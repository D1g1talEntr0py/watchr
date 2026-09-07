import { readdir, stat } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import { RetryQueue } from './retry-queue';
import { timeout } from './decorators/timeout';
import { FileSystemEntries } from './file-system-entries';
import { setTimeout as setAsyncTimeout } from 'node:timers/promises';
import type { DirectoryReadOptions, NodeError, NodeErrorCode, Stats } from './@types/index';
import { raceWithAbort } from './utils';

const maxConcurrentDirectoryReads = 8;
const missingStat = Symbol('missing-stat');
const retryErrorCodes: Set<NodeErrorCode> = new Set([ 'EMFILE', 'ENFILE', 'EAGAIN', 'EBUSY', 'EACCESS', 'EACCES', 'EACCS', 'EPERM' ]);
const recursiveReadUnsupportedErrorCodes = new Set([ 'ERR_INVALID_ARG_VALUE', 'ERR_INVALID_OPT_VALUE' ]);

/**
 * Checks if the error is a Node.js error.
 * @param error - The error to check.
 * @returns True if the error is a Node.js error, false otherwise.
 */
const isNodeError = (error: unknown): error is NodeError => error instanceof Error;

/**
 * A class that provides methods for interacting with the file system.
 */
export class FileSystem {
	private static readonly retryQueue = new RetryQueue();
	private static readonly maxStatRetries = 10;

	private constructor () {
		throw new Error('This class cannot be instantiated');
	}

	/**
	 * Reads the contents of a directory.
	 * @param rootPath - The root directory to read.
	 * @param param1 - Options for reading the directory.
	 * @returns A promise that resolves to a FileSystemEntries object containing the directory contents.
	 */
	static async readDirectory(rootPath: string, { ignore, recursive = true, signal }: DirectoryReadOptions & { recursive?: boolean } = {}): Promise<FileSystemEntries> {
		const fileSystemEntries = new FileSystemEntries();

		if (signal?.aborted) { return fileSystemEntries }

		const shouldIgnore = ignore ?? (() => false);
		rootPath = normalize(rootPath);

		const readWithNativeRecursion = async () => {
			try {
				if (signal?.aborted) { return true }

				const entries = await readdir(rootPath, { recursive, withFileTypes: true });

				for (const entry of entries) {
					if (signal?.aborted) { break }

					const subPath = normalize(join(typeof entry.parentPath === 'string' ? entry.parentPath : rootPath, entry.name));

					if (shouldIgnore(subPath)) { continue }

					if (entry.isDirectory()) {
						fileSystemEntries.addDirectory(subPath);
					} else if (entry.isFile()) {
						fileSystemEntries.addFile(subPath);
					}
				}

				return true;
			} catch (error: unknown) {
				const errorCode = isNodeError(error) && typeof error.code === 'string' ? error.code : undefined;

				if (errorCode === undefined || !recursiveReadUnsupportedErrorCodes.has(errorCode)) {
					throw error;
				}

				return false;
			}
		};

		const readWithManualTraversal = async () => {
			const pendingDirectories = [ rootPath ];

			const readNextDirectory = async () => {
				while (!signal?.aborted) {
					const currentPath = pendingDirectories.shift();
					if (currentPath === undefined) { return }

					if (signal?.aborted) { return }
					const subPathPrefix = `${currentPath}${currentPath === sep ? '' : sep}`;
					const entries = await readdir(currentPath, { withFileTypes: true });

					for (const directoryEntry of entries) {
						if (signal?.aborted) { return }

						const subPath = normalize(`${subPathPrefix}${directoryEntry.name}`);
						if (shouldIgnore(subPath)) { continue }

						if (directoryEntry.isDirectory()) {
							fileSystemEntries.addDirectory(subPath);
							if (recursive) { pendingDirectories.push(subPath) }
						} else if (directoryEntry.isFile()) {
							fileSystemEntries.addFile(subPath);
						}
					}
				}
			};

			await Promise.all(Array.from({ length: maxConcurrentDirectoryReads }, readNextDirectory));
		};

		const nativeRecursiveReadUsed = ignore === undefined && await readWithNativeRecursion();

		if (!nativeRecursiveReadUsed) { await readWithManualTraversal() }

		return signal?.aborted ? fileSystemEntries.reset() : fileSystemEntries;
	}

	/**
	 * Gets the stats for a file or directory.
	 * @param targetPath - The path to the file or directory.
	 * @param signal - Abort signal supplied by the timeout decorator; stops retrying once aborted.
	 * @returns A promise that resolves to the stats object, undefined for confirmed absence, or rejects for an indeterminate result.
	 */
	static async getStats(targetPath: string, signal?: AbortSignal): Promise<Stats | undefined> {
		const result = signal === undefined
			? await FileSystem.getStatsWithTimeout(targetPath)
			: await FileSystem.getStatsWithTimeout(targetPath, signal);

		if (result === missingStat) { return undefined }

		if (result === undefined) {
			if (signal?.aborted) { throw new DOMException('The operation was aborted', 'AbortError') }

			throw new Error('🚨 Stat operation timed out');
		}

		return result;
	}

	/**
	 * Gets stats with a bounded timeout while preserving confirmed absence separately from timeout.
	 * @param targetPath - The path to the file or directory.
	 * @param signal - Optional caller cancellation signal.
	 * @returns Stats, the missing sentinel, or undefined when the timeout/cancellation wins.
	 */
	@timeout()
	private static async getStatsWithTimeout(targetPath: string, signal?: AbortSignal): Promise<Stats | typeof missingStat | undefined> {
		let retries = 0;

		const handleRejection = async (error: unknown): Promise<Stats | typeof missingStat | undefined> => {
			if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) { return missingStat }
			if (!isNodeError(error) || !retryErrorCodes.has(error.code)) { throw error }

			if (retries >= FileSystem.maxStatRetries) { throw error }

			// The decorator already returned undefined to the caller; further retries are discarded work.
			if (signal?.aborted) { return }

			retries++;

			try {
				await setAsyncTimeout(~~(Math.random() * 100), { signal });
			} catch (sleepError: unknown) {
				if (signal?.aborted) { return }

				throw sleepError;
			}

			if (signal?.aborted) { return }

			return getStatsWithTimeout(targetPath, signal);
		};

		/**
		 * Gets the stats for a file or directory with a timeout.
		 * @param targetPath - The path to the file or directory.
		 * @param requestSignal - Signal used for this individual retry attempt.
		 * @returns A promise that resolves to the stats or undefined if not found.
		 */
		const getStatsWithTimeout = async (targetPath: string, requestSignal: AbortSignal | undefined = signal): Promise<Stats | typeof missingStat | undefined> => {
			// Each attempt takes its own queue slot so retries stay throttled under descriptor pressure.
			try {
				using _queueLease = await FileSystem.retryQueue.schedule<Stats>(requestSignal);

				if (requestSignal?.aborted) { return }

				const result = await raceWithAbort(stat(targetPath, { bigint: true }), requestSignal);

				if (requestSignal?.aborted) { return }

				return result;
			} catch (error: unknown) {
				return handleRejection(error);
			}
		};

		try {
			return await getStatsWithTimeout(targetPath);
		} catch (error: unknown) {
			if (signal?.aborted) { return }

			throw error;
		}
	}

	/**
	 * Checks if a path is a subpath of another path.
	 * @param targetPath - The target path to check against.
	 * @param subPath - The subpath to check.
	 * @returns True if the subPath is a subpath of the targetPath, false otherwise.
	 */
	static isSubPath(targetPath: string, subPath: string): boolean {
		// Normalize paths to handle edge cases
		targetPath = normalize(targetPath);
		subPath = normalize(subPath);

		// Ensure target path ends with separator for proper comparison
		const normalizedTargetPath = targetPath.endsWith(sep) ? targetPath : targetPath + sep;

		// Check if subPath starts with the normalized target path
		return subPath.startsWith(normalizedTargetPath) && subPath.length > normalizedTargetPath.length;
	}
}

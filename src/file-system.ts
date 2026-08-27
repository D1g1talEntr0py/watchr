import { readdir, stat } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import { RetryQueue } from './retry-queue';
import { timeout } from './decorators/timeout';
import { FileSystemEntries } from './file-system-entries';
import { setTimeout as setAsyncTimeout } from 'node:timers/promises';
import type { DirectoryReadOptions, NodeError, NodeErrorCode, Stats } from './@types/index';

const retryErrorCodes: Set<NodeErrorCode> = new Set([ 'EMFILE', 'ENFILE', 'EAGAIN', 'EBUSY', 'EACCESS', 'EACCES', 'EACCS', 'EPERM' ]);
const recursiveReadUnsupportedErrorCodes = new Set([ 'ERR_INVALID_ARG_VALUE', 'ERR_INVALID_OPT_VALUE' ]);
const maxConcurrentDirectoryReads = 8;

/**
 * Runs an async task over items with bounded concurrency using a shared-index worker pool.
 * @param items - The items to process.
 * @param task - The async task to run for each item.
 * @returns A promise that resolves when all items are processed.
 */
const runWithBoundedConcurrency = async <T>(items: T[], task: (item: T) => Promise<void>): Promise<void> => {
	let nextIndex = 0;

	const workers = Array.from({ length: Math.min(maxConcurrentDirectoryReads, items.length) }, async () => {
		while (nextIndex < items.length) {
			await task(items[nextIndex++]!);
		}
	});

	await Promise.all(workers);
};

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
		throw new Error('🚨 This class cannot be instantiated');
	}

	/**
	 * Reads the contents of a directory.
	 * @param rootPath - The root directory to read.
	 * @param param1 - Options for reading the directory.
	 * @returns A promise that resolves to a FileSystemEntries object containing the directory contents.
	 */
	static async readDirectory(rootPath: string, { ignore = () => false, signal }: DirectoryReadOptions = {}): Promise<FileSystemEntries> {
		const fileSystemEntries = new FileSystemEntries();

		rootPath = normalize(rootPath);

		const readWithNativeRecursion = async (): Promise<boolean> => {
			try {
				const entries = await readdir(rootPath, { recursive: true, withFileTypes: true });

				for (const entry of entries) {
					if (signal?.aborted) { break }

					const parentPath = typeof entry.parentPath === 'string' ? entry.parentPath : rootPath;
					const subPath = normalize(join(parentPath, entry.name));

					if (ignore(subPath)) { continue }

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
			const visited = new Set<string>([ rootPath ]);

			const populateResultFromPath = async (currentPath: string) => {
				if (signal?.aborted) { return }

				const subPathPrefix = `${currentPath}${currentPath === sep ? '' : sep}`;
				const subdirectoriesToProcess: string[] = [];

				for (const directoryEntry of await readdir(currentPath, { withFileTypes: true })) {
					const subPath = `${subPathPrefix}${directoryEntry.name}`;

					if (ignore(subPath) || visited.has(subPath)) { continue }

					visited.add(subPath);

					if (directoryEntry.isDirectory()) {
						fileSystemEntries.addDirectory(subPath);
						subdirectoriesToProcess.push(subPath);
					} else if (directoryEntry.isFile()) {
						fileSystemEntries.addFile(subPath);
					}
				}

				if (subdirectoriesToProcess.length > 0) {
					// Per-level bounded workers cap fanout without deadlocking on recursion.
					await runWithBoundedConcurrency(subdirectoriesToProcess, populateResultFromPath);
				}
			};

			await populateResultFromPath(rootPath);
		};

		const nativeRecursiveReadUsed = await readWithNativeRecursion();

		if (!nativeRecursiveReadUsed) {
			await readWithManualTraversal();
		}

		return signal?.aborted ? fileSystemEntries.reset() : fileSystemEntries;
	}

	/**
	 * Gets the stats for a file or directory.
	 * @param targetPath - The path to the file or directory.
	 * @param signal - Abort signal supplied by the timeout decorator; stops retrying once aborted.
	 * @returns A promise that resolves to the stats object or undefined if not found.
	 */
	@timeout()
	static async getStats(targetPath: string, signal?: AbortSignal): Promise<Stats | undefined> {
		let retries = 0;

		/**
		 * Handles the rejection of a promise.
		 * @param error - The error that was thrown.
		 * @returns A promise that resolves to the stats or undefined.
		 */
		const handleRejection = async (error: unknown): Promise<Stats | undefined> => {
			if (!isNodeError(error) || !retryErrorCodes.has(error.code)) { return }

			if (retries >= FileSystem.maxStatRetries) { return }

			// The decorator already returned undefined to the caller; further retries are discarded work.
			if (signal?.aborted) { return }

			retries++;

			await setAsyncTimeout(~~(Math.random() * 100));

			if (signal?.aborted) { return }

			return getStatsWithTimeout(targetPath);
		};

		/**
		 * Gets the stats for a file or directory with a timeout.
		 * @param targetPath - The path to the file or directory.
		 * @returns A promise that resolves to the stats or undefined if not found.
		 */
		const getStatsWithTimeout = async (targetPath: string): Promise<Stats | undefined> => {
			// Each attempt takes its own queue slot so retries stay throttled under descriptor pressure.
			const clearQueue = await FileSystem.retryQueue.schedule<Stats>();

			try {
				return clearQueue(await stat(targetPath, { bigint: true }));
			} catch (error: unknown) {
				clearQueue();

				return handleRejection(error);
			}
		};

		return getStatsWithTimeout(targetPath);
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

import { lstatSync, statSync } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import { raceWithAbort } from './utils';
import { RetryQueue } from './retry-queue';
import { FileSystemEntries } from './file-system-entries';
import { setTimeout as setAsyncTimeout } from 'node:timers/promises';
import type { DirectoryReadOptions, NodeError, NodeErrorCode, StatOptions, Stats } from './@types/index';

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
 * @internal
 */
export class FileSystem {
	static readonly #retryQueue = new RetryQueue();
	static readonly #maxStatRetries = 10;

	private constructor () {
		throw new Error('This class cannot be instantiated');
	}

	/**
	 * Reads the contents of a directory.
	 * @param rootPath - The root directory to read.
	 * @param param1 - Options for reading the directory.
	 * @returns A promise that resolves to a FileSystemEntries object containing the directory contents.
	 */
	static async readDirectory(rootPath: string, { ignore, recursive = true, signal, followSymlinks = true }: DirectoryReadOptions = {}): Promise<FileSystemEntries> {
		const fileSystemEntries = new FileSystemEntries();

		if (signal?.aborted) { return fileSystemEntries }

		const shouldIgnore = ignore ?? (() => false);
		rootPath = normalize(rootPath);

		// Real paths of symlinked directories already scanned (seeded with the root); regular directories are never realpath'd.
		let visitedRealPaths: Set<string> | undefined;
		let rootRealPath: string | undefined;

		/**
		 * Resolves a symlink entry: records it as a file or directory (dangling/unreadable links are skipped).
		 * @param subPath - The symlink path.
		 * @returns True when the link points at a directory that should be traversed.
		 */
		const addSymlink = async (subPath: string): Promise<boolean> => {
			let stats: Stats | undefined;

			try {
				stats = await FileSystem.getStats(subPath, { signal });
			} catch {
				return false;
			}

			if (signal?.aborted || stats === undefined) { return false }

			if (stats.isDirectory()) {
				fileSystemEntries.addDirectory(subPath).addSymlink(subPath);

				return recursive;
			}

			if (stats.isFile()) { fileSystemEntries.addFile(subPath).addSymlink(subPath) }

			return false;
		};

		/**
		 * Decides whether a symlinked directory may be traversed without revisiting a directory or looping back to an ancestor.
		 * @param subPath - The symlink path.
		 * @returns True when the link's real path has not been visited yet.
		 */
		const shouldTraverseSymlink = async (subPath: string): Promise<boolean> => {
			try {
				rootRealPath ??= await realpath(rootPath);
				visitedRealPaths ??= new Set([ rootRealPath ]);

				const realTarget = await realpath(subPath);

				// Reject links to an ancestor even when its real path has not been visited.
				if (visitedRealPaths.has(realTarget) || !FileSystem.isSubPath(rootRealPath, realTarget) || FileSystem.isSubPath(realTarget, subPath)) { return false }

				visitedRealPaths.add(realTarget);

				return true;
			} catch {
				return false;
			}
		};

		const readWithManualTraversal = async (startPath: string) => {
			const pendingDirectories = [ startPath ];

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
						} else if (followSymlinks && directoryEntry.isSymbolicLink() && await addSymlink(subPath) && await shouldTraverseSymlink(subPath)) {
							pendingDirectories.push(subPath);
						}
					}
				}
			};

			await Promise.all(Array.from({ length: maxConcurrentDirectoryReads }, readNextDirectory));
		};

		const readWithNativeRecursion = async () => {
			try {
				if (signal?.aborted) { return true }

				const entries = await readdir(rootPath, { recursive, withFileTypes: true });
				const symlinkedDirectories: string[] = [];

				for (const entry of entries) {
					if (signal?.aborted) { break }

					const subPath = normalize(join(typeof entry.parentPath === 'string' ? entry.parentPath : rootPath, entry.name));

					if (shouldIgnore(subPath)) { continue }

					if (entry.isDirectory()) {
						fileSystemEntries.addDirectory(subPath);
					} else if (entry.isFile()) {
						fileSystemEntries.addFile(subPath);
					} else if (followSymlinks && entry.isSymbolicLink() && await addSymlink(subPath)) {
						symlinkedDirectories.push(subPath);
					}
				}

				// Native recursion does not descend into symlinked directories; traverse those subtrees manually.
				for (const symlinkedDirectory of symlinkedDirectories) {
					if (signal?.aborted) { break }
					if (await shouldTraverseSymlink(symlinkedDirectory)) { await readWithManualTraversal(symlinkedDirectory) }
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

		// Attempt a native recursive read first if no ignore rules are specified. If it fails or ignore rules exist, fall back to manual traversal.
		if (!(ignore === undefined && await readWithNativeRecursion())) { await readWithManualTraversal(rootPath) }

		return signal?.aborted ? fileSystemEntries.reset() : fileSystemEntries;
	}

	/**
	 * Checks whether a path is itself a symbolic link (without following it).
	 * @param targetPath - The path to check.
	 * @param sync - Use a blocking `lstatSync` instead of the async call.
	 * @returns True for a symlink; false for anything else, including a missing path.
	 */
	static async isSymbolicLink(targetPath: string, sync: boolean = false): Promise<boolean> {
		try { return (sync ? lstatSync(targetPath) : await lstat(targetPath)).isSymbolicLink() } catch { return false }
	}

	/**
	 * Gets the stats for a file or directory.
	 * @param targetPath - The path to the file or directory.
	 * @param options - Optional cancellation signal and timeout. Without a timeout the stat is bounded only by the signal.
	 * @returns A promise that resolves to the stats object, undefined for confirmed absence, or rejects for an indeterminate result.
	 */
	static async getStats(targetPath: string, { signal, timeout, sync }: StatOptions = {}): Promise<Stats | undefined> {
		if (sync === true) {
			if (signal?.aborted) { throw new DOMException('The operation was aborted', 'AbortError') }

			try {
				return statSync(targetPath, { bigint: true, throwIfNoEntry: false });
			} catch (error: unknown) {
				if (isNodeError(error) && error.code === 'ENOTDIR') { return undefined }
				if (!isNodeError(error) || !retryErrorCodes.has(error.code)) { throw error }
			}
		}

		const timeoutSignal = timeout === undefined ? undefined : AbortSignal.timeout(timeout);
		if (timeoutSignal !== undefined) {
			signal = signal === undefined ? timeoutSignal : AbortSignal.any([ signal, timeoutSignal ]);
		}

		const result = await FileSystem.#getStatsWithRetries(targetPath, signal);

		if (result === missingStat) { return undefined }

		if (result === undefined) {
			if (timeoutSignal?.aborted) {
				const error = new Error(`Stat operation timed out after ${timeout}ms for "${targetPath}"`, { cause: timeoutSignal.reason });
				error.name = 'TimeoutError';
				throw Object.assign(error, { code: 'WATCHR_STAT_TIMEOUT' });
			}

			if (signal?.aborted) { throw new DOMException('The operation was aborted', 'AbortError') }

			throw new Error('Stat operation timed out');
		}

		return result;
	}

	/**
	 * Stats a path with bounded retries while preserving confirmed absence separately from cancellation.
	 * @param targetPath - The path to the file or directory.
	 * @param signal - Optional cancellation signal; stops retrying once aborted.
	 * @returns Stats, the missing sentinel, or undefined when cancellation wins.
	 */
	static async #getStatsWithRetries(targetPath: string, signal?: AbortSignal): Promise<Stats | typeof missingStat | undefined> {
		let retries = 0;

		const handleRejection = async (error: unknown): Promise<Stats | typeof missingStat | undefined> => {
			if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) { return missingStat }
			if (!isNodeError(error) || !retryErrorCodes.has(error.code)) { throw error }

			if (retries >= FileSystem.#maxStatRetries) { throw error }

			// The caller already gave up once the signal aborted; further retries are discarded work.
			if (signal?.aborted) { return }

			retries++;

			try {
				await setAsyncTimeout(~~(Math.random() * 100), { signal });
			} catch (sleepError: unknown) {
				if (signal?.aborted) { return }

				throw sleepError;
			}

			if (signal?.aborted) { return }

			return attemptStat(targetPath, signal);
		};

		/**
		 * Performs a single stat attempt through the retry queue.
		 * @param targetPath - The path to the file or directory.
		 * @param requestSignal - Signal used for this individual retry attempt.
		 * @returns A promise that resolves to the stats or undefined if not found.
		 */
		const attemptStat = async (targetPath: string, requestSignal: AbortSignal | undefined = signal): Promise<Stats | typeof missingStat | undefined> => {
			// Each attempt takes its own queue slot so retries stay throttled under descriptor pressure.
			try {
				using _queueLease = await FileSystem.#retryQueue.schedule(requestSignal);

				if (requestSignal?.aborted) { return }

				const result = await raceWithAbort(stat(targetPath, { bigint: true }), requestSignal);

				if (requestSignal?.aborted) { return }

				return result;
			} catch (error: unknown) {
				return handleRejection(error);
			}
		};

		try {
			return await attemptStat(targetPath);
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

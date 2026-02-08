import { readdir, stat } from 'node:fs/promises';
import { normalize, sep } from 'node:path';
import { RetryQueue } from './retry-queue';
import { timeout } from './decorators/timeout';
import { FileSystemEntries } from './file-system-entries';
import { setTimeout as setAsyncTimeout } from 'node:timers/promises';
import type { DirectoryReadOptions, NodeError, NodeErrorCode, Stats } from './@types';

const retryErrorCodes: Set<NodeErrorCode> = new Set([ 'ENOENT', 'EMFILE', 'ENFILE', 'EAGAIN', 'EBUSY', 'EACCESS', 'EACCES', 'EACCS', 'EPERM' ]);

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

	private constructor () {
		throw new Error('This class cannot be instantiated');
	}

	/**
	 * Reads the contents of a directory.
	 * @param rootPath - The root directory to read.
	 * @param param1 - Options for reading the directory.
	 * @returns A promise that resolves to a FileSystemEntries object containing the directory contents.
	 */
	static async readDirectory(rootPath: string, { ignore = () => false, signal }: DirectoryReadOptions = {}): Promise<FileSystemEntries> {
		const visited = new Set<string>();
		const fileSystemEntries = new FileSystemEntries();

		/**
		 * Populates the result from the given path.
		 * @param rootPath - The root path to populate from.
		 * @returns A promise that resolves when the population is complete.
		 */
		const populateResultFromPath = async (rootPath: string): Promise<void> => {
			if (signal?.aborted) { return }

			const subPathPrefix = `${rootPath}${rootPath === sep ? '' : sep}`;

			for (const directoryEntry of await readdir(rootPath, { withFileTypes: true })) {
				const subPath = `${subPathPrefix}${directoryEntry.name}`;

				if (ignore(subPath) || visited.has(subPath)) { continue }

				visited.add(subPath);

				if (directoryEntry.isDirectory()) {
					fileSystemEntries.addDirectory(subPath);
					await populateResultFromPath(subPath);
				} else if (directoryEntry.isFile()) {
					fileSystemEntries.addFile(subPath);
				}
			}
		};

		rootPath = normalize(rootPath);

		visited.add(rootPath);

		await populateResultFromPath(rootPath);

		return signal?.aborted ? fileSystemEntries.reset() : fileSystemEntries;
	}

	/**
	 * Gets the stats for a file or directory.
	 * @param targetPath - The path to the file or directory.
	 * @returns A promise that resolves to the stats object or undefined if not found.
	 */
	@timeout()
	static async getStats(targetPath: string): Promise<Stats | undefined> {
		const clearQueue = await FileSystem.retryQueue.schedule<Stats>();

		/**
		 * Handles the rejection of a promise.
		 * @param error - The error that was thrown.
		 * @returns A promise that resolves to the stats or undefined.
		 */
		const handleRejection = async (error: unknown): Promise<Stats | undefined> => {
			clearQueue();

			if (!isNodeError(error) || !retryErrorCodes.has(error.code)) { return }

			await setAsyncTimeout(~~(Math.random() * 100));

			return getStatsWithTimeout(targetPath);
		};

		/**
		 * Gets the stats for a file or directory with a timeout.
		 * @param targetPath - The path to the file or directory.
		 * @returns A promise that resolves to the stats or undefined if not found.
		 */
		const getStatsWithTimeout = async (targetPath: string): Promise<Stats | undefined> => {
			try {
				return clearQueue(await stat(targetPath, { bigint: true }));
			} catch (error: unknown) {
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
import type { InodeNumber, Stats } from './@types';

/**
 * This class is intended to be used as a wrapper around the stats objects
 * returned by fs.stat() and fs.lstat() calls. It provides a more memory-efficient
 * representation of the useful subset of the stats object properties.
 */
export class WatchrStats {
	/** The inode number of the file or directory. */
	private readonly _inodeNumber: InodeNumber;
	/** The size of the file or directory. */
	private readonly _size: number;
	/** True if the stats object represents a file. */
	private readonly _isFile: boolean;
	/** True if the stats object represents a directory. */
	private readonly _isDirectory: boolean;
	/** True if the stats object represents a symbolic link. */
	private readonly _isSymbolicLink: boolean;

	/**
	 * Creates an instance of WatchrStats.
	 * @param stats - The original stats object to wrap.
	 */
	constructor(stats: Stats) {
		this._inodeNumber = (stats.ino <= Number.MAX_SAFE_INTEGER) ? Number(stats.ino) : stats.ino;
		this._size = Number(stats.size);
		this._isFile = stats.isFile();
		this._isDirectory = stats.isDirectory();
		this._isSymbolicLink = stats.isSymbolicLink();
	}

	/**
	 * Returns the inode number of the file or directory.
	 *
	 * @returns The inode number of the file or directory.
	 */
	get inodeNumber(): InodeNumber {
		return this._inodeNumber;
	}

	/**
	 * Returns the size of the file or directory.
	 *
	 * @returns The size of the file or directory.
	 */
	get size(): number {
		return this._size;
	}

	/**
	 * Returns true if the stats object represents a file.
	 *
	 * @returns True if the stats object represents a file. Otherwise, false.
	 */
	isFile(): boolean {
		return this._isFile;
	}

	/**
	 * Returns true if the stats object represents a directory.
	 *
	 * @returns True if the stats object represents a directory. Otherwise, false.
	 */
	isDirectory(): boolean {
		return this._isDirectory;
	}

	/**
	 * Returns true if the stats object represents a symbolic link.
	 *
	 * @returns True if the stats object represents a symbolic link. Otherwise, false.
	 */
	isSymbolicLink(): boolean {
		return this._isSymbolicLink;
	}
}
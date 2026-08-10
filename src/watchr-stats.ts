import './temporal-polyfill';
import type { InodeNumber, Stats } from './@types/index';

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

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
	/** Last modification time. */
	private readonly _modifiedTime: Temporal.Instant;
	/** Last status change time. */
	private readonly _changeTime: Temporal.Instant;
	/** Last modification time in milliseconds. */
	private readonly _modifiedTimeMs: number;
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
		this._modifiedTime = WatchrStats.resolveInstant(stats.mtimeInstant, stats.mtimeNs);
		this._changeTime = WatchrStats.resolveInstant(stats.ctimeInstant, stats.ctimeNs);
		const modifiedTimeNanoseconds = this._modifiedTime.epochNanoseconds;
		this._modifiedTimeMs = Number(modifiedTimeNanoseconds / NANOSECONDS_PER_MILLISECOND) + (Number(modifiedTimeNanoseconds % NANOSECONDS_PER_MILLISECOND) / Number(NANOSECONDS_PER_MILLISECOND));
		this._isFile = stats.isFile();
		this._isDirectory = stats.isDirectory();
		this._isSymbolicLink = stats.isSymbolicLink();
	}

	/**
	 * Returns the last modification time.
	 *
	 * @returns The last modification time.
	 */
	get modifiedTime(): Temporal.Instant {
		return this._modifiedTime;
	}

	/**
	 * Returns the last status change time.
	 *
	 * @returns The last status change time.
	 */
	get changeTime(): Temporal.Instant {
		return this._changeTime;
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
	 * Returns the last modification time in milliseconds.
	 *
	 * @returns The last modification time in milliseconds.
	 */
	get modifiedTimeMs(): number {
		return this._modifiedTimeMs;
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

	/**
	 * Checks whether this snapshot is equal to another snapshot using canonical
	 * change-detection fields.
	 * @param other - The stats snapshot to compare against.
	 * @returns True when inode, size, timestamps, and type flags match.
	 */
	equals(other: WatchrStats): boolean {
		return this._inodeNumber === other._inodeNumber
			&& this._size === other._size
			&& this._modifiedTime.equals(other._modifiedTime)
			&& this._changeTime.equals(other._changeTime)
			&& this._isFile === other._isFile
			&& this._isDirectory === other._isDirectory
			&& this._isSymbolicLink === other._isSymbolicLink;
	}

	/**
	 * Resolves a temporal instant from stats fields across Node versions.
	 * @param instant - Native instant when available.
	 * @param nanoseconds - Nanosecond timestamp fallback.
	 * @returns A temporal instant.
	 */
	private static resolveInstant(instant: Temporal.Instant | undefined, nanoseconds: bigint): Temporal.Instant {
		return instant ?? Temporal.Instant.fromEpochNanoseconds(nanoseconds);
	}
}
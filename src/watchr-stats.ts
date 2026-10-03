import { Temporal as TemporalPolyfill } from 'temporal-polyfill-lite';
import type { InodeNumber, Stats } from './@types/stats';

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

/** Bit positions of the type/origin flags packed into {@link WatchrStats}. */
const StatsFlag = {
	FILE: 1,
	DIRECTORY: 2,
	SYMBOLIC_LINK: 4,
	SYNTHETIC: 8
} as const;

/** Flags that describe the entry type; the synthetic bit is excluded from equality. */
const TYPE_FLAGS_MASK: number = StatsFlag.FILE | StatsFlag.DIRECTORY | StatsFlag.SYMBOLIC_LINK;

/**
 * Resolves the `Temporal` namespace on every access without ever installing it on `globalThis`.
 * A host-provided global is preferred; otherwise the polyfill is used as a plain module value.
 * @returns The `Temporal` namespace to use for constructing instants.
 */
function getTemporal(): typeof Temporal {
	return (globalThis as { Temporal?: typeof Temporal }).Temporal ?? TemporalPolyfill;
}

/**
 * This class is intended to be used as a wrapper around the stats objects
 * returned by fs.stat() and fs.lstat() calls. It provides a more memory-efficient
 * representation of the useful subset of the stats object properties.
 */
export class WatchrStats {
	/** The inode number of the file or directory. */
	readonly #ino: bigint;
	/** The size of the file or directory. */
	readonly #size: number;
	/** Last modification time in nanoseconds since the epoch. */
	readonly #mtimeNs: bigint;
	/** Last status change time in nanoseconds since the epoch. */
	readonly #ctimeNs: bigint;
	/** Packed {@link StatsFlag} bits. */
	readonly #flags: number;

	/**
	 * Creates an instance of WatchrStats.
	 * @param ino - The inode number.
	 * @param size - The size in bytes.
	 * @param mtimeNs - Last modification time in nanoseconds since the epoch.
	 * @param ctimeNs - Last status change time in nanoseconds since the epoch.
	 * @param flags - Packed {@link StatsFlag} bits.
	 */
	private constructor(ino: bigint, size: number, mtimeNs: bigint, ctimeNs: bigint, flags: number) {
		this.#ino = ino;
		this.#size = size;
		this.#mtimeNs = mtimeNs;
		this.#ctimeNs = ctimeNs;
		this.#flags = flags;
	}

	/**
	 * Creates a snapshot from a native `Stats` object. Only nanosecond timestamps are read, so this
	 * works on hosts without a `Temporal` global (where `Stats.mtimeInstant` throws).
	 * @param stats - The original stats object to wrap.
	 * @param isSymbolicLink - Forces the symlink flag on; used when `stats` came from a following `stat()` of a known symlink.
	 * @returns A stats snapshot.
	 */
	static fromStats(stats: Stats, isSymbolicLink: boolean = false): WatchrStats {
		const flags = (stats.isFile() ? StatsFlag.FILE : 0) | (stats.isDirectory() ? StatsFlag.DIRECTORY : 0) | (isSymbolicLink || stats.isSymbolicLink() ? StatsFlag.SYMBOLIC_LINK : 0);

		return new WatchrStats(stats.ino, Number(stats.size), stats.mtimeNs, stats.ctimeNs, flags);
	}

	/**
	 * Creates a synthetic snapshot for edge-case events where native watchers do not provide
	 * enough information to recover a tracked stat.
	 * @param isDirectory - Whether the synthetic snapshot represents a directory.
	 * @param nowMs - Timestamp in milliseconds used for both modification and change time.
	 * @returns A synthetic stats snapshot.
	 */
	static synthetic(isDirectory: boolean, nowMs: number = Date.now()): WatchrStats {
		const nowNs = BigInt(nowMs) * NANOSECONDS_PER_MILLISECOND;

		return new WatchrStats(0n, 0, nowNs, nowNs, (isDirectory ? StatsFlag.DIRECTORY : StatsFlag.FILE) | StatsFlag.SYNTHETIC);
	}

	/**
	 * Returns the last modification time.
	 *
	 * @returns The last modification time.
	 */
	get modifiedTime(): Temporal.Instant {
		return getTemporal().Instant.fromEpochNanoseconds(this.#mtimeNs);
	}

	/**
	 * Returns the last status change time.
	 *
	 * @returns The last status change time.
	 */
	get changeTime(): Temporal.Instant {
		return getTemporal().Instant.fromEpochNanoseconds(this.#ctimeNs);
	}

	/**
	 * Returns the last modification time in nanoseconds since the epoch.
	 * @returns The last modification time in nanoseconds.
	 */
	get modifiedTimeNs(): bigint {
		return this.#mtimeNs;
	}

	/**
	 * Returns the last status change time in nanoseconds since the epoch.
	 * @returns The last status change time in nanoseconds.
	 */
	get changeTimeNs(): bigint {
		return this.#ctimeNs;
	}

	/**
	 * Returns the inode number of the file or directory.
	 *
	 * @returns The inode number of the file or directory.
	 */
	get inodeNumber(): InodeNumber {
		return this.#ino <= Number.MAX_SAFE_INTEGER ? Number(this.#ino) : this.#ino;
	}

	/**
	 * Returns the size of the file or directory.
	 *
	 * @returns The size of the file or directory.
	 */
	get size(): number {
		return this.#size;
	}

	/**
	 * Returns the last modification time in milliseconds.
	 *
	 * @returns The last modification time in milliseconds.
	 */
	get modifiedTimeMs(): number {
		return Number(this.#mtimeNs / NANOSECONDS_PER_MILLISECOND) + (Number(this.#mtimeNs % NANOSECONDS_PER_MILLISECOND) / Number(NANOSECONDS_PER_MILLISECOND));
	}

	/**
	 * Returns true if the stats object represents a file.
	 *
	 * @returns True if the stats object represents a file. Otherwise, false.
	 */
	isFile(): boolean {
		return (this.#flags & StatsFlag.FILE) !== 0;
	}

	/**
	 * Returns true if the stats object represents a directory.
	 *
	 * @returns True if the stats object represents a directory. Otherwise, false.
	 */
	isDirectory(): boolean {
		return (this.#flags & StatsFlag.DIRECTORY) !== 0;
	}

	/**
	 * Returns true if the entry is a symbolic link. Size, timestamps and `isFile()`/`isDirectory()` still describe the
	 * link's target. This is true only for entries discovered as symlinks during a scan (and kept for later events on
	 * that path); a symlink first seen through a live event under `followSymlinks: true` reports `false`.
	 *
	 * @returns True if the stats object represents a symbolic link. Otherwise, false.
	 */
	isSymbolicLink(): boolean {
		return (this.#flags & StatsFlag.SYMBOLIC_LINK) !== 0;
	}

	/**
	 * Returns whether this snapshot was synthesized because filesystem metadata was unavailable.
	 * @returns True for synthetic snapshots, otherwise false.
	 */
	get isSynthetic(): boolean {
		return (this.#flags & StatsFlag.SYNTHETIC) !== 0;
	}

	/**
	 * Checks whether this snapshot is equal to another snapshot using canonical
	 * change-detection fields.
	 * @param other - The stats snapshot to compare against.
	 * @returns True when inode, size, timestamps, and type flags match.
	 */
	equals(other: WatchrStats): boolean {
		return this.#ino === other.#ino
			&& this.#size === other.#size
			&& this.#mtimeNs === other.#mtimeNs
			&& this.#ctimeNs === other.#ctimeNs
			&& (this.#flags & TYPE_FLAGS_MASK) === (other.#flags & TYPE_FLAGS_MASK);
	}
}

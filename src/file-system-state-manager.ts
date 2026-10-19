import { EvictingCache } from 'evicting-cache';
import { SetMultiMap } from './set-multi-map';
import { FileSystem } from './file-system';
import { WatchrStats } from './watchr-stats';
import { FileSystemEvent, InodeType, renameTimeout } from './constants';
import type { InodeNumber, Path, StateEvent, StateUpdateOptions } from './@types/index';

type InodeEntry = { inodeNumber: InodeNumber, inodeType: InodeType };

/**
 * Polls the file system for changes
 * @internal
 */
export class FileSystemStateManager {
	#vacatedRetentionMs: number = renameTimeout;
	#generation = 0;
	static readonly #maxTrackedEventInodes: number = 50_000;
	/** Last inode seen per (event, path), keyed by `${event}\0${path}`. */
	readonly #targetInodes = new EvictingCache<string, InodeEntry>(FileSystemStateManager.#maxTrackedEventInodes);
	readonly #paths = new SetMultiMap<InodeNumber, Path>();
	readonly #stats = new Map<Path, WatchrStats>();
	/** When each inode last lost a tracked path, oldest first; lets an add tell a possible rename target from a new file. */
	readonly #vacatedInodes = new Map<InodeNumber, number>();

	/**
	 * Gets the paths being watched.
	 * @returns A set multi-map of paths being watched.
	 */
	get paths(): SetMultiMap<InodeNumber, Path> {
		return this.#paths;
	}

	/**
	 * Gets the stats for the paths being watched.
	 * @returns A map of paths to their stats.
	 */
	get stats(): Map<Path, WatchrStats> {
		return this.#stats;
	}

	/**
	 * Gets the inode number for a specific path and event.
	 * @param targetPath - The path to get the inode number for.
	 * @param event - The file system event to check.
	 * @param type - The inode type to check.
	 * @returns The inode number if it exists, otherwise undefined.
	 */
	getInodeNumber(targetPath: Path, event: FileSystemEvent, type?: InodeType): InodeNumber | undefined {
		const entry = this.#targetInodes.peek(FileSystemStateManager.#inodeKey(event, targetPath));

		return entry === null || (type !== undefined && entry.inodeType !== type) ? undefined : entry.inodeNumber;
	}

	/**
	 * Configures retention before recording removals. Shared roots retain the largest configured window.
	 * A zero window does not lower existing retention; configure positive windows before the first removal.
	 * @param timeoutMs - The rename retention window in milliseconds.
	 */
	configureRenameTimeout(timeoutMs: number): void {
		if (timeoutMs > this.#vacatedRetentionMs) { this.#vacatedRetentionMs = timeoutMs }
	}

	/**
	 * Checks whether an inode stopped backing a tracked path within the last `windowMs` milliseconds.
	 * @param inodeNumber - The inode to check.
	 * @param windowMs - The look-back window in milliseconds.
	 * @returns True when the inode was vacated inside the window.
	 */
	wasVacatedWithin(inodeNumber: InodeNumber, windowMs: number): boolean {
		this.configureRenameTimeout(windowMs);

		const vacatedAt = this.#vacatedInodes.get(inodeNumber);

		return vacatedAt !== undefined && performance.now() - vacatedAt <= windowMs;
	}

	/**
	 * Builds the {@link targetInodes} key for an event and path.
	 * @param event - The file system event.
	 * @param targetPath - The path.
	 * @returns The composite key.
	 */
	static #inodeKey(event: FileSystemEvent, targetPath: Path): string {
		return `${event}\0${targetPath}`;
	}

	/**
	 * Updates the file system state for a specific path.
	 * @param targetPath - The path to update.
	 * @param options - Optional stat cancellation signal/timeout and symlink handling.
	 * @returns The file system events that occurred, each paired with the stats to emit it with.
	 */
	async update(targetPath: Path, options?: StateUpdateOptions): Promise<StateEvent[]> {
		const generation = this.#generation;
		let nextStats: WatchrStats | undefined;

		try { nextStats = await this.#getStats(targetPath, options) } catch (error: unknown) {
			if (generation !== this.#generation) { return [] }

			throw error;
		}

		if (generation !== this.#generation) { return [] }

		const events = this.#determineEvents(this.#stats.get(targetPath), nextStats);

		this.#updateStats(targetPath, nextStats);
		this.#updateInodes(targetPath, events);

		return events;
	}

	/**
	 * Determines what events occurred based on previous and current stats.
	 * @param previousStats - The previous stats for the path.
	 * @param nextStats - The current stats for the path.
	 * @returns An array of events with their associated stats.
	 */
	#determineEvents(previousStats?: WatchrStats, nextStats?: WatchrStats): StateEvent[] {
		// Extract file type information once
		const wasFile = previousStats?.isFile() ?? false;
		const isFile = nextStats?.isFile() ?? false;

		// Use switch on 4-bit pattern: hasOld(3) | hasNew(2) | wasFile(1) | isFile(0)
		switch ((previousStats ? 8 : 0) | (nextStats ? 4 : 0) | (wasFile ? 2 : 0) | (isFile ? 1 : 0)) {
			// New additions (01xx) - no old, has new
			case 4: return [{ type: FileSystemEvent.ADD_DIR, stats: nextStats! }];
			case 5: return [{ type: FileSystemEvent.ADD, stats: nextStats! }];
			// Removals (10xx) - has old, no new
			case 8: return [{ type: FileSystemEvent.UNLINK_DIR, stats: previousStats! }];
			case 10: return [{ type: FileSystemEvent.UNLINK, stats: previousStats! }];
			// Changes/replacements (11xx) - has old, has new
			case 15: return previousStats!.equals(nextStats!) ? [] : [{ type: FileSystemEvent.CHANGE, stats: nextStats! }];
			// File to directory (1110)
			case 14: return [ { type: FileSystemEvent.UNLINK, stats: previousStats! }, { type: FileSystemEvent.ADD_DIR, stats: nextStats! } ];
			// Directory to file (1101)
			case 13: return [ { type: FileSystemEvent.UNLINK_DIR, stats: previousStats! }, { type: FileSystemEvent.ADD, stats: nextStats! } ];
			// Directory to directory (1100): only a swapped inode is a replacement; mtime/ctime churn from children is not an event
			case 12: return previousStats!.inodeNumber === nextStats!.inodeNumber ? [] : [ { type: FileSystemEvent.UNLINK_DIR, stats: previousStats! }, { type: FileSystemEvent.ADD_DIR, stats: nextStats! } ];
			// No change (0000) - no old, no new
			default: return [];
		}
	}

	/**
	 * Updates inode information for all determined events.
	 * @param targetPath - The path to update inodes for.
	 * @param events - The events with their associated stats.
	 */
	#updateInodes(targetPath: Path, events: StateEvent[]) {
		for (const event of events) { this.#updateInode(targetPath, event.type, event.stats) }
	}

	/**
	 * Resets the file system poller state.
	 */
	reset(): void {
		this.#generation++;
		this.#paths.clear();
		this.#stats.clear();
		this.#targetInodes.clear();
		this.#vacatedInodes.clear();
	}

	/**
	 * Gets the stats for a specific path. Regular paths cost a single `stat`; the extra `lstat` runs only for an
	 * untracked path under `followSymlinks: false`, so a new symlink can be dropped instead of tracked as its target.
	 * @param targetPath - The path to get the stats for.
	 * @param options - Optional stat cancellation signal/timeout and symlink handling.
	 * @returns The stats for the path, or undefined if not found (or dropped).
	 */
	async #getStats(targetPath: Path, options?: StateUpdateOptions) {
		const stats = await FileSystem.getStats(targetPath, options);

		if (!stats || !(stats.isFile() || stats.isDirectory())) { return }

		const previousStats = this.#stats.get(targetPath);

		if (previousStats === undefined && options?.followSymlinks === false && await FileSystem.isSymbolicLink(targetPath, options.sync === true)) { return }

		// The symlink flag is sticky for a tracked path: live polls `stat()` the target and cannot see the link itself.
		return WatchrStats.fromStats(stats, options?.isSymbolicLink === true || (previousStats !== undefined && previousStats.isSymbolicLink()));
	}

	/**
	 * Updates the inode information for a specific path.
	 * @param targetPath - The path to update.
	 * @param event - The file system event that occurred.
	 * @param stats - The stats for the path.
	 */
	#updateInode(targetPath: Path, event: FileSystemEvent, stats: WatchrStats) {
		this.#targetInodes.put(FileSystemStateManager.#inodeKey(event, targetPath), { inodeNumber: stats.inodeNumber, inodeType: stats.isFile() ? InodeType.FILE : InodeType.DIR });
	}

	/**
	 * Updates the file system state for a specific path.
	 * @param targetPath - The path to update.
	 * @param stats - The new stats for the path.
	 */
	#updateStats(targetPath: Path, stats?: WatchrStats) {
		const previousStats = this.#stats.get(targetPath);

		if (previousStats && (!stats || previousStats.inodeNumber !== stats.inodeNumber)) {
			this.#paths.deleteValue(previousStats.inodeNumber, targetPath);
			this.#recordVacated(previousStats.inodeNumber);
		}

		if (stats) {
			this.#paths.set(stats.inodeNumber, targetPath);
			this.#stats.set(targetPath, stats);
		} else {
			this.#stats.delete(targetPath);
		}
	}

	/**
	 * Records that an inode lost a tracked path, pruning entries past the retention window or the size cap.
	 * @param inodeNumber - The vacated inode.
	 */
	#recordVacated(inodeNumber: InodeNumber) {
		const now = performance.now();

		this.#vacatedInodes.delete(inodeNumber);
		this.#vacatedInodes.set(inodeNumber, now);

		for (const [ oldestInode, vacatedAt ] of this.#vacatedInodes) {
			if (now - vacatedAt <= this.#vacatedRetentionMs && this.#vacatedInodes.size <= FileSystemStateManager.#maxTrackedEventInodes) { break }

			this.#vacatedInodes.delete(oldestInode);
		}
	}
}

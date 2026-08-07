import { SetMultiMap } from './set-multi-map';
import { FileSystem } from './file-system';
import { WatchrStats } from './watchr-stats';
import { FileSystemEvent, InodeType } from './constants';
import type { InodeNumber, Path } from './@types';

type InodeEntry = { event: FileSystemEvent, targetPath: Path, inodeNumber: InodeNumber, inodeType: InodeType };

/** Polls the file system for changes */
export class FileSystemStateManager {
	private static readonly maxTrackedEventInodes: number = 50000;
	private readonly targetInodes = new Map<FileSystemEvent, Map<Path, InodeEntry>>();
	/** Insertion-ordered LRU view over the entries held by {@link targetInodes}. */
	private readonly targetInodeOrder = new Set<InodeEntry>();
	private readonly _paths = new SetMultiMap<InodeNumber, Path>();
	private readonly _stats = new Map<Path, WatchrStats>();

	/**
	 * Gets the paths being watched.
	 * @returns A set multi-map of paths being watched.
	 */
	get paths(): SetMultiMap<InodeNumber, Path> {
		return this._paths;
	}

	/**
	 * Gets the stats for the paths being watched.
	 * @returns A map of paths to their stats.
	 */
	get stats(): Map<Path, WatchrStats> {
		return this._stats;
	}

	/**
	 * Gets the inode number for a specific path and event.
	 * @param targetPath - The path to get the inode number for.
	 * @param event - The file system event to check.
	 * @param type - The inode type to check.
	 * @returns The inode number if it exists, otherwise undefined.
	 */
	getInodeNumber(targetPath: Path, event: FileSystemEvent, type?: InodeType): InodeNumber | undefined {
		const entry = this.targetInodes.get(event)?.get(targetPath);

		if (entry === undefined) { return undefined }

		return type !== undefined && entry.inodeType !== type ? undefined : entry.inodeNumber;
	}

	/**
	 * Updates the file system state for a specific path.
	 * @param targetPath - The path to update.
	 * @returns A list of file system events that occurred.
	 */
	async update(targetPath: Path): Promise<FileSystemEvent[]> {
		const nextStats = await this.getStats(targetPath);
		const events = this.determineEvents(this._stats.get(targetPath), nextStats);

		this.updateStats(targetPath, nextStats);
		this.updateInodes(targetPath, events);

		return events.map((event) => event.type);
	}

	/**
	 * Determines what events occurred based on previous and current stats.
	 * @param previousStats - The previous stats for the path.
	 * @param nextStats - The current stats for the path.
	 * @returns An array of events with their associated stats.
	 */
	private determineEvents(previousStats?: WatchrStats, nextStats?: WatchrStats): Array<{type: FileSystemEvent, stats: WatchrStats}> {
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
			// Directory to directory (1100)
			case 12: return [ { type: FileSystemEvent.UNLINK_DIR, stats: previousStats! }, { type: FileSystemEvent.ADD_DIR, stats: nextStats! } ];
			// No change (0000) - no old, no new
			default: return [];
		}
	}

	/**
	 * Updates inode information for all determined events.
	 * @param targetPath - The path to update inodes for.
	 * @param events - The events with their associated stats.
	 */
	private updateInodes(targetPath: Path, events: Array<{type: FileSystemEvent, stats: WatchrStats}>) {
		for (const event of events) {
			this.updateInode(targetPath, event.type, event.stats);
		}
	}

	/**
	 * Resets the file system poller state.
	 */
	reset(): void {
		this._paths.clear();
		this._stats.clear();
		this.targetInodes.clear();
		this.targetInodeOrder.clear();
	}

	/**
	 * Gets the stats for a specific path.
	 * @param targetPath - The path to get the stats for.
	 * @returns The stats for the path, or undefined if not found.
	 */
	private async getStats(targetPath: Path) {
		const stats = await FileSystem.getStats(targetPath);

		if (!stats || !(stats.isFile() || stats.isDirectory())) { return }

		return new WatchrStats(stats);
	}

	/**
	 * Updates the inode information for a specific path.
	 * @param targetPath - The path to update.
	 * @param event - The file system event that occurred.
	 * @param stats - The stats for the path.
	 */
	private updateInode(targetPath: Path, event: FileSystemEvent, stats: WatchrStats) {
		let eventInodes = this.targetInodes.get(event);

		if (eventInodes === undefined) { this.targetInodes.set(event, eventInodes = new Map<Path, InodeEntry>()) }

		const inodeType = stats.isFile() ? InodeType.FILE : InodeType.DIR;
		const existingEntry = eventInodes.get(targetPath);

		if (existingEntry !== undefined) {
			existingEntry.inodeNumber = stats.inodeNumber;
			existingEntry.inodeType = inodeType;
			// Re-insert to move the entry to the most-recently-used end of the set.
			this.targetInodeOrder.delete(existingEntry);
			this.targetInodeOrder.add(existingEntry);

			return;
		}

		const entry: InodeEntry = { event, targetPath, inodeNumber: stats.inodeNumber, inodeType };

		eventInodes.set(targetPath, entry);
		this.targetInodeOrder.add(entry);
		this.pruneTrackedInodes();
	}

	/**
	 * Prunes tracked inode events to keep memory bounded in long-running processes.
	 */
	private pruneTrackedInodes() {
		while (this.targetInodeOrder.size > FileSystemStateManager.maxTrackedEventInodes) {
			const oldestEntry = this.targetInodeOrder.values().next().value;

			if (oldestEntry === undefined) { break }

			this.targetInodeOrder.delete(oldestEntry);

			const eventInodes = this.targetInodes.get(oldestEntry.event);

			if (eventInodes === undefined) { continue }

			eventInodes.delete(oldestEntry.targetPath);

			if (eventInodes.size === 0) { this.targetInodes.delete(oldestEntry.event) }
		}
	}

	/**
	 * Updates the file system state for a specific path.
	 * @param targetPath - The path to update.
	 * @param stats - The new stats for the path.
	 */
	private updateStats(targetPath: Path, stats?: WatchrStats) {
		if (stats) {
			this._paths.set(stats.inodeNumber, targetPath);
			this._stats.set(targetPath, stats);
		} else {
			this._paths.deleteValue(this._stats.get(targetPath)?.inodeNumber ?? -1, targetPath);
			this._stats.delete(targetPath);
		}
	}
}
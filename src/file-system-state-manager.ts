import { SetMultiMap } from './set-multi-map';
import { FileSystem } from './file-system';
import { WatchrStats } from './watchr-stats';
import { FileSystemEvent, InodeType } from './constants';
import type { InodeNumber, Path } from './@types';

type EventInodeRecord = Partial<Record<FileSystemEvent, Record<Path, [InodeNumber, InodeType]>>>;

/** Polls the file system for changes */
export class FileSystemStateManager {
	private static readonly maxTrackedEventInodes: number = 50000;
	private readonly targetInodes: EventInodeRecord = {};
	private readonly targetInodeOrder = new Map<string, { event: FileSystemEvent, targetPath: Path }>();
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
		const [ inodeNumber, inodeType ] = this.targetInodes[event]?.[targetPath] ?? [];

		return type && inodeType !== type ? undefined : inodeNumber;
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
			case 15: return [{ type: FileSystemEvent.CHANGE, stats: nextStats! }];
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
		for (const [ event, eventInodes ] of Object.entries(this.targetInodes) as Array<[FileSystemEvent, Record<Path, [InodeNumber, InodeType]>]>) {
			if (!eventInodes) { continue }

			for (const targetPath of Object.keys(eventInodes)) {
				delete eventInodes[targetPath];
			}

			delete this.targetInodes[event];
		}

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
		const eventInodes = this.targetInodes[event] ??= {};
		eventInodes[targetPath] = [ stats.inodeNumber, stats.isFile() ? InodeType.FILE : InodeType.DIR ];

		const inodeEventKey = `${event}:${targetPath}`;
		if (this.targetInodeOrder.has(inodeEventKey)) {
			this.targetInodeOrder.delete(inodeEventKey);
		}

		this.targetInodeOrder.set(inodeEventKey, { event, targetPath });
		this.pruneTrackedInodes();
	}

	/**
	 * Prunes tracked inode events to keep memory bounded in long-running processes.
	 */
	private pruneTrackedInodes() {
		while (this.targetInodeOrder.size > FileSystemStateManager.maxTrackedEventInodes) {
			const oldestKey = this.targetInodeOrder.keys().next().value;

			if (!oldestKey) { break }

			const oldestEntry = this.targetInodeOrder.get(oldestKey);
			this.targetInodeOrder.delete(oldestKey);

			if (!oldestEntry) { continue }

			const eventInodes = this.targetInodes[oldestEntry.event];
			if (!eventInodes) { continue }

			delete eventInodes[oldestEntry.targetPath];

			if (!Object.keys(eventInodes).length) {
				delete this.targetInodes[oldestEntry.event];
			}
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
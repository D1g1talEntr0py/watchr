import { resolve } from 'node:path';
import type { LockResolver } from './lock-resolver';
import { InodeType, FileSystemEvent, renameTimeout, DirectoryEvent, FileEvent } from './constants';
import { FileSystemLocker } from './file-system-locker';
import { FileSystemStateManager } from './file-system-state-manager';
import type { WatchrStats } from './watchr-stats';
import type { InodeNumber, LockEvent, Path, TargetEventEmitter } from './@types/index';

type LockConfig = {
	inodeNumber?: InodeNumber,
	targetPath: Path,
	stats: WatchrStats,
	fileSystemLocker: FileSystemLocker,
	lockEvent: LockEvent
};

type AnnouncedTarget = {
	inodeNumber: InodeNumber,
	expiresAt: number
};

/**
 * Handles file rename events
 * @internal
 */
export class FileRenameHandler {
	readonly #emitEvent: TargetEventEmitter;
	readonly #emitError: (error: unknown) => boolean;
	readonly #fileLocks: FileSystemLocker;
	readonly #directoryLocks: FileSystemLocker;
	readonly #fileSystemStateManager: FileSystemStateManager;
	readonly #lockResolver: LockResolver;
	readonly #canonicalChangedPathsCache: WeakMap<ReadonlySet<Path>, ReadonlySet<Path>>;
	/** Paths whose ADD is held by a delayed lock and has not been emitted yet, mapped to a silent cancel. */
	readonly #pendingAdds: Map<Path, () => void>;
	/** Rename destinations already emitted, retained until the counterpart notification arrives or expires. */
	readonly #announcedTargets: Map<Path, AnnouncedTarget>;
	static readonly #maxAnnouncedTargets: number = 50000;

	/**
	 * Creates an instance of FileRenameHandler.
	 * @param emitEvent - The event emitter to use for emitting events.
	 * @param emitError - The error emitter to use for reporting internal failures.
	 * @param lockResolver - The resolver used to coordinate delayed lock settlement.
	 */
	constructor(emitEvent: TargetEventEmitter, emitError: (error: unknown) => boolean, lockResolver: LockResolver) {
		this.#emitEvent = emitEvent;
		this.#emitError = emitError;
		this.#fileLocks = new FileSystemLocker();
		this.#directoryLocks = new FileSystemLocker();
		this.#fileSystemStateManager = new FileSystemStateManager();
		this.#lockResolver = lockResolver;
		this.#canonicalChangedPathsCache = new WeakMap();
		this.#pendingAdds = new Map();
		this.#announcedTargets = new Map();
	}

	/**
	 * @returns The file system state manager.
	 */
	get fileStateManager(): FileSystemStateManager {
		return this.#fileSystemStateManager;
	}

	/**
	 * Gets the lock target event for a file system event.
	 * @param event - The file system event.
	 * @param targetPath - The target path of the event.
	 * @param stats - Stats to emit the event with (previous stats for unlinks, next stats for adds).
	 * @param timeout - The timeout duration in milliseconds.
	 * @param changedPaths - Paths that already received a direct CHANGE in the same batch, excluded from rename-sibling correlation.
	 * @returns void
	 */
	getLockTargetEvent(event: FileSystemEvent, targetPath: Path, stats: WatchrStats, timeout?: number, changedPaths?: ReadonlySet<Path>): void {
		const canonicalChangedPaths = this.#getCanonicalChangedPaths(changedPaths);

		switch (event) {
			case FileSystemEvent.ADD: return this.#processLock(targetPath, event, stats, InodeType.FILE, 'add', timeout, canonicalChangedPaths);
			case FileSystemEvent.ADD_DIR: return this.#processLock(targetPath, event, stats, InodeType.DIR, 'add', timeout, canonicalChangedPaths);
			case FileSystemEvent.UNLINK: return this.#processLock(targetPath, event, stats, InodeType.FILE, 'unlink', timeout, canonicalChangedPaths);
			case FileSystemEvent.UNLINK_DIR: return this.#processLock(targetPath, event, stats, InodeType.DIR, 'unlink', timeout, canonicalChangedPaths);
		}
	}

	/**
	 * Routes a CHANGE through the rename handler so it cannot escape ahead of a pending ADD for the same path.
	 * While the ADD is still held by a lock the change is absorbed: the eventual `add` is emitted with the
	 * newest stats, and a following `unlink` cancels both silently (transient file).
	 * @param targetPath - The path that changed.
	 * @param stats - The stats observed after the change.
	 */
	handleChange(targetPath: Path, stats: WatchrStats): void {
		if (this.#pendingAdds.has(targetPath)) { return }

		this.#emitEvent(FileSystemEvent.CHANGE, targetPath, stats);
	}

	/**
	 * Augments a changed-paths set with the canonical form of each path, cached per batch set.
	 * @param changedPaths - Paths that already emitted a direct CHANGE in the current batch.
	 * @returns A set containing both raw and canonical forms, or undefined when no set was provided.
	 */
	#getCanonicalChangedPaths(changedPaths?: ReadonlySet<Path>): ReadonlySet<Path> | undefined {
		if (changedPaths === undefined) { return undefined }

		let canonicalChangedPaths = this.#canonicalChangedPathsCache.get(changedPaths);

		if (canonicalChangedPaths === undefined) {
			const augmentedPaths = new Set<Path>();

			for (const changedPath of changedPaths) {
				augmentedPaths.add(changedPath);
				augmentedPaths.add(resolve(changedPath));
			}

			canonicalChangedPaths = augmentedPaths;
			this.#canonicalChangedPathsCache.set(changedPaths, canonicalChangedPaths);
		}

		return canonicalChangedPaths;
	}

	/**
	 * Processes a lock operation for both add and unlink events.
	 * @param targetPath - The target path.
	 * @param event - The file system event.
	 * @param stats - Stats to emit the event with.
	 * @param inodeType - The inode type (file or directory).
	 * @param operation - Whether this is an 'add' or 'unlink' operation.
	 * @param timeout - The timeout duration in milliseconds.
	 * @param changedPaths - Paths that already received a direct CHANGE in the same batch, excluded from rename-sibling correlation.
	 */
	#processLock(targetPath: Path, event: FileSystemEvent, stats: WatchrStats, inodeType: InodeType, operation: 'add' | 'unlink', timeout?: number, changedPaths?: ReadonlySet<Path>) {
		const lockConfig: LockConfig = {
			targetPath,
			stats,
			lockEvent: inodeType === InodeType.FILE ? FileEvent : DirectoryEvent,
			fileSystemLocker: inodeType === InodeType.FILE ? this.#fileLocks : this.#directoryLocks
		};

		const inodeNumber = this.#fileSystemStateManager.getInodeNumber(targetPath, event, inodeType);
		if (inodeNumber !== undefined) { lockConfig.inodeNumber = inodeNumber }

		if (operation === 'add') {
			this.#addLock(lockConfig, timeout, changedPaths);
		} else {
			this.#unlinkLock(lockConfig, timeout, changedPaths);
		}
	}

	/**
	 * Resets the lock resolver.
	 */
	reset(): void {
		this.#lockResolver.reset();
		this.#fileSystemStateManager.reset();
		this.#directoryLocks.reset();
		this.#fileLocks.reset();
		this.#pendingAdds.clear();
		this.#announcedTargets.clear();
	}

	/**
	 * Adds a lock.
	 * @param lockConfig - The lock configuration.
	 * @param timeout - The timeout duration in milliseconds.
	 * @param changedPaths - Paths that already received a direct CHANGE in the same batch, excluded from rename-sibling correlation.
	 * @returns void
	 */
	#addLock({ inodeNumber, targetPath, stats, lockEvent, fileSystemLocker }: LockConfig, timeout: number = renameTimeout, changedPaths?: ReadonlySet<Path>) {
		if (inodeNumber !== undefined && this.#consumeAnnouncedTarget(targetPath, inodeNumber)) { return }

		if (inodeNumber !== undefined) {
			const previousTargetPath = this.#findSiblingPath(inodeNumber, targetPath);

			if (previousTargetPath !== undefined && !this.#hasChangedPath(changedPaths, previousTargetPath)) {
				this.#emitEvent(lockEvent.rename, previousTargetPath, stats, targetPath);
				this.#announceTarget(targetPath, inodeNumber, timeout);

				return;
			}
		}

		const immediate = timeout <= 0;

		/** Emits the appropriate events based on the lock state. */
		const emit = () => {
			// Maybe this is actually a rename in a case-insensitive filesystem
			const otherPath = inodeNumber !== undefined ? this.#findSiblingPath(inodeNumber, targetPath) : undefined;
			// Prefer the newest tracked stats so a change absorbed while the add was pending is reflected.
			const currentStats = this.#currentStats(targetPath, stats);

			if (otherPath && !this.#hasChangedPath(changedPaths, otherPath)) {
				this.#emitEvent(lockEvent.rename, otherPath, currentStats, targetPath);
			} else {
				this.#emitEvent(lockEvent.add, targetPath, currentStats);
			}
		};

		if (!inodeNumber) { return emit() }

		const pendingUnlink = fileSystemLocker.getUnlink(inodeNumber);

		if (pendingUnlink !== undefined) {
			const previousTargetPath = pendingUnlink();
			fileSystemLocker.removeUnlink(inodeNumber);

			if (targetPath === previousTargetPath) {
				this.#emitReplacementChange(lockEvent, targetPath);
			} else {
				this.#emitEvent(lockEvent.rename, previousTargetPath, stats, targetPath);
			}

			return;
		}

		// An inode no tracked path recently gave up cannot be a rename target, so there is nothing to wait for.
		if (!this.#fileSystemStateManager.wasVacatedWithin(inodeNumber, timeout)) { return emit() }

		/** Cleans up the lock state without touching a newer lock another path registered for the same inode. */
		const cleanup = () => {
			if (fileSystemLocker.getLock(inodeNumber) === resolve) { fileSystemLocker.removeLock(inodeNumber) }

			this.#lockResolver.remove(free);
			this.#pendingAdds.delete(targetPath);
		};

		/** Frees the lock and emits the appropriate events. */
		const free = () => {
			cleanup();
			emit();
		};

		/**
		 * Resolves the lock and emits the appropriate events.
		 * @returns True if a matching unlink lock was resolved.
		 */
		const resolve = () => {
			const unlink = fileSystemLocker.getUnlink(inodeNumber);

			// No matching "unlink" lock found, skipping
			if (!unlink) { return false }

			cleanup();

			const previousTargetPath = unlink();
			if (targetPath === previousTargetPath) {
				this.#emitReplacementChange(lockEvent, targetPath);
			} else {
				this.#emitEvent(lockEvent.rename, previousTargetPath, this.#currentStats(targetPath, stats), targetPath);
			}

			return true;
		};

		fileSystemLocker.addLock(inodeNumber, resolve);

		if (resolve()) { return }

		if (immediate) {
			fileSystemLocker.removeLock(inodeNumber);
			emit();

			return;
		}

		this.#pendingAdds.set(targetPath, cleanup);
		this.#lockResolver.add(free, timeout, () => {
			try {
				free();
			} finally {
				this.#emitError(new Error('Lock resolver capacity exceeded.'));
			}
		});
	}

	/**
	 * Adds a lock.
	 * @param lockConfig - The lock configuration.
	 * @param timeout - The timeout duration in milliseconds.
	 * @param changedPaths - Paths that already received a direct CHANGE in the same batch, excluded from rename-sibling correlation.
	 * @returns void
	 */
	#unlinkLock({ inodeNumber, targetPath, stats, lockEvent, fileSystemLocker }: LockConfig, timeout: number = renameTimeout, changedPaths?: ReadonlySet<Path>) {
		const cancelPendingAdd = this.#pendingAdds.get(targetPath);

		// The path was never announced (its ADD is still held), so the pair is a transient file: drop both silently.
		if (cancelPendingAdd !== undefined) { return cancelPendingAdd() }

		if (!inodeNumber) { return this.#emitEvent(lockEvent.unlink, targetPath, stats) }

		const nextTargetPath = this.#findSiblingPath(inodeNumber, targetPath);

		if (nextTargetPath !== undefined && !this.#hasChangedPath(changedPaths, nextTargetPath)) {
			if (this.#consumeAnnouncedTarget(nextTargetPath, inodeNumber)) { return }

			// Same inode, so the unlinked path's stats are a faithful fallback when the sibling is not tracked yet.
			this.#emitEvent(lockEvent.rename, targetPath, this.#currentStats(nextTargetPath, stats), nextTargetPath);
			this.#announceTarget(nextTargetPath, inodeNumber, timeout);

			return;
		}

		const immediate = timeout <= 0;

		/** Cleans up the lock state. */
		const cleanup = () => {
			fileSystemLocker.removeUnlink(inodeNumber);
			this.#lockResolver.remove(free);
		};

		/** Frees the lock and emits the appropriate events. */
		const free = () => {
			cleanup();
			this.#emitEvent(lockEvent.unlink, targetPath, stats);
		};

		/**
		 * Overrides the unlink lock.
		 * @returns The overridden path.
		 */
		const overridden = () => {
			cleanup();
			return targetPath;
		};

		fileSystemLocker.addUnlink(inodeNumber, overridden);
		fileSystemLocker.getLock(inodeNumber)?.();

		// Resolved synchronously by an existing add lock.
		if (fileSystemLocker.getUnlink(inodeNumber) === undefined) { return }

		if (immediate && fileSystemLocker.getUnlink(inodeNumber) !== undefined) {
			fileSystemLocker.removeUnlink(inodeNumber);
			this.#emitEvent(lockEvent.unlink, targetPath, stats);

			return;
		}

		this.#lockResolver.add(free, timeout, () => {
			try {
				free();
			} finally {
				this.#emitError(new Error('Lock resolver capacity exceeded.'));
			}
		});
	}

	/**
	 * Marks a destination whose rename has already been emitted so its counterpart notification is suppressed.
	 * A pending ADD is cancelled; otherwise the mark lasts until consumed or expired.
	 * @param targetPath - The rename destination.
	 * @param inodeNumber - The inode the rename was correlated on.
	 * @param timeout - The maximum time to retain the announcement.
	 */
	#announceTarget(targetPath: Path, inodeNumber: InodeNumber, timeout: number): void {
		const cancelPendingAdd = this.#pendingAdds.get(targetPath);

		if (cancelPendingAdd !== undefined) { return cancelPendingAdd() }

		const now = performance.now();

		for (const [ path, announced ] of this.#announcedTargets) {
			if (announced.expiresAt > now) { break }

			this.#announcedTargets.delete(path);
		}

		if (this.#announcedTargets.size >= FileRenameHandler.#maxAnnouncedTargets) {
			const oldestPath = this.#announcedTargets.keys().next().value;

			if (oldestPath !== undefined) { this.#announcedTargets.delete(oldestPath) }
		}

		this.#announcedTargets.delete(targetPath);
		this.#announcedTargets.set(targetPath, { inodeNumber, expiresAt: now + Math.max(timeout, 1000) });
	}

	/**
	 * Consumes a rename announcement when the matching counterpart notification arrives.
	 * @param targetPath - The announced rename destination.
	 * @param inodeNumber - The inode associated with the announcement.
	 * @returns True when the announcement is current and matches this inode.
	 */
	#consumeAnnouncedTarget(targetPath: Path, inodeNumber: InodeNumber): boolean {
		const announced = this.#announcedTargets.get(targetPath);

		if (announced === undefined) { return false }

		this.#announcedTargets.delete(targetPath);

		return announced.inodeNumber === inodeNumber && announced.expiresAt > performance.now();
	}

	/**
	 * Finds another tracked path for the same inode.
	 * @param inodeNumber - The inode number to search for.
	 * @param targetPath - Path to exclude from matches.
	 * @returns The sibling path if found.
	 */
	#findSiblingPath(inodeNumber: number | bigint, targetPath: Path): Path | undefined {
		return this.#fileSystemStateManager.paths.find(inodeNumber, (path) => path !== targetPath);
	}

	/**
	 * Emits a CHANGE for a path whose unlink and add resolved against each other (same path, same inode),
	 * provided the path is still tracked. Directories have no change event and emit nothing.
	 * @param lockEvent - Event set for the inode type.
	 * @param targetPath - The path that was replaced in place.
	 */
	#emitReplacementChange(lockEvent: LockConfig['lockEvent'], targetPath: Path): void {
		if (lockEvent.change === undefined) { return }

		const trackedStats = this.#fileSystemStateManager.stats.get(targetPath);

		if (trackedStats !== undefined) { this.#emitEvent(lockEvent.change, targetPath, trackedStats) }
	}

	/**
	 * Returns the stats currently tracked for a path, falling back to the stats captured when the lock was created.
	 * @param targetPath - The path whose current stats are wanted.
	 * @param fallback - Stats captured at lock creation.
	 * @returns The freshest stats available for the path.
	 */
	#currentStats(targetPath: Path, fallback: WatchrStats): WatchrStats {
		return this.#fileSystemStateManager.stats.get(targetPath) ?? fallback;
	}

	/**
	 * Checks whether a path is present in a changed-paths set that holds raw and canonical forms.
	 * @param changedPaths - Augmented changed-paths set produced by getCanonicalChangedPaths.
	 * @param targetPath - Path to check.
	 * @returns True when the path is represented in the changed set.
	 */
	#hasChangedPath(changedPaths: ReadonlySet<Path> | undefined, targetPath: Path): boolean {
		if (changedPaths === undefined) { return false }

		return changedPaths.has(targetPath) || changedPaths.has(resolve(targetPath));
	}
}

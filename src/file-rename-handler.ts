import { LockResolver } from './lock-resolver';
import { InodeType, FileSystemEvent, renameTimeout, DirectoryEvent, FileEvent } from './constants';
import { FileSystemLocker } from './file-system-locker';
import { FileSystemStateManager } from './file-system-state-manager';
import type { Path, LockConfig, TargetEventEmitter } from './@types';

/** Handles file rename events */
export class FileRenameHandler {
	private readonly emitEvent: TargetEventEmitter;
	private readonly emitError: (error: unknown) => boolean;
	private readonly fileLocks: FileSystemLocker;
	private readonly directoryLocks: FileSystemLocker;
	private readonly fileSystemStateManager: FileSystemStateManager;
	private readonly lockResolver: LockResolver;

	/**
	 * Creates an instance of FileRenameHandler.
	 * @param emitEvent - The event emitter to use for emitting events.
	 * @param emitError - The error emitter to use for reporting internal failures.
	 */
	constructor(emitEvent: TargetEventEmitter, emitError: (error: unknown) => boolean = () => false) {
		this.emitEvent = emitEvent;
		this.emitError = emitError;
		this.fileLocks = new FileSystemLocker();
		this.directoryLocks = new FileSystemLocker();
		this.fileSystemStateManager = new FileSystemStateManager();
		this.lockResolver = new LockResolver();
	}

	/**
	 * @returns The file system state manager.
	 */
	get fileStateManager(): FileSystemStateManager {
		return this.fileSystemStateManager;
	}

	/**
	 * Gets the lock target event for a file system event.
	 * @param event - The file system event.
	 * @param targetPath - The target path of the event.
	 * @param timeout - The timeout duration in milliseconds.
	 * @returns void
	 */
	getLockTargetEvent(event: FileSystemEvent, targetPath: Path, timeout?: number): void {
		switch (event) {
			case FileSystemEvent.ADD: return this.processLock(targetPath, event, InodeType.FILE, 'add', timeout);
			case FileSystemEvent.ADD_DIR: return this.processLock(targetPath, event, InodeType.DIR, 'add', timeout);
			case FileSystemEvent.UNLINK: return this.processLock(targetPath, event, InodeType.FILE, 'unlink', timeout);
			case FileSystemEvent.UNLINK_DIR: return this.processLock(targetPath, event, InodeType.DIR, 'unlink', timeout);
		}
	}

	/**
	 * Processes a lock operation for both add and unlink events.
	 * @param targetPath - The target path.
	 * @param event - The file system event.
	 * @param inodeType - The inode type (file or directory).
	 * @param operation - Whether this is an 'add' or 'unlink' operation.
	 * @param timeout - The timeout duration in milliseconds.
	 */
	private processLock(targetPath: Path, event: FileSystemEvent, inodeType: InodeType, operation: 'add' | 'unlink', timeout?: number) {
		const inodeNumber = this.fileSystemStateManager.getInodeNumber(targetPath, event, inodeType);
		const lockConfig = {
			targetPath,
			lockEvent: inodeType === InodeType.FILE ? FileEvent : DirectoryEvent,
			fileSystemLocker: inodeType === InodeType.FILE ? this.fileLocks : this.directoryLocks,
			...(inodeNumber === undefined ? {} : { inodeNumber }),
		};

		if (operation === 'add') {
			this.addLock(lockConfig, timeout);
		} else {
			this.unlinkLock(lockConfig, timeout);
		}
	}

	/**
	 * Resets the lock resolver.
	 */
	reset(): void {
		this.lockResolver.reset();
		this.fileSystemStateManager.reset();
		this.directoryLocks.reset();
		this.fileLocks.reset();
	}

	/**
	 * Adds a lock.
	 * @param lockConfig - The lock configuration.
	 * @param timeout - The timeout duration in milliseconds.
	 * @returns void
	 */
	private addLock({ inodeNumber, targetPath, lockEvent, fileSystemLocker }: LockConfig, timeout: number = renameTimeout) {
		if (inodeNumber !== undefined) {
			const previousTargetPath = this.findSiblingPath(inodeNumber, targetPath);

			if (previousTargetPath !== undefined) {
				this.emitEvent(lockEvent.rename, previousTargetPath, targetPath);
				return;
			}
		}

		const immediate = timeout <= 0;

		/** Emits the appropriate events based on the lock state. */
		const emit = () => {
			// Maybe this is actually a rename in a case-insensitive filesystem
			const otherPath = inodeNumber !== undefined ? this.findSiblingPath(inodeNumber, targetPath) : undefined;

			if (otherPath) {
				this.emitEvent(lockEvent.rename, otherPath, targetPath);
			} else {
				this.emitEvent(lockEvent.add, targetPath);
			}
		};

		if (!inodeNumber) { return emit() }

		const pendingUnlink = fileSystemLocker.getUnlink(inodeNumber);

		if (pendingUnlink !== undefined) {
			const previousTargetPath = pendingUnlink();
			fileSystemLocker.removeUnlink(inodeNumber);

			if (targetPath === previousTargetPath) {
				if (lockEvent.change && this.fileSystemStateManager.stats.has(targetPath)) {
					this.emitEvent(lockEvent.change, targetPath);
				}
			} else {
				this.emitEvent(lockEvent.rename, previousTargetPath, targetPath);
			}

			return;
		}

		/** Cleans up the lock state. */
		const cleanup = () => {
			fileSystemLocker.removeLock(inodeNumber);
			this.lockResolver.remove(free);
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
				if (lockEvent.change && this.fileSystemStateManager.stats.has(targetPath)) {
					this.emitEvent(lockEvent.change, targetPath);
				}
			} else {
				this.emitEvent(lockEvent.rename, previousTargetPath, targetPath);
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

		this.lockResolver.add(free, timeout, () => this.emitError(new Error('🚨 Lock resolver capacity exceeded.')));
	}

	/**
	 * Adds a lock.
	 * @param lockConfig - The lock configuration.
	 * @param timeout - The timeout duration in milliseconds.
	 * @returns void
	 */
	private unlinkLock({ inodeNumber, targetPath, lockEvent, fileSystemLocker }: LockConfig, timeout: number = renameTimeout) {
		if (!inodeNumber) { return this.emitEvent(lockEvent.unlink, targetPath) }

		const nextTargetPath = this.findSiblingPath(inodeNumber, targetPath);

		if (nextTargetPath !== undefined) {
			this.emitEvent(lockEvent.rename, targetPath, nextTargetPath);
			return;
		}

		const immediate = timeout <= 0;

		/** Cleans up the lock state. */
		const cleanup = () => {
			fileSystemLocker.removeUnlink(inodeNumber);
			this.lockResolver.remove(free);
		};

		/** Frees the lock and emits the appropriate events. */
		const free = () => {
			cleanup();
			this.emitEvent(lockEvent.unlink, targetPath);
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
			this.emitEvent(lockEvent.unlink, targetPath);

			return;
		}

		this.lockResolver.add(free, timeout, () => this.emitError(new Error('🚨 Lock resolver capacity exceeded.')));
	}

	/**
	 * Finds another tracked path for the same inode.
	 * @param inodeNumber - The inode number to search for.
	 * @param targetPath - Path to exclude from matches.
	 * @returns The sibling path if found.
	 */
	private findSiblingPath(inodeNumber: number | bigint, targetPath: Path): Path | undefined {
		return this.fileSystemStateManager.paths.find(inodeNumber, (path) => path !== targetPath);
	}
}
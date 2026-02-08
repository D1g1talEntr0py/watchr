import { LockResolver } from './lock-resolver';
import { InodeType, FileSystemEvent, renameTimeout, DirectoryEvent, FileEvent } from './constants';
import { FileSystemLocker } from './file-system-locker';
import { FileSystemStateManager } from './file-system-state-manager';
import type { Path, LockConfig, TargetEventEmitter } from './@types';

/** Handles file rename events */
export class FileRenameHandler {
	private readonly emitEvent: TargetEventEmitter;
	private readonly fileLocks: FileSystemLocker;
	private readonly directoryLocks: FileSystemLocker;
	private readonly fileSystemStateManager: FileSystemStateManager;

	/**
	 * Creates an instance of FileRenameHandler.
	 * @param emitEvent - The event emitter to use for emitting events.
	 */
	constructor(emitEvent: TargetEventEmitter) {
		this.emitEvent = emitEvent;
		this.fileLocks = new FileSystemLocker();
		this.directoryLocks = new FileSystemLocker();
		this.fileSystemStateManager = new FileSystemStateManager();
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
	private processLock(targetPath: Path, event: FileSystemEvent, inodeType: InodeType, operation: 'add' | 'unlink', timeout?: number): void {
		const inodeNumber = this.fileSystemStateManager.getInodeNumber(targetPath, event, inodeType);
		const lockConfig = { inodeNumber, targetPath, lockEvent: inodeType === InodeType.FILE ? FileEvent : DirectoryEvent, fileSystemLocker: inodeType === InodeType.FILE ? this.fileLocks : this.directoryLocks };

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
	private addLock({ inodeNumber, targetPath, lockEvent, fileSystemLocker }: LockConfig, timeout: number = renameTimeout): void {
		/** Emits the appropriate events based on the lock state. */
		const emit = (): void => {
			// Maybe this is actually a rename in a case-insensitive filesystem
			const otherPath = this.fileSystemStateManager.paths.find(inodeNumber ?? -1, (path) => path !== targetPath);

			if (otherPath) {
				this.emitEvent(lockEvent.rename, otherPath, targetPath);
			} else {
				this.emitEvent(lockEvent.add, targetPath);
			}
		};

		if (!inodeNumber) { return emit() }

		/** Cleans up the lock state. */
		const cleanup = (): void => {
			fileSystemLocker.removeLock(inodeNumber);
			LockResolver.remove(free);
		};

		/** Frees the lock and emits the appropriate events. */
		const free = (): void => {
			cleanup();
			emit();
		};

		LockResolver.add(free, timeout);

		/** Resolves the lock and emits the appropriate events. */
		const resolve = (): void => {
			const unlink = fileSystemLocker.getUnlink(inodeNumber);

			// No matching "unlink" lock found, skipping
			if (!unlink) { return }

			cleanup();

			const previousTargetPath = unlink();
			if (targetPath === previousTargetPath) {
				if (lockEvent.change && this.fileSystemStateManager.stats.has(targetPath)) {
					this.emitEvent(lockEvent.change, targetPath);
				}
			} else {
				this.emitEvent(lockEvent.rename, previousTargetPath, targetPath);
			}
		};

		fileSystemLocker.addLock(inodeNumber, resolve);

		resolve();
	}

	/**
	 * Adds a lock.
	 * @param lockConfig - The lock configuration.
	 * @param timeout - The timeout duration in milliseconds.
	 * @returns void
	 */
	private unlinkLock({ inodeNumber, targetPath, lockEvent, fileSystemLocker }: LockConfig, timeout: number = renameTimeout): void {
		if (!inodeNumber) { return this.emitEvent(lockEvent.unlink, targetPath) }

		/** Cleans up the lock state. */
		const cleanup = (): void => {
			fileSystemLocker.removeUnlink(inodeNumber);
			LockResolver.remove(free);
		};

		/** Frees the lock and emits the appropriate events. */
		const free = (): void => {
			cleanup();
			this.emitEvent(lockEvent.unlink, targetPath);
		};

		LockResolver.add(free, timeout);

		/**
		 * Overrides the unlink lock.
		 * @returns The overridden path.
		 */
		const overridden = (): Path => {
			cleanup();
			return targetPath;
		};

		fileSystemLocker.addUnlink(inodeNumber, overridden);
		fileSystemLocker.getLock(inodeNumber)?.();
	}
}
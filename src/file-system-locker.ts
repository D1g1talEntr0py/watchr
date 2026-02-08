import type { Callable, InodeNumber, Path, Producer } from './@types';

/** A class that manages file system locks for file and directory operations. */
export class FileSystemLocker {
	private readonly add: Map<InodeNumber, Callable>;
	private readonly unlink: Map<InodeNumber, Producer<Path>>;

	constructor() {
		this.add = new Map();
		this.unlink = new Map();
	}

	/**
	 * Adds a lock for the add event to the file system locker.
	 * @param inodeNumber - The inode number to lock.
	 * @param callback - The callback to execute when the lock is released.
	 */
	addLock(inodeNumber: InodeNumber, callback: Callable): void {
		this.add.set(inodeNumber, callback);
	}

	/**
	 * Adds a lock for the unlink event to the file system locker.
	 * @param inodeNumber - The inode number to lock.
	 * @param producer - The producer to execute when the lock is released.
	 */
	addUnlink(inodeNumber: InodeNumber, producer: Producer<Path>): void {
		this.unlink.set(inodeNumber, producer);
	}

	/**
	 * Removes a lock for the add event from the file system locker.
	 * @param inodeNumber - The inode number to remove the lock from.
	 */
	removeLock(inodeNumber: InodeNumber): void {
		this.add.delete(inodeNumber);
	}

	/**
	 * Removes a lock for the unlink event from the file system locker.
	 * @param inodeNumber - The inode number to remove the lock from.
	 */
	removeUnlink(inodeNumber: InodeNumber): void {
		this.unlink.delete(inodeNumber);
	}

	/**
	 * Retrieves a lock for the add event from the file system locker.
	 * @param inodeNumber - The inode number to retrieve the lock for.
	 * @returns The callback for the lock or undefined if not found.
	 */
	getLock(inodeNumber: InodeNumber): Callable | undefined {
		return this.add.get(inodeNumber);
	}

	/**
	 * Retrieves a lock for the unlink event from the file system locker.
	 * @param inodeNumber - The inode number to retrieve the lock for.
	 * @returns The producer for the lock or undefined if not found.
	 */
	getUnlink(inodeNumber: InodeNumber): Producer<Path> | undefined {
		return this.unlink.get(inodeNumber);
	}

	/** Resets the file system locker. */
	reset(): void {
		this.add.clear();
		this.unlink.clear();
	}
}
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FileSystemLocker } from '../src/file-system-locker';
import type { Callable, InodeNumber, Path, Producer } from '../src/@types';

describe('FileSystemLocker', () => {
	let locker: FileSystemLocker;
	const inode: InodeNumber = 123;
	const callback: Callable = vi.fn();
	const producer: Producer<Path> = () => '/path/to/file';

	beforeEach(() => {
		locker = new FileSystemLocker();
		vi.clearAllMocks();
	});

	describe('constructor', () => {
		it('should initialize with empty lock and unlink maps', () => {
			// Test via public methods to avoid accessing private properties
			expect(locker.getLock(inode)).toBeUndefined();
			expect(locker.getUnlink(inode)).toBeUndefined();
		});
	});

	describe('addLock and getLock', () => {
		it('should add a lock and allow retrieving it', () => {
			locker.addLock(inode, callback);
			expect(locker.getLock(inode)).toBe(callback);
		});

		it('should return undefined for a non-existent lock', () => {
			expect(locker.getLock(999)).toBeUndefined();
		});
	});

	describe('addUnlink and getUnlink', () => {
		it('should add an unlink producer and allow retrieving it', () => {
			locker.addUnlink(inode, producer);
			expect(locker.getUnlink(inode)).toBe(producer);
		});

		it('should return undefined for a non-existent unlink producer', () => {
			expect(locker.getUnlink(999)).toBeUndefined();
		});
	});

	describe('removeLock', () => {
		it('should remove an existing lock', () => {
			locker.addLock(inode, callback);
			expect(locker.getLock(inode)).toBeDefined();
			locker.removeLock(inode);
			expect(locker.getLock(inode)).toBeUndefined();
		});

		it('should not throw when removing a non-existent lock', () => {
			expect(() => locker.removeLock(999)).not.toThrow();
		});
	});

	describe('removeUnlink', () => {
		it('should remove an existing unlink producer', () => {
			locker.addUnlink(inode, producer);
			expect(locker.getUnlink(inode)).toBeDefined();
			locker.removeUnlink(inode);
			expect(locker.getUnlink(inode)).toBeUndefined();
		});

		it('should not throw when removing a non-existent unlink producer', () => {
			expect(() => locker.removeUnlink(999)).not.toThrow();
		});
	});

	describe('reset', () => {
		it('should clear all locks and unlink producers', () => {
			locker.addLock(inode, callback);
			locker.addUnlink(inode, producer);
			locker.addLock(456, callback);
			locker.addUnlink(789, producer);

			locker.reset();

			expect(locker.getLock(inode)).toBeUndefined();
			expect(locker.getUnlink(inode)).toBeUndefined();
			expect(locker.getLock(456)).toBeUndefined();
			expect(locker.getUnlink(789)).toBeUndefined();
		});
	});
});
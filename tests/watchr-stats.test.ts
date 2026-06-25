import { describe, it, expect } from 'vitest';
import { WatchrStats } from '../src/watchr-stats';
import type { Stats } from '../src/@types';

describe('WatchrStats', () => {
	const mockStats: Stats = {
		ino: 123456n,
		size: 1024n,
		mtimeMs: 1n,
		isFile: () => true,
		isDirectory: () => false,
		isSymbolicLink: () => false,
		atimeNs: 0n,
		mtimeNs: 0n,
		ctimeNs: 0n,
		birthtimeNs: 0n,
		isBlockDevice: () => false,
		isCharacterDevice: () => false,
		isFIFO: () => false,
		isSocket: () => false,
		dev: 0n,
		mode: 0n,
		nlink: 0n,
		uid: 0n,
		gid: 0n,
		rdev: 0n,
		blksize: 0n,
		blocks: 0n,
		atimeMs: 0n,
		mtimeMs: 1n,
		ctimeMs: 0n,
		birthtimeMs: 0n,
		atime: new Date(),
		mtime: new Date(),
		ctime: new Date(),
		birthtime: new Date(),
	};

	describe('constructor', () => {
		it('should correctly initialize properties from a Stats object', () => {
			const watchrStats = new WatchrStats(mockStats);
			expect(watchrStats.inodeNumber).toBe(123456);
			expect(watchrStats.size).toBe(1024);
			expect(watchrStats.isFile()).toBe(true);
			expect(watchrStats.isDirectory()).toBe(false);
			expect(watchrStats.isSymbolicLink()).toBe(false);
		});

		it('should handle inode numbers larger than Number.MAX_SAFE_INTEGER', () => {
			const largeInodeStats: Stats = {
				...mockStats,
				ino: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
			};
			const watchrStats = new WatchrStats(largeInodeStats);
			expect(watchrStats.inodeNumber).toBe(largeInodeStats.ino);
		});
	});

	describe('inodeNumber', () => {
		it('should return the correct inode number', () => {
			const watchrStats = new WatchrStats(mockStats);
			expect(watchrStats.inodeNumber).toBe(123456);
		});
	});

	describe('size', () => {
		it('should return the correct size', () => {
			const watchrStats = new WatchrStats(mockStats);
			expect(watchrStats.size).toBe(1024);
		});
	});

	describe('modifiedTimeMs', () => {
		it('should return the correct modified time', () => {
			const watchrStats = new WatchrStats(mockStats);
			expect(watchrStats.modifiedTimeMs).toBe(1);
		});
	});

	describe('modifiedTimeNs', () => {
		it('should return the correct modified time in nanoseconds', () => {
			const watchrStats = new WatchrStats(mockStats);
			expect(watchrStats.modifiedTimeNs).toBe(0n);
		});
	});

	describe('changeTimeNs', () => {
		it('should return the correct status change time in nanoseconds', () => {
			const watchrStats = new WatchrStats(mockStats);
			expect(watchrStats.changeTimeNs).toBe(0n);
		});
	});

	describe('isFile', () => {
		it('should return true if the stats represent a file', () => {
			const watchrStats = new WatchrStats(mockStats);
			expect(watchrStats.isFile()).toBe(true);
		});

		it('should return false if the stats do not represent a file', () => {
			const notFileStats: Stats = { ...mockStats, isFile: () => false };
			const watchrStats = new WatchrStats(notFileStats);
			expect(watchrStats.isFile()).toBe(false);
		});
	});

	describe('isDirectory', () => {
		it('should return true if the stats represent a directory', () => {
			const dirStats: Stats = {
				...mockStats,
				isFile: () => false,
				isDirectory: () => true,
			};
			const watchrStats = new WatchrStats(dirStats);
			expect(watchrStats.isDirectory()).toBe(true);
		});

		it('should return false if the stats do not represent a directory', () => {
			const watchrStats = new WatchrStats(mockStats);
			expect(watchrStats.isDirectory()).toBe(false);
		});
	});

	describe('isSymbolicLink', () => {
		it('should return true if the stats represent a symbolic link', () => {
			const symlinkStats: Stats = {
				...mockStats,
				isFile: () => false,
				isSymbolicLink: () => true,
			};
			const watchrStats = new WatchrStats(symlinkStats);
			expect(watchrStats.isSymbolicLink()).toBe(true);
		});

		it('should return false if the stats do not represent a symbolic link', () => {
			const watchrStats = new WatchrStats(mockStats);
			expect(watchrStats.isSymbolicLink()).toBe(false);
		});
	});

	describe('equals', () => {
		it('should return true for identical snapshots', () => {
			const left = new WatchrStats(mockStats);
			const right = new WatchrStats({ ...mockStats });

			expect(left.equals(right)).toBe(true);
		});

		it('should return false when modified time differs', () => {
			const left = new WatchrStats(mockStats);
			const right = new WatchrStats({ ...mockStats, mtimeNs: 2n });

			expect(left.equals(right)).toBe(false);
		});

		it('should return false when status change time differs', () => {
			const left = new WatchrStats(mockStats);
			const right = new WatchrStats({ ...mockStats, ctimeNs: 2n });

			expect(left.equals(right)).toBe(false);
		});
	});
});
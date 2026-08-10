import { describe, it, expect } from 'vitest';
import { WatchrStats } from '../src/watchr-stats';
import type { Stats } from '../src/@types';

describe('WatchrStats', () => {
	const mockStats: Stats = {
		ino: 123456n,
		size: 1024n,
		isFile: () => true,
		isDirectory: () => false,
		isSymbolicLink: () => false,
		atimeNs: 0n,
		mtimeNs: 1_000_000n,
		ctimeNs: 0n,
		birthtimeNs: 0n,
		atimeInstant: Temporal.Instant.fromEpochMilliseconds(0),
		mtimeInstant: Temporal.Instant.fromEpochMilliseconds(1),
		ctimeInstant: Temporal.Instant.fromEpochMilliseconds(0),
		birthtimeInstant: Temporal.Instant.fromEpochMilliseconds(0),
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

		it('should preserve sub-millisecond precision from mtimeInstant', () => {
			const first = new WatchrStats({ ...mockStats, mtimeInstant: Temporal.Instant.from('1970-01-01T00:00:00.0010001Z') });
			const second = new WatchrStats({ ...mockStats, mtimeInstant: Temporal.Instant.from('1970-01-01T00:00:00.0010009Z') });

			expect(first.modifiedTimeMs).toBe(1.0001);
			expect(second.modifiedTimeMs).toBe(1.0009);
			expect(second.modifiedTimeMs).toBeGreaterThan(first.modifiedTimeMs);
		});

		it('should derive fractional milliseconds from mtimeInstant', () => {
			const watchrStats = new WatchrStats(({
				...mockStats,
				mtimeMs: 1.0009,
				mtimeInstant: Temporal.Instant.from('1970-01-01T00:00:00.0010009Z'),
			} as unknown) as Stats);

			expect(watchrStats.modifiedTimeMs).toBe(1.0009);
		});

		it('should derive fractional milliseconds from mtimeNs when mtimeInstant is unavailable', () => {
			const watchrStats = new WatchrStats(({
				...mockStats,
				mtimeNs: 1_000_900n,
				mtimeInstant: undefined,
			} as unknown) as Stats);

			expect(watchrStats.modifiedTimeMs).toBe(1.0009);
		});
	});

	describe('modifiedTime', () => {
		it('should return the modification instant', () => {
			const watchrStats = new WatchrStats(mockStats);
			expect(watchrStats.modifiedTime).toBe(mockStats.mtimeInstant);
		});

		it('should create the modification instant from mtimeNs when mtimeInstant is unavailable', () => {
			const watchrStats = new WatchrStats(({
				...mockStats,
				mtimeNs: 1_000_900n,
				mtimeInstant: undefined,
			} as unknown) as Stats);

			expect(watchrStats.modifiedTime).toStrictEqual(Temporal.Instant.fromEpochNanoseconds(1_000_900n));
		});
	});

	describe('changeTime', () => {
		it('should return the status change instant', () => {
			const watchrStats = new WatchrStats(mockStats);
			expect(watchrStats.changeTime).toBe(mockStats.ctimeInstant);
		});

		it('should create the status change instant from ctimeNs when ctimeInstant is unavailable', () => {
			const watchrStats = new WatchrStats(({
				...mockStats,
				ctimeNs: 2_000_100n,
				ctimeInstant: undefined,
			} as unknown) as Stats);

			expect(watchrStats.changeTime).toStrictEqual(Temporal.Instant.fromEpochNanoseconds(2_000_100n));
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
			const right = new WatchrStats({ ...mockStats, mtimeInstant: Temporal.Instant.fromEpochMilliseconds(2) });

			expect(left.equals(right)).toBe(false);
		});

		it('should return false when status change time differs', () => {
			const left = new WatchrStats(mockStats);
			const right = new WatchrStats({ ...mockStats, ctimeInstant: Temporal.Instant.fromEpochMilliseconds(2) });

			expect(left.equals(right)).toBe(false);
		});
	});

});
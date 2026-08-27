import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileSystemStateManager } from '../src/file-system-state-manager';
import { FileSystem } from '../src/file-system';
import { FileSystemEvent, InodeType } from '../src/constants';
import type { Stats } from '../src/@types';

vi.mock('../src/file-system', () => ({
  FileSystem: {
    getStats: vi.fn(),
  },
}));

const timestampStats = {
	mtimeInstant: Temporal.Instant.fromEpochMilliseconds(1),
	ctimeInstant: Temporal.Instant.fromEpochMilliseconds(1),
};

/**
 * Builds a mock stats object suitable for mocking FileSystem.getStats results.
 * @param kind - Whether the entry is a file, a directory, or an unsupported type.
 * @param overrides - Optional stat field overrides.
 * @returns A mock stats object.
 */
function createStats(kind: 'file' | 'dir' | 'other', overrides: Partial<{ ino: bigint, size: bigint, mtime: number, ctime: number }> = {}): Stats {
	const { ino = 123n, size = 100n, mtime = 1, ctime = 1 } = overrides;

	return {
		mtimeInstant: Temporal.Instant.fromEpochMilliseconds(mtime),
		ctimeInstant: Temporal.Instant.fromEpochMilliseconds(ctime),
		isFile: () => kind === 'file',
		isDirectory: () => kind === 'dir',
		isSymbolicLink: () => false,
		ino,
		size,
	} as unknown as Stats;
}

describe('FileSystemStateManager', () => {
	let fileSystemStateManager: FileSystemStateManager;

  beforeEach(() => {
		fileSystemStateManager = new FileSystemStateManager();
		vi.clearAllMocks();
  });

  describe('Initialization', () => {
    it('should initialize with empty state', () => {
			expect(fileSystemStateManager.paths.size).toBe(0);
			expect(fileSystemStateManager.stats.size).toBe(0);
    });
  });

  describe('getInodeNumber', () => {
    it('should return undefined for non-existent path', () => {
			const inodeNumber = fileSystemStateManager.getInodeNumber('/non-existent', FileSystemEvent.ADD);
      expect(inodeNumber).toBeUndefined();
    });

		it('should return inode number for existing path and event', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({
				...timestampStats,
				isFile: () => true,
				isDirectory: () => false,
				isSymbolicLink: () => false,
				ino: 123n,
				size: 100n,
			} as unknown as Stats);

			await fileSystemStateManager.update('/path');
			const inodeNumber = fileSystemStateManager.getInodeNumber('/path', FileSystemEvent.ADD);

      expect(inodeNumber).toBe(123);
    });

		it('should return undefined if inode type does not match', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({
				...timestampStats,
				isFile: () => true,
				isDirectory: () => false,
				isSymbolicLink: () => false,
				ino: 123n,
				size: 100n,
			} as unknown as Stats);

			await fileSystemStateManager.update('/path');
			const inodeNumber = fileSystemStateManager.getInodeNumber('/path', FileSystemEvent.ADD, InodeType.DIR);

      expect(inodeNumber).toBeUndefined();
    });
  });

  describe('reset', () => {
		it('should reset tracked state', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({
				...timestampStats,
				isFile: () => true,
				isDirectory: () => false,
				isSymbolicLink: () => false,
				ino: 123n,
				size: 100n,
			} as unknown as Stats);

			await fileSystemStateManager.update('/path');
			fileSystemStateManager.reset();

			expect(fileSystemStateManager.paths.size).toBe(0);
			expect(fileSystemStateManager.stats.size).toBe(0);
			expect(fileSystemStateManager.getInodeNumber('/path', FileSystemEvent.ADD)).toBeUndefined();
    });
  });

	describe('update', () => {
		it('should handle file addition', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ ...timestampStats, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ino: 123n, size: 100n } as unknown as Stats);
			const events = await fileSystemStateManager.update('/file.txt');
			expect(events).toEqual([FileSystemEvent.ADD]);
		});

		it('should handle file removal', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ ...timestampStats, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ino: 123n, size: 100n } as unknown as Stats);
			await fileSystemStateManager.update('/file.txt');
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce(undefined);
			const events = await fileSystemStateManager.update('/file.txt');
			expect(events).toEqual([FileSystemEvent.UNLINK]);
		});

		it('should handle directory addition', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ ...timestampStats, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ino: 123n } as unknown as Stats);
			const events = await fileSystemStateManager.update('/dir');
			expect(events).toEqual([FileSystemEvent.ADD_DIR]);
		});

		it('should return no events when file stats are unchanged', async () => {
			const filePath = '/unchanged-file.txt';
			const stableStats = {
				...timestampStats,
				isFile: () => true,
				isDirectory: () => false,
				isSymbolicLink: () => false,
				ino: 123n,
				size: 100n,
				mtimeNs: 1_000_000n,
				ctimeNs: 1_000_000n,
				mtimeMs: 1n,
			} as unknown as Stats;

			vi.spyOn(FileSystem, 'getStats').mockResolvedValue(stableStats);

			expect(await fileSystemStateManager.update(filePath)).toEqual([FileSystemEvent.ADD]);
			expect(await fileSystemStateManager.update(filePath)).toEqual([]);
		});

		it('should handle directory removal', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ ...timestampStats, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ino: 123n } as unknown as Stats);
			await fileSystemStateManager.update('/dir');
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce(undefined);
			const events = await fileSystemStateManager.update('/dir');
			expect(events).toEqual([FileSystemEvent.UNLINK_DIR]);
		});

		it('should handle file change', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ ...timestampStats, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ino: 123n, size: 100n } as unknown as Stats);
			await fileSystemStateManager.update('/file.txt');
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ ...timestampStats, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ino: 123n, size: 200n } as unknown as Stats);
			const events = await fileSystemStateManager.update('/file.txt');
			expect(events).toEqual([FileSystemEvent.CHANGE]);
		});

		it('should handle directory change', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ ...timestampStats, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ino: 123n } as unknown as Stats);
			await fileSystemStateManager.update('/dir');
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ ...timestampStats, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ino: 124n } as unknown as Stats);
			const events = await fileSystemStateManager.update('/dir');
			expect(events).toEqual([FileSystemEvent.UNLINK_DIR, FileSystemEvent.ADD_DIR]);
		});

		it('should handle subdirectory addition', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ ...timestampStats, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ino: 123n } as unknown as Stats);
			const events = await fileSystemStateManager.update('/dir/subdir');
			expect(events).toEqual([FileSystemEvent.ADD_DIR]);
		});

		it('should handle subdirectory removal', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ ...timestampStats, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ino: 123n } as unknown as Stats);
			await fileSystemStateManager.update('/dir/subdir');
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce(undefined);
			const events = await fileSystemStateManager.update('/dir/subdir');
			expect(events).toEqual([FileSystemEvent.UNLINK_DIR]);
		});

		it('should handle file deletion and replacement with a directory', async () => {
			const targetPath = '/file-to-dir';
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ ...timestampStats, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ino: 123n, size: 100n } as unknown as Stats);
			await fileSystemStateManager.update(targetPath);
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ ...timestampStats, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ino: 124n } as unknown as Stats);

			const events = await fileSystemStateManager.update(targetPath);

			expect(events).toEqual([FileSystemEvent.UNLINK, FileSystemEvent.ADD_DIR]);
		});

		it('should handle directory deletion and replacement with a file', async () => {
			const targetPath = '/dir-to-file';
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ ...timestampStats, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ino: 123n } as unknown as Stats);
			await fileSystemStateManager.update(targetPath);
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ ...timestampStats, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ino: 124n, size: 100n } as unknown as Stats);

			const events = await fileSystemStateManager.update(targetPath);

			expect(events).toEqual([FileSystemEvent.UNLINK_DIR, FileSystemEvent.ADD]);
		});

		it('should handle invalid path', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce(undefined);
			const events = await fileSystemStateManager.update('/invalid.txt');
			expect(events).toEqual([]);
		});

		it('should handle no-change scenario efficiently (no stats before or after)', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce(undefined);
			const events = await fileSystemStateManager.update('/nonexistent');
			expect(events).toEqual([]);
			expect(FileSystem.getStats).toHaveBeenCalledTimes(1);
		});
	});

	describe('determineEvents transitions (exercised through update)', () => {
		const targetPath = '/transition-target';

		/**
		 * Runs update() with a sequence of mocked stats results and returns the events from the final update.
		 * @param statsSequence - Ordered FileSystem.getStats results, one per update() call.
		 * @returns The events produced by the final update() call.
		 */
		async function runTransition(...statsSequence: Array<Stats | undefined>): Promise<FileSystemEvent[]> {
			let events: FileSystemEvent[] = [];

			for (const stats of statsSequence) {
				vi.mocked(FileSystem.getStats).mockResolvedValueOnce(stats);
				events = await fileSystemStateManager.update(targetPath);
			}

			return events;
		}

		it('no previous + no next (case 0) emits no events', async () => {
			expect(await runTransition(undefined)).toEqual([]);
		});

		it('no previous + new directory (case 4) emits addDir', async () => {
			expect(await runTransition(createStats('dir'))).toEqual([FileSystemEvent.ADD_DIR]);
		});

		it('no previous + new file (case 5) emits add', async () => {
			expect(await runTransition(createStats('file'))).toEqual([FileSystemEvent.ADD]);
		});

		it('previous directory + gone (case 8) emits unlinkDir', async () => {
			expect(await runTransition(createStats('dir'), undefined)).toEqual([FileSystemEvent.UNLINK_DIR]);
		});

		it('previous file + gone (case 10) emits unlink', async () => {
			expect(await runTransition(createStats('file'), undefined)).toEqual([FileSystemEvent.UNLINK]);
		});

		it('directory to directory with identical stats (case 12) emits unlinkDir + addDir', async () => {
			expect(await runTransition(createStats('dir'), createStats('dir'))).toEqual([FileSystemEvent.UNLINK_DIR, FileSystemEvent.ADD_DIR]);
		});

		it('directory to directory with a different inode (case 12) emits unlinkDir + addDir', async () => {
			expect(await runTransition(createStats('dir', { ino: 123n }), createStats('dir', { ino: 456n }))).toEqual([FileSystemEvent.UNLINK_DIR, FileSystemEvent.ADD_DIR]);
		});

		it('directory to file (case 13) emits unlinkDir + add', async () => {
			expect(await runTransition(createStats('dir'), createStats('file', { ino: 456n }))).toEqual([FileSystemEvent.UNLINK_DIR, FileSystemEvent.ADD]);
		});

		it('file to directory (case 14) emits unlink + addDir', async () => {
			expect(await runTransition(createStats('file'), createStats('dir', { ino: 456n }))).toEqual([FileSystemEvent.UNLINK, FileSystemEvent.ADD_DIR]);
		});

		it('file to file with identical stats (case 15, equal) emits no events', async () => {
			expect(await runTransition(createStats('file'), createStats('file'))).toEqual([]);
		});

		it('file to file with a changed size (case 15) emits change', async () => {
			expect(await runTransition(createStats('file', { size: 100n }), createStats('file', { size: 200n }))).toEqual([FileSystemEvent.CHANGE]);
		});

		it('file to file with a changed modification time (case 15) emits change', async () => {
			expect(await runTransition(createStats('file', { mtime: 1 }), createStats('file', { mtime: 2 }))).toEqual([FileSystemEvent.CHANGE]);
		});

		it('file to file with a changed status-change time (case 15) emits change', async () => {
			expect(await runTransition(createStats('file', { ctime: 1 }), createStats('file', { ctime: 2 }))).toEqual([FileSystemEvent.CHANGE]);
		});

		it('same-path inode swap between files (case 15, atomic save) emits a single change', async () => {
			expect(await runTransition(createStats('file', { ino: 123n }), createStats('file', { ino: 456n }))).toEqual([FileSystemEvent.CHANGE]);
		});

		it('previous file replaced by an unsupported entry type is treated as unlink', async () => {
			expect(await runTransition(createStats('file'), createStats('other'))).toEqual([FileSystemEvent.UNLINK]);
		});

		it('unsupported entry type with no previous stats emits no events', async () => {
			expect(await runTransition(createStats('other'))).toEqual([]);
		});
	});

	describe('public state updates', () => {
		it('updates public stats and inode-path map after update', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({
				...timestampStats,
				isFile: () => true,
				isDirectory: () => false,
				isSymbolicLink: () => false,
				ino: 123n,
				size: 100n,
			} as unknown as Stats);

			await fileSystemStateManager.update('/file.txt');

			expect(fileSystemStateManager.stats.has('/file.txt')).toBe(true);
			expect(fileSystemStateManager.paths.get(123)).toContain('/file.txt');
		});

		it('removes public stats and inode-path mapping when file disappears', async () => {
			vi.mocked(FileSystem.getStats)
				.mockResolvedValueOnce({
					...timestampStats,
					isFile: () => true,
					isDirectory: () => false,
					isSymbolicLink: () => false,
					ino: 123n,
					size: 100n,
				} as unknown as Stats)
				.mockResolvedValueOnce(undefined);

			await fileSystemStateManager.update('/file.txt');
			await fileSystemStateManager.update('/file.txt');

			expect(fileSystemStateManager.stats.has('/file.txt')).toBe(false);
			expect(fileSystemStateManager.paths.get(123) ?? []).not.toContain('/file.txt');
		});
	});
});

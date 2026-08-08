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

describe('FileSystemPoller', () => {
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
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ino: 123n, size: 100n } as unknown as Stats);
			const events = await fileSystemStateManager.update('/file.txt');
			expect(events).toEqual([FileSystemEvent.ADD]);
		});

		it('should handle file removal', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ino: 123n, size: 100n } as unknown as Stats);
			await fileSystemStateManager.update('/file.txt');
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce(undefined);
			const events = await fileSystemStateManager.update('/file.txt');
			expect(events).toEqual([FileSystemEvent.UNLINK]);
		});

		it('should handle directory addition', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ino: 123n } as unknown as Stats);
			const events = await fileSystemStateManager.update('/dir');
			expect(events).toEqual([FileSystemEvent.ADD_DIR]);
		});

		it('should return no events when file stats are unchanged', async () => {
			const filePath = '/unchanged-file.txt';
			const stableStats = {
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
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ino: 123n } as unknown as Stats);
			await fileSystemStateManager.update('/dir');
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce(undefined);
			const events = await fileSystemStateManager.update('/dir');
			expect(events).toEqual([FileSystemEvent.UNLINK_DIR]);
		});

		it('should handle file change', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ino: 123n, size: 100n, mtimeNs: 1_000_000n, ctimeNs: 1_000_000n, mtimeMs: 1n } as unknown as Stats);
			await fileSystemStateManager.update('/file.txt');
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ino: 123n, size: 200n } as unknown as Stats);
			const events = await fileSystemStateManager.update('/file.txt');
			expect(events).toEqual([FileSystemEvent.CHANGE]);
		});

		it('should handle directory change', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ino: 123n } as unknown as Stats);
			await fileSystemStateManager.update('/dir');
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ino: 124n } as unknown as Stats);
			const events = await fileSystemStateManager.update('/dir');
			expect(events).toEqual([FileSystemEvent.UNLINK_DIR, FileSystemEvent.ADD_DIR]);
		});

		it('should handle subdirectory addition', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ino: 123n } as unknown as Stats);
			const events = await fileSystemStateManager.update('/dir/subdir');
			expect(events).toEqual([FileSystemEvent.ADD_DIR]);
		});

		it('should handle subdirectory removal', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ino: 123n } as unknown as Stats);
			await fileSystemStateManager.update('/dir/subdir');
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce(undefined);
			const events = await fileSystemStateManager.update('/dir/subdir');
			expect(events).toEqual([FileSystemEvent.UNLINK_DIR]);
		});

		it('should handle file deletion and replacement with a directory', async () => {
			const targetPath = '/file-to-dir';
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ino: 123n, size: 100n } as unknown as Stats);
			await fileSystemStateManager.update(targetPath);
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ino: 124n } as unknown as Stats);

			const events = await fileSystemStateManager.update(targetPath);

			expect(events).toEqual([FileSystemEvent.UNLINK, FileSystemEvent.ADD_DIR]);
		});

		it('should handle directory deletion and replacement with a file', async () => {
			const targetPath = '/dir-to-file';
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ino: 123n } as unknown as Stats);
			await fileSystemStateManager.update(targetPath);
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ino: 124n, size: 100n } as unknown as Stats);

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

	describe('public state updates', () => {
		it('updates public stats and inode-path map after update', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({
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
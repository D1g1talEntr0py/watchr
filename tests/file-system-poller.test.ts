import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileSystemStateManager } from '../src/file-system-state-manager';
import { FileSystem } from '../src/file-system';
import { WatchrStats } from '../src/watchr-stats';
import { FileSystemEvent, InodeType } from '../src/constants';
import type { Stats } from '../src/@types';

vi.mock('../src/file-system', () => ({
  FileSystem: {
    getStats: vi.fn(),
  },
}));

describe('FileSystemPoller', () => {
  let fileSystemEventManager: FileSystemStateManager;

  beforeEach(() => {
    fileSystemEventManager = new FileSystemStateManager();
  });

  describe('Initialization', () => {
    it('should initialize with empty state', () => {
      expect(fileSystemEventManager.paths.size).toBe(0);
      expect(fileSystemEventManager.stats.size).toBe(0);
    });
  });

  describe('getInodeNumber', () => {
    it('should return undefined for non-existent path', () => {
      const inodeNumber = fileSystemEventManager.getInodeNumber('/non-existent', FileSystemEvent.ADD);
      expect(inodeNumber).toBeUndefined();
    });

    it('should return inode number for existing path and event', () => {
      fileSystemEventManager['targetInodes'][FileSystemEvent.ADD] = { '/path': [123, InodeType.FILE] };
      const inodeNumber = fileSystemEventManager.getInodeNumber('/path', FileSystemEvent.ADD);
      expect(inodeNumber).toBe(123);
    });

    it('should return undefined if inode type does not match', () => {
      fileSystemEventManager['targetInodes'][FileSystemEvent.ADD] = { '/path': [123, InodeType.FILE] };
      const inodeNumber = fileSystemEventManager.getInodeNumber('/path', FileSystemEvent.ADD, InodeType.DIR);
      expect(inodeNumber).toBeUndefined();
    });
  });

  describe('reset', () => {
    it('should reset the internal state', () => {
      fileSystemEventManager['targetInodes'][FileSystemEvent.ADD] = { '/path': [123, InodeType.FILE] };
      fileSystemEventManager.reset();
      expect(fileSystemEventManager['targetInodes']).toEqual({});
      expect(fileSystemEventManager.paths.size).toBe(0);
      expect(fileSystemEventManager.stats.size).toBe(0);
    });
  });

	describe('update', () => {
		it('should handle file addition', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ino: 123n, size: 100n } as any as Stats);
			const events = await fileSystemEventManager.update('/file.txt');
			expect(events).toEqual([FileSystemEvent.ADD]);
		});

		it('should handle file removal', async () => {
			fileSystemEventManager['stats'].set('/file.txt', new WatchrStats({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ino: 123, size: 100n } as any as Stats));
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce(undefined);
			const events = await fileSystemEventManager.update('/file.txt');
			expect(events).toEqual([FileSystemEvent.UNLINK]);
		});

		it('should handle directory addition', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ino: 123n } as any as Stats);
			const events = await fileSystemEventManager.update('/dir');
			expect(events).toEqual([FileSystemEvent.ADD_DIR]);
		});

		it('should handle directory removal', async () => {
			fileSystemEventManager['stats'].set('/dir', new WatchrStats({ isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ino: 123n } as any as Stats));
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce(undefined);
			const events = await fileSystemEventManager.update('/dir');
			expect(events).toEqual([FileSystemEvent.UNLINK_DIR]);
		});

		it('should handle file change', async () => {
			fileSystemEventManager['stats'].set('/file.txt', new WatchrStats({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ino: 123n, size: 100n } as any as Stats));
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ino: 123n, size: 200n } as any as Stats);
			const events = await fileSystemEventManager.update('/file.txt');
			expect(events).toEqual([FileSystemEvent.CHANGE]);
		});

		it('should handle directory change', async () => {
			fileSystemEventManager['stats'].set('/dir', new WatchrStats({ isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ino: 123n } as any as Stats));
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ino: 124n } as any as Stats);
			const events = await fileSystemEventManager.update('/dir');
			expect(events).toEqual([FileSystemEvent.UNLINK_DIR, FileSystemEvent.ADD_DIR]);
		});

		it('should handle subdirectory addition', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce({ isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ino: 123n } as any as Stats);
			const events = await fileSystemEventManager.update('/dir/subdir');
			expect(events).toEqual([FileSystemEvent.ADD_DIR]);
		});

		it('should handle subdirectory removal', async () => {
			fileSystemEventManager['stats'].set('/dir/subdir', new WatchrStats({ isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ino: 123n } as any as Stats));
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce(undefined);
			const events = await fileSystemEventManager.update('/dir/subdir');
			expect(events).toEqual([FileSystemEvent.UNLINK_DIR]);
		});

		// I'm not sure if this is even a valid scenario
		it('should handle file deletion and replacement with a directory', async () => {
			const targetPath = '/file-to-dir';
			const fileStats = new WatchrStats({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ino: 123n, size: 100n } as any as Stats);
			const dirStats = new WatchrStats({ isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ino: 124n } as any as Stats);

			// Set initial state with a file
			fileSystemEventManager['stats'].set(targetPath, fileStats);

			// Mock FileSystem.poll to return directory stats
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce(dirStats as any as Stats);

			const events = await fileSystemEventManager.update(targetPath);

			expect(events).toEqual([FileSystemEvent.UNLINK, FileSystemEvent.ADD_DIR]);
		});

		it('should handle directory deletion and replacement with a file', async () => {
			const targetPath = '/dir-to-file';
			const dirStats = new WatchrStats({ isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ino: 123n } as any as Stats);
			const fileStats = new WatchrStats({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ino: 124n, size: 100n } as any as Stats);

			// Set initial state with a directory
			fileSystemEventManager['stats'].set(targetPath, dirStats);

			// Mock FileSystem.poll to return file stats
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce(fileStats as any as Stats);

			const events = await fileSystemEventManager.update(targetPath);

			expect(events).toEqual([FileSystemEvent.UNLINK_DIR, FileSystemEvent.ADD]);
		});

		it('should handle invalid path', async () => {
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce(undefined);
			const events = await fileSystemEventManager.update('/invalid.txt');
			expect(events).toEqual([]);
		});

		it('should handle no-change scenario efficiently (no stats before or after)', async () => {
			vi.clearAllMocks(); // Clear previous calls
			vi.mocked(FileSystem.getStats).mockResolvedValueOnce(undefined);
			const events = await fileSystemEventManager.update('/nonexistent');
			expect(events).toEqual([]);
			expect(FileSystem.getStats).toHaveBeenCalledTimes(1);
		});
	});

  describe('getStats', () => {
    it('should return stats for a valid path', async () => {
      const mockStats = { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ino: 123, size: 100 };
      vi.mocked(FileSystem.getStats).mockResolvedValueOnce(mockStats as any as Stats);
      const stats = await fileSystemEventManager['getStats']('/file.txt');
      expect(stats).toBeInstanceOf(WatchrStats);
    });

    it('should return undefined for an invalid path', async () => {
      vi.mocked(FileSystem.getStats).mockResolvedValueOnce(undefined);
      const stats = await fileSystemEventManager['getStats']('/invalid.txt');
      expect(stats).toBeUndefined();
    });
  });

  describe('updateInode', () => {
    it('should update inode information', () => {
      const mockStats = new WatchrStats({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ino: 123n, size: 100n } as any as Stats);
      fileSystemEventManager['updateInode']('/file.txt', FileSystemEvent.ADD, mockStats);
      expect(fileSystemEventManager?.['targetInodes']?.[FileSystemEvent.ADD]?.['/file.txt']).toEqual([123, InodeType.FILE]);
    });
  });

  describe('updateStats', () => {
    it('should update stats for a given path', () => {
      const mockStats = new WatchrStats({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ino: 123n, size: 100n } as any as Stats);
      fileSystemEventManager['updateStats']('/file.txt', mockStats);
      expect(fileSystemEventManager.stats.get('/file.txt')).toEqual(mockStats);
      expect(fileSystemEventManager.paths.get(123)).toContain('/file.txt');
    });

    it('should remove stats for a given path if stats is undefined', () => {
      const mockStats = new WatchrStats({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ino: 123n, size: 100n } as any as Stats);
      fileSystemEventManager['stats'].set('/file.txt', mockStats);
      fileSystemEventManager['updateStats']('/file.txt', undefined);
      expect(fileSystemEventManager.stats.get('/file.txt')).toBeUndefined();
      expect(fileSystemEventManager.paths.get(123) ?? '').not.toContain('/file.txt');
    });
  });
});
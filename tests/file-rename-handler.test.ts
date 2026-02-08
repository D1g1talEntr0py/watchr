import { FileRenameHandler } from '../src/file-rename-handler';
import { FileSystemEvent, InodeType } from '../src/constants';
import { FileSystemLocker } from '../src/file-system-locker';
import { FileSystemStateManager } from '../src/file-system-state-manager';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Path, TargetEventEmitter } from '../src/@types';

describe('FileRenameHandler', () => {
  let fileRenameHandler: FileRenameHandler;
  let emitEvent: TargetEventEmitter;
  let fileSystemPoller: FileSystemStateManager;

  beforeEach(() => {
    emitEvent = vi.fn();
    fileRenameHandler = new FileRenameHandler(emitEvent);
    fileSystemPoller = fileRenameHandler.fileStateManager;
  });

  describe('Initialization', () => {
    it('should initialize correctly', () => {
      expect(fileRenameHandler).toBeInstanceOf(FileRenameHandler);
      expect(fileRenameHandler['fileLocks']).toBeInstanceOf(FileSystemLocker);
      expect(fileRenameHandler['directoryLocks']).toBeInstanceOf(FileSystemLocker);
      expect(fileRenameHandler.fileStateManager).toBeInstanceOf(FileSystemStateManager);
    });
  });

  describe('getLockTargetEvent', () => {
    it('should emit ADD event for new file when no inode tracking involved', () => {
      const targetPath: Path = '/path/to/file';

      // Mock getInodeNumber to return undefined (no inode tracking)
      vi.spyOn(fileSystemPoller, 'getInodeNumber').mockReturnValue(undefined);

      fileRenameHandler.getLockTargetEvent(FileSystemEvent.ADD, targetPath);

      expect(emitEvent).toHaveBeenCalledWith(FileSystemEvent.ADD, targetPath);
    });

    it('should emit ADD_DIR event for new directory when no inode tracking involved', () => {
      const targetPath: Path = '/path/to/dir';

      // Mock getInodeNumber to return undefined (no inode tracking)
      vi.spyOn(fileSystemPoller, 'getInodeNumber').mockReturnValue(undefined);

      fileRenameHandler.getLockTargetEvent(FileSystemEvent.ADD_DIR, targetPath);

      expect(emitEvent).toHaveBeenCalledWith(FileSystemEvent.ADD_DIR, targetPath);
    });

    it('should emit UNLINK event for deleted file when no inode tracking involved', () => {
      const targetPath: Path = '/path/to/file';

      // Mock getInodeNumber to return undefined (no inode tracking)
      vi.spyOn(fileSystemPoller, 'getInodeNumber').mockReturnValue(undefined);

      fileRenameHandler.getLockTargetEvent(FileSystemEvent.UNLINK, targetPath);

      expect(emitEvent).toHaveBeenCalledWith(FileSystemEvent.UNLINK, targetPath);
    });

    it('should emit UNLINK_DIR event for deleted directory when no inode tracking involved', () => {
      const targetPath: Path = '/path/to/dir';

      // Mock getInodeNumber to return undefined (no inode tracking)
      vi.spyOn(fileSystemPoller, 'getInodeNumber').mockReturnValue(undefined);

      fileRenameHandler.getLockTargetEvent(FileSystemEvent.UNLINK_DIR, targetPath);

      expect(emitEvent).toHaveBeenCalledWith(FileSystemEvent.UNLINK_DIR, targetPath);
    });
  });

  describe('Rename event', () => {
    it('should emit a RENAME event when a file is moved', () => {
			vi.useFakeTimers();
			const originalPath: Path = '/path/to/file';
			const renamedPath: Path = '/path/to/renamed-file';
			const inodeNumber = 456;

			// Mock getInodeNumber to control the inode
  		vi.spyOn(fileSystemPoller, 'getInodeNumber').mockReturnValue(inodeNumber);

			// 1. Simulate UNLINK on the original path.
			fileRenameHandler.getLockTargetEvent(FileSystemEvent.UNLINK, originalPath, 1);

			vi.advanceTimersByTime(100);

			expect(emitEvent).toHaveBeenCalledWith(FileSystemEvent.UNLINK, originalPath);

			// 2. Mock the poller's find method. This is key.
			// We make it return the original path to simulate finding a case-variant match.
			vi.spyOn(fileSystemPoller.paths, 'find').mockReturnValue(originalPath);

			// 3. Simulate ADD on the new path, which should trigger the RENAME event.
			fileRenameHandler.getLockTargetEvent(FileSystemEvent.ADD, renamedPath, 2);

			vi.advanceTimersByTime(100);

			// Verify that the RENAME event was emitted correctly.
			expect(emitEvent).toHaveBeenCalledWith(FileSystemEvent.RENAME, originalPath, renamedPath);

			expect(emitEvent).toHaveBeenCalledTimes(2);

			vi.useRealTimers();
    });

		it('should emit RENAME event when file system is case-insensitive', () => {
			const originalPath: Path = '/path/to/file';
			const renamedPath: Path = '/path/to/File';
			const inodeNumber = 456;

			// Mock getInodeNumber to control the inode
			vi.spyOn(fileSystemPoller, 'getInodeNumber').mockReturnValue(inodeNumber);

			// 1. Simulate UNLINK on the original path.
			fileRenameHandler.getLockTargetEvent(FileSystemEvent.UNLINK, originalPath);

			// 2. Mock the poller's find method. This is key.
			// We make it return the original path to simulate finding a case-variant match.
			vi.spyOn(fileSystemPoller.paths, 'find').mockReturnValue(originalPath);

			// 3. Simulate ADD on the new path, which should trigger the RENAME event.
			fileRenameHandler.getLockTargetEvent(FileSystemEvent.ADD, renamedPath);

			// Verify that the RENAME event was emitted correctly.
			expect(emitEvent).toHaveBeenCalledWith(FileSystemEvent.RENAME, originalPath, renamedPath);
			expect(emitEvent).toHaveBeenCalledTimes(1);
		});
  });

  describe('Change event', () => {
    it('should emit a CHANGE event when a file is modified', () => {
      const targetPath: Path = '/path/to/file';
      const inodeNumber = 111;

      // Mock getInodeNumber to return a consistent inode for both UNLINK and ADD
      const getInodeSpy = vi.spyOn(fileSystemPoller, 'getInodeNumber');
      getInodeSpy.mockReturnValue(inodeNumber);

      // Mock the poller's stats.has method to simulate the file existing after the change
      const statsHasSpy = vi.spyOn(fileSystemPoller.stats, 'has');
      statsHasSpy.mockReturnValue(true);

      // 1. Simulate an UNLINK event. This creates a pending unlink lock.
      fileRenameHandler.getLockTargetEvent(FileSystemEvent.UNLINK, targetPath);

      // 2. Simulate an ADD event on the *same* path. This should find the
      // pending lock and identify it as a CHANGE event.
      fileRenameHandler.getLockTargetEvent(FileSystemEvent.ADD, targetPath);

      // Verify that the CHANGE event was emitted correctly.
      expect(emitEvent).toHaveBeenCalledWith(FileSystemEvent.CHANGE, targetPath);
      expect(emitEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe('reset', () => {
    it('should reset fileSystemPoller, directoryLocks, and fileLocks', () => {
      const pollerSpy = vi.spyOn(fileSystemPoller, 'reset');
      fileRenameHandler.reset();

      expect(pollerSpy).toHaveBeenCalled();
      expect(fileRenameHandler['directoryLocks']).toBeInstanceOf(FileSystemLocker);
      expect(fileRenameHandler['fileLocks']).toBeInstanceOf(FileSystemLocker);
    });
  });
});
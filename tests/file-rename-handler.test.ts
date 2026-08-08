import { FileRenameHandler } from '../src/file-rename-handler';
import { FileSystemEvent, InodeType } from '../src/constants';
import { FileSystemLocker } from '../src/file-system-locker';
import { FileSystemStateManager } from '../src/file-system-state-manager';
import { LockResolver } from '../src/lock-resolver';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Path, TargetEventEmitter } from '../src/@types';

describe('FileRenameHandler', () => {
  let fileRenameHandler: FileRenameHandler;
  let emitEvent: TargetEventEmitter;
  let emitError: ReturnType<typeof vi.fn>;
  let fileSystemPoller: FileSystemStateManager;

  beforeEach(() => {
    emitEvent = vi.fn();
    emitError = vi.fn();
    fileRenameHandler = new FileRenameHandler(emitEvent, emitError);
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
    it('should not emit delayed UNLINK fallback when add lock resolves first', () => {
      vi.useFakeTimers();

      const originalPath: Path = '/path/to/file';
      const renamedPath: Path = '/path/to/renamed-file';
      const inodeNumber = 777;

      vi.spyOn(fileSystemPoller, 'getInodeNumber').mockReturnValue(inodeNumber);

      // Out-of-order delivery: ADD observed first, then UNLINK for the same inode.
      fileRenameHandler.getLockTargetEvent(FileSystemEvent.ADD, renamedPath, 50);
      fileRenameHandler.getLockTargetEvent(FileSystemEvent.UNLINK, originalPath, 50);

      vi.advanceTimersByTime(200);

      expect(emitEvent).toHaveBeenCalledWith(FileSystemEvent.RENAME, originalPath, renamedPath);
      expect(emitEvent).not.toHaveBeenCalledWith(FileSystemEvent.UNLINK, originalPath);

      vi.useRealTimers();
    });

    it('should emit RENAME immediately for ADD when a sibling inode path already exists', () => {
      const originalPath: Path = '/path/to/file';
      const renamedPath: Path = '/path/to/file-renamed';
      const inodeNumber = 456;

      const getInodeSpy = vi.spyOn(fileSystemPoller, 'getInodeNumber').mockReturnValue(inodeNumber);
      const siblingSpy = vi.spyOn(fileSystemPoller.paths, 'find').mockReturnValue(originalPath);
      const resolverSpy = vi.spyOn(fileRenameHandler['lockResolver'], 'add');

      fileRenameHandler.getLockTargetEvent(FileSystemEvent.ADD, renamedPath, 250);

      expect(getInodeSpy).toHaveBeenCalledWith(renamedPath, FileSystemEvent.ADD, InodeType.FILE);
      expect(siblingSpy).toHaveBeenCalledWith(inodeNumber, expect.any(Function));
      expect(emitEvent).toHaveBeenCalledWith(FileSystemEvent.RENAME, originalPath, renamedPath);
      expect(resolverSpy).not.toHaveBeenCalled();
    });

    it('should emit RENAME immediately for UNLINK when destination inode path already exists', () => {
      const originalPath: Path = '/path/to/file';
      const renamedPath: Path = '/path/to/file-renamed';
      const inodeNumber = 654;

      const getInodeSpy = vi.spyOn(fileSystemPoller, 'getInodeNumber').mockReturnValue(inodeNumber);
      const siblingSpy = vi.spyOn(fileSystemPoller.paths, 'find').mockReturnValue(renamedPath);
      const resolverSpy = vi.spyOn(fileRenameHandler['lockResolver'], 'add');

      fileRenameHandler.getLockTargetEvent(FileSystemEvent.UNLINK, originalPath, 250);

      expect(getInodeSpy).toHaveBeenCalledWith(originalPath, FileSystemEvent.UNLINK, InodeType.FILE);
      expect(siblingSpy).toHaveBeenCalledWith(inodeNumber, expect.any(Function));
      expect(emitEvent).toHaveBeenCalledWith(FileSystemEvent.RENAME, originalPath, renamedPath);
      expect(resolverSpy).not.toHaveBeenCalled();
    });

    it('should not emit RENAME for UNLINK when the sibling path already received a direct CHANGE this batch', () => {
      const tempPath: Path = '/path/to/.file.tmp';
      const targetPath: Path = '/path/to/file';
      const inodeNumber = 789;

      vi.spyOn(fileSystemPoller, 'getInodeNumber').mockReturnValue(inodeNumber);
      vi.spyOn(fileSystemPoller.paths, 'find').mockReturnValue(targetPath);

      fileRenameHandler.getLockTargetEvent(FileSystemEvent.UNLINK, tempPath, 0, new Set([ targetPath ]));

      expect(emitEvent).not.toHaveBeenCalledWith(FileSystemEvent.RENAME, tempPath, targetPath);
      expect(emitEvent).toHaveBeenCalledWith(FileSystemEvent.UNLINK, tempPath);
    });

  it('should not emit RENAME for UNLINK when changedPaths contains a non-canonical sibling path', () => {
    const tempPath: Path = '/path/to/.file.tmp';
    const targetPath: Path = '/path/to/file';
    const nonCanonicalTargetPath: Path = '/path/to/sub/../file';
    const inodeNumber = 789;

    vi.spyOn(fileSystemPoller, 'getInodeNumber').mockReturnValue(inodeNumber);
    vi.spyOn(fileSystemPoller.paths, 'find').mockReturnValue(targetPath);

    fileRenameHandler.getLockTargetEvent(FileSystemEvent.UNLINK, tempPath, 0, new Set([ nonCanonicalTargetPath ]));

    expect(emitEvent).not.toHaveBeenCalledWith(FileSystemEvent.RENAME, tempPath, targetPath);
    expect(emitEvent).toHaveBeenCalledWith(FileSystemEvent.UNLINK, tempPath);
  });

    it('should not emit RENAME for ADD when the sibling inode path already received a direct CHANGE this batch', () => {
      const originalPath: Path = '/path/to/file';
      const tempPath: Path = '/path/to/.file.tmp';
      const inodeNumber = 987;

      vi.spyOn(fileSystemPoller, 'getInodeNumber').mockReturnValue(inodeNumber);
      vi.spyOn(fileSystemPoller.paths, 'find').mockReturnValue(originalPath);

      fileRenameHandler.getLockTargetEvent(FileSystemEvent.ADD, tempPath, 0, new Set([ originalPath ]));

      expect(emitEvent).not.toHaveBeenCalledWith(FileSystemEvent.RENAME, originalPath, tempPath);
      expect(emitEvent).toHaveBeenCalledWith(FileSystemEvent.ADD, tempPath);
    });

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

    it('should not clear pending locks from a different handler', () => {
      vi.useFakeTimers();

      const firstEmitEvent = vi.fn();
      const secondEmitEvent = vi.fn();
      const firstHandler = new FileRenameHandler(firstEmitEvent, emitError);
      const secondHandler = new FileRenameHandler(secondEmitEvent, emitError);

      vi.spyOn(firstHandler.fileStateManager, 'getInodeNumber').mockReturnValue(1);
      vi.spyOn(secondHandler.fileStateManager, 'getInodeNumber').mockReturnValue(1);

      firstHandler.getLockTargetEvent(FileSystemEvent.ADD, '/first-file', 100);
      secondHandler.getLockTargetEvent(FileSystemEvent.ADD, '/second-file', 100);

      firstHandler.reset();

      vi.advanceTimersByTime(100);

      expect(firstEmitEvent).not.toHaveBeenCalled();
      expect(secondEmitEvent).toHaveBeenCalledWith(FileSystemEvent.ADD, '/second-file');

      vi.useRealTimers();
    });
  });

  describe('lock overflow handling', () => {
    it('should emit a safe error when lock resolver capacity is exceeded', () => {
      const addSpy = vi.spyOn(LockResolver.prototype, 'add').mockImplementation((_fn, _timeout, onEvict) => {
        onEvict?.();
      });

      vi.spyOn(fileSystemPoller, 'getInodeNumber').mockReturnValue(123);

      fileRenameHandler.getLockTargetEvent(FileSystemEvent.UNLINK, '/old-file');

      expect(emitError).toHaveBeenCalledWith(expect.objectContaining({ message: '🚨 Lock resolver capacity exceeded.' }));

			addSpy.mockRestore();
    });
  });
});
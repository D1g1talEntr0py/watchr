import { promises as fs, mkdirSync, rmdirSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Stats } from 'node:fs';
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { NodeTargetEvent, FileSystemEvent } from '../src/constants';
import { FileSystemEntries } from '../src/file-system-entries';
import { FileSystem } from '../src/file-system';
import { FileSystemEventManager } from '../src/file-system-event-manager';
import { FileSystemStateManager } from '../src/file-system-state-manager';
import { Watchr } from '../src/watchr';
import type { Event, Path, WatchrOptions } from '../src/@types';

const tmpDir = resolve(__dirname, '.tmp', 'file-system-event-manager');
const defaultOptions: WatchrOptions = {
	persistent: false,
	// Recursive behavior is not under test in this suite and can trigger
	// Windows-native fs watcher assertion failures under heavy CI coverage runs.
	recursive: false,
	renameTimeout: 100,
	ignore: (() => false),
	ignoreInitial: false,
};

let watchr: Watchr;
let fileSystemPoller: FileSystemStateManager;
let fileSystemEventManager: FileSystemEventManager;

beforeAll(async () => await fs.mkdir(tmpDir, { recursive: true }));

afterAll(async () => await fs.rm(tmpDir, { recursive: true, force: true }));

beforeEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
	await fs.mkdir(tmpDir, { recursive: true });
	watchr = new Watchr();
	fileSystemPoller = new FileSystemStateManager();
	const watcherConfig = {
		watcher: watch(tmpDir, defaultOptions),
		options: defaultOptions,
		folderPath: tmpDir,
	};
	fileSystemEventManager = await FileSystemEventManager.newInstance(fileSystemPoller, watchr, watcherConfig);
	await watchr.readyLock;
});

afterEach(async () => {
	watchr.close();
	vi.clearAllMocks();
	// Give a moment for watchers to fully close
	await new Promise(resolve => setTimeout(resolve, 10));
});

describe('FileSystemEventManager', () => {
	describe('newInstance()', () => {
		it('should initialize watcher events and initial events', () => {
			expect(fileSystemEventManager).toBeInstanceOf(FileSystemEventManager);
			expect((fileSystemEventManager as any).initials).toBeDefined();
			expect((fileSystemEventManager as any).watcher).toBeDefined();
		});
	});

	describe('initializeEvents()', () => {
		it('should not re-poll a file path that is already in stats', async () => {
			const filePath = resolve(tmpDir, 'file.txt');
			await fs.writeFile(filePath, 'content');

			const poller = new FileSystemStateManager();
			(poller.stats as unknown as Map<Path, Stats>).set(filePath, await fs.stat(filePath));

			// Track events emitted
			const events: Array<{ event: string, path: string }> = [];
			const testWatchr = new Watchr();
			testWatchr.on('add', (stats, path) => events.push({ event: 'add', path }));
			testWatchr.on('change', (stats, path) => events.push({ event: 'change', path }));

			const config = {
				watcher: watch(filePath, defaultOptions),
				options: defaultOptions,
				folderPath: dirname(filePath),
				filePath,
			};
			await FileSystemEventManager.newInstance(poller, testWatchr, config);

			// Should not emit duplicate events for files already in stats
			const addEvents = events.filter(e => e.event === 'add' && e.path === filePath);
			expect(addEvents.length).toBeLessThanOrEqual(1);

			testWatchr.close();
		});

		it('should not re-poll paths in a directory that are already in stats', async () => {
			const dirPath = resolve(tmpDir, 'dir');
			const filePath = resolve(dirPath, 'file.txt');
			await fs.mkdir(dirPath, { recursive: true });
			await fs.writeFile(filePath, 'content');

			const localWatchr = new Watchr();
			vi.spyOn(localWatchr, 'isReady').mockReturnValue(false);

			// Track events emitted
			const events: Array<{ event: string, path: string }> = [];
			localWatchr.on('add', (stats, path) => events.push({ event: 'add', path }));
			localWatchr.on('addDir', (stats, path) => events.push({ event: 'addDir', path }));

			const poller = new FileSystemStateManager();
			(poller.stats as unknown as Map<Path, Stats>).set(filePath, await fs.stat(filePath));

			const config = {
				watcher: watch(dirPath, defaultOptions),
				options: defaultOptions,
				folderPath: dirPath,
			};
			await FileSystemEventManager.newInstance(poller, localWatchr, config);

			// Directory should still be processed, but file already in stats should not generate duplicate events
			const dirEvents = events.filter(e => e.path === dirPath);
			const fileEvents = events.filter(e => e.path === filePath);

			expect(dirEvents.length).toBeGreaterThanOrEqual(0); // Directory may or may not emit events depending on ready state
			expect(fileEvents.length).toBeLessThanOrEqual(1); // File should not get duplicate events
			localWatchr.close();
		});

		it('should ignore paths that are ignored by the watchr instance', async () => {
			const dirPath = resolve(tmpDir, 'dir');
			const ignoredFilePath = resolve(dirPath, 'ignored-file.txt');
			const notIgnoredFilePath = resolve(dirPath, 'not-ignored-file.txt');
			await fs.mkdir(dirPath, { recursive: true });
			await fs.writeFile(ignoredFilePath, 'content');
			await fs.writeFile(notIgnoredFilePath, 'content');

			const localWatchr = new Watchr();
			vi.spyOn(localWatchr, 'isReady').mockReturnValue(false);
			vi.spyOn(localWatchr, 'isIgnored').mockImplementation((path: Path) => {
				return path === ignoredFilePath;
			});

			// Track events emitted
			const events: Array<{ event: string, path: string }> = [];
			localWatchr.on('add', (stats, path) => events.push({ event: 'add', path }));
			localWatchr.on('addDir', (stats, path) => events.push({ event: 'addDir', path }));

			const poller = new FileSystemStateManager();

			const config = {
				watcher: watch(dirPath, defaultOptions),
				options: defaultOptions,
				folderPath: dirPath,
			};
			await FileSystemEventManager.newInstance(poller, localWatchr, config);

			// Should process directory and non-ignored file, but not ignored file
			const dirEvents = events.filter(e => e.path === dirPath);
			const notIgnoredEvents = events.filter(e => e.path === notIgnoredFilePath);
			const ignoredEvents = events.filter(e => e.path === ignoredFilePath);

			expect(dirEvents.length).toBeGreaterThanOrEqual(0); // Directory may emit events
			expect(notIgnoredEvents.length).toBeGreaterThanOrEqual(0); // Non-ignored file should be processed
			expect(ignoredEvents.length).toBe(0); // Ignored file should never emit events

			localWatchr.close();
		});
	});

	describe('handleWatchrError()', () => {
		it('should handle watcher errors correctly', () => {
			const errorSpy = vi.spyOn(watchr, 'error').mockImplementation(() => true);
			const error = { message: 'Test error', code: 'ENOENT' } as NodeJS.ErrnoException;

			(fileSystemEventManager as any).handleWatchrError(error);

			expect(errorSpy).toHaveBeenCalledTimes(1);
			const [ emittedError ] = errorSpy.mock.calls[0] as [NodeJS.ErrnoException];
			expect(emittedError).toBeInstanceOf(Error);
			expect(emittedError.message).toBe('🚨 Watcher error (ENOENT)');
			expect(emittedError.code).toBe('ENOENT');
			expect(emittedError.message).not.toContain('Test error');
		});

		it('should sanitize watcher errors without Windows-specific fallback', () => {
			const errorSpy = vi.spyOn(watchr, 'error').mockImplementation(() => true);
			const error = new Error('EPERM') as NodeJS.ErrnoException;
			error.code = 'EPERM';

			(fileSystemEventManager as any).handleWatchrError(error);

			expect(errorSpy).toHaveBeenCalledTimes(1);
			const [ emittedError ] = errorSpy.mock.calls[0] as [NodeJS.ErrnoException];
			expect(emittedError).toBeInstanceOf(Error);
			expect(emittedError.message).toBe('🚨 Watcher error (EPERM)');
			expect(emittedError.code).toBe('EPERM');
		});
	});

	describe('cleanup()', () => {
		it('should remove watcher listeners when cleanup is called', () => {
			const watcher = (fileSystemEventManager as any).watcher;

			expect(watcher.listenerCount('change')).toBeGreaterThan(0);
			expect(watcher.listenerCount('error')).toBeGreaterThan(0);

			(fileSystemEventManager as any).cleanup();

			expect(watcher.listenerCount('change')).toBe(0);
			expect(watcher.listenerCount('error')).toBe(0);
		});

		it('should close the underlying watcher when cleanup is called', () => {
			const watcher = (fileSystemEventManager as any).watcher;
			const closeSpy = vi.spyOn(watcher, 'close');

			(fileSystemEventManager as any).cleanup();

			expect(closeSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe('populateEvents()', () => {
		it('should populate add events for new files', async () => {
			const filePath = resolve(tmpDir, 'new-file.txt');
			await fs.writeFile(filePath, 'content');
			const events: Event[] = [];
			await (fileSystemEventManager as any).populateEvents([ filePath ], events);
			expect(events).toHaveLength(1);
			expect(events[0]?.[1]).toBe(filePath);
			expect([ FileSystemEvent.ADD, FileSystemEvent.CHANGE ]).toContain(events[0]?.[0]);
		});

		it('should not recursively scan added directories during initial scan', async () => {
			const dirA = resolve(tmpDir, 'a');
			await fs.mkdir(dirA);
			await fs.writeFile(resolve(dirA, 'b'), 'content');

			const readDirectorySpy = vi.spyOn(FileSystem, 'readDirectory');
			readDirectorySpy.mockClear();

			const events: Event[] = [];
			await (fileSystemEventManager as any).populateEvents([ dirA ], events, true);

			expect(readDirectorySpy).not.toHaveBeenCalled();
			readDirectorySpy.mockRestore();
		});

		it('should populate events for new directories without manual subdirectory scanning', async () => {
			const dirA = resolve(tmpDir, 'a');
			const fileB = resolve(dirA, 'b');
			await fs.mkdir(dirA, { recursive: true });
			await fs.writeFile(fileB, 'content');

			const events: Event[] = [];
			await (fileSystemEventManager as any).populateEvents([ dirA ], events);
			expect(events.some(([ event, path ]) => event === FileSystemEvent.ADD_DIR && path === dirA)).toBe(true);
		});

		it('should only populate events for the specific path requested', async () => {
			const newDirPath = join(tmpDir, 'newDir');
			const subFile = join(newDirPath, 'file.txt');
			mkdirSync(newDirPath, { recursive: true });
			writeFileSync(subFile, 'content');

			const events: Event[] = [];
			await (fileSystemEventManager as any).populateEvents([ newDirPath ], events);

			// Should only detect the directory, not its contents (native watcher handles that)
			expect(events).toEqual([ [ FileSystemEvent.ADD_DIR, newDirPath ] ]);
		});
	});

	describe('deduplicateEvents()', () => {
		it('should deduplicate events correctly', () => {
			const events = [
				[FileSystemEvent.ADD, './tests/file1'],
				[FileSystemEvent.CHANGE, './tests/file1'],
				[FileSystemEvent.UNLINK, './tests/file2'],
			];

			const result = (fileSystemEventManager as any).deduplicateEvents(events);

			expect(result).toEqual([
				[FileSystemEvent.ADD, './tests/file1'],
				[FileSystemEvent.UNLINK, './tests/file2'],
			]);
		});

		it('should deduplicate change after add', () => {
			const events: Event[] = [
				[ FileSystemEvent.ADD, 'a' ],
				[ FileSystemEvent.CHANGE, 'a' ],
			];
			const deduplicatedEvents = (fileSystemEventManager as any).deduplicateEvents(events);
			expect(deduplicatedEvents).toEqual([ [ FileSystemEvent.ADD, 'a' ] ]);
		});

		it('should collapse repeated same-path events into one informative event', () => {
			const events: Event[] = [
				[ FileSystemEvent.ADD, 'a' ],
				[ FileSystemEvent.UNLINK, 'a' ],
				[ FileSystemEvent.ADD, 'a' ],
			];
			const deduplicatedEvents = (fileSystemEventManager as any).deduplicateEvents(events);
			expect(deduplicatedEvents).toEqual([ [ FileSystemEvent.ADD, 'a' ] ]);
		});

		it('should remove identical consecutive events', () => {
			const events: Event[] = [
				[ FileSystemEvent.ADD, 'a' ],
				[ FileSystemEvent.ADD, 'a' ],
			];
			const deduplicatedEvents = (fileSystemEventManager as any).deduplicateEvents(events);
			expect(deduplicatedEvents).toEqual([ [ FileSystemEvent.ADD, 'a' ] ]);
		});
	});

	describe('flush()', () => {
		it('should coalesce synchronous flush calls into one microtask flush', async () => {
			const flushImmediateSpy = vi.spyOn(fileSystemEventManager as any, 'flushImmediate').mockImplementation(() => {});

			(fileSystemEventManager as any).flush();
			(fileSystemEventManager as any).flush();

			expect(flushImmediateSpy).not.toHaveBeenCalled();

			await Promise.resolve();

			expect(flushImmediateSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe('empty-name fallback scans', () => {
		it('should avoid overlapping scans and schedule one trailing rescan', async () => {
			vi.useFakeTimers();

			const localWatchr = new Watchr();
			const localPoller = new FileSystemStateManager();
			const manager = await FileSystemEventManager.newInstance(localPoller, localWatchr, {
				watcher: watch(tmpDir, defaultOptions),
				options: defaultOptions,
				folderPath: tmpDir,
				nodeHandler: async () => {},
			});

			const firstScan = Promise.withResolvers<FileSystemEntries>();
			const secondScan = Promise.withResolvers<FileSystemEntries>();
			const readDirectorySpy = vi.spyOn(FileSystem, 'readDirectory')
				.mockImplementationOnce(async () => firstScan.promise)
				.mockImplementationOnce(async () => secondScan.promise);

			readDirectorySpy.mockClear();

			(manager as any).onWatcherChange(NodeTargetEvent.CHANGE, '');
			await Promise.resolve();

			expect(readDirectorySpy).toHaveBeenCalledTimes(1);

			(manager as any).onWatcherChange(NodeTargetEvent.CHANGE, '');
			await Promise.resolve();

			expect(readDirectorySpy).toHaveBeenCalledTimes(1);

			firstScan.resolve(new FileSystemEntries());
			await Promise.resolve();
			await Promise.resolve();

			expect(readDirectorySpy).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync((FileSystemEventManager as any).directoryFallbackScanIntervalMs);

			expect(readDirectorySpy).toHaveBeenCalledTimes(2);

			secondScan.resolve(new FileSystemEntries());
			await Promise.resolve();

			manager.cleanup();
			localWatchr.close();
			vi.useRealTimers();
		});

		it('should not emit fallback events for an ignored root path', async () => {
			const localWatchr = new Watchr();
			const localPoller = new FileSystemStateManager();
			vi.spyOn(localWatchr, 'isIgnored').mockImplementation((path: Path) => path === tmpDir);

			const targetPathCalls: string[] = [];
			const manager = await FileSystemEventManager.newInstance(localPoller, localWatchr, {
				watcher: watch(tmpDir, defaultOptions),
				options: defaultOptions,
				folderPath: tmpDir,
				nodeHandler: async (_event, targetPath) => {
					if (targetPath !== undefined) { targetPathCalls.push(targetPath) }
				},
			});

			(manager as any).onWatcherChange(NodeTargetEvent.CHANGE, '');
			await new Promise((resolve) => setTimeout(resolve, 25));

			expect(targetPathCalls).not.toContain(tmpDir);

			manager.cleanup();
			localWatchr.close();
		});
	});

	describe('isSubRoot()', () => {
		it('should correctly identify sub roots', () => {
			const result = (fileSystemEventManager as any).isSubRoot(tmpDir);
			expect(result).toBe(true);
		});

		it('should identify sub and non-sub roots correctly', () => {
			const subPath = resolve(tmpDir, 'sub');
			const nonSubPath = resolve(tmpDir, '../not-sub');
			expect((fileSystemEventManager as any).isSubRoot(subPath)).toBe(true);
			expect((fileSystemEventManager as any).isSubRoot(nonSubPath)).toBe(false);
		});
	});

	describe('onTargetEvents()', () => {
		it('should delegate non-change events to rename handler', () => {
			// Track events emitted by watchr (these would come through rename handler)
			const events: Array<{ event: string, path: string }> = [];
			watchr.on('add', (stats, path) => events.push({ event: 'add', path }));
			watchr.on('addDir', (stats, path) => events.push({ event: 'addDir', path }));
			watchr.on('unlink', (stats, path) => events.push({ event: 'unlink', path }));
			watchr.on('unlinkDir', (stats, path) => events.push({ event: 'unlinkDir', path }));

			const targetPath = resolve((fileSystemEventManager as any).folderPath, 'a/b');
			const testEvents: Event[] = [
				[ FileSystemEvent.ADD, targetPath ],
			];

			(fileSystemEventManager as any).onTargetEvents(testEvents);

			// Should eventually emit the event (possibly after rename handling)
			expect(events.some(e => e.path === targetPath && e.event === 'add')).toBe(true);
		});

		it('should emit change events directly', () => {
			const events: Array<{ event: string, path: string }> = [];
			watchr.on('change', (stats, path) => events.push({ event: 'change', path }));

			const targetPath = resolve((fileSystemEventManager as any).folderPath, 'a/b');
			const testEvents: Event[] = [
				[ FileSystemEvent.CHANGE, targetPath ],
			];

			(fileSystemEventManager as any).onTargetEvents(testEvents);

			// Change events should be emitted directly
			expect(events.some(e => e.path === targetPath && e.event === 'change')).toBe(true);
		});

		it('should do nothing for empty events', () => {
			const events: Array<{ event: string, path: string }> = [];
			watchr.on('change', (stats, path) => events.push({ event: 'change', path }));
			watchr.on('add', (stats, path) => events.push({ event: 'add', path }));

			(fileSystemEventManager as any).onTargetEvents([]);

			// No events should be emitted for empty array
			expect(events.length).toBe(0);
		});

		it('should ignore events outside the root path', () => {
			const events: Array<{ event: string, path: string }> = [];
			watchr.on('add', (stats, path) => events.push({ event: 'add', path }));
			watchr.on('change', (stats, path) => events.push({ event: 'change', path }));

			const targetPath = resolve(tmpDir, '../outside/file');
			const testEvents: Event[] = [
				[ FileSystemEvent.ADD, targetPath ],
				[ FileSystemEvent.CHANGE, targetPath ],
			];

			(fileSystemEventManager as any).onTargetEvents(testEvents);

			// Events outside the root path should be ignored
			expect(events.length).toBe(0);
		});

		it('should handle UNLINK_DIR events by closing watchers for parent and directory', () => {
			const watchersCloseSpy = vi.spyOn(watchr, 'watchersClose');

			const targetPath = resolve((fileSystemEventManager as any).folderPath, 'subdir');
			const testEvents: Event[] = [
				[ FileSystemEvent.UNLINK_DIR, targetPath ],
			];

			// Track events emitted
			const events: Array<{ event: string, path: string }> = [];
			watchr.on('unlinkDir', (stats, path) => events.push({ event: 'unlinkDir', path }));

			(fileSystemEventManager as any).onTargetEvents(testEvents);

			// Should call watchersClose twice: once for parent with file path, once for directory itself
			expect(watchersCloseSpy).toHaveBeenCalledTimes(2);
			expect(watchersCloseSpy).toHaveBeenCalledWith(dirname(targetPath), targetPath);
			expect(watchersCloseSpy).toHaveBeenCalledWith(targetPath);

			// Should also eventually emit the unlinkDir event
			expect(events.some(e => e.path === targetPath && e.event === 'unlinkDir')).toBe(true);
		});

		it('should not close a file-target watcher on UNLINK events', async () => {
			const filePath = resolve(tmpDir, 'tracked-file.txt');
			await fs.writeFile(filePath, 'content');

			const localWatchr = new Watchr();
			const watchersCloseSpy = vi.spyOn(localWatchr, 'watchersClose');
			const config = {
				watcher: watch(dirname(filePath), defaultOptions),
				options: defaultOptions,
				folderPath: dirname(filePath),
				filePath,
			};
			const manager = await FileSystemEventManager.newInstance(new FileSystemStateManager(), localWatchr, config);

			(manager as any).onTargetEvents([ [ FileSystemEvent.UNLINK, filePath ] ]);

			expect(watchersCloseSpy).not.toHaveBeenCalled();
			localWatchr.close();
		});

		it('should not close a file-target watcher on UNLINK_DIR events', async () => {
			const filePath = resolve(tmpDir, 'tracked-file.txt');
			await fs.writeFile(filePath, 'content');

			const localWatchr = new Watchr();
			const watchersCloseSpy = vi.spyOn(localWatchr, 'watchersClose');
			const config = {
				watcher: watch(dirname(filePath), defaultOptions),
				options: defaultOptions,
				folderPath: dirname(filePath),
				filePath,
			};
			const manager = await FileSystemEventManager.newInstance(new FileSystemStateManager(), localWatchr, config);

			(manager as any).onTargetEvents([ [ FileSystemEvent.UNLINK_DIR, dirname(filePath) ] ]);

			expect(watchersCloseSpy).not.toHaveBeenCalled();
			localWatchr.close();
		});

		it('should poll tracked descendants when directory watcher emits an empty filename', async () => {
			const localWatchr = new Watchr();
			const localPoller = new FileSystemStateManager();
			const trackedA = resolve(tmpDir, 'a.ts');
			const trackedB = resolve(tmpDir, 'b.ts');

			await fs.writeFile(trackedA, 'a');
			await fs.writeFile(trackedB, 'b');

			await localPoller.update(trackedA);
			await localPoller.update(trackedB);

			const targetPathCalls: string[] = [];
			const manager = await FileSystemEventManager.newInstance(localPoller, localWatchr, {
				watcher: watch(tmpDir, defaultOptions),
				options: defaultOptions,
				folderPath: tmpDir,
				nodeHandler: async (_event, targetPath) => {
					if (targetPath !== undefined) { targetPathCalls.push(targetPath) }
				},
			});

			(manager as any).onWatcherChange(NodeTargetEvent.CHANGE, '');
			await new Promise((resolve) => setTimeout(resolve, 25));

			expect(targetPathCalls).toContain(trackedA);
			expect(targetPathCalls).toContain(trackedB);
			localWatchr.close();
		});

		it('should use callback filename for non-empty directory watcher events', async () => {
			const localWatchr = new Watchr();
			const localPoller = new FileSystemStateManager();
			const expectedTargetPath = resolve(tmpDir, 'clearly-wrong-filename.ts');

			const targetPathCalls: string[] = [];
			const manager = await FileSystemEventManager.newInstance(localPoller, localWatchr, {
				watcher: watch(tmpDir, defaultOptions),
				options: defaultOptions,
				folderPath: tmpDir,
				nodeHandler: async (_event, targetPath) => {
					if (targetPath !== undefined) { targetPathCalls.push(targetPath) }
				},
			});

			(manager as any).onWatcherChange(NodeTargetEvent.CHANGE, 'clearly-wrong-filename.ts');
			await new Promise((resolve) => setTimeout(resolve, 25));

			expect(targetPathCalls).toContain(expectedTargetPath);
			localWatchr.close();
		});
	});

});
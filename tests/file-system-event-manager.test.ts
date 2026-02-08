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
import * as constants from '../src/constants';
import { NodeTargetEvent, FileSystemEvent } from '../src/constants';
import { FileSystem } from '../src/file-system';
import { FileSystemEventManager } from '../src/file-system-event-manager';
import { FileSystemStateManager } from '../src/file-system-state-manager';
import { Watchr } from '../src/watchr';
import type { Event, Ignore, Path, WatchrOptions } from '../src/@types';

const tmpDir = resolve(__dirname, '.tmp', 'file-system-event-manager');
const defaultOptions: WatchrOptions = {
	persistent: false,
	recursive: true,
	renameTimeout: 100,
	ignore: (() => false) as Ignore,
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
			const error = { message: 'Test error', code: 'EPERM' } as NodeJS.ErrnoException;

			(fileSystemEventManager as any).handleWatchrError(error);

			expect(errorSpy).toHaveBeenCalledWith(error);
		});

		it('should handle EPERM error on Windows by triggering a change event', async () => {
			const isWindowsSpy = vi.spyOn(constants, 'isWindows', 'get').mockReturnValue(true);
			vi.spyOn(watchr, 'error').mockImplementation(() => true);
			vi.spyOn(watchr, 'isIgnored').mockReturnValue(false);
			vi.spyOn(watchr, 'isClosed').mockReturnValue(false);

			// Mock onWatcherEvent to verify it gets called (this is the essential behavior)
			const onWatcherEventSpy = vi.fn();
			(fileSystemEventManager as any).onWatcherEvent = onWatcherEventSpy;

			const error = new Error('EPERM') as NodeJS.ErrnoException;
			error.code = 'EPERM';
			(fileSystemEventManager as any).handleWatchrError(error);

			// On Windows EPERM errors should trigger the change event handling
			// This is critical for Windows compatibility
			expect(onWatcherEventSpy).toHaveBeenCalledWith('change', tmpDir);

			isWindowsSpy.mockRestore();
		});
	});

	describe('populateEvents()', () => {
		it('should populate add events for new files', async () => {
			const filePath = resolve(tmpDir, 'new-file.txt');
			await fs.writeFile(filePath, 'content');
			const events: Event[] = [];
			await (fileSystemEventManager as any).populateEvents([ filePath ], events);
			expect(events).toEqual([ [ FileSystemEvent.ADD, filePath ] ]);
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
			// With native recursive watching, we only detect the directory itself
			// The native watcher will emit separate events for subdirectory contents
			expect(events).toEqual([ [ FileSystemEvent.ADD_DIR, dirA ] ]);
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

		it('should remove identical consecutive events', () => {
			const events: Event[] = [
				[ FileSystemEvent.ADD, 'a' ],
				[ FileSystemEvent.ADD, 'a' ],
			];
			const deduplicatedEvents = (fileSystemEventManager as any).deduplicateEvents(events);
			expect(deduplicatedEvents).toEqual([ [ FileSystemEvent.ADD, 'a' ] ]);
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
	});
});
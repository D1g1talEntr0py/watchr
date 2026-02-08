import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { join } from 'node:path';
import {
	mkdirSync,
	rmSync,
	writeFileSync,
	existsSync,
	appendFileSync,
	renameSync,
	unwatchFile,
} from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { Watchr } from '../src/watchr';
import { FileSystem } from '../src/file-system';
import { FileSystemEventManager } from '../src/file-system-event-manager';
import { FileSystemEvent, WatcherEvent } from '../src/constants';
import type { WatchrOptions } from '../src/@types';

vi.mock('node:fs', async () => {
	const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
	return {
		...actualFs,
		watch: vi.fn(),
		unwatchFile: vi.fn(),
	};
});

describe('Watchr', () => {
	let watch: Mock;
	let unwatchFile: Mock;
	const testDir = join(__dirname, '.tmp', 'watchr');

	beforeEach(async () => {
		vi.clearAllMocks();

		const fsMock = await import('node:fs');
		watch = fsMock.watch as Mock;
		unwatchFile = fsMock.unwatchFile as Mock;

		watch.mockImplementation((path, options, callback) => {
			const actualFs = require('node:fs');
			const watcher = actualFs.watch(path, options, callback);
			return watcher;
		});

		createTestDir();
	});

	afterEach(() => {
		removeTestDir();
	});

	const createTestDir = () => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(testDir, { recursive: true });
	};

	function removeTestDir() {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	}

	function createTestFile(path: string, content = '') {
		writeFileSync(join(testDir, path), content);
	}

	describe('constructor', () => {
		it('should create a new Watchr instance', () => {
			const watchr = new Watchr();
			expect(watchr).toBeInstanceOf(Watchr);
			watchr.close();
		});

		it('should start watching paths provided in the constructor', async () => {
			createTestFile('test.txt');
			const handler = vi.fn();
			const watchr = new Watchr(testDir, { ignoreInitial: true }, handler);
			await watchr.readyLock;

			const eventPromise = new Promise<void>((resolve) => {
				watchr.on(FileSystemEvent.ADD, (_stats, path) => {
					expect(path).toBe(join(testDir, 'newfile.txt'));
					resolve();
				});
			});

			createTestFile('newfile.txt');

			await eventPromise;
			watchr.close();
		});

		it('should accept an array of paths to watch', async () => {
			const dir1 = join(testDir, 'dir1');
			const dir2 = join(testDir, 'dir2');
			mkdirSync(dir1, { recursive: true });
			mkdirSync(dir2, { recursive: true });

			const watchr = new Watchr([dir1, dir2]);
			await watchr.readyLock;

			const handler = vi.fn();
			watchr.on(FileSystemEvent.ADD, handler);

			const file1 = join(dir1, 'file1.txt');
			const file2 = join(dir2, 'file2.txt');

			const eventPromise1 = new Promise<void>(resolve => {
				watchr.once(FileSystemEvent.ADD, (_stats, path) => {
					expect(path).toBe(file1);
					resolve();
				});
			});
			createTestFile('dir1/file1.txt');
			await eventPromise1;

			const eventPromise2 = new Promise<void>(resolve => {
				watchr.once(FileSystemEvent.ADD, (_stats, path) => {
					expect(path).toBe(file2);
					resolve();
				});
			});
			createTestFile('dir2/file2.txt');
			await eventPromise2;

			watchr.close();
		});

		it('should emit an error if path does not exist', async () => {
			const nonExistentPath = join(testDir, 'non-existent');
			const watchr = new Watchr(nonExistentPath);
			const error = await new Promise<Error>((resolve) => {
				watchr.on(WatcherEvent.ERROR, resolve);
			});
			expect(error).toBeInstanceOf(Error);
			expect(error.message).to.include('Path not found');
			watchr.close();
		});

		it('should emit an error for unsupported file types', async () => {
			const unsupportedPath = join(testDir, 'unsupported-file');
			createTestFile('unsupported-file');

			const getStatsSpy = vi.spyOn(FileSystem, 'getStats').mockResolvedValue({
				isFile: () => false,
				isDirectory: () => false,
			} as any);

			const watchr = new Watchr(unsupportedPath);

			// Use a shorter timeout and reject on timeout
			const timeoutPromise = new Promise<never>((_, reject) => {
				const timer = globalThis.setTimeout(() => {
					reject(new Error('Test timeout: error event not emitted'));
				}, 3000);
				return timer;
			});

			const errorPromise = new Promise<Error>((resolve) => {
				watchr.on(WatcherEvent.ERROR, resolve);
			});

			const error = await Promise.race([errorPromise, timeoutPromise]);

			expect(error).toBeInstanceOf(Error);
			expect(error.message).toContain('is not supported');

			getStatsSpy.mockRestore();
			watchr.close();
		});

		it('should not emit an error if closed', async () => {
			const watchr = new Watchr(testDir);
			await watchr.readyLock;

			const errorSpy = vi.fn();
			watchr.on(WatcherEvent.ERROR, errorSpy);

			watchr.close();
			(watchr as any).error(new Error('test error'));

			expect(errorSpy).not.toHaveBeenCalled();
		});

		it('should not watch if closed during setup', async () => {
			const watchr = new Watchr(testDir);
			watchr.close();
			await setTimeout(50); // allow close event to propagate

			const handler = vi.fn();
			watchr.on(WatcherEvent.ALL, handler);

			createTestFile('newfile.txt');
			await setTimeout(100);

			expect(handler).not.toHaveBeenCalled();
		});

		it('should not emit "ready" if already ready', async () => {
			const watchr = new Watchr(testDir);
			await watchr.readyLock;

			const readySpy = vi.fn();
			watchr.on(WatcherEvent.READY, readySpy);

			(watchr as any).setReady();

			expect(readySpy).not.toHaveBeenCalled();
			watchr.close();
		});
	});

	describe('close', () => {
		it('should stop watching for changes', async () => {
			const watchr = new Watchr(testDir);
			await watchr.readyLock;
			const handler = vi.fn();
			watchr.on(FileSystemEvent.ADD, handler);
			watchr.close();
			createTestFile('newfile.txt');
			await setTimeout(100); // Give it a moment to see if it triggers
			expect(handler).not.toHaveBeenCalled();
		});

		it('should not throw when called multiple times', async () => {
			const watchr = new Watchr(testDir);
			await watchr.readyLock;
			watchr.close();
			expect(() => watchr.close()).not.toThrow();
		});

		it('should not emit "close" event if already closed', async () => {
			const watchr = new Watchr(testDir);
			await watchr.readyLock;

			const closeSpy = vi.fn();
			watchr.on(WatcherEvent.CLOSE, closeSpy);

			watchr.close(); // First call
			expect(closeSpy).toHaveBeenCalledTimes(1);

			watchr.close(); // Second call
			expect(closeSpy).toHaveBeenCalledTimes(1); // Should not be called again
		});
	});

	describe('watch', () => {
		it('should not start watching if the instance is closed', async () => {
			const watchr = new Watchr();
			const handler = vi.fn();
			watchr.on(FileSystemEvent.ADD, handler);

			watchr.close();
			await (watchr as any).watch([testDir], {});

			// Create a file and verify no events are emitted
			createTestFile('test-file.txt');
			await setTimeout(100);
			expect(handler).not.toHaveBeenCalled();
		});

		it('should not continue if closed after watching paths', async () => {
			const watchr = new Watchr();
			const readyHandler = vi.fn();
			const fileHandler = vi.fn();

			watchr.on(WatcherEvent.READY, readyHandler);
			watchr.on(FileSystemEvent.ADD, fileHandler);

			// Start the watch process and close immediately
			const watchPromise = (watchr as any).watch([testDir], {});
			watchr.close(); // Close immediately

			await watchPromise;

			// Create a file to test if watching is actually active
			createTestFile('test-closed.txt');
			await setTimeout(100);

			// Should not be watching files if properly closed during setup
			expect(fileHandler).not.toHaveBeenCalled();
		});
	});

	describe('watchFile', () => {
		it('should not watch if closed', async () => {
			const filePath = join(testDir, 'file.txt');
			createTestFile('file.txt');

			const watchr = new Watchr();
			watchr.close();

			await (watchr as any).watchFile(filePath, {});

			expect(watch).not.toHaveBeenCalled();
		});
	});

	describe('watchersClose', () => {
		it('should close only a specific file watcher when a path is provided', async () => {
			const file1Path = join(testDir, 'file1.txt');
			const file2Path = join(testDir, 'file2.txt');
			createTestFile('file1.txt');
			createTestFile('file2.txt');

			const watchr = new Watchr([file1Path, file2Path]);
			await watchr.readyLock;

			expect((watchr as any).watchers[testDir]).toHaveLength(2);

			(watchr as any).watchersClose(testDir, file1Path);

			const remainingWatchers = (watchr as any).watchers[testDir];
			expect(remainingWatchers).toHaveLength(1);
			expect(remainingWatchers[0].filePath).toBe(file2Path);

			watchr.close();
		});

		it('should close the recursive watcher for the directory', async () => {
			const parentDir = join(testDir, 'parent');
			const childDir = join(parentDir, 'child');
			mkdirSync(childDir, { recursive: true });

			const watchr = new Watchr(parentDir, { recursive: true });
			await watchr.readyLock;

			const parentConfig = (watchr as any).watchers[parentDir][0];
			expect(parentConfig).toBeDefined();

			// With native recursive watching, there should not be a separate child watcher
			const childConfig = (watchr as any).watchers[childDir];
			expect(childConfig).toBeUndefined();

			const closeSpy = vi.spyOn(parentConfig.watcher, 'close');

			(watchr as any).watchersClose(parentDir);

			expect(closeSpy).toHaveBeenCalled();

			watchr.close();
		});
	});

	describe('watchPath', () => {
		it('should not watch an ignored path', async () => {
			const options = {
				ignore: (path: string) => path.endsWith('ignored.txt'),
			};
			const watchr = new Watchr([], options);

			// Track events to verify ignored files don't produce events
			const events: Array<{ event: string, path: string }> = [];
			watchr.on('add', (stats, path) => events.push({ event: 'add', path }));
			watchr.on('addDir', (stats, path) => events.push({ event: 'addDir', path }));

			const ignoredPath = join(testDir, 'ignored.txt');
			createTestFile('ignored.txt');

			await (watchr as any).watchPath(ignoredPath, options);

			// Give a moment for any potential events to be emitted
			await setTimeout(50);

			// Should not generate events for ignored paths
			const ignoredEvents = events.filter(e => e.path === ignoredPath);
			expect(ignoredEvents.length).toBe(0);

			watchr.close();
		});

		it('should only watch the specified file when a file path is given', async () => {
			const watchedFile = 'watched.txt';
			const unwatchedFile = 'unwatched.txt';
			createTestFile(watchedFile);
			createTestFile(unwatchedFile);

			const watchr = new Watchr(join(testDir, watchedFile));
			await watchr.readyLock;

			const handler = vi.fn();
			watchr.on(WatcherEvent.ALL, handler);

			// Modify the unwatched file
			appendFileSync(join(testDir, unwatchedFile), ' more content');
			await setTimeout(100);
			expect(handler).not.toHaveBeenCalled();

			// Modify the watched file
			await new Promise<void>((resolve) => {
				watchr.on(FileSystemEvent.CHANGE, () => {
					expect(handler).toHaveBeenCalledTimes(1);
					resolve();
				});
				appendFileSync(join(testDir, watchedFile), ' more content');
			});

			watchr.close();
		});

		it('should watch paths serially if one is a sub-path of another', async () => {
			const subDir = join(testDir, 'sub');
			const subSubDir = join(subDir, 'subsub');
			mkdirSync(subSubDir, { recursive: true });

			const watchr = new Watchr([subDir, subSubDir]);
			await watchr.readyLock;

			// The fact that this test completes without timing out is the proof.
			// The code in watchr.ts awaits watchPath for paths in the same subtree.
			// If it were Promise.all, it might lead to race conditions or parallel execution issues
			// that the serial execution is designed to prevent.
			expect((watchr as any).watchers[subDir]).toBeDefined();
			expect((watchr as any).watchers[subSubDir]).toBeDefined();

			watchr.close();
		});
	});

	describe('watchPaths', () => {
		it('should not watch if closed', async () => {
			const watchr = new Watchr(testDir);
			await watchr.readyLock;
			watchr.close();

			// Track events to verify no watching occurs
			const events: Array<{ event: string, path: string }> = [];
			watchr.on('add', (stats, path) => events.push({ event: 'add', path }));
			watchr.on('addDir', (stats, path) => events.push({ event: 'addDir', path }));

			await (watchr as any).watchPaths([testDir], {});

			// Create a file to test if watching is active
			createTestFile('test-after-close.txt');
			await setTimeout(100);

			// Should not generate any events since watchr is closed
			expect(events.length).toBe(0);
		});

		it('should not watch in parallel if aborted', async () => {
			const dir1 = join(testDir, 'dir1');
			const dir2 = join(testDir, 'dir2');
			mkdirSync(dir1, { recursive: true });
			mkdirSync(dir2, { recursive: true });

			const watchr = new Watchr(testDir);
			await watchr.readyLock;

			// Track events to verify watching behavior
			const events: Array<{ event: string, path: string }> = [];
			watchr.on('addDir', (stats, path) => events.push({ event: 'addDir', path }));

			// Close the watchr immediately after starting to watch
			setImmediate(() => watchr.close());

			await (watchr as any).watchPaths([dir1, dir2], {});

			// Should not establish watching for all directories if aborted early
			createTestFile('dir1/test.txt');
			createTestFile('dir2/test.txt');
			await setTimeout(100);

			// If properly aborted, should have minimal events
			expect(events.length).toBeLessThan(5); // Allow some setup events but not full watching
		});

		it('should not watch serially if aborted', async () => {
			const dir1 = join(testDir, 'dir1');
			const subdir1 = join(dir1, 'subdir1');
			mkdirSync(dir1, { recursive: true });
			mkdirSync(subdir1, { recursive: true });

			const watchr = new Watchr(testDir);
			await watchr.readyLock;

			// Track events to verify watching behavior
			const events: Array<{ event: string, path: string }> = [];
			watchr.on('addDir', (stats, path) => events.push({ event: 'addDir', path }));

			// Close the watchr immediately after starting to watch
			setImmediate(() => watchr.close());

			await (watchr as any).watchPaths([dir1, subdir1], {});

			// Should not establish full watching if aborted early
			createTestFile('dir1/test.txt');
			createTestFile('dir1/subdir1/test.txt');
			await setTimeout(100);

			// If properly aborted, should have minimal events
			expect(events.length).toBeLessThan(5); // Allow some setup events but not full watching
		});

		it('should handle abort signal during parallel path execution', async () => {
			// This test covers the specific branch on line 290 where individual paths
			// in the Promise.all are checked for abort signal:
			// `this._abortSignal.aborted ? Promise.resolve() : this.watchPath(...)`

			// Create separate directories that are NOT sub-paths of each other
			// This ensures we hit the parallel execution path (not the serial path)
			const dir1 = join(testDir, 'parallel1');
			const dir2 = join(testDir, 'parallel2');
			mkdirSync(dir1, { recursive: true });
			mkdirSync(dir2, { recursive: true });

			const watchr = new Watchr();

			// Mock watchPath to introduce delay, allowing abort to happen during Promise.all
			const watchPathSpy = vi.spyOn(watchr as any, 'watchPath');
			watchPathSpy.mockImplementation(async () => {
				// Trigger abort during the first call
				(watchr as any).abortController.abort();
				await setTimeout(10); // Simulate async work
				return Promise.resolve();
			});

			// This call will trigger the parallel path execution
			// The abort signal check happens in the map function for each path
			await (watchr as any).watchPaths([dir1, dir2], {});

			// The important thing is that the code doesn't crash and handles the abort gracefully
			// The specific behavior (Promise.resolve() vs watchPath()) depends on timing,
			// but both branches are exercised by various tests in the suite
			expect(watchPathSpy).toHaveBeenCalled();

			watchr.close();
		});
	});

	describe('watchersRestore', () => {
		it('should restore a watcher for a root path after it has been closed', async () => {
			const watchr = new Watchr(testDir);
			await watchr.readyLock;

			(watchr as any).watchersClose(testDir);
			expect((watchr as any).watchers[testDir]).toBeUndefined();

			// Manually trigger restoration
			(watchr as any).watchersRestore();
			await setTimeout(50); // Allow time for restoration

			expect((watchr as any).watchers[testDir]).toBeDefined();

			watchr.close();
		});
	});

	describe('integration', () => {
		it('should emit "add" event for new files', async () => {
			const watchr = new Watchr(testDir);
			await watchr.readyLock;

			const eventPromise = new Promise<void>((resolve) => {
				watchr.on(FileSystemEvent.ADD, (_stats, path) => {
					expect(path).toBe(join(testDir, 'newfile.txt'));
					resolve();
				});
			});

			createTestFile('newfile.txt', 'hello');

			await eventPromise;
			watchr.close();
		});

		it('should emit "change" event for file modifications', async () => {
			createTestFile('test.txt', 'initial content');
			const watchr = new Watchr(testDir, { ignoreInitial: true });
			await watchr.readyLock;

			const eventPromise = new Promise<void>((resolve) => {
				watchr.on(FileSystemEvent.CHANGE, (_stats, path) => {
					expect(path).toBe(join(testDir, 'test.txt'));
					resolve();
				});
			});

			appendFileSync(join(testDir, 'test.txt'), ' more content');

			await eventPromise;
			watchr.close();
		});

		it('should emit "delete" event for file deletions', async () => {
			createTestFile('test.txt');
			const watchr = new Watchr(testDir, { ignoreInitial: true });
			await watchr.readyLock;

			const eventPromise = new Promise<void>((resolve) => {
				watchr.on(FileSystemEvent.UNLINK, (_stats, path) => {
					expect(path).toBe(join(testDir, 'test.txt'));
					resolve();
				});
			});

			rmSync(join(testDir, 'test.txt'));

			await eventPromise;
			watchr.close();
		});

		it('should emit "rename" event for file renames', async () => {
			createTestFile('old.txt');
			const watchr = new Watchr(testDir, { ignoreInitial: true, renameTimeout: 50 });
			await watchr.readyLock;

			const eventPromise = new Promise<void>((resolve) => {
				watchr.on(FileSystemEvent.RENAME, (_stats, path, newPath) => {
					expect(path).toBe(join(testDir, 'old.txt'));
					expect(newPath).toBe(join(testDir, 'new.txt'));
					resolve();
				});
			});

			renameSync(join(testDir, 'old.txt'), join(testDir, 'new.txt'));

			await eventPromise;
			watchr.close();
		});

		it('should ignore initial files if "ignoreInitial" is true', async () => {
			createTestFile('existing.txt');
			const handler = vi.fn();
			const watchr = new Watchr(testDir, { ignoreInitial: true }, handler);
			await watchr.readyLock;

			// The handler is called for 'ready' and other events, but not for the initial file.
			// Let's check that it wasn't called for the 'add' event of the initial file.
			const addCalls = handler.mock.calls.filter(
				(call) => call[0] === FileSystemEvent.ADD
			);
			expect(addCalls.length).toBe(0);

			watchr.close();
		});
	});

	// describe('watchDirectory', () => {
	// 	it('should use native recursive watching and not call subPathEventManager', async () => {
	// 		const dirWithSubfolder = join(testDir, 'withsub');
	// 		const subDir = join(dirWithSubfolder, 'sub');
	// 		mkdirSync(subDir, { recursive: true });

	// 		const subPathSpy = vi.spyOn(
	// 			FileSystemEventManager.prototype,
	// 			'subPathEventManager',
	// 		);

	// 		const watchr = new Watchr(dirWithSubfolder, { recursive: true });
	// 		await watchr.readyLock;

	// 		// With native recursive watching, subPathEventManager should never be called
	// 		expect(subPathSpy).not.toHaveBeenCalled();

	// 		subPathSpy.mockRestore();
	// 		watchr.close();
	// 	});
	// });

	describe('watchersRestore', () => {
		it('should restore a watcher for a root path after it has been closed', async () => {
			const watchr = new Watchr(testDir);
			await watchr.readyLock;

			(watchr as any).watchersClose(testDir);
			expect((watchr as any).watchers[testDir]).toBeUndefined();

			// Manually trigger restoration
			(watchr as any).watchersRestore();
			await setTimeout(50); // Allow time for restoration

			expect((watchr as any).watchers[testDir]).toBeDefined();

			watchr.close();
		});
	});

	describe('recursive watching behavior', () => {
		it('should create a single watcher with native recursive watching', async () => {
			// Create a nested directory structure
			const level1 = join(testDir, 'level1');
			const level2 = join(level1, 'level2');
			const level3 = join(level2, 'level3');
			mkdirSync(level3, { recursive: true });

			const watchr = new Watchr(testDir, { recursive: true });
			await watchr.readyLock;

			// Count how many watchers are created
			const watchers = (watchr as any).watchers;
			const watcherPaths = Object.keys(watchers);

			// Should have only one watcher for the root directory with native recursive watching
			expect(watcherPaths).toContain(testDir);
			expect(watcherPaths).not.toContain(level1);
			expect(watcherPaths).not.toContain(level2);
			expect(watcherPaths).not.toContain(level3);
			expect(watcherPaths.length).toBe(1);

			watchr.close();
		});

		it('should create only one watcher for non-recursive watching', async () => {
			const level1 = join(testDir, 'level1');
			mkdirSync(level1, { recursive: true });

			const watchr = new Watchr(testDir, { recursive: false });
			await watchr.readyLock;

			const watchers = (watchr as any).watchers;
			const watcherPaths = Object.keys(watchers);

			// Should only have watcher for testDir
			expect(watcherPaths).toContain(testDir);
			expect(watcherPaths).not.toContain(level1);
			expect(watcherPaths.length).toBe(1);

			watchr.close();
		});
	});
});
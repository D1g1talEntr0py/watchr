import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createServer } from 'node:net';
import {
	mkdirSync,
	rmSync,
	writeFileSync,
	appendFileSync,
	renameSync
} from 'node:fs';
import { Watchr, FileSystemEvent, WatcherEvent, type WatchrEventMap } from '../src/watchr';
import { cleanupTempRoots, createTempRoot } from './helpers/fs-fixtures';

describe('Watchr', () => {
	let testDir: string;

	beforeEach(() => {
		testDir = createTempRoot('watchr-test-');
	});

	afterEach(() => {
		vi.restoreAllMocks();
		cleanupTempRoots();
	});

	function createTestFile(path: string, content = '') {
		writeFileSync(join(testDir, path), content);
	}

	/**
	 * Waits for a specific watcher event, optionally filtered by path, with a generous timeout.
	 * @param watchr - The watcher to listen on.
	 * @param event - The event name to wait for.
	 * @param path - Optional path the event must reference.
	 * @returns A promise resolving with the event path when the event arrives.
	 */
	function waitForEvent(watchr: Watchr, event: FileSystemEvent, path?: string): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const timeoutId = globalThis.setTimeout(() => {
				watchr.off(event, onEvent);
				reject(new Error(`timed out waiting for "${event}" event`));
			}, 5000);

			const onEvent = (...args: WatchrEventMap[FileSystemEvent]) => {
				const [ , targetPath ] = args;

				if (path !== undefined && targetPath !== path) { return }

				globalThis.clearTimeout(timeoutId);
				watchr.off(event, onEvent);
				resolve(targetPath);
			};

			watchr.on(event, onEvent);
		});
	}

	/**
	 * Yields a few macrotask turns so already-scheduled watcher work can settle.
	 * @param turns - Number of macrotask turns to yield.
	 */
	async function settle(turns = 3): Promise<void> {
		for (let turn = 0; turn < turns; turn++) {
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}

	describe('constructor', () => {
		it('should create a new Watchr instance', () => {
			const watchr = new Watchr();
			expect(watchr).toBeInstanceOf(Watchr);
			watchr.close();
		});

		it('should not expose implementation members at runtime', () => {
			const watchr = new Watchr();
			for (const member of [ 'renameWatchr', 'addWatcherConfig', 'error', 'emitEvent', 'watchersClose' ]) {
				expect(member in watchr).toBe(false);
			}
			watchr.close();
		});

		it('emits a one-time WATCHR_PLATFORM_TIER2 warning on win32', async () => {
			vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
			const warningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
			// A fresh module instance resets the module-level "already warned" flag.
			vi.resetModules();
			const { Watchr: FreshWatchr } = await import('../src/watchr');

			const first = new FreshWatchr(testDir);
			const second = new FreshWatchr(testDir);

			try {
				const tier2Warnings = warningSpy.mock.calls.filter(([ warning ]) => (warning as NodeJS.ErrnoException).code === 'WATCHR_PLATFORM_TIER2');

				expect(tier2Warnings).toHaveLength(1);
				expect(tier2Warnings[0]?.[0]).toEqual(expect.objectContaining({ name: 'WatchrWarning', message: expect.stringContaining('Tier 2') }));
				expect(tier2Warnings[0]?.[1]).toEqual(expect.objectContaining({ code: 'WATCHR_PLATFORM_TIER2', detail: expect.stringContaining('WSL') }));
			} finally {
				first.close();
				second.close();
			}
		});

		it('does not emit the platform warning on non-win32 platforms', () => {
			vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
			const warningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
			const watchr = new Watchr(testDir);

			expect(warningSpy).not.toHaveBeenCalled();
			watchr.close();
		});

		it('should throw for invalid renameTimeout option', () => {
			expect(() => new Watchr(testDir, { renameTimeout: -1 })).toThrow('renameTimeout must be a non-negative finite number');
		});

		it.each([ -1, Number.NaN, Number.POSITIVE_INFINITY ])('should throw for invalid statTimeout option %s', (statTimeout) => {
			expect(() => new Watchr(testDir, { statTimeout })).toThrow('statTimeout must be a non-negative finite number');
		});

		it.each([ -1, Number.NaN, Number.POSITIVE_INFINITY ])('should throw for invalid fallbackScanInterval option %s', (fallbackScanInterval) => {
			expect(() => new Watchr(testDir, { fallbackScanInterval })).toThrow('fallbackScanInterval must be a non-negative finite number');
		});

		it.each([ 'yes', 1, null ])('should throw for non-boolean followSymlinks option %s', (followSymlinks) => {
			expect(() => Reflect.construct(Watchr, [ testDir, { followSymlinks } ])).toThrow('followSymlinks must be a boolean');
		});

		it('should throw for invalid ignore option', () => {
			expect(() => Reflect.construct(Watchr, [ testDir, { ignore: true } ])).toThrow('ignore must be a function, string, RegExp, or array of these values');
		});

		it('should accept native ignore patterns', () => {
			let watchr: Watchr | undefined;

			expect(() => {
				watchr = new Watchr(testDir, { ignore: /ignored\\.txt$/ });
			}).not.toThrow();

			watchr?.close();
		});

		it('should accept throwIfNoEntry option', () => {
			let watchr: Watchr | undefined;

			expect(() => {
				watchr = new Watchr(testDir, { throwIfNoEntry: false });
			}).not.toThrow();

			watchr?.close();
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

		it('should apply native ignore patterns', async () => {
			const ignoredFilePath = join(testDir, 'ignored.log');
			const includedFilePath = join(testDir, 'included.txt');
			const watchr = new Watchr(testDir, { ignore: /\.log$/ });
			await watchr.readyLock;

			expect(watchr.isIgnored(ignoredFilePath, /\.log$/)).toBe(true);
			expect(watchr.isIgnored(includedFilePath, /\.log$/)).toBe(false);

			watchr.close();
		});

		it('should apply glob-like native string ignores', async () => {
			const logsDirectory = join(testDir, 'logs');
			mkdirSync(logsDirectory, { recursive: true });
			const ignoredFilePath = join(logsDirectory, 'ignored.log');
			const includedFilePath = join(logsDirectory, 'included.txt');

			const watchr = new Watchr(testDir, { ignore: '**/*.log' });
			await watchr.readyLock;

			expect(watchr.isIgnored(ignoredFilePath, '**/*.log')).toBe(true);
			expect(watchr.isIgnored(includedFilePath, '**/*.log')).toBe(false);

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
			expect(error.message).not.toContain(nonExistentPath);
			watchr.close();
		});

		it('should reject readyLock when startup fails', async () => {
			const watchr = new Watchr(join(testDir, 'missing-startup-root'));
			watchr.on(WatcherEvent.ERROR, vi.fn());

			await expect(watchr.readyLock).rejects.toThrow('Path not found');
			expect(watchr.isReady()).toBe(false);
			watchr.close();
		});

		it.skipIf(process.platform === 'win32')('should emit an error for unsupported file types', async () => {
			const unsupportedPath = join(testDir, 'unsupported-file');
			const server = createServer();
			await new Promise<void>((resolveListen, rejectListen) => {
				server.once('error', rejectListen);
				server.listen(unsupportedPath, resolveListen);
			});

			const watchr = new Watchr(unsupportedPath);
			try {
				const error = await new Promise<Error>((resolveError) => watchr.once(WatcherEvent.ERROR, resolveError));
				expect(error.message).toContain('Target path type is not supported');
				expect(error.message).not.toContain(unsupportedPath);
			} finally {
				watchr.close();
				server.close();
			}
		});

		it('should not watch if closed during setup', async () => {
			const watchr = new Watchr(testDir);
			watchr.close();
			await expect(watchr.readyLock).rejects.toThrow('watcher closed before becoming ready');

			const handler = vi.fn();
			watchr.on(WatcherEvent.ALL, handler);

			// A control watcher on the same directory bounds the wait deterministically:
			// once it observes the new file, the closed watcher had every chance to react.
			const control = new Watchr(testDir, { ignoreInitial: true });
			await control.readyLock;
			const controlEvent = waitForEvent(control, FileSystemEvent.ADD, join(testDir, 'newfile.txt'));

			createTestFile('newfile.txt');
			await controlEvent;
			control.close();

			expect(handler).not.toHaveBeenCalled();
		});

		it('should emit "ready" once during startup', async () => {
			const watchr = new Watchr(testDir);
			const readySpy = vi.fn();
			watchr.on(WatcherEvent.READY, readySpy);
			await watchr.readyLock;
			await settle();

			expect(readySpy).toHaveBeenCalledTimes(1);
			watchr.close();
		});

		it('should reject readyLock if closed before ready', async () => {
			const watchr = new Watchr(testDir);
			watchr.close();

			await expect(watchr.readyLock).rejects.toThrow('watcher closed before becoming ready');
		});
	});

	describe('close', () => {
		it('should stop watching for changes', async () => {
			const watchr = new Watchr(testDir);
			await watchr.readyLock;
			const handler = vi.fn();
			watchr.on(FileSystemEvent.ADD, handler);
			watchr.close();

			// A control watcher bounds the wait: once it sees the file, the closed watcher had its chance.
			const control = new Watchr(testDir, { ignoreInitial: true });
			await control.readyLock;
			const controlEvent = waitForEvent(control, FileSystemEvent.ADD, join(testDir, 'newfile.txt'));

			createTestFile('newfile.txt');
			await controlEvent;
			control.close();

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

		it('should dispose through Symbol.dispose', async () => {
			const watchr = new Watchr(testDir);
			await watchr.readyLock;
			const closeSpy = vi.fn();

			watchr.on(WatcherEvent.CLOSE, closeSpy);
			watchr[Symbol.dispose]();

			expect(watchr.isClosed()).toBe(true);
			expect(watchr.abortSignal.aborted).toBe(true);
			expect(closeSpy).toHaveBeenCalledTimes(1);
		});

		it('should not emit "close" more than once when disposed after close', async () => {
			const watchr = new Watchr(testDir);
			await watchr.readyLock;
			const closeSpy = vi.fn();

			watchr.on(WatcherEvent.CLOSE, closeSpy);
			watchr.close();
			watchr[Symbol.dispose]();

			expect(closeSpy).toHaveBeenCalledTimes(1);
		});

	});

	describe('safe emission boundary', () => {
		it('should emit error before close when startup fails and emit close exactly once', async () => {
			const watchr = new Watchr(join(testDir, 'missing-root'));
			const order: string[] = [];
			watchr.on(WatcherEvent.ERROR, () => order.push('error'));
			watchr.on(WatcherEvent.CLOSE, () => order.push('close'));

			await expect(watchr.readyLock).rejects.toThrow('Path not found');
			await settle();

			expect(order).toEqual([ 'error', 'close' ]);
			expect(watchr.isClosed()).toBe(true);
		});
	});

	describe('watch behavior', () => {
		it('should allow a new watcher to start after a previous initialization fails', async () => {
			const failed = new Watchr(join(testDir, 'missing'));
			failed.on(WatcherEvent.ERROR, () => undefined);
			await expect(failed.readyLock).rejects.toThrow('Path not found');
			const recovered = new Watchr(testDir);
			await recovered.readyLock;
			expect(recovered.isClosed()).toBe(false);
			recovered.close();
		});

		it('should emit an error when a user event handler throws', async () => {
			const throwingHandler = vi.fn(() => {
				throw new Error('handler exploded');
			});

			const watchr = new Watchr(testDir, { ignoreInitial: true, renameTimeout: 0 }, throwingHandler);
			await watchr.readyLock;

			const errorPromise = new Promise<Error>((resolve, reject) => {
				const timeoutId = globalThis.setTimeout(() => {
					watchr.off(WatcherEvent.ERROR, onError);
					reject(new Error('timed out waiting for thrown handler error'));
				}, 2000);

				const onError = (error: Error) => {
					clearTimeout(timeoutId);
					watchr.off(WatcherEvent.ERROR, onError);
					resolve(error);
				};

				watchr.on(WatcherEvent.ERROR, onError);
			});

			createTestFile('handler-throws.txt');
			const error = await errorPromise;

			expect(error.message).toBe('handler exploded');
			expect(throwingHandler).toHaveBeenCalled();
			watchr.close();
		});
	});

	describe('watchFile', () => {
		it('should watch a direct file target and emit change events', async () => {
			const filePath = join(testDir, 'direct-file.txt');
			createTestFile('direct-file.txt');

			const watchr = new Watchr(filePath, { ignoreInitial: true });
			await watchr.readyLock;

			const changePromise = waitForEvent(watchr, FileSystemEvent.CHANGE, filePath);
			appendFileSync(filePath, 'more content');

			expect(await changePromise).toBe(filePath);

			watchr.close();
		});
	});

	describe('watchPath', () => {
		it('should not watch an ignored path', async () => {
			const options = {
				ignore: (path: string) => path.endsWith('ignored.txt')
			};
			const watchr = new Watchr([], options);

			// Track events to verify ignored files don't produce events
			const events: Array<{ event: string, path: string }> = [];
			watchr.on('add', (_stats, path) => events.push({ event: 'add', path }));
			watchr.on('addDir', (_stats, path) => events.push({ event: 'addDir', path }));

			const ignoredPath = join(testDir, 'ignored.txt');
			createTestFile('ignored.txt');

			await watchr.watchPath(ignoredPath, options);

			// watchPath resolves after setup; drain scheduled turns for any stray events.
			await settle();

			// Should not generate events for ignored paths
			const ignoredEvents = events.filter(e => e.path === ignoredPath);
			expect(ignoredEvents.length).toBe(0);

			watchr.close();
		});

		it('should emit a safe error when ignore callback throws', async () => {
			const options = {
				ignore: () => {
					throw new Error('ignore exploded');
				}
			};
			const watchr = new Watchr([], options);
			const targetPath = join(testDir, 'callback-throw.txt');
			createTestFile('callback-throw.txt');

			const errorPromise = new Promise<Error>((resolve) => {
				watchr.once(WatcherEvent.ERROR, resolve);
			});

			await watchr.watchPath(targetPath, options);
			const error = await errorPromise;

			expect(error).toBeInstanceOf(Error);
			expect(error.message).toBe('ignore callback failed.');

			watchr.close();
		});

		it('should emit a safe error when a nested ignore callback throws', async () => {
			const options = {
				ignore: [ 'ignored.txt', () => { throw new Error('nested ignore exploded') } ]
			};
			const watchr = new Watchr([]);
			const errorPromise = new Promise<Error>((resolve) => watchr.once(WatcherEvent.ERROR, resolve));

			await watchr.watchPath(join(testDir, 'callback-array-throw.txt'), options);
			await expect(errorPromise).resolves.toMatchObject({ message: 'ignore callback failed.' });
			watchr.close();
		});

		it('should only watch the specified file when a file path is given', async () => {
			const watchedFile = 'watched.txt';
			const unwatchedFile = 'unwatched.txt';
			createTestFile(watchedFile);
			createTestFile(unwatchedFile);

			const watchr = new Watchr(join(testDir, watchedFile));
			await watchr.readyLock;

			const events: Array<{ event: string, path: string }> = [];
			watchr.on(WatcherEvent.ALL, (event: string, _stats: unknown, path: string) => events.push({ event, path }));

			// The initial add is held for `renameTimeout`; a change inside that window folds into it,
			// so let it settle before modifying the watched file.
			await waitForEvent(watchr, FileSystemEvent.ADD, join(testDir, watchedFile));

			// Modify the unwatched sibling first; the watched-file change below bounds the wait,
			// since both files share the same underlying directory watcher.
			appendFileSync(join(testDir, unwatchedFile), ' more content');
			const changePromise = waitForEvent(watchr, FileSystemEvent.CHANGE, join(testDir, watchedFile));
			appendFileSync(join(testDir, watchedFile), ' more content');
			await changePromise;

			expect(events).toEqual([
				{ event: FileSystemEvent.ADD, path: join(testDir, watchedFile) },
				{ event: FileSystemEvent.CHANGE, path: join(testDir, watchedFile) }
			]);

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

		it('should emit events for consecutive atomic saves on a watched file path', async () => {
			createTestFile('atomic.txt', 'initial content');
			const filePath = join(testDir, 'atomic.txt');
			const watchr = new Watchr(filePath, { ignoreInitial: true, renameTimeout: 50 });
			await watchr.readyLock;

			const waitForFileEvent = () => new Promise<void>((resolve, reject) => {
				const timeoutId = globalThis.setTimeout(() => {
					watchr.off(WatcherEvent.ALL, onAll);
					reject(new Error('timed out waiting for event after atomic save'));
				}, 2000);

				const onAll = (_event: FileSystemEvent, _stats: unknown, targetPath?: string, targetPathNext?: string) => {
					if (targetPath === filePath || targetPathNext === filePath) {
						clearTimeout(timeoutId);
						watchr.off(WatcherEvent.ALL, onAll);
						resolve();
					}
				};

				watchr.on(WatcherEvent.ALL, onAll);
			});

			const atomicSave = (content: string) => {
				const tempPath = join(testDir, '.atomic.txt.tmp');
				writeFileSync(tempPath, content);
				renameSync(tempPath, filePath);
			};

			atomicSave('content one');
			await waitForFileEvent();
			atomicSave('content two');
			await waitForFileEvent();
			atomicSave('content three');
			await waitForFileEvent();

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
				watchr.on(FileSystemEvent.RENAME, (stats, path, newPath) => {
					expect(path).toBe(join(testDir, 'old.txt'));
					expect(newPath).toBe(join(testDir, 'new.txt'));
					expect(stats).toBeDefined();
					expect(typeof stats.size).toBe('number');
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

	describe('recursive watching behavior', () => {
		it('should emit events for nested paths when watching recursively', async () => {
			const level1 = join(testDir, 'level1');
			const level2 = join(level1, 'level2');
			mkdirSync(level2, { recursive: true });

			const watchr = new Watchr(testDir, { recursive: true, ignoreInitial: true });
			await watchr.readyLock;

			const nestedFile = join(level2, 'nested.txt');
			const addPromise = waitForEvent(watchr, FileSystemEvent.ADD, nestedFile);

			writeFileSync(nestedFile, 'nested');

			expect(await addPromise).toBe(nestedFile);

			watchr.close();
		});

		it('should default to recursive: scan and watch nested paths (B6)', async () => {
			const nestedDir = join(testDir, 'nested');
			const nestedFile = join(nestedDir, 'existing.txt');
			mkdirSync(nestedDir);
			writeFileSync(nestedFile, 'x');

			const watchr = new Watchr(testDir, { renameTimeout: 0 });
			const initialAdds: string[] = [];
			watchr.on(FileSystemEvent.ADD, (_stats, path) => initialAdds.push(path));
			await watchr.readyLock;
			await settle();

			expect(initialAdds).toContain(nestedFile);

			const liveNested = join(nestedDir, 'live.txt');
			const added = waitForEvent(watchr, FileSystemEvent.ADD, liveNested);
			writeFileSync(liveNested, 'y');
			expect(await added).toBe(liveNested);

			watchr.close();
		});

		it('should neither scan nor watch nested paths when recursive is false (B6)', async () => {
			const nestedDir = join(testDir, 'nested');
			const nestedFile = join(nestedDir, 'existing.txt');
			const topFile = join(testDir, 'top.txt');
			mkdirSync(nestedDir);
			writeFileSync(nestedFile, 'x');
			writeFileSync(topFile, 'x');

			const watchr = new Watchr(testDir, { recursive: false, renameTimeout: 0 });
			const events: Array<{ event: string, path: string }> = [];
			watchr.on(WatcherEvent.ALL, (event: string, _stats: unknown, path: string) => events.push({ event, path }));
			await watchr.readyLock;
			await settle();

			expect(events).toContainEqual({ event: FileSystemEvent.ADD_DIR, path: nestedDir });
			expect(events).toContainEqual({ event: FileSystemEvent.ADD, path: topFile });
			expect(events.some(({ path }) => path === nestedFile)).toBe(false);

			events.length = 0;
			writeFileSync(join(nestedDir, 'live.txt'), 'y');
			appendFileSync(nestedFile, 'more');
			await new Promise((resolve) => setTimeout(resolve, 300));

			// Only the nested directory itself may surface (its mtime changed); nothing beneath it does.
			expect(events.filter(({ path }) => path.startsWith(nestedDir + '/'))).toEqual([]);

			watchr.close();
		});
	});
});

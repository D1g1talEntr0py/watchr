import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHook } from 'node:async_hooks';
import { linkSync, mkdirSync, renameSync, rmSync, stat, statSync, symlinkSync, watch, watchFile, unwatchFile, writeFileSync, type FSWatcher, type Stats, type BigIntStats } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { FileSystemEvent } from '../src/watchr';
import { FileSystem } from '../src/file-system';
import { FileSystemEventManager } from '../src/file-system-event-manager';
import { FileSystemStateManager } from '../src/file-system-state-manager';
import { observeEvent, cleanupTempRoots, closeWatchers, collectEvents, createWatcher, createReadyWatcher, createTempRoot, settle, waitForEvent } from './helpers/fs-fixtures';

const { nativeWatchers, rootStatListeners, scans } = vi.hoisted(() => ({
	nativeWatchers: new Map<string, FSWatcher>(),
	rootStatListeners: new Map<string, (current: Stats, previous: Stats) => void>(),
	scans: { gate: undefined as Promise<void> | undefined, failure: undefined as Error | undefined }
}));

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>();

	return {
		...actual,
		stat: vi.fn(actual.stat),
		watchFile: vi.fn((target: string, _options: unknown, listener: (current: Stats, previous: Stats) => void) => {
			rootStatListeners.set(target, listener);
		}),
		unwatchFile: vi.fn(),
		watch: vi.fn((target: string) => {
			const watcher = new EventEmitter() as FSWatcher;
			watcher.close = vi.fn(() => { watcher.emit('close') });
			watcher.ref = vi.fn(() => watcher);
			watcher.unref = vi.fn(() => watcher);
			nativeWatchers.set(target, watcher);
			return watcher;
		})
	};
});

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return {
		...actual,
		readdir: vi.fn(async (...args: Parameters<typeof actual.readdir>) => {
			await scans.gate;
			if (scans.failure !== undefined) { throw scans.failure }
			return actual.readdir(...args);
		})
	};
});

describe('Watchr native notification boundary', () => {
	beforeEach(async () => {
		const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
		vi.mocked(stat).mockImplementation(actual.stat);
	});

	afterEach(() => {
		closeWatchers();
		cleanupTempRoots();
		nativeWatchers.clear();
		rootStatListeners.clear();
		scans.gate = undefined;
		scans.failure = undefined;
		vi.mocked(readdir).mockClear();
		vi.mocked(stat).mockReset();
		vi.mocked(watch).mockClear();
		vi.mocked(watchFile).mockClear();
		vi.mocked(unwatchFile).mockClear();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it.each([ false, true ])('admits repeated live notifications synchronously without ingress promises (file target=%s)', async (fileTarget) => {
		const root = createTempRoot();
		const file = join(root, 'entry.txt');
		writeFileSync(file, 'original');
		const watcher = await createReadyWatcher(fileTarget ? file : root);
		const { events } = collectEvents(watcher);
		const update = vi.spyOn(FileSystemStateManager.prototype, 'update');
		writeFileSync(file, 'changed contents');
		const listener = nativeWatchers.get(root)!.listeners('change')[0]!;
		let promises = 0;
		const hook = createHook({ init: (_asyncId, type) => { if (type === 'PROMISE') { promises++ } } });
		let firstResult: unknown;
		let repeatedResult: unknown;
		let firstPromises: number;
		hook.enable();
		try {
			firstResult = listener('change', 'entry.txt');
			firstPromises = promises;
			promises = 0;
			for (let index = 0; index < 20; index++) { repeatedResult = listener('change', 'entry.txt') }
		} finally {
			hook.disable();
		}
		expect(firstResult).toBeUndefined();
		expect(repeatedResult).toBeUndefined();
		expect(firstPromises).toBe(2);
		expect(promises).toBe(0);
		expect(update).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(events).toHaveLength(1));
		expect(update.mock.calls.map(([ path ]) => path)).toEqual([ file ]);
	});

	it.each([ false, true ])('serializes coalesced admission behind in-flight stats and suppresses close (close=%s)', async (close) => {
		const root = createTempRoot();
		const first = join(root, 'first.txt');
		const second = join(root, 'second.txt');
		const watcher = await createReadyWatcher(root);
		const { events } = collectEvents(watcher);
		writeFileSync(first, 'first');
		writeFileSync(second, 'second');
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const getStats = FileSystem.getStats;
		const stats = vi.spyOn(FileSystem, 'getStats').mockImplementation(async (path, options) => {
			if (path === first) {
				entered.resolve();
				await release.promise;
			}
			return getStats(path, options);
		});
		const native = nativeWatchers.get(root)!;
		try {
			native.emit('change', 'rename', 'first.txt');
			await entered.promise;
			for (let index = 0; index < 20; index++) { native.emit('change', 'rename', 'second.txt') }
			await settle(10);
			expect(stats.mock.calls.map(([ path ]) => path)).toEqual([ first ]);
			if (close) { watcher.close() }
		} finally {
			release.resolve();
		}
		if (close) {
			await settle();
			expect(events).toEqual([]);
			expect(stats.mock.calls.map(([ path ]) => path)).toEqual([ first ]);
		} else {
			await vi.waitFor(() => expect(events).toHaveLength(2));
			expect(events.map(({ path }) => path)).toEqual([ first, second ]);
			expect(stats.mock.calls.map(([ path ]) => path)).toEqual([ first, second ]);
		}
	});

	it('awaits custom handlers before admitting the next bounded fallback chunk', async () => {
		const root = createTempRoot();
		for (let index = 0; index < 33; index++) { writeFileSync(join(root, `entry-${index}.txt`), 'entry') }
		const release = Promise.withResolvers<void>();
		const admitted: string[] = [];
		const completed: string[] = [];
		const newInstance = FileSystemEventManager.newInstance;
		vi.spyOn(FileSystemEventManager, 'newInstance').mockImplementation((poller, watchr, config, hooks) => newInstance(poller, watchr, {
			...config,
			nodeHandler: async (_event, path = '', initial = false) => {
				if (initial) { await poller.update(path, { sync: true }); return }
				admitted.push(path);
				await release.promise;
				completed.push(path);
			}
		}, hooks));
		await createReadyWatcher(root);
		scans.gate = release.promise;
		try {
			nativeWatchers.get(root)!.emit('change', 'change', '');
			expect(admitted).toHaveLength(32);
			await settle(10);
			expect(admitted).toHaveLength(32);
			expect(completed).toEqual([]);
		} finally {
			release.resolve();
		}
		await vi.waitFor(() => expect(completed.length).toBeGreaterThanOrEqual(34));
		expect(new Set(completed).size).toBe(34);
	});

	it.each([ 'throw', 'reject' ])('observes a custom live handler %s without unhandled rejection', async (action) => {
		const root = createTempRoot();
		const failure = new Error('custom live failure');
		const errors: Error[] = [];
		const newInstance = FileSystemEventManager.newInstance;
		vi.spyOn(FileSystemEventManager, 'newInstance').mockImplementation((poller, watchr, config, hooks) => newInstance(poller, watchr, {
			...config,
			nodeHandler: (_event, path = '', initial = false) => {
				if (initial) { return poller.update(path, { sync: true }).then(() => {}) }
				if (action === 'throw') { throw failure }
				return Promise.reject(failure);
			}
		}, hooks));
		await createReadyWatcher(root, { handlers: { error: (error) => { errors.push(error) } } });
		nativeWatchers.get(root)!.emit('change', 'change', 'entry.txt');
		await vi.waitFor(() => expect(errors).toEqual([ failure ]));
	});

	it.each([ false, true ])('awaits asynchronous initial failure without live delivery (custom=%s)', async (custom) => {
		const root = createTempRoot();
		const release = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const failure = new Error('asynchronous initial failure');
		const failInitial = async () => {
			entered.resolve();
			await release.promise;
			throw failure;
		};
		if (custom) {
			const newInstance = FileSystemEventManager.newInstance;
			vi.spyOn(FileSystemEventManager, 'newInstance').mockImplementation((poller, watchr, config, hooks) => newInstance(poller, watchr, {
				...config,
				nodeHandler: (_event, _path, initial = false) => initial ? failInitial() : Promise.resolve()
			}, hooks));
		} else {
			vi.spyOn(FileSystemStateManager.prototype, 'update').mockImplementation(failInitial);
		}
		const all = vi.fn();
		const error = vi.fn();
		const watcher = createWatcher(root, { emitInitial: true, handlers: { all, error } });
		const rejected = expect(watcher.start()).rejects.toThrow('asynchronous initial failure');
		try {
			await entered.promise;
			expect(watcher.state).toBe('starting');
			nativeWatchers.get(root)!.emit('change', 'change', 'entry.txt');
			expect(all).not.toHaveBeenCalled();
		} finally {
			release.resolve();
		}
		await rejected;
		expect(watcher.state).toBe('closed');
		expect(all).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
	});

	it.skipIf(process.platform === 'win32').each([ false, true ])('seeds initial state and symlink stats before live changes (emitInitial=%s)', async (emitInitial) => {
		const root = createTempRoot();
		const file = join(root, 'entry.txt');
		const ignored = join(root, 'ignored.txt');
		const linked = join(root, 'linked.txt');
		const outside = join(createTempRoot(), 'target.txt');
		writeFileSync(file, 'original');
		writeFileSync(ignored, 'ignored');
		writeFileSync(outside, 'linked');
		symlinkSync(outside, linked);
		const update = vi.spyOn(FileSystemStateManager.prototype, 'update');
		const watcher = await createReadyWatcher(root, { emitInitial, ignore: (path) => path === ignored });
		const { events } = collectEvents(watcher);
		expect(update.mock.calls.map(([ path ]) => path).sort()).toEqual([ root, file, linked ].sort());
		for (const [ path, options ] of update.mock.calls) {
			expect(options).toMatchObject({ sync: true, followSymlinks: true, signal: expect.any(AbortSignal) });
			expect(options?.timeout).toBeUndefined();
			expect(options?.isSymbolicLink === true).toBe(path === linked);
		}
		if (emitInitial) {
			expect(events.map(({ path }) => path).sort()).toEqual([ root, file, linked ].sort());
			expect(events.every(({ initial }) => initial)).toBe(true);
			expect(events.find(({ path }) => path === linked)?.stats.isSymbolicLink()).toBe(true);
		} else {
			expect(events).toEqual([]);
		}
		events.length = 0;
		writeFileSync(file, 'changed contents');
		nativeWatchers.get(root)!.emit('change', 'change', 'entry.txt');
		await vi.waitFor(() => expect(events).toHaveLength(1));
		expect(events[0]).toMatchObject({ event: FileSystemEvent.CHANGE, path: file, initial: false, stats: { size: 16 } });
	});

	it.runIf(process.platform === 'darwin').each([ 1, 2 ])('recovers macOS startup additions across %s roots without notifications and stops reconciling', async (rootCount) => {
		vi.useFakeTimers({ toFake: [ 'setTimeout', 'clearTimeout' ] });
		const roots = Array.from({ length: rootCount }, () => createTempRoot());
		const watcher = await createReadyWatcher(roots, { emitInitial: false, persistent: false, renameTimeout: 0 });
		const { events } = collectEvents(watcher);
		const first = join(roots[0]!, 'first.txt');
		const second = join(roots[rootCount - 1]!, 'second.txt');
		writeFileSync(first, 'first');
		await vi.advanceTimersByTimeAsync(100);
		await vi.waitFor(() => expect(events.find(({ path }) => path === first)?.event).toBe(FileSystemEvent.ADD));
		writeFileSync(second, 'second');
		await vi.advanceTimersByTimeAsync(250);
		await vi.waitFor(() => expect(events.find(({ path }) => path === second)?.event).toBe(FileSystemEvent.ADD));
		await vi.advanceTimersByTimeAsync(500);
		await vi.advanceTimersByTimeAsync(1000);
		await vi.waitFor(() => expect(readdir).toHaveBeenCalledTimes(5 * rootCount));
		await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
		await settle();
		expect(events).toHaveLength(2);
		const scansBefore = vi.mocked(readdir).mock.calls.length;
		await vi.advanceTimersByTimeAsync(5000);
		expect(readdir).toHaveBeenCalledTimes(scansBefore);
		watcher.close();
	});

	it.each([ 'close', 'throw', 'reject' ])('honors %s from a callback during a completed default batch', async (action) => {
		const root = createTempRoot();
		const errors: Error[] = [];
		const seen: string[] = [];
		const watcher = await createReadyWatcher(root, {
			handlers: {
				all: (event) => {
					seen.push(event.type);
					if (seen.length !== 1) { return }
					if (action === 'close') { watcher.close(); return }
					const failure = new Error('application callback failed');
					if (action === 'throw') { throw failure }
					return Promise.reject(failure);
				},
				error: (error) => { errors.push(error) }
			}
		});
		writeFileSync(join(root, 'first.txt'), 'first');
		writeFileSync(join(root, 'second.txt'), 'second');
		const native = nativeWatchers.get(root)!;
		native.emit('change', 'rename', 'first.txt');
		native.emit('change', 'rename', 'second.txt');
		await vi.waitFor(() => expect(seen).toHaveLength(action === 'close' ? 1 : 2));
		await settle();
		expect(seen).toEqual(action === 'close' ? [ FileSystemEvent.ADD ] : [ FileSystemEvent.ADD, FileSystemEvent.ADD ]);
		expect(errors).toHaveLength(action === 'close' ? 0 : 1);
		expect(watcher.state).toBe(action === 'close' ? 'closed' : 'watching');
	});

	it.each([ false, true ])('correlates a default completed rename batch (destination notification first=%s)', async (destinationFirst) => {
		const root = createTempRoot();
		const source = join(root, 'source.txt');
		const target = join(root, 'target.txt');
		writeFileSync(source, 'contents');
		const watcher = await createReadyWatcher(root);
		const { events } = collectEvents(watcher);
		renameSync(source, target);
		const native = nativeWatchers.get(root)!;
		for (const name of destinationFirst ? [ 'target.txt', 'source.txt' ] : [ 'source.txt', 'target.txt' ]) { native.emit('change', 'rename', name) }
		await vi.waitFor(() => expect(events).toHaveLength(1));
		expect(events[0]).toMatchObject({ event: FileSystemEvent.RENAME, path: source, pathNext: target, initial: false, stats: { size: 8 } });
		await settle();
		expect(events).toHaveLength(1);
	});

	it('keeps an atomic-save change independent of the temporary unlink at the default', async () => {
		const root = createTempRoot();
		const target = join(root, 'target.txt');
		const temporary = join(root, 'temp.txt');
		writeFileSync(target, 'old');
		writeFileSync(temporary, 'replacement');
		const watcher = await createReadyWatcher(root);
		const { events } = collectEvents(watcher);
		renameSync(temporary, target);
		const native = nativeWatchers.get(root)!;
		native.emit('change', 'rename', 'temp.txt');
		native.emit('change', 'rename', 'target.txt');
		await vi.waitFor(() => expect(events).toHaveLength(2));
		expect(events.map(({ event, path }) => [ event, path ]).sort()).toEqual([[ FileSystemEvent.CHANGE, target ], [ FileSystemEvent.UNLINK, temporary ]].sort());
	});

	it.runIf(process.platform === 'darwin')('cancels macOS directory startup reconciliation on close', async () => {
		vi.useFakeTimers({ toFake: [ 'setTimeout', 'clearTimeout' ] });
		const root = createTempRoot();
		const watcher = await createReadyWatcher(root, { emitInitial: false, persistent: false });
		const { events } = collectEvents(watcher);
		watcher.close();
		vi.mocked(readdir).mockClear();
		writeFileSync(join(root, 'after.txt'), 'after close');
		await vi.advanceTimersByTimeAsync(5000);
		await settle();

		expect(readdir).not.toHaveBeenCalled();
		expect(events).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.runIf(process.platform === 'win32')('detects Windows root deletion through stat polling and releases the polling listener', async () => {
		const root = createTempRoot();
		const watcher = await createReadyWatcher(root, { emitInitial: false, renameTimeout: 0 });
		const { events } = collectEvents(watcher);
		expect(watchFile).toHaveBeenCalledWith(root, { interval: 100, persistent: true }, expect.any(Function));
		const listener = rootStatListeners.get(root)!;
		const previous = statSync(root);
		listener(previous, previous);
		expect(events).toEqual([]);
		rmSync(root, { recursive: true });
		listener({ ...previous, nlink: 0 }, previous);

		await vi.waitFor(() => expect(events.find(({ path }) => path === root)?.event).toBe(FileSystemEvent.UNLINK_DIR));
		expect(nativeWatchers.get(root)!.close).toHaveBeenCalled();
		expect(unwatchFile).toHaveBeenCalledWith(root, listener);
		expect(watcher.state).not.toBe('closed');
	});

	it.runIf(process.platform === 'win32')('removes Windows root stat polling on close without waiting for deletion', async () => {
		const root = createTempRoot();
		const watcher = await createReadyWatcher(root, { emitInitial: false, persistent: false });
		expect(watchFile).toHaveBeenCalledWith(root, { interval: 100, persistent: false }, expect.any(Function));
		const listener = rootStatListeners.get(root)!;
		watcher.close();

		expect(unwatchFile).toHaveBeenCalledWith(root, listener);
	});

	it.runIf(process.platform === 'darwin').each([ false, true ])('recovers a missed macOS file notification through stat polling (emitInitial=%s)', async (emitInitial) => {
		vi.useFakeTimers({ toFake: [ 'setInterval', 'clearInterval' ] });
		const root = createTempRoot();
		const file = join(root, 'watched.txt');
		writeFileSync(file, 'original');
		const watcher = await createReadyWatcher(file, { emitInitial, persistent: false });
		const { events } = collectEvents(watcher);
		if (emitInitial) {
			await vi.waitFor(() => expect(events[0]).toMatchObject({ event: FileSystemEvent.ADD, path: file }));
			events.length = 0;
		}
		expect(vi.getTimerCount()).toBe(1);
		writeFileSync(file, 'missed native notification');
		await vi.advanceTimersByTimeAsync(100);

		await vi.waitFor(() => expect(events).toHaveLength(1));
		expect(events[0]).toMatchObject({ event: FileSystemEvent.CHANGE, path: file, stats: { size: 26 } });
		nativeWatchers.get(root)!.emit('change', 'change', 'watched.txt');
		await settle();
		expect(events).toHaveLength(1);
		watcher.close();
		expect(vi.getTimerCount()).toBe(0);
		writeFileSync(file, 'after close');
		await vi.advanceTimersByTimeAsync(500);
		await settle();
		expect(events).toHaveLength(1);
	});

	it.each([ 'linux', 'darwin' ].filter((platform) => platform === process.platform))('selects the native parent watcher mode for a file on %s and filters siblings', async (platform) => {
		// Any target stat still running on the threadpool can observe writeFileSync's truncation as an extra change.
		vi.useFakeTimers({ toFake: [ 'setInterval', 'clearInterval' ] });
		const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
		const root = createTempRoot();
		const file = join(root, 'watched.txt');
		const sibling = join(root, 'sibling.txt');
		writeFileSync(file, 'original');
		writeFileSync(sibling, 'sibling');
		const watcher = await createReadyWatcher(file, { emitInitial: false });
		expect(watch).toHaveBeenCalledWith(root, expect.objectContaining({ recursive: platform === 'darwin' }), expect.any(Function));
		const { events } = collectEvents(watcher);
		const native = nativeWatchers.get(root)!;
		const siblingStat = Promise.withResolvers<void>();
		vi.mocked(stat).mockImplementationOnce((path, options, callback) => actual.stat(path, options, (error, stats) => {
			callback(error, stats);
			siblingStat.resolve();
		}));
		writeFileSync(sibling, 'changed sibling');
		native.emit('change', 'change', 'sibling.txt');
		await siblingStat.promise;
		await settle();
		expect(events).toEqual([]);
		writeFileSync(file, 'changed watched file');
		native.emit('change', 'change', 'watched.txt');
		await vi.waitFor(() => expect(events).toHaveLength(1));
		expect(events[0]).toMatchObject({ event: FileSystemEvent.CHANGE, path: file });
	});

	it.runIf(process.platform === 'darwin').each([ false, true ])('discovers coalesced macOS additions (named entry is ignored symlink=%s)', async (symlink) => {
		const root = createTempRoot();
		const watcher = await createReadyWatcher(root, { emitInitial: false, followSymlinks: false, renameTimeout: 0 });
		const { events } = collectEvents(watcher);
		const first = join(root, 'first.txt');
		const second = join(root, 'second.txt');
		if (symlink) {
			const outside = join(createTempRoot(), 'target.txt');
			writeFileSync(outside, 'first');
			symlinkSync(outside, first);
		} else {
			writeFileSync(first, 'first');
		}
		writeFileSync(second, 'second');
		nativeWatchers.get(root)!.emit('change', 'rename', 'first.txt');

		const expectedPaths = symlink ? [ second ] : [ first, second ];
		await vi.waitFor(() => expect(events.filter(({ event }) => event === FileSystemEvent.ADD).map(({ path }) => path).sort()).toEqual(expectedPaths));
		await settle();
		expect(events).toHaveLength(expectedPaths.length);
	});

	it.each([ '', null ])('discovers new files through an unnamed notification (%s)', async (filename) => {
		const root = createTempRoot();
		const watcher = await createReadyWatcher(root, { emitInitial: false, renameTimeout: 0 });
		const { events } = collectEvents(watcher);
		const file = join(root, 'new.txt');
		writeFileSync(file, 'new contents');
		nativeWatchers.get(root)!.emit('change', 'rename', filename);

		await vi.waitFor(() => expect(events.filter(({ path }) => path === file)).toHaveLength(1));
		expect(events.find(({ path }) => path === file)).toMatchObject({ event: FileSystemEvent.ADD, stats: { size: 12 } });
		await settle();
		expect(events.filter(({ path }) => path === file)).toHaveLength(1);
	});

	it.each([ 'EIO', undefined ])('sanitizes native watcher errors with code %s', async (code) => {
		const root = createTempRoot();
		const watcher = await createReadyWatcher(root, { emitInitial: false });
		const errors: Error[] = [];
		observeEvent(watcher, 'error', (error) => errors.push(error));
		const original = Object.assign(new Error(`Cannot watch ${root}`), { code });
		nativeWatchers.get(root)!.emit('error', original);

		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({
			message: code === undefined ? 'Watcher error' : `Watcher error (${code})`,
			code: code ?? 'UNKNOWN',
			cause: original
		});
		expect(errors[0]?.message).not.toContain(root);
		expect(watcher.state).not.toBe('closed');
	});

	it.each([ false, true ])('reports a live stat failure immediately and recovers (multi-path=%s)', async (multiple) => {
		const root = createTempRoot();
		const file = join(root, 'file.txt');
		writeFileSync(file, 'original');
		const watcher = await createReadyWatcher(root, { emitInitial: false });
		const errors: Error[] = [];
		observeEvent(watcher, 'error', (error) => errors.push(error));
		const { events } = collectEvents(watcher);
		const failure = Object.assign(new Error('Stat operation timed out'), { code: 'WATCHR_STAT_TIMEOUT' });
		vi.spyOn(FileSystem, 'getStats').mockRejectedValueOnce(failure);
		const native = nativeWatchers.get(root)!;
		native.emit('change', 'change', 'file.txt');
		if (multiple) { native.emit('change', 'change', 'other.txt') }

		await vi.waitFor(() => expect(errors).toEqual([ failure ]));
		expect(watcher.state).not.toBe('closed');
		writeFileSync(file, 'recovered contents');
		native.emit('change', 'change', 'file.txt');
		await vi.waitFor(() => expect(events.find(({ path }) => path === file)).toMatchObject({ event: FileSystemEvent.CHANGE, stats: { size: 18 } }));
	});

	it.each([ 'failed-first', 'success-first', 'no-error', 'close' ])('preserves successful sibling deletion across native stat completion: %s', async (order) => {
		const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
		vi.mocked(stat).mockImplementation(actual.stat);
		const root = createTempRoot();
		const bad = join(root, 'bad.txt');
		const good = join(root, 'good.txt');
		writeFileSync(bad, 'bad');
		writeFileSync(good, 'good');
		const watcher = await createReadyWatcher(root, { renameTimeout: 0 });
		const { events } = collectEvents(watcher);
		const errors: Error[] = [];
		observeEvent(watcher, 'error', (error) => errors.push(error));
		const pending = new Map<string, (error: NodeJS.ErrnoException | null, stats?: BigIntStats) => void>();
		vi.mocked(stat).mockImplementation((path, _options, callback) => { pending.set(String(path), callback) });
		rmSync(good);
		if (order === 'no-error') { rmSync(bad) }
		const native = nativeWatchers.get(root)!;
		native.emit('change', 'rename', 'bad.txt');
		native.emit('change', 'rename', 'good.txt');
		await vi.waitFor(() => expect(pending.size).toBe(2));
		const failure = Object.assign(new Error('failed path'), { code: 'EIO' });
		const missing = Object.assign(new Error('missing path'), { code: 'ENOENT' });
		if (order === 'close') { watcher.close() }
		if (order === 'success-first') {
			pending.get(good)!(missing);
			await settle();
			expect(events).toEqual([]);
			pending.get(bad)!(failure);
		} else {
			pending.get(bad)!(order === 'no-error' ? missing : failure);
			if (order === 'failed-first') {
				await vi.waitFor(() => expect(errors).toEqual([ failure ]));
				expect(events).toEqual([]);
			}
			pending.get(good)!(missing);
		}
		vi.mocked(stat).mockImplementation(actual.stat);
		await vi.waitFor(() => expect(events).toHaveLength(order === 'close' ? 0 : order === 'no-error' ? 2 : 1));
		native.emit('change', 'rename', 'good.txt');
		await settle();
		expect(events.filter(({ path }) => path === good)).toHaveLength(order === 'close' ? 0 : 1);
		if (order !== 'close') { expect(events.find(({ path }) => path === good)).toMatchObject({ event: FileSystemEvent.UNLINK, stats: { size: 4 } }) }
		expect(errors).toEqual(order === 'no-error' || order === 'close' ? [] : [ failure ]);
	});

	it.each([
		[ 'delete', true, 'root-first', 0, 2 ],
		[ 'move', true, 'root-first', 0, 2 ],
		[ 'delete', false, 'root-first', 0, 2 ],
		[ 'move', false, 'root-first', 0, 2 ],
		[ 'move', true, 'root-first', 25, 2 ],
		[ 'delete', true, 'root-last', 0, 2 ],
		[ 'delete', true, 'root-first', 0, 40 ],
		[ 'close', true, 'root-first', 0, 2 ]
	] as const)('reconciles populated root %s (recursive=%s, %s, timeout=%s, files=%s)', async (operation, recursive, order, renameTimeout, count) => {
		vi.useFakeTimers({ toFake: [ 'setTimeout', 'clearTimeout', 'performance' ] });
		const parent = createTempRoot();
		const root = join(parent, 'root');
		const replacement = join(parent, 'replacement');
		for (const directory of [ root, replacement ]) {
			mkdirSync(join(directory, 'nested'), { recursive: true });
			for (let index = 0; index < count; index++) { writeFileSync(join(directory, `file-${index}.txt`), `file-${index}`) }
			writeFileSync(join(directory, 'nested', 'leaf.txt'), 'leaf');
		}
		const update = vi.spyOn(FileSystemStateManager.prototype, 'update');
		const watcher = await createReadyWatcher(root, { recursive, renameTimeout, persistent: false, fallbackScanInterval: 0 });
		const state = update.mock.contexts[0] as FileSystemStateManager;
		const inventory = [ ...state.stats.entries() ];
		expect(inventory).toHaveLength(count + (recursive ? 3 : 2));
		const { events } = collectEvents(watcher);
		const errors: Error[] = [];
		observeEvent(watcher, 'error', (error) => errors.push(error));
		const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
		const pending = new Map<string, (error: NodeJS.ErrnoException | null, stats?: BigIntStats) => void>();
		vi.mocked(stat).mockImplementation((path, _options, callback) => { pending.set(String(path), callback) });
		if (operation === 'move') { renameSync(root, join(parent, 'moved')) }
		else { rmSync(root, { recursive: true }) }
		const native = nativeWatchers.get(root)!;
		native.emit('change', 'rename', recursive ? '' : basename(root));
		await vi.waitFor(() => expect(pending.has(root)).toBe(true));
		await settle();
		if (operation === 'close') { watcher.close() }
		const paths = [ ...pending.keys() ].sort((left, right) => left === root ? (order === 'root-first' ? -1 : 1) : right === root ? (order === 'root-first' ? 1 : -1) : left.localeCompare(right));
		vi.mocked(stat).mockImplementation(actual.stat);
		for (const path of paths) { pending.get(path)!(Object.assign(new Error('missing'), { code: 'ENOENT' })) }
		if (operation === 'close') {
			await settle();
			renameSync(replacement, root);
			await vi.advanceTimersByTimeAsync(5000);
			await settle();
			expect(events).toEqual([]);
			expect(errors).toEqual([]);
			expect(state.stats.size).toBe(0);
			expect(watcher.abortSignal.aborted).toBe(true);
			expect(watch).toHaveBeenCalledTimes(1);
			return;
		}
		await vi.waitFor(() => expect(native.listenerCount('change')).toBe(0));
		await vi.advanceTimersByTimeAsync(renameTimeout);
		await settle();
		expect(events.map(({ event, path }) => [ event, path ]).sort()).toEqual(inventory.map(([ path, stats ]) => [ stats.isFile() ? FileSystemEvent.UNLINK : FileSystemEvent.UNLINK_DIR, path ]).sort());
		for (const [ path, stats ] of inventory) {
			expect(state.stats.has(path)).toBe(false);
			expect(state.paths.find(stats.inodeNumber, (candidate) => candidate === path)).toBeUndefined();
			expect(events.find((event) => event.path === path)?.stats).toBe(stats);
		}
		expect(watcher.state).toBe('watching');
		expect(watcher.abortSignal.aborted).toBe(false);
		events.length = 0;
		renameSync(replacement, root);
		await vi.advanceTimersByTimeAsync(100);
		await vi.waitFor(() => expect(nativeWatchers.get(root)).not.toBe(native));
		await vi.waitFor(() => expect(state.stats.size).toBe(inventory.length));
		await vi.advanceTimersByTimeAsync(renameTimeout);
		await vi.waitFor(() => expect(events).toHaveLength(inventory.length));
		expect(events.map(({ event, path }) => [ event, path ]).sort()).toEqual(inventory.map(([ path, stats ]) => [ stats.isFile() ? FileSystemEvent.ADD : FileSystemEvent.ADD_DIR, path ]).sort());
		events.length = 0;
		const file = join(root, 'file-0.txt');
		writeFileSync(file, 'after restoration');
		nativeWatchers.get(root)!.emit('change', 'change', 'file-0.txt');
		await vi.waitFor(() => expect(events).toHaveLength(1));
		expect(events[0]).toMatchObject({ event: FileSystemEvent.CHANGE, path: file });
		expect(errors).toEqual([]);
	});

	it.each([
		[ 'parent-first', 'parent-first', 'move' ],
		[ 'parent-first', 'child-first', 'move' ],
		[ 'child-first', 'parent-first', 'move' ],
		[ 'child-first', 'child-first', 'move' ],
		[ 'parent-first', 'parent-first', 'delete' ],
		[ 'parent-first', 'child-first', 'delete' ],
		[ 'child-first', 'parent-first', 'delete' ],
		[ 'child-first', 'child-first', 'delete' ]
	] as const)('restores overlapping roots (targets=%s, notifications=%s, operation=%s)', async (targetOrder, notificationOrder, operation) => {
		vi.useFakeTimers({ toFake: [ 'setTimeout', 'clearTimeout', 'performance' ] });
		const outside = createTempRoot();
		const parent = join(outside, 'parent');
		const child = join(parent, 'child');
		const leaf = join(child, 'leaf.txt');
		const replacement = join(outside, 'replacement');
		for (const directory of [ parent, replacement ]) {
			mkdirSync(join(directory, 'child'), { recursive: true });
			writeFileSync(join(directory, 'child', 'leaf.txt'), 'leaf');
		}
		const watcher = await createReadyWatcher(targetOrder === 'parent-first' ? [ parent, child ] : [ child, parent ], { recursive: false, persistent: false });
		const { events } = collectEvents(watcher);
		const errors: Error[] = [];
		observeEvent(watcher, 'error', (error) => errors.push(error));
		const parentNative = nativeWatchers.get(parent)!;
		const childNative = nativeWatchers.get(child)!;
		if (operation === 'move') { renameSync(parent, join(outside, 'moved')) }
		else { rmSync(parent, { recursive: true }) }
		const first = notificationOrder === 'parent-first' ? parent : child;
		const second = notificationOrder === 'parent-first' ? child : parent;
		nativeWatchers.get(first)!.emit('change', 'rename', basename(first));
		await vi.waitFor(() => expect(nativeWatchers.get(first)!.close).toHaveBeenCalled());
		nativeWatchers.get(second)!.emit('change', 'rename', basename(second));
		await vi.waitFor(() => expect(parentNative.close).toHaveBeenCalled());
		expect(childNative.close).toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(150);
		await vi.waitFor(() => expect(events).toHaveLength(3));
		expect(events.map(({ event, path }) => [ event, path ]).sort()).toEqual([
			[ FileSystemEvent.UNLINK_DIR, parent ], [ FileSystemEvent.UNLINK_DIR, child ], [ FileSystemEvent.UNLINK, leaf ]
		].sort());
		expect(watcher.abortSignal.aborted).toBe(false);
		events.length = 0;
		renameSync(replacement, parent);
		await vi.advanceTimersByTimeAsync(250);
		await vi.waitFor(() => expect(nativeWatchers.get(parent)).not.toBe(parentNative));
		await vi.waitFor(() => expect(nativeWatchers.get(child)).not.toBe(childNative));
		await vi.advanceTimersByTimeAsync(150);
		await vi.waitFor(() => expect(events).toHaveLength(3));
		expect(events.map(({ event, path }) => [ event, path ]).sort()).toEqual([
			[ FileSystemEvent.ADD_DIR, parent ], [ FileSystemEvent.ADD_DIR, child ], [ FileSystemEvent.ADD, leaf ]
		].sort());
		events.length = 0;
		writeFileSync(leaf, 'after recovery');
		nativeWatchers.get(child)!.emit('change', 'change', 'leaf.txt');
		await vi.waitFor(() => expect(events).toHaveLength(1));
		expect(events[0]).toMatchObject({ event: FileSystemEvent.CHANGE, path: leaf });
		expect(errors).toEqual([]);
	});

	it('stops automatic closures when the public watcher closes during root teardown', async () => {
		vi.useFakeTimers({ toFake: [ 'setTimeout', 'clearTimeout', 'performance' ] });
		const outside = createTempRoot();
		const parent = join(outside, 'parent');
		const child = join(parent, 'child');
		mkdirSync(child, { recursive: true });
		writeFileSync(join(child, 'leaf.txt'), 'leaf');
		const closeTargets = vi.fn<(folderPath?: string, filePath?: string) => void>();
		const newInstance = FileSystemEventManager.newInstance;
		vi.spyOn(FileSystemEventManager, 'newInstance').mockImplementation((poller, watchr, config, hooks) => {
			closeTargets.mockImplementation((folderPath, filePath) => {
				hooks.closeWatchers(folderPath, filePath);
				if (folderPath === parent && filePath === undefined) { watchr.close() }
			});
			return newInstance(poller, watchr, config, { ...hooks, closeWatchers: closeTargets });
		});
		const watcher = await createReadyWatcher([ parent, child ], { recursive: false, persistent: false, renameTimeout: 25 });
		const { events } = collectEvents(watcher);
		renameSync(parent, join(outside, 'moved'));
		nativeWatchers.get(parent)!.emit('change', 'rename', basename(parent));
		await vi.waitFor(() => expect(watcher.state).toBe('closed'));
		expect(closeTargets.mock.calls).toEqual([ [ outside, parent ], [ parent ] ]);
		mkdirSync(child, { recursive: true });
		await vi.advanceTimersByTimeAsync(5000);
		await settle();
		expect(watch).toHaveBeenCalledTimes(2);
		expect(events).toEqual([]);
		expect(watcher.abortSignal.aborted).toBe(true);
	});

	it('suppresses ignored tracked descendants during named subtree reconciliation', async () => {
		const root = createTempRoot();
		const subtree = join(root, 'nested');
		const leaf = join(subtree, 'leaf.txt');
		mkdirSync(subtree);
		writeFileSync(leaf, 'leaf');
		let ignoreLeaf = false;
		const ignore = vi.fn((path: string) => ignoreLeaf && path === leaf);
		const update = vi.spyOn(FileSystemStateManager.prototype, 'update');
		const watcher = await createReadyWatcher(root, { renameTimeout: 0, ignore });
		const state = update.mock.contexts[0] as FileSystemStateManager;
		const leafStats = state.stats.get(leaf)!;
		const { events } = collectEvents(watcher);
		ignoreLeaf = true;
		ignore.mockClear();
		update.mockClear();
		rmSync(subtree, { recursive: true });
		nativeWatchers.get(root)!.emit('change', 'rename', 'nested');
		await vi.waitFor(() => expect(events.some(({ path }) => path === subtree)).toBe(true));
		await settle();
		expect(events.map(({ event, path }) => [ event, path ])).toEqual([ [ FileSystemEvent.UNLINK_DIR, subtree ] ]);
		expect(update.mock.calls.map(([ path ]) => path)).toEqual([ subtree ]);
		expect(ignore.mock.calls.map(([ path ]) => path)).toEqual([ subtree, leaf ]);
		expect(state.stats.get(leaf)).toBe(leafStats);
		expect(state.paths.find(leafStats.inodeNumber, (path) => path === leaf)).toBe(leaf);
		ignoreLeaf = false;
		nativeWatchers.get(root)!.emit('change', 'rename', 'nested/leaf.txt');
		await vi.waitFor(() => expect(events).toHaveLength(2));
		expect(events[1]).toMatchObject({ event: FileSystemEvent.UNLINK, path: leaf, stats: leafStats });
		expect(state.stats.has(leaf)).toBe(false);
		expect(state.paths.find(leafStats.inodeNumber, (path) => path === leaf)).toBeUndefined();
	});

	it.each([ 'delete', 'move' ])('reconciles named subtree %s without descendant notifications', async (operation) => {
		const root = createTempRoot();
		const outside = createTempRoot();
		const subtree = join(root, 'nested');
		const leaf = join(subtree, 'leaf.txt');
		const replacement = join(outside, 'replacement');
		mkdirSync(subtree);
		mkdirSync(replacement);
		writeFileSync(leaf, 'old leaf');
		writeFileSync(join(replacement, 'leaf.txt'), 'replacement');
		const update = vi.spyOn(FileSystemStateManager.prototype, 'update');
		const watcher = await createReadyWatcher(root, { renameTimeout: 0 });
		const state = update.mock.contexts[0] as FileSystemStateManager;
		const oldStats = state.stats.get(leaf)!;
		const { events } = collectEvents(watcher);
		const errors: Error[] = [];
		observeEvent(watcher, 'error', (error) => errors.push(error));
		const native = nativeWatchers.get(root)!;
		if (operation === 'move') { renameSync(subtree, join(outside, 'moved')) }
		else { rmSync(subtree, { recursive: true }) }
		native.emit('change', 'rename', 'nested');
		await vi.waitFor(() => expect(events).toHaveLength(2));
		expect(events.map(({ event, path }) => [ event, path ]).sort()).toEqual([ [ FileSystemEvent.UNLINK_DIR, subtree ], [ FileSystemEvent.UNLINK, leaf ] ].sort());
		expect(state.stats.has(leaf)).toBe(false);
		expect(state.paths.find(oldStats.inodeNumber, (path) => path === leaf)).toBeUndefined();
		expect(events.find(({ path }) => path === leaf)?.stats).toBe(oldStats);
		native.emit('change', 'rename', 'nested');
		await settle();
		expect(events).toHaveLength(2);
		events.length = 0;
		renameSync(replacement, subtree);
		native.emit('change', 'rename', '');
		await vi.waitFor(() => expect(events).toHaveLength(2));
		expect(events.map(({ event, path }) => [ event, path ]).sort()).toEqual([ [ FileSystemEvent.ADD_DIR, subtree ], [ FileSystemEvent.ADD, leaf ] ].sort());
		events.length = 0;
		writeFileSync(leaf, 'changed after restore');
		native.emit('change', 'change', 'nested/leaf.txt');
		await vi.waitFor(() => expect(events).toHaveLength(1));
		expect(events[0]).toMatchObject({ event: FileSystemEvent.CHANGE, path: leaf });
		expect(native.close).not.toHaveBeenCalled();
		expect(errors).toEqual([]);
	});

	it('reconciles a directory-to-file replacement without removing surviving hardlink state', async () => {
		const root = createTempRoot();
		const subtree = join(root, 'nested');
		const leaf = join(subtree, 'leaf.txt');
		const sibling = join(root, 'linked.txt');
		mkdirSync(subtree);
		writeFileSync(leaf, 'linked contents');
		linkSync(leaf, sibling);
		const update = vi.spyOn(FileSystemStateManager.prototype, 'update');
		const watcher = await createReadyWatcher([ root, subtree ], { renameTimeout: 0 });
		const state = update.mock.contexts[0] as FileSystemStateManager;
		const leafStats = state.stats.get(leaf)!;
		const { events } = collectEvents(watcher);
		rmSync(subtree, { recursive: true });
		writeFileSync(subtree, 'replacement file');
		nativeWatchers.get(root)!.emit('change', 'rename', 'nested');
		await vi.waitFor(() => expect(events).toHaveLength(3));
		expect(events.map(({ event, path }) => [ event, path ]).sort()).toEqual([
			[ FileSystemEvent.UNLINK_DIR, subtree ], [ FileSystemEvent.ADD, subtree ], [ FileSystemEvent.UNLINK, leaf ]
		].sort());
		expect(events.find(({ path }) => path === leaf)?.pathNext).toBeUndefined();
		expect(events.find(({ path }) => path === leaf)?.stats).toBe(leafStats);
		expect(state.paths.find(leafStats.inodeNumber, (path) => path === leaf)).toBeUndefined();
		expect(state.paths.find(leafStats.inodeNumber, (path) => path === sibling)).toBe(sibling);
		expect(state.stats.has(sibling)).toBe(true);
		expect(nativeWatchers.get(root)!.close).not.toHaveBeenCalled();
	});

	it('correlates a populated in-root move across batches with an explicit positive rename window', async () => {
		vi.useFakeTimers({ toFake: [ 'setTimeout', 'clearTimeout', 'performance' ] });
		vi.advanceTimersByTime(50);
		const root = createTempRoot();
		const source = join(root, 'source');
		const target = join(root, 'target');
		mkdirSync(source);
		writeFileSync(join(source, 'leaf.txt'), 'leaf');
		const watcher = await createReadyWatcher(root, { renameTimeout: 25 });
		const { events } = collectEvents(watcher);
		renameSync(source, target);
		const native = nativeWatchers.get(root)!;
		const directoryRenamed = waitForEvent(watcher, FileSystemEvent.RENAME_DIR, { path: source });
		native.emit('change', 'rename', 'source');
		native.emit('change', 'rename', 'target');
		await directoryRenamed;
		const leafRenamed = waitForEvent(watcher, FileSystemEvent.RENAME, { path: join(source, 'leaf.txt') });
		native.emit('change', 'rename', '');
		await leafRenamed;
		expect(events).toHaveLength(2);
		expect(events).toEqual(expect.arrayContaining([
			expect.objectContaining({ event: FileSystemEvent.RENAME_DIR, path: source, pathNext: target }),
			expect.objectContaining({ event: FileSystemEvent.RENAME, path: join(source, 'leaf.txt'), pathNext: join(target, 'leaf.txt') })
		]));
		expect(native.close).not.toHaveBeenCalled();
	});

	it('preserves file-to-directory replacement events in a multi-path batch', async () => {
		const root = createTempRoot();
		const target = join(root, 'entry');
		const other = join(root, 'other.txt');
		writeFileSync(target, 'file');
		const watcher = await createReadyWatcher(root, { emitInitial: false, renameTimeout: 0 });
		const { events } = collectEvents(watcher);
		rmSync(target);
		mkdirSync(target);
		writeFileSync(other, 'other');
		const native = nativeWatchers.get(root)!;
		native.emit('change', 'rename', 'entry');
		native.emit('change', 'rename', 'other.txt');

		await vi.waitFor(() => expect(events.filter(({ path }) => path === target)).toHaveLength(2));
		expect(events.filter(({ path }) => path === target).map(({ event }) => event)).toEqual([
			FileSystemEvent.UNLINK,
			FileSystemEvent.ADD_DIR
		]);
		expect(events.find(({ path }) => path === other)?.event).toBe(FileSystemEvent.ADD);
	});

	it('coalesces notification storms during a scan and discovers files in the queued scan', async () => {
		const root = createTempRoot();
		const watcher = await createReadyWatcher(root, { emitInitial: false, renameTimeout: 0, fallbackScanInterval: 25 });
		const { events } = collectEvents(watcher);
		vi.mocked(readdir).mockClear();
		const scan = Promise.withResolvers<void>();
		scans.gate = scan.promise;
		const native = nativeWatchers.get(root)!;
		native.emit('change', 'change', '');
		await vi.waitFor(() => expect(readdir).toHaveBeenCalledTimes(1));

		for (let index = 0; index < 10; index++) { native.emit('change', 'rename', null) }
		expect(readdir).toHaveBeenCalledTimes(1);
		const file = join(root, 'queued.txt');
		writeFileSync(file, 'queued');
		scan.resolve();
		await vi.waitFor(() => expect(readdir).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(events.filter(({ path }) => path === file)).toHaveLength(1));
		expect(events.find(({ path }) => path === file)?.event).toBe(FileSystemEvent.ADD);
	});

	it('does not emit stale events after closing during a snapshot scan', async () => {
		const root = createTempRoot();
		const watcher = await createReadyWatcher(root, { emitInitial: false, renameTimeout: 0 });
		const { events } = collectEvents(watcher);
		vi.mocked(readdir).mockClear();
		const scan = Promise.withResolvers<void>();
		scans.gate = scan.promise;
		const native = nativeWatchers.get(root)!;
		native.emit('change', 'rename', '');
		await vi.waitFor(() => expect(readdir).toHaveBeenCalledOnce());
		writeFileSync(join(root, 'late.txt'), 'late');
		watcher.close();
		scan.resolve();
		await vi.waitFor(() => expect(vi.mocked(readdir).mock.settledResults[0]?.type).toBe('fulfilled'));
		await settle(10);
		expect(events).toEqual([]);
		expect(native.close).toHaveBeenCalled();
		expect(native.listenerCount('change')).toBe(0);
		expect(native.listenerCount('error')).toBe(0);
	});

	it('recovers on the next notification after a snapshot read fails', async () => {
		const root = createTempRoot();
		const watcher = await createReadyWatcher(root, { emitInitial: false, renameTimeout: 0, fallbackScanInterval: 0 });
		const { events } = collectEvents(watcher);
		vi.mocked(readdir).mockClear();
		scans.failure = Object.assign(new Error('snapshot unavailable'), { code: 'EIO' });
		const native = nativeWatchers.get(root)!;
		native.emit('change', 'change', '');
		await vi.waitFor(() => expect(vi.mocked(readdir).mock.settledResults[0]?.type).toBe('rejected'));
		await settle();
		scans.failure = undefined;
		const file = join(root, 'recovered.txt');
		writeFileSync(file, 'recovered');
		native.emit('change', 'rename', '');
		await vi.waitFor(() => expect(events.find(({ path }) => path === file)?.event).toBe(FileSystemEvent.ADD));
		expect(watcher.state).not.toBe('closed');
	});

	it.each(([
		[ 'linux', false ],
		[ 'linux', true ],
		[ 'darwin', false ],
		[ 'darwin', true ]
	] as const).filter(([ platform ]) => platform === process.platform))('correlates delayed rename notifications on %s (directory=%s)', async (platform, directory) => {
		vi.useFakeTimers({ toFake: [ 'setTimeout', 'clearTimeout', 'performance' ] });
		vi.advanceTimersByTime(50);
		const root = createTempRoot();
		const source = join(root, 'source');
		const target = join(root, 'target');
		if (directory) { mkdirSync(source) } else { writeFileSync(source, 'original') }
		const watcher = await createReadyWatcher(root, { emitInitial: false, renameTimeout: 25 });
		const { events } = collectEvents(watcher);
		const native = nativeWatchers.get(root)!;
		renameSync(source, target);
		const marker = join(root, 'marker.txt');
		const marked = waitForEvent(watcher, FileSystemEvent.ADD, { path: marker });
		const renamed = waitForEvent(watcher, directory ? FileSystemEvent.RENAME_DIR : FileSystemEvent.RENAME, { path: source });
		writeFileSync(marker, 'marker');
		native.emit('change', 'rename', 'source');
		native.emit('change', 'rename', 'marker.txt');
		await marked;
		const expectedRename = {
			event: directory ? FileSystemEvent.RENAME_DIR : FileSystemEvent.RENAME,
			path: source,
			pathNext: target
		};
		if (platform === 'linux') {
			expect(events.filter(({ path }) => path === source)).toEqual([]);
		} else {
			await renamed;
			expect(events.find(({ path }) => path === source)).toMatchObject(expectedRename);
		}
		const after = join(root, 'after.txt');
		const afterAdded = waitForEvent(watcher, FileSystemEvent.ADD, { path: after });
		writeFileSync(after, 'after');
		native.emit('change', 'rename', 'target');
		native.emit('change', 'rename', 'after.txt');
		await afterAdded;
		await renamed;
		expect(events.filter(({ path }) => path === source)).toHaveLength(1);
		expect(events.find(({ path }) => path === source)).toMatchObject(expectedRename);
		expect(events.filter(({ path }) => path === target)).toEqual([]);
	});

	it('reports a same-path inode restoration as change instead of unlink and add', async () => {
		vi.useFakeTimers({ toFake: [ 'setTimeout', 'clearTimeout', 'performance' ] });
		const root = createTempRoot();
		const outside = createTempRoot();
		const file = join(root, 'restored.txt');
		const saved = join(outside, 'saved.txt');
		writeFileSync(file, 'original');
		linkSync(file, saved);
		const watcher = await createReadyWatcher(root, { emitInitial: false, renameTimeout: 25 });
		const { events } = collectEvents(watcher);
		rmSync(file);
		const marker = join(root, 'marker.txt');
		const marked = waitForEvent(watcher, FileSystemEvent.ADD, { path: marker });
		writeFileSync(marker, 'marker');
		const native = nativeWatchers.get(root)!;
		native.emit('change', 'rename', 'restored.txt');
		native.emit('change', 'rename', 'marker.txt');
		await marked;
		linkSync(saved, file);
		writeFileSync(file, 'restored contents');
		const changed = waitForEvent(watcher, FileSystemEvent.CHANGE, { path: file });
		native.emit('change', 'rename', 'restored.txt');
		await changed;
		expect(events.filter(({ path }) => path === file)).toHaveLength(1);
		expect(events.find(({ path }) => path === file)).toMatchObject({ event: FileSystemEvent.CHANGE, stats: { size: 17 } });
	});

	it.each([ 'settle', 'delete', 'close' ])('handles a pending add after an inode moves out of a replaced path: %s', async (action) => {
		vi.useFakeTimers({ toFake: [ 'setTimeout', 'clearTimeout', 'performance' ] });
		const root = createTempRoot();
		const source = join(root, 'source.txt');
		const target = join(root, 'target.txt');
		writeFileSync(source, 'original');
		const watcher = await createReadyWatcher(root, { emitInitial: false, renameTimeout: 25 });
		const { events } = collectEvents(watcher);
		const native = nativeWatchers.get(root)!;
		renameSync(source, target);
		writeFileSync(source, 'replacement');
		const replaced = waitForEvent(watcher, FileSystemEvent.CHANGE, { path: source });
		native.emit('change', 'rename', 'source.txt');
		native.emit('change', 'rename', 'target.txt');
		await replaced;
		expect(events.filter(({ path }) => path === target)).toEqual([]);

		writeFileSync(target, 'latest contents');
		const marker = join(root, 'marker.txt');
		const marked = waitForEvent(watcher, FileSystemEvent.ADD, { path: marker });
		writeFileSync(marker, 'marker');
		native.emit('change', 'change', 'target.txt');
		native.emit('change', 'rename', 'marker.txt');
		await marked;
		expect(events.filter(({ path }) => path === target)).toEqual([]);

		if (action === 'delete') {
			linkSync(target, join(createTempRoot(), 'saved-target.txt'));
			rmSync(target);
			const deletedMarker = join(root, 'deleted-marker.txt');
			const deletionMarked = waitForEvent(watcher, FileSystemEvent.ADD, { path: deletedMarker });
			writeFileSync(deletedMarker, 'marker');
			native.emit('change', 'rename', 'target.txt');
			native.emit('change', 'rename', 'deleted-marker.txt');
			await deletionMarked;
		} else if (action === 'close') {
			watcher.close();
		}

		await vi.advanceTimersByTimeAsync(25);
		const targetEvents = events.filter(({ path }) => path === target);
		if (action === 'settle') {
			expect(targetEvents).toHaveLength(1);
			expect(targetEvents[0]).toMatchObject({ event: FileSystemEvent.ADD, stats: { size: 15 } });
		} else {
			expect(targetEvents).toEqual([]);
		}
	});
});

import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Watchr, WatchrStats, type WatchrEvent, type WatchrOptions } from '../src/watchr';
import { FileSystem } from '../src/file-system';
import { FileSystemStateManager } from '../src/file-system-state-manager';
import { FileSystemEventManager } from '../src/file-system-event-manager';

const watchers: Watchr[] = [];
const roots: string[] = [];

/** Creates an isolated real filesystem root. */
async function createRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'watchr-lifecycle-'));
	roots.push(root);
	return root;
}

afterEach(async () => {
	for (const watcher of watchers.splice(0)) { watcher.close() }
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('configured watcher lifecycle', () => {
	it('constructs idle and shares an instance-returning startup promise', async () => {
		const root = await createRoot();
		await writeFile(join(root, 'entry'), 'value');
		const watcher = new Watchr(root);
		watchers.push(watcher);
		expect(watcher.state).toBe('idle');
		expect('on' in watcher).toBe(false);
		const started = watcher.start();
		expect(watcher.state).toBe('starting');
		expect(watcher.start()).toBe(started);
		expect(await started).toBe(watcher);
		expect(watcher.state).toBe('watching');
		expect(watcher.start()).toBe(started);
	});

	it('resolves its stable closed promise after cleanup', async () => {
		const root = await createRoot();
		const watcher = new Watchr(root);
		watchers.push(watcher);
		const closed = watcher.closed;

		expect(watcher.closed).toBe(closed);
		await watcher.start();
		watcher.close();
		await expect(closed).resolves.toBeUndefined();
		expect(watcher.state).toBe('closed');
	});

	it('requires nonempty targets and exposes only the configured lifecycle API', async () => {
		for (const target of [ undefined, '', [], [ '' ], [ 'valid', 1 ], Array<string>(1) ]) {
			expect(() => new Watchr(target as string)).toThrow(/target/);
		}
		const watcher = new Watchr(await createRoot());
		watchers.push(watcher);
		for (const name of [ 'on', 'once', 'off', 'emit', 'isReady', 'isClosed', 'isIgnored', 'watchersClose' ]) {
			expect(name in watcher).toBe(false);
		}
		for (const name of [ 'FileEvent', 'DirectoryEvent', 'Event' ]) { expect(name in Watchr).toBe(false) }
		expect(() => Reflect.construct(Watchr, [ 'path', {}, () => {} ])).toThrow(/Only target and options/);
		expect(() => new Watchr('path', { handlers: { ready: () => {} } } as WatchrOptions)).toThrow(/handler/);
	});

	it.each([
		[ 'ignoreInitial', true ],
		[ 'encoding', 'buffer' ],
		[ 'throwIfNoEntry', false ],
		[ 'signal', new AbortController().signal ],
		[ 'unknownOption', true ]
	])('rejects unsupported JavaScript option %s synchronously without filesystem access', (name, value) => {
		const stat = vi.spyOn(FileSystem, 'getStats');
		const read = vi.spyOn(FileSystem, 'readDirectory');
		const attach = vi.spyOn(FileSystemEventManager, 'newInstance');
		for (const optionValue of [ value, undefined ]) {
			expect(() => Reflect.construct(Watchr, [ 'path', { [name]: optionValue } ])).toThrow(`Unknown option: ${String(name)}.`);
		}
		expect(stat).not.toHaveBeenCalled();
		expect(read).not.toHaveBeenCalled();
		expect(attach).not.toHaveBeenCalled();
	});

	it('finishes synchronous initial inventory across all roots before resolving', async () => {
		const first = await createRoot();
		const second = await createRoot();
		await mkdir(join(first, 'nested'));
		await writeFile(join(first, 'nested', 'first'), 'first');
		await writeFile(join(second, 'second'), 'second');
		const events: WatchrEvent[] = [];
		const specific: WatchrEvent[] = [];
		let reentrant: Promise<Watchr> | undefined;
		const watcher = new Watchr([ first, second ], { emitInitial: true, handlers: {
			all: (event) => {
				events.push(event);
				reentrant = watcher.start();
			},
			add: (event) => { specific.push(event) }
		} });
		watchers.push(watcher);
		const started = watcher.start();
		await started;
		expect(reentrant).toBe(started);
		expect(events.map((event) => 'path' in event ? event.path : event.to).sort()).toEqual([ first, second, join(first, 'nested'), join(first, 'nested', 'first'), join(second, 'second') ].sort());
		expect(events.every((event) => event.initial && Object.isFrozen(event) && event.stats instanceof WatchrStats)).toBe(true);
		expect(specific).toHaveLength(2);
		expect(events).toContain(specific[0]);
	});

	it('does not await application promises and defaults to silent initial discovery', async () => {
		const root = await createRoot();
		await writeFile(join(root, 'entry'), 'value');
		const quiet = vi.fn();
		const silent = new Watchr(root, { handlers: { all: quiet } });
		watchers.push(silent);
		await silent.start();
		expect(quiet).not.toHaveBeenCalled();
		const pending = Promise.withResolvers<void>();
		const handler = vi.fn(() => pending.promise);
		const watcher = new Watchr(root, { emitInitial: true, handlers: { all: handler } });
		watchers.push(watcher);
		expect(await watcher.start()).toBe(watcher);
		expect(handler).toHaveBeenCalledTimes(2);
		pending.resolve();
	});

	it('consumes once callbacks before invocation and copies handler configuration', async () => {
		const root = await createRoot();
		await writeFile(join(root, 'first'), 'first');
		await writeFile(join(root, 'second'), 'second');
		const handler = vi.fn(() => { expect(watcher.start()).toBe(started) });
		const entry = { handler, once: true };
		const options: WatchrOptions = { emitInitial: true, handlers: { all: entry, add: { handler, once: true } } };
		const watcher = new Watchr(root, options);
		watchers.push(watcher);
		entry.handler = vi.fn();
		options.handlers = {};
		const started = watcher.start();
		await started;
		expect(handler).toHaveBeenCalledTimes(2);
		expect(entry.handler).not.toHaveBeenCalled();
	});

	it('does not include pending live batches in the finite startup barrier', async () => {
		const root = await createRoot();
		const entry = join(root, 'entry');
		await writeFile(entry, 'value');
		const original = FileSystemEventManager.newInstance;
		let notify: (() => void) | undefined;
		vi.spyOn(FileSystemEventManager, 'newInstance').mockImplementation((poller, owner, config, hooks) => {
			notify = () => { config.watcher.emit('change', 'change', 'entry') };
			return original(poller, owner, config, hooks);
		});
		const update = FileSystemStateManager.prototype.update;
		const liveEntered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(FileSystemStateManager.prototype, 'update').mockImplementation(async function (this: FileSystemStateManager, path, options) {
			if (path === entry && options?.sync !== true) {
				liveEntered.resolve();
				await release.promise;
			}
			return update.call(this, path, options);
		});
		const watcher = new Watchr(root, { emitInitial: true, handlers: {
			addDir: () => { notify!() }
		} });
		watchers.push(watcher);
		try {
			expect(await watcher.start()).toBe(watcher);
			await liveEntered.promise;
			expect(watcher.state).toBe('watching');
		} finally {
			watcher.close();
			release.resolve();
			await new Promise(setImmediate);
		}
	});

	it('closes idle and starting watchers permanently', async () => {
		const root = await createRoot();
		const close = vi.fn();
		const idle = new Watchr(root, { handlers: { close } });
		watchers.push(idle);
		idle.close();
		idle[Symbol.dispose]();
		expect(idle.state).toBe('closed');
		expect(idle.abortSignal.aborted).toBe(true);
		expect(close.mock.calls).toEqual([ [] ]);
		await expect(idle.start()).rejects.toThrow(/closed/);
		const starting = new Watchr(root);
		watchers.push(starting);
		const rejected = expect(starting.start()).rejects.toThrow(/closed/);
		starting.close();
		await rejected;
	});

	it('owns and aborts managers while their directory scan is pending', async () => {
		const root = await createRoot();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const read = FileSystem.readDirectory;
		let scanSignal: AbortSignal | undefined;
		vi.spyOn(FileSystem, 'readDirectory').mockImplementation(async (path, options) => {
			scanSignal = options?.signal;
			entered.resolve();
			await release.promise;
			return read(path, options);
		});
		const all = vi.fn();
		const watcher = new Watchr(root, { emitInitial: true, handlers: { all } });
		watchers.push(watcher);
		const rejected = expect(watcher.start()).rejects.toThrow(/closed/);
		await entered.promise;
		watcher.close();
		expect(scanSignal?.aborted).toBe(true);
		await rejected;
		release.resolve();
		await new Promise(setImmediate);
		expect(all).not.toHaveBeenCalled();
	});

	it.each([ false, true ])('cancels a pending initial state update without stale delivery (emitInitial=%s)', async (emitInitial) => {
		const root = await createRoot();
		await writeFile(join(root, 'entry'), 'value');
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const update = FileSystemStateManager.prototype.update;
		let updateSignal: AbortSignal | undefined;
		vi.spyOn(FileSystemStateManager.prototype, 'update').mockImplementation(async function (this: FileSystemStateManager, path, options) {
			const pending = update.call(this, path, options);
			if (path === root && options?.sync === true) {
				updateSignal = options.signal;
				entered.resolve();
				await release.promise;
			}
			return pending;
		});
		const all = vi.fn();
		const error = vi.fn();
		const watcher = new Watchr(root, { emitInitial, handlers: { all, error } });
		watchers.push(watcher);
		const rejected = expect(watcher.start()).rejects.toThrow(/closed/);
		await entered.promise;
		watcher.close();
		expect(updateSignal?.aborted).toBe(true);
		release.resolve();
		await rejected;
		await new Promise(setImmediate);
		expect(watcher.state).toBe('closed');
		expect(all).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
	});

	it('stops delivery immediately when an initial callback closes the watcher', async () => {
		const root = await createRoot();
		await writeFile(join(root, 'entry'), 'value');
		const specific = vi.fn();
		const close = vi.fn();
		const all = vi.fn(() => watcher.close());
		const watcher = new Watchr(root, { emitInitial: true, handlers: { all, add: specific, addDir: specific, close } });
		watchers.push(watcher);
		await expect(watcher.start()).rejects.toThrow(/closed/);
		expect(all).toHaveBeenCalledTimes(1);
		expect(specific).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledTimes(1);
	});

	it('rejects fatal startup failures without also calling error handlers', async () => {
		const root = await createRoot();
		const failure = new Error('directory read failed');
		vi.spyOn(FileSystem, 'readDirectory').mockRejectedValueOnce(failure);
		const error = vi.fn();
		const close = vi.fn();
		const watcher = new Watchr(root, { handlers: { error, close } });
		watchers.push(watcher);
		const closed = watcher.closed;
		await expect(watcher.start()).rejects.toBe(failure);
		await expect(closed).resolves.toBeUndefined();
		expect(error).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledTimes(1);
		expect(watcher.state).toBe('closed');
		expect(watcher.abortSignal.aborted).toBe(true);
	});

	it('rejects and closes when the original root disappears between inventory and its initial stat', async () => {
		const root = await createRoot();
		const nativeWatchers: FSWatcher[] = [];
		const nativeListeners = new Map<FSWatcher, ReturnType<FSWatcher['listeners']>>();
		const original = FileSystemEventManager.newInstance;
		vi.spyOn(FileSystemEventManager, 'newInstance').mockImplementation((poller, owner, config, hooks) => {
			nativeWatchers.push(config.watcher);
			nativeListeners.set(config.watcher, config.watcher.listeners('change'));
			vi.spyOn(config.watcher, 'emit').mockReturnValue(false);
			vi.spyOn(config.watcher, 'close');
			return original(poller, owner, config, hooks);
		});
		const read = FileSystem.readDirectory;
		vi.spyOn(FileSystem, 'readDirectory').mockImplementation(async (path, options) => {
			const inventory = await read(path, options);
			if (path === root) { await rm(root, { recursive: true }) }
			return inventory;
		});
		const error = vi.fn();
		const all = vi.fn();
		const close = vi.fn();
		const watcher = new Watchr(root, { emitInitial: true, handlers: { error, all, close } });
		watchers.push(watcher);
		const startupError = await watcher.start().catch((error) => error as Error) as Error;
		expect(startupError).toBeInstanceOf(Error);
		expect(startupError.message).toMatch(/Configured root is unavailable during initial scan/);
		expect(startupError.message).not.toContain(root);
		expect(watcher.state).toBe('closed');
		expect(watcher.abortSignal.aborted).toBe(true);
		expect(error).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledTimes(1);
		expect(nativeWatchers).toHaveLength(1);
		for (const native of nativeWatchers) {
			expect(native.close).toHaveBeenCalled();
			expect(native.listeners('change')).toEqual(nativeListeners.get(native));
			expect(native.listenerCount('error')).toBe(0);
		}
		await mkdir(root);
		await writeFile(join(root, 'recreated'), 'value');
		await new Promise(setImmediate);
		await expect(watcher.start()).rejects.toThrow(/closed/);
		expect(nativeWatchers).toHaveLength(1);
		expect(all).not.toHaveBeenCalled();
	});

	it('reports and skips child stat failures without rejecting startup', async () => {
		const root = await createRoot();
		const skipped = join(root, 'skipped');
		await writeFile(skipped, 'value');
		await writeFile(join(root, 'healthy'), 'value');
		const update = FileSystemStateManager.prototype.update;
		vi.spyOn(FileSystemStateManager.prototype, 'update').mockImplementation(function (this: FileSystemStateManager, path, options) {
			if (path === skipped) { return Promise.reject(new Error('child stat failed')) }
			return update.call(this, path, options);
		});
		const error = vi.fn();
		const all = vi.fn();
		const watcher = new Watchr(root, { emitInitial: true, handlers: { error, all } });
		watchers.push(watcher);
		expect(await watcher.start()).toBe(watcher);
		expect(error).toHaveBeenCalledTimes(1);
		expect(error.mock.calls[0]![0]).toBeInstanceOf(Error);
		expect(all).toHaveBeenCalledTimes(2);
	});

	it('treats native watcher errors during initial attachment as fatal startup failures', async () => {
		const root = await createRoot();
		const original = FileSystemEventManager.newInstance;
		let failNative: (() => void) | undefined;
		vi.spyOn(FileSystemEventManager, 'newInstance').mockImplementation((poller, owner, config, hooks) => {
			failNative = () => { config.watcher.emit('error', Object.assign(new Error('native details'), { code: 'EIO' })) };
			return original(poller, owner, config, hooks);
		});
		const read = FileSystem.readDirectory;
		vi.spyOn(FileSystem, 'readDirectory').mockImplementation((path, options) => {
			failNative!();
			return read(path, options);
		});
		const error = vi.fn();
		const all = vi.fn();
		const watcher = new Watchr(root, { emitInitial: true, handlers: { error, all } });
		watchers.push(watcher);
		await expect(watcher.start()).rejects.toThrow('Watcher error (EIO)');
		expect(watcher.state).toBe('closed');
		expect(error).not.toHaveBeenCalled();
		expect(all).not.toHaveBeenCalled();
	});

	it.each([ 'direct', 'array' ] as const)('releases configured callbacks and %s ignore callbacks while the closed instance remains reachable', async (mode) => {
		const root = await createRoot();
		const { watcher, reference, ignoreReference } = (() => {
			const callback = () => {};
			const ignore = () => false;
			const options: WatchrOptions = { ignore: mode === 'direct' ? ignore : [ '**/ignored', ignore ], handlers: { all: callback, error: callback, close: callback, add: { handler: callback } } };
			return { watcher: new Watchr(root, options), reference: new WeakRef(callback), ignoreReference: new WeakRef(ignore) };
		})();
		watchers.push(watcher);
		await watcher.start();
		watcher.close();
		for (let attempt = 0; attempt < 5; attempt++) {
			await new Promise(setImmediate);
			globalThis.gc!();
		}
		expect(reference.deref()).toBeUndefined();
		expect(ignoreReference.deref()).toBeUndefined();
		expect(watcher.state).toBe('closed');
	});

	it('routes synchronous and async callback failures without waiting or error recursion', async () => {
		const root = await createRoot();
		await writeFile(join(root, 'entry'), 'value');
		const warnings = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
		const error = vi.fn(() => { throw new Error('error callback failed') });
		const watcher = new Watchr(root, { emitInitial: true, handlers: {
			all: () => { throw new Error('sync callback failed') },
			add: () => Promise.reject(new Error('async callback failed')),
			error: { handler: error, once: true }
		} });
		watchers.push(watcher);
		await watcher.start();
		await new Promise(setImmediate);
		expect(error).toHaveBeenCalledTimes(1);
		expect(warnings).toHaveBeenCalledTimes(3);
	});

	it('warns on post-close rejections and throwing close callbacks without calling released handlers', async () => {
		const root = await createRoot();
		const pending = Promise.withResolvers<void>();
		const warnings = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
		const error = vi.fn();
		const close = vi.fn(() => { throw new Error('close failed') });
		const watcher = new Watchr(root, { emitInitial: true, handlers: { all: () => pending.promise, error, close } });
		watchers.push(watcher);
		await watcher.start();
		watcher.close();
		watcher.close();
		pending.reject(new Error('late rejection'));
		await new Promise(setImmediate);
		expect(watcher.abortSignal.aborted).toBe(true);
		expect(close).toHaveBeenCalledTimes(1);
		expect(error).not.toHaveBeenCalled();
		expect(warnings).toHaveBeenCalledTimes(2);
		expect(warnings).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'close failed', detail: 'The "close" handler threw synchronously.' }),
			expect.anything()
		);
	});

	it('evaluates ignore callbacks only with absolute paths, including array entries', async () => {
		const root = await createRoot();
		await writeFile(join(root, 'ignored'), 'value');
		await writeFile(join(root, 'visible'), 'value');
		const ignore = vi.fn((path: string) => path === join(root, 'ignored'));
		const all = vi.fn();
		const watcher = new Watchr(root, { emitInitial: true, ignore: [ ignore ], handlers: { all } });
		watchers.push(watcher);
		await watcher.start();
		expect(ignore.mock.calls.every(([ path ]) => isAbsolute(path))).toBe(true);
		expect(all.mock.calls.map(([ event ]) => event.path)).toEqual([ root, join(root, 'visible') ]);
		const ignored = new Watchr([ root, join(root, 'visible') ], { ignore: () => true });
		watchers.push(ignored);
		expect(await ignored.start()).toBe(ignored);
	});

	it.each([
		[ 'file', undefined ], [ 'file', 0 ], [ 'file', 25 ],
		[ 'directory', undefined ], [ 'directory', 0 ], [ 'directory', 25 ]
	] as const)('applies the public split-batch rename policy for %s with renameTimeout=%s', async (kind, renameTimeout) => {
		vi.useFakeTimers({ toFake: [ 'setTimeout', 'clearTimeout', 'performance' ] });
		const root = await createRoot();
		const outside = await createRoot();
		const from = join(root, 'from');
		const to = join(root, 'to');
		const parked = join(outside, 'parked');
		const marker = join(root, 'marker');
		if (kind === 'directory') { await mkdir(from) }
		else { await writeFile(from, 'value') }
		await writeFile(marker, 'marker');
		const inode = Number((await stat(from, { bigint: true })).ino);
		const original = FileSystemEventManager.newInstance;
		let notify: (name: string) => void;
		vi.spyOn(FileSystemEventManager, 'newInstance').mockImplementation((poller, owner, config, hooks) => {
			const emit = config.watcher.emit.bind(config.watcher);
			vi.spyOn(config.watcher, 'emit').mockReturnValue(false);
			notify = (name) => { emit('change', 'change', name) };
			return original(poller, owner, config, hooks);
		});
		const events: WatchrEvent[] = [];
		let barrier = Promise.withResolvers<void>();
		const error = vi.fn();
		const watcher = new Watchr(root, { ...(renameTimeout === undefined ? {} : { renameTimeout }), handlers: {
			all: (event) => {
				if ('path' in event && event.path === marker) { barrier.resolve() }
				else { events.push(event) }
			},
			error
		} });
		watchers.push(watcher);
		await watcher.start();
		expect(events).toEqual([]);
		const clock = performance.now();
		await rename(from, parked);
		await writeFile(marker, 'first marker batch');
		notify!('from');
		notify!('marker');
		await barrier.promise;
		await new Promise(setImmediate);
		expect(performance.now()).toBe(clock);
		const removal = kind === 'directory' ? 'unlinkDir' : 'unlink';
		const addition = kind === 'directory' ? 'addDir' : 'add';
		if (renameTimeout === 25) { expect(events).toEqual([]) }
		else { expect(events).toEqual([ expect.objectContaining({ type: removal, path: from, initial: false }) ]) }

		barrier = Promise.withResolvers<void>();
		await rename(parked, to);
		await writeFile(marker, 'second marker batch with a different size');
		notify!('to');
		notify!('marker');
		await barrier.promise;
		await new Promise(setImmediate);
		expect(performance.now()).toBe(clock);
		let expected = [
			expect.objectContaining({ type: removal, path: from, initial: false }),
			expect.objectContaining({ type: addition, path: to, initial: false })
		];
		if (renameTimeout === 25) { expected = [ expect.objectContaining({ type: kind === 'directory' ? 'renameDir' : 'rename', from, to, initial: false }) ] }
		expect(events).toEqual(expected);
		expect(events.every((event) => Object.isFrozen(event) && event.stats instanceof WatchrStats && !event.stats.isSynthetic && event.stats.inodeNumber === inode)).toBe(true);
		await vi.advanceTimersByTimeAsync(1000);
		barrier = Promise.withResolvers<void>();
		await writeFile(marker, 'final marker');
		notify!('from');
		notify!('to');
		notify!('marker');
		await barrier.promise;
		await new Promise(setImmediate);
		expect(events).toEqual(expected);
		expect(error).not.toHaveBeenCalled();
	});

	it('preserves live add, rename and removal payloads with explicit noninitial provenance', async () => {
		const root = await createRoot();
		const events: WatchrEvent[] = [];
		const watcher = new Watchr(root, { renameTimeout: 25, handlers: { all: (event) => { events.push(event) } } });
		watchers.push(watcher);
		await watcher.start();
		const from = join(root, 'from');
		const to = join(root, 'to');
		await writeFile(from, 'value');
		await vi.waitFor(() => expect(events.some((event) => event.type === 'add' && event.path === from)).toBe(true));
		await rename(from, to);
		await vi.waitFor(() => expect(events.some((event) => event.type === 'rename' && event.from === from && event.to === to)).toBe(true));
		await rm(to);
		await vi.waitFor(() => expect(events.some((event) => event.type === 'unlink' && event.path === to)).toBe(true));
		expect(events.every((event) => event.initial === false && event.stats instanceof WatchrStats)).toBe(true);
	});

	it.each([ false, true ])('classifies root recovery inventory as live rather than initial discovery (emitInitial=%s)', async (emitInitial) => {
		const root = await createRoot();
		const events: WatchrEvent[] = [];
		const watcher = new Watchr(root, { emitInitial, handlers: { all: (event) => { events.push(event) } } });
		watchers.push(watcher);
		await watcher.start();
		expect(events).toHaveLength(emitInitial ? 1 : 0);
		if (emitInitial) { expect(events[0]!.initial).toBe(true) }
		events.length = 0;
		await rm(root, { recursive: true });
		await vi.waitFor(() => expect(events.some((event) => event.type === 'unlinkDir')).toBe(true));
		await mkdir(root);
		await writeFile(join(root, 'recovered'), 'value');
		await vi.waitFor(() => expect(events.some((event) => event.type === 'add' && event.path === join(root, 'recovered'))).toBe(true));
		expect(events.every((event) => event.initial === false)).toBe(true);
	});
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Watchr, type FileSystemEvent, type Path, type WatchrEvent, type WatchrOptions, type WatchrStats } from '../../src/watchr';

/** A single captured watcher emission. */
type CapturedEvent = {
	event: FileSystemEvent;
	path: Path;
	pathNext?: Path;
	stats: WatchrStats;
	initial: boolean;
};

/** Positional data used only by legacy engine assertions. */
type RecordedEventMap = {
	add: [stats: WatchrStats, path: Path];
	addDir: [stats: WatchrStats, path: Path];
	change: [stats: WatchrStats, path: Path];
	unlink: [stats: WatchrStats, path: Path];
	unlinkDir: [stats: WatchrStats, path: Path];
	rename: [stats: WatchrStats, from: Path, to: Path];
	renameDir: [stats: WatchrStats, from: Path, to: Path];
	all: [event: FileSystemEvent, stats: WatchrStats, path: Path, pathNext?: Path];
	error: [error: Error];
	close: [];
};

/** A callback attached to test-owned recorded data, not to Watchr. */
type RecordedCallback<K extends keyof RecordedEventMap> = (...args: RecordedEventMap[K]) => void;

/** Constructor-installed recorder and its independent observation queues. */
type Recorder = {
	initialEvents: CapturedEvent[];
	collectors: Set<CapturedEvent[]>;
	cancellations: Set<() => void>;
	callbacks: Map<keyof RecordedEventMap, Set<(...args: never[]) => void>>;
	onceCallbacks: Set<(...args: never[]) => void>;
};

/** Result of `collectEvents`. */
type EventCollector = {
	events: CapturedEvent[];
	dispose: () => void;
};

/** Options for `waitForEvent`. */
type WaitForEventOptions = {
	path?: Path;
	timeoutMs?: number;
};

const tempRoots = new Set<Path>();
const watchers = new Set<Watchr>();
const recorders = new WeakMap<Watchr, Recorder>();

/**
 * Constructs an idle watcher with recording handlers already installed.
 * @param target Paths to watch.
 * @param options Watcher configuration and optional user handlers.
 * @returns An idle watcher registered for cleanup.
 */
function createWatcher(target: Path | Path[], options: WatchrOptions = {}): Watchr {
	const recorder: Recorder = { initialEvents: [], collectors: new Set(), cancellations: new Set(), callbacks: new Map(), onceCallbacks: new Set() };
	const dispatch = <K extends keyof RecordedEventMap>(event: K, ...args: RecordedEventMap[K]): void => {
		for (const callback of [ ...recorder.callbacks.get(event) ?? [] ]) {
			if (recorder.onceCallbacks.delete(callback)) { recorder.callbacks.get(event)?.delete(callback) }
			(callback as RecordedCallback<K>)(...args);
		}
	};
	const invoke = <Value>(entry: ((value: Value) => void | PromiseLike<void>) | { handler: (value: Value) => void | PromiseLike<void>; once?: boolean } | undefined, value: Value): void | PromiseLike<void> => {
		if (entry === undefined) { return }
		return typeof entry === 'function' ? entry(value) : entry.handler(value);
	};
	const userHandlers = Object.fromEntries(Object.entries(options.handlers ?? {}).map(([ name, entry ]) => [ name, typeof entry === 'function' || entry === undefined ? entry : { ...entry } ])) as NonNullable<WatchrOptions['handlers']>;
	const watcher = new Watchr(target, {
		renameTimeout: 0,
		...options,
		handlers: {
			...userHandlers,
			all: (payload: WatchrEvent) => {
				const captured: CapturedEvent = 'from' in payload ? { event: payload.type, stats: payload.stats, path: payload.from, pathNext: payload.to, initial: payload.initial } : { event: payload.type, stats: payload.stats, path: payload.path, initial: payload.initial };
				if (payload.initial) { recorder.initialEvents.push(captured) }
				for (const events of recorder.collectors) { events.push(captured) }
				dispatch('all', captured.event, captured.stats, captured.path, captured.pathNext);
				if ('from' in payload) { dispatch(payload.type, payload.stats, payload.from, payload.to) }
				else { dispatch(payload.type, payload.stats, payload.path) }
				const entry = userHandlers.all;
				if (typeof entry === 'object' && entry.once) { delete userHandlers.all }
				return invoke(entry, payload);
			},
			error: (error: Error) => {
				dispatch('error', error);
				const entry = userHandlers.error;
				if (typeof entry === 'object' && entry.once) { delete userHandlers.error }
				return invoke(entry, error);
			},
			close: () => {
				dispatch('close');
				for (const cancel of recorder.cancellations) { cancel() }
				recorder.cancellations.clear();
				recorder.initialEvents.length = 0;
				recorder.callbacks.clear();
				recorder.onceCallbacks.clear();
				recorder.collectors.clear();
				watchers.delete(watcher);
				const entry = userHandlers.close;
				return typeof entry === 'function' ? entry() : entry?.handler();
			}
		}
	});
	recorders.set(watcher, recorder);
	watchers.add(watcher);
	return watcher;
}

/**
 * Observes the test recorder's positional event stream.
 * @param watcher Watcher constructed with createWatcher.
 * @param event Recorded channel.
 * @param callback Assertion callback.
 * @param once Whether to consume the observation before invocation.
 * @returns A function removing the observation from the recorder.
 */
function observeEvent<K extends keyof RecordedEventMap>(watcher: Watchr, event: K, callback: RecordedCallback<K>, once = false): () => void {
	const recorder = recorders.get(watcher);
	if (!recorder) { throw new Error('Recording requires createWatcher before construction') }
	let callbacks = recorder.callbacks.get(event);
	if (!callbacks) { callbacks = new Set(); recorder.callbacks.set(event, callbacks) }
	const stored = callback as (...args: never[]) => void;
	callbacks.add(stored);
	if (once) { recorder.onceCallbacks.add(stored) }
	return () => { callbacks.delete(stored); recorder.onceCallbacks.delete(stored) };
}

/**
 * Removes a callback from the test recorder.
 * @param watcher Recorded watcher.
 * @param event Recorded channel.
 * @param callback Previously registered callback.
 */
function unobserveEvent<K extends keyof RecordedEventMap>(watcher: Watchr, event: K, callback: RecordedCallback<K>): void {
	const recorder = recorders.get(watcher);
	const stored = callback as (...args: never[]) => void;
	recorder?.callbacks.get(event)?.delete(stored);
	recorder?.onceCallbacks.delete(stored);
}

/**
 * Creates a unique temporary directory under the OS temp dir and registers it for cleanup.
 * @param prefix Directory name prefix.
 * @returns Absolute path of the created directory.
 */
function createTempRoot(prefix = 'watchr-'): Path {
	const root = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.add(root);

	return root;
}

/**
 * Removes every temp root created via `createTempRoot`.
 */
function cleanupTempRoots(): void {
	for (const root of tempRoots) {
		rmSync(root, { recursive: true, force: true });
	}

	tempRoots.clear();
}

/**
 * Constructs a watcher, waits for it to become ready, and registers it for cleanup.
 * @param target Path or paths to watch.
 * @param options Watcher options.
 * @returns The ready watcher.
 */
async function createReadyWatcher(target: Path | Path[], options: WatchrOptions = {}): Promise<Watchr> {
	const watcher = createWatcher(target, options);
	await watcher.start();

	return watcher;
}

/**
 * Closes every watcher created via `createReadyWatcher`.
 */
function closeWatchers(): void {
	for (const watcher of watchers) {
		watcher.close();
	}

	watchers.clear();
}

/**
 * Collects initial inventory already recorded during start and subsequent events until disposed.
 * @param watcher Watcher to listen on.
 * @returns The live events array and a disposer.
 */
function collectEvents(watcher: Watchr): EventCollector {
	const recorder = recorders.get(watcher);
	if (!recorder) { throw new Error('Recording requires createWatcher before construction') }
	const events = [ ...recorder.initialEvents ];
	recorder.collectors.add(events);
	return { events, dispose: () => { recorder.collectors.delete(events) } };
}

/**
 * Resolves with the path of the next matching event or rejects on timeout.
 * @param watcher Watcher to listen on.
 * @param event Event name to wait for.
 * @param options Optional path filter and timeout.
 * @returns The path the event was emitted for.
 */
function waitForEvent(watcher: Watchr, event: FileSystemEvent, { path, timeoutMs = 5000 }: WaitForEventOptions = {}): Promise<Path> {
	const recorder = recorders.get(watcher);
	if (!recorder) { throw new Error('Recording requires createWatcher before construction') }
	if (watcher.state === 'closed') { return Promise.reject(new Error('watcher is closed')) }
	return new Promise<Path>((resolve, reject) => {
		const cancel = (): void => {
			clearTimeout(timeoutId);
			unobserveEvent(watcher, event, onEvent);
			reject(new Error('watcher closed while waiting for a recorded event'));
		};
		recorder.cancellations.add(cancel);
		const timeoutId = setTimeout(() => {
			recorder.cancellations.delete(cancel);
			unobserveEvent(watcher, event, onEvent);
			reject(new Error(`timed out after ${timeoutMs}ms waiting for "${event}"${path === undefined ? '' : ` on ${path}`}`));
		}, timeoutMs);

		const onEvent = (...args: RecordedEventMap[FileSystemEvent]): void => {
			const [ , targetPath ] = args;

			if (path !== undefined && targetPath !== path) { return }

			clearTimeout(timeoutId);
			recorder.cancellations.delete(cancel);
			unobserveEvent(watcher, event, onEvent);
			resolve(targetPath);
		};

		observeEvent(watcher, event, onEvent);
	});
}

/**
 * Yields macrotask turns so already-scheduled watcher work can settle.
 * @param turns Number of macrotask turns to yield.
 */
async function settle(turns = 3): Promise<void> {
	for (let turn = 0; turn < turns; turn++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

/**
 * Waits for a fixed number of milliseconds.
 * @param ms Milliseconds to wait.
 */
function delay(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export {
	cleanupTempRoots,
	closeWatchers,
	collectEvents,
	createReadyWatcher,
	createWatcher,
	createTempRoot,
	delay,
	observeEvent,
	settle,
	unobserveEvent,
	waitForEvent,
	type RecordedEventMap,
	type CapturedEvent,
	type EventCollector,
	type WaitForEventOptions
};

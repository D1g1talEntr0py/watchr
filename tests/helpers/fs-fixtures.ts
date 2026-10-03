import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Watchr, WatcherEvent, type FileSystemEvent, type Path, type WatchrEventMap, type WatchrOptions, type WatchrStats } from '../../src/watchr';

/** A single captured watcher emission. */
type CapturedEvent = {
	event: FileSystemEvent;
	path: Path;
	pathNext?: Path;
	stats: WatchrStats;
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
	const watcher = new Watchr(target, options);
	watchers.add(watcher);
	await watcher.readyLock;

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
 * Records every emission on the `all` channel until disposed.
 * @param watcher Watcher to listen on.
 * @returns The live events array and a disposer.
 */
function collectEvents(watcher: Watchr): EventCollector {
	const events: CapturedEvent[] = [];
	const onAll = (event: FileSystemEvent, stats: WatchrStats, path: Path, pathNext?: Path): void => {
		events.push(pathNext === undefined ? { event, path, stats } : { event, path, pathNext, stats });
	};

	watcher.on(WatcherEvent.ALL, onAll);

	return { events, dispose: () => watcher.off(WatcherEvent.ALL, onAll) };
}

/**
 * Resolves with the path of the next matching event or rejects on timeout.
 * @param watcher Watcher to listen on.
 * @param event Event name to wait for.
 * @param options Optional path filter and timeout.
 * @returns The path the event was emitted for.
 */
function waitForEvent(watcher: Watchr, event: FileSystemEvent, { path, timeoutMs = 5000 }: WaitForEventOptions = {}): Promise<Path> {
	return new Promise<Path>((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			watcher.off(event, onEvent);
			reject(new Error(`timed out after ${timeoutMs}ms waiting for "${event}"${path === undefined ? '' : ` on ${path}`}`));
		}, timeoutMs);

		const onEvent = (...args: WatchrEventMap[FileSystemEvent]): void => {
			const [ , targetPath ] = args;

			if (path !== undefined && targetPath !== path) { return }

			clearTimeout(timeoutId);
			watcher.off(event, onEvent);
			resolve(targetPath);
		};

		watcher.on(event, onEvent);
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
	createTempRoot,
	delay,
	settle,
	waitForEvent,
	type CapturedEvent,
	type EventCollector,
	type WaitForEventOptions
};

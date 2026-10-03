/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FSWatcher, WatchOptions } from 'node:fs';
import type { WatchrStats } from '../watchr-stats';
import type { InodeNumber, Stats } from './stats';
import type { NodeTargetEvent, FileSystemEvent, DirectoryEvent, FileEvent } from '../constants';

interface Closable extends Disposable { close: Callable };

type Expand<T> = { [K in keyof T]: T[K] } & {};
type MergeConstTypes<T, U> = Expand<{ readonly [K in keyof T & keyof U]: T[K] | U[K] } & Partial<Omit<T, keyof U>> & Partial<Omit<U, keyof T>>>;

type Function<P = any, R = any> = (...args: P[]) => R;
type Producer<R> = Function<never, R>;
type Callable = Function<never, void>;
type AsyncCallable = Function<never, Promise<void>>;
type Resolver = Function<never, void>;
type WatchIgnore = Exclude<WatchOptions['ignore'], undefined>;
/** A precompiled ignore predicate produced from a {@link WatchIgnore}. */
type IgnoreMatcher = (targetPath: Path) => boolean;

type Event = [ FileSystemEvent, Path, WatchrStats, Path? ];
/** A derived event paired with the stats it should be emitted with (previous stats for removals, next stats otherwise). */
type StateEvent = { type: FileSystemEvent, stats: WatchrStats };
type TargetEventEmitter = (event: FileSystemEvent, targetPath: Path, stats: WatchrStats, targetPathNext?: string) => void;
type Handler = (event: FileSystemEvent, stats: WatchrStats, targetPath: Path, targetPathNext?: string) => void;
type NodeEventHandler = (event: NodeTargetEvent, targetPath?: Path, isInitial?: boolean) => Promise<void>;

/** Listener argument tuples for every event a `Watchr` emits, keyed by event name. */
type WatchrEventMap = {
	add: [ stats: WatchrStats, targetPath: Path ];
	addDir: [ stats: WatchrStats, targetPath: Path ];
	change: [ stats: WatchrStats, targetPath: Path ];
	unlink: [ stats: WatchrStats, targetPath: Path ];
	unlinkDir: [ stats: WatchrStats, targetPath: Path ];
	rename: [ stats: WatchrStats, targetPath: Path, targetPathNext: Path ];
	renameDir: [ stats: WatchrStats, targetPath: Path, targetPathNext: Path ];
	all: [ event: FileSystemEvent, stats: WatchrStats, targetPath: Path, targetPathNext?: Path ];
	error: [ error: Error ];
	ready: [];
	close: [];
};

type Path = string;
type NodeError = NodeJS.ErrnoException;
type NodeErrorCode = NodeError['code'];

type DirectoryReadOptions = {
  ignore?: (targetPath: string) => boolean;
  signal?: AbortSignal;
	recursive?: boolean;
	/** Whether symlinked files/directories are included (resolved with one `stat` each). Defaults to `true`. */
	followSymlinks?: boolean;
};

type StatOptions = {
	/** Cancels the stat (including pending retries). */
	signal?: AbortSignal | undefined;
	/** Upper bound in milliseconds for the stat; when omitted the stat is bounded only by `signal`. */
	timeout?: number | undefined;
	/** Tries a blocking `statSync` first (no thread-pool round-trip); retryable errors fall back to the async path. */
	sync?: boolean | undefined;
};

/** Options for one `FileSystemStateManager.update()` poll. */
type StateUpdateOptions = StatOptions & {
	/** When `false`, an untracked path that turns out to be a symlink (one extra `lstat`) is dropped instead of added. */
	followSymlinks?: boolean | undefined;
	/** Marks the resulting stats as a symlink; set by the initial scan, which knows the entry type from `readdir`. */
	isSymbolicLink?: boolean | undefined;
};

type LockEvent = MergeConstTypes<typeof DirectoryEvent, typeof FileEvent>;

/**
 * Per-root watcher wiring owned by `Watchr`.
 * @internal
 */
export type WatchrConfig = {
	folderPath: Path;
	options: NormalizedWatchrOptions;
	watcher: FSWatcher;
	filePath?: Path;
  handler?: Handler;
	nodeHandler?: NodeEventHandler;
	eventManager?: { cleanup: () => void };
};

type WatchrOptions = {
	persistent?: boolean;
	/**
	 * Whether to watch (and initially scan) nested directories.
	 * Defaults to `true`; `false` limits both the initial scan and live events to direct children of the root.
	 */
	recursive?: boolean;
	encoding?: BufferEncoding;
  ignore?: WatchIgnore;
  ignoreInitial?: boolean;
	throwIfNoEntry?: boolean;
	// TODO: Having a timeout for these sorts of things isn't exactly reliable, but what's the better option?
  renameTimeout?: number;
	/**
	 * Timeout in milliseconds for each stat performed while polling live watcher events.
	 * The initial scan is not time-limited (it is bounded only by the watcher's abort signal).
	 * Defaults to 1000.
	 */
	statTimeout?: number;
	/**
	 * Minimum interval in milliseconds between fallback snapshot scans of a watched root.
	 * A fallback scan (a full directory read) runs when the native watcher reports an event without a usable file name;
	 * this bounds how often that can happen under event storms. Defaults to 50.
	 */
	fallbackScanInterval?: number;
	/**
	 * Whether symbolic links are followed. When `true` (the default) a link whose target is a file or directory is
	 * reported under the link's own path with the target's stats and `WatchrStats.isSymbolicLink()` set; symlinked
	 * directories are scanned unless they point at an ancestor. When `false` symlinks are skipped by the initial scan
	 * and ignored by live events.
	 */
	followSymlinks?: boolean;
};

/** Watch options after `Watchr.normalizeWatchOptions()`: defaults applied and the ignore option precompiled. */
type NormalizedWatchrOptions = WatchrOptions & {
	recursive: boolean;
	renameTimeout: number;
	statTimeout: number;
	fallbackScanInterval: number;
	followSymlinks: boolean;
	/** Precompiled form of `ignore`; absent when no ignore option was given. */
	ignoreMatcher?: IgnoreMatcher;
};

export type {
	Closable,
	NodeError,
	NodeErrorCode,
	DirectoryReadOptions,
	FileSystemEvent,
	Callable,
	AsyncCallable,
	Resolver,
	Event,
	StateEvent,
	Handler,
	TargetEventEmitter,
	NodeEventHandler,
	WatchIgnore,
	IgnoreMatcher,
	InodeNumber,
	LockEvent,
	Path,
	Stats,
	StatOptions,
	StateUpdateOptions,
	WatchrEventMap,
	WatchrOptions,
	NormalizedWatchrOptions,
	Producer
};

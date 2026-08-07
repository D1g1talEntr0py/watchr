/* eslint-disable @typescript-eslint/no-explicit-any */
import type { BigIntStats, FSWatcher, WatchOptions } from 'node:fs';
import type { WatchrStats } from '../watchr-stats';
import type { FileSystemLocker } from '../file-system-locker';
import type { FileSystemEventManager } from '../file-system-event-manager';
import type { NodeTargetEvent, FileSystemEvent, DirectoryEvent, FileEvent } from '../constants';

interface Closable { close: Callable };

type Prettify<T> = { [K in keyof T]: T[K] } & {};
type MergeConstTypes<T, U> = Prettify<{ readonly [K in keyof T & keyof U]: T[K] | U[K] } & Partial<Omit<T, keyof U>> & Partial<Omit<U, keyof T>>>;

type Function<P = any, R = any> = (...args: P[]) => R;
type Producer<R> = Function<never, R>;
type Callable = Function<never, void>;
type AsyncCallable = Function<never, Promise<void>>;
type Resolver = Function<never, void>;
type WatchIgnore = Exclude<WatchOptions['ignore'], undefined>;

type Event = [ FileSystemEvent, Path, Path? ];
type TargetEventEmitter = (event: FileSystemEvent, targetPath: Path, targetPathNext?: string) => void;
type Handler = (event: FileSystemEvent, stats: WatchrStats, targetPath: Path, targetPathNext?: string) => void;
type NodeEventHandler = (event: NodeTargetEvent, targetPath?: Path, isInitial?: boolean) => Promise<void>;

type InodeNumber = bigint | number;
type Path = string;
type Stats = BigIntStats;
type NodeError = NodeJS.ErrnoException;
type NodeErrorCode = NodeError['code'];

type DirectoryReadOptions = {
  ignore?: (targetPath: string) => boolean;
  signal?: AbortSignal;
};

type LockEvent = MergeConstTypes<typeof DirectoryEvent, typeof FileEvent>;

type LockConfig = {
  inodeNumber?: InodeNumber;
  targetPath: Path;
  fileSystemLocker: FileSystemLocker;
  lockEvent: LockEvent;
};

type WatchrConfig = {
	folderPath: Path;
	options: WatchrOptions;
	watcher: FSWatcher;
	filePath?: Path;
  handler?: Handler;
	nodeHandler?: NodeEventHandler;
	eventManager?: FileSystemEventManager;
};

type WatchrOptions = {
	persistent?: boolean;
	recursive?: boolean;
	encoding?: BufferEncoding;
  ignore?: WatchIgnore;
  ignoreInitial?: boolean;
	throwIfNoEntry?: boolean;
	// TODO: Having a timeout for these sorts of things isn't exactly reliable, but what's the better option?
  renameTimeout?: number;
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
	Handler,
	TargetEventEmitter,
	NodeEventHandler,
	WatchIgnore,
	InodeNumber,
	Path,
	Stats,
	LockConfig,
	WatchrConfig,
	WatchrOptions,
	Producer
};
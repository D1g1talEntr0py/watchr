/* eslint-disable @typescript-eslint/no-explicit-any */
import type { BigIntStats, FSWatcher } from 'node:fs';
import type { WatchrStats } from '../watchr-stats';
import type { FileSystemLocker } from '../file-system-locker';
import type { NodeTargetEvent, FileSystemEvent, DirectoryEvent, FileEvent } from '../constants';

interface Closable { close: Callable };

type Optional<T> = T | undefined | void;
type OptionalReturn<T extends TypedFunction<T>> = Optional<ReturnType<T>>;
type Prettify<T> = { [K in keyof T]: T[K] } & {};
type MergeConstTypes<T, U> = Prettify<{ readonly [K in keyof T & keyof U]: T[K] | U[K] } & Partial<Omit<T, keyof U>> & Partial<Omit<U, keyof T>>>;

type Function<P = any, R = any> = (...args: P[]) => R;
type AsyncFunction<P = any, R = any> = Function<P, Promise<R>>;
type InferredFunction<T = Function> = T extends (...args: infer P) => infer R ? (...args: P) => R : never;
type TypedFunction<T extends (...args: Parameters<T>) => ReturnType<T>> = (...args: Parameters<T>) => ReturnType<T>;
type AsyncTypedFunction<T extends (...args: Parameters<T>) => Promise<ReturnType<T>>> = (...args: Parameters<T>) => Promise<ReturnType<T>>;
type Producer<R> = Function<never, R>;
type Consumer<T, R = void> = Function<T, R>;
type Callable = Function<never, void>;
type AsyncCallable = Function<never, Promise<void>>;
type Resolver = Function<never, void>;
type Ignore = Consumer<Path, boolean>;

type MethodDescriptor<T extends TypedFunction<T> = Function> = TypedPropertyDescriptor<T>;
type AsyncMethodDescriptor<T extends AsyncTypedFunction<T> = AsyncFunction> = TypedPropertyDescriptor<T>;
type MethodDecorator = <T extends MethodDescriptor>(target: object, propertyKey: PropertyKey, descriptor: T) => T | void;
type AsyncMethodDecorator = <T extends AsyncMethodDescriptor>(target: object, propertyKey: PropertyKey, descriptor: T) => T | void;

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
};

type WatchrOptions = {
	persistent?: boolean;
	recursive?: boolean;
	encoding?: BufferEncoding;
  debounce?: number;
  ignore?: Ignore;
  ignoreInitial?: boolean;
	//TODO: Having a timeout for these sorts of things isn't exactly reliable, but what's the better option?
  renameTimeout?: number;
};

export type {
	Optional,
	OptionalReturn,
	MethodDescriptor,
	AsyncMethodDescriptor,
	MethodDecorator,
	AsyncMethodDecorator,
	TypedFunction,
	InferredFunction,
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
	Ignore,
	InodeNumber,
	Path,
	Stats,
	LockConfig,
	WatchrConfig,
	WatchrOptions,
	Producer
};
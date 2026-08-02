import EventEmitter from 'node:events';
import { resolve, dirname, basename, matchesGlob } from 'node:path';
import { watch } from 'node:fs';
import type { BigIntStats, WatchOptions } from 'node:fs';
import { FileSystem } from './file-system';
import { castError, noop, uniqueSortedArray } from './utils';
import { FileRenameHandler } from './file-rename-handler';
import { WatchrStats } from './watchr-stats';
import { FileEvent, DirectoryEvent, WatcherEvent, debounceWait, renameTimeout } from './constants';
import { FileSystemEventManager } from './file-system-event-manager';
import type { Handler, WatchIgnore, Path, WatchrOptions, WatchrConfig, AsyncCallable, Closable, FileSystemEvent } from './@types';

type NativeIgnoreEntry = string | RegExp | ((filename: string) => boolean);
type NativeIgnoreMatcher = NativeIgnoreEntry | ReadonlyArray<NativeIgnoreEntry>;

/**
 * Watches files and directories for changes.
 * Created primarily for build tooling.
 */
class Watchr extends EventEmitter implements Closable {
	private closed: boolean;
	private ready: boolean;
	private _watchersLock: Promise<void>;
	private watchersRestorable: Record<Path, WatchrConfig>;
	private watchersRestoreTimeout?: NodeJS.Timeout;
	private readonly abortController: AbortController;
	private readonly _abortSignal: AbortSignal;
	private readonly _readyLock: Promise<void>;
	private readonly _renameHandler: FileRenameHandler;
	private readonly roots: Set<Path>;
	private readonly watchers: Record<Path, WatchrConfig[]>;
	private readonly allEventHandlers = new WeakSet<Handler>();
	static readonly FileEvent: typeof FileEvent = FileEvent;
	static readonly DirectoryEvent: typeof DirectoryEvent = DirectoryEvent;
	static readonly Event: typeof WatcherEvent = WatcherEvent;

	/**
	 * @param target The target files or directories to watch
	 * @param options The options for the watcher
	 * @param handler The handler to call when a change is detected
	 */
	constructor(target: Path[] | Path = [], options: WatchrOptions = {}, handler?: Handler) {
		super();
		Watchr.validateWatchArguments(options, handler);
		options = Watchr.normalizeWatchOptions(options);
		this.closed = false;
		this.ready = false;
		this.abortController = new AbortController();
		this._abortSignal = this.abortController.signal;
		this._readyLock = new Promise((resolve) => this.on(WatcherEvent.READY, resolve));
		this.roots = new Set();
		this._renameHandler = new FileRenameHandler(this.emitEvent.bind(this), this.error.bind(this));
		this.watchers = {};
		this._watchersLock = Promise.resolve();
		this.watchersRestorable = {};
		this.on(WatcherEvent.CLOSE, () => this.abortController.abort());
		// Initialize watching with proper error handling
		this.watch(Array.isArray(target) ? target : [ target ], options, handler).catch((error) => this.error(error));
	}

	/**
	 * Returns the abort signal for the watcher
	 * @returns The abort signal for the watcher
	 */
	get abortSignal(): AbortSignal {
		return this._abortSignal;
	}

	/**
	 * Returns the ready lock for the watcher
	 * @returns The ready lock for the watcher
	 */
	get readyLock(): Promise<void> {
		return this._readyLock;
	}

	/**
	 * Returns the rename handler for the watcher
	 * @returns The rename handler for the watcher
	 */
	get renameWatchr(): FileRenameHandler {
		return this._renameHandler;
	}

	/**
	 * Adds a watcher configuration to the watcher
	 * @param config The watcher configuration to add
	 */
	addWatcherConfig(config: WatchrConfig): void {
		const { folderPath } = config;
		(this.watchers[folderPath] = (this.watchers[folderPath] ?? [])).push(config);
	}

	/**
	 * Checks if the watcher is closed
	 * @returns True if the watcher is closed, false otherwise
	 */
	isClosed(): boolean {
		return this.closed;
	}

	/**
	 * Checks if the target path is ignored
	 * @param targetPath The target path to check
	 * @param ignore The ignore matcher to use
	 * @returns True if the target path is ignored, false otherwise
	 */
	isIgnored(targetPath: Path, ignore?: WatchIgnore): boolean {
		if (ignore === undefined) { return false }

		if (typeof ignore !== 'function') { return Watchr.matchesNativeIgnore(targetPath, ignore) }

		try {
			return ignore(targetPath);
		} catch {
			this.error(new Error('🚨 ignore callback failed.'));
			return true;
		}
	}

	/**
	 * Matches a target path against a native ignore matcher.
	 * @param targetPath The target path to test.
	 * @param nativeIgnore A native ignore pattern.
	 * @returns True when the matcher applies to the target path.
	 */
	private static matchesNativeIgnore(targetPath: Path, nativeIgnore: NativeIgnoreMatcher | NativeIgnoreEntry): boolean {
		if (Watchr.isNativeIgnoreArray(nativeIgnore)) {
			for (const ignoreEntry of nativeIgnore) {
				if (Watchr.matchesNativeIgnore(targetPath, ignoreEntry)) { return true }
			}

			return false;
		}

		if (typeof nativeIgnore === 'function') {
			const basenamePath = basename(targetPath);

			return nativeIgnore(targetPath) || nativeIgnore(basenamePath);
		}

		if (typeof nativeIgnore === 'string') {
			if (targetPath === nativeIgnore || basename(targetPath) === nativeIgnore) { return true }
			const trimmedTargetPath = targetPath.replace(/^\/+/, '');

			return matchesGlob(targetPath, nativeIgnore) || matchesGlob(trimmedTargetPath, nativeIgnore) || matchesGlob(basename(targetPath), nativeIgnore);
		}

		if (!(nativeIgnore instanceof RegExp)) { return false }

		nativeIgnore.lastIndex = 0;

		if (nativeIgnore.test(targetPath)) { return true }

		nativeIgnore.lastIndex = 0;

		return nativeIgnore.test(basename(targetPath));
	}

	/**
	 * Type guard for native ignore arrays.
	 * @param nativeIgnore Ignore matcher candidate.
	 * @returns True when nativeIgnore is an array of native ignore entries.
	 */
	private static isNativeIgnoreArray(nativeIgnore: NativeIgnoreMatcher | NativeIgnoreEntry): nativeIgnore is ReadonlyArray<NativeIgnoreEntry> {
		return Array.isArray(nativeIgnore);
	}

	/**
	 * Checks if the watcher is ready
	 * @returns True if the watcher is ready, false otherwise
	 */
	isReady(): boolean {
		return this.ready;
	}

	/**
	 * Closes the watcher
	 */
	close(): void {
		this._renameHandler.reset();
		this.roots.clear();
		this.watchersClose();

		// Clear watcher restoration timeout and restorable watchers
		if (this.watchersRestoreTimeout) {
			clearTimeout(this.watchersRestoreTimeout);
			delete this.watchersRestoreTimeout;
		}
		this.watchersRestorable = {};

		if (this.isClosed()) { return }

		this.closed = true;

		// Abort pending operations before emitting close event to avoid race conditions
		this.abortController.abort();

		this.emit(WatcherEvent.CLOSE);
	}

	/**
	 * Emits an error event
	 * @param exception The error to emit
	 * @returns True if the event was emitted, false otherwise
	 */
	error(exception: unknown): boolean {
		if (this.isClosed()) { return false }

		return this.emit(WatcherEvent.ERROR, castError(exception));
	}

	/**
	 * Emits a file system event
	 * @param event The file system event to emit
	 * @param targetPath The target path of the event
	 * @param targetPathNext The next target path of the event
	 */
	emitEvent(event: FileSystemEvent, targetPath: Path, targetPathNext?: Path): void {
		if (this.isClosed()) { return }

		const targetStats = this.resolveEventStats(targetPath, targetPathNext);

		if (event === 'unlink' || event === 'unlinkDir') {
			this.lastKnownStats.delete(targetPath);
		} else {
			this.lastKnownStats.set(targetPath, targetStats);
			if (targetPathNext) {
				this.lastKnownStats.set(targetPathNext, targetStats);
			}
		}

		this.emit(WatcherEvent.ALL, event, targetStats, targetPath, targetPathNext);
		this.emit(event, targetStats, targetPath, targetPathNext);
	}

	/**
	 * Resolves event stats with fallbacks for rename/unlink edge cases.
	 * @param targetPath Primary event path.
	 * @param targetPathNext Optional secondary event path.
	 * @returns A concrete stats object for downstream handlers.
	 */
	private resolveEventStats(targetPath: Path, targetPathNext?: Path): WatchrStats {
		const fileStateStats = this._renameHandler.fileStateManager.stats;
		const currentStats = fileStateStats.get(targetPath);

		if (currentStats) { return currentStats }

		if (targetPathNext) {
			const nextStats = fileStateStats.get(targetPathNext);

			if (nextStats) { return nextStats }
		}

		const cachedStats = this.lastKnownStats.get(targetPath) ?? (targetPathNext ? this.lastKnownStats.get(targetPathNext) : undefined);

		return cachedStats ?? Watchr.createFallbackStats();
	}

	/**
	 * Creates a synthetic stats snapshot for edge-case events where native
	 * watchers do not provide enough information to recover a tracked stat.
	 * @returns A synthetic stats object with default values.
	 */
	private static createFallbackStats(): WatchrStats {
		const nowMs = Date.now();
		const nowNs = BigInt(nowMs) * 1_000_000n;
		const nowMsBigInt = BigInt(nowMs);
		const fallbackStats: BigIntStats = {
			ino: 0n,
			size: 0n,
			atimeNs: nowNs,
			mtimeNs: nowNs,
			ctimeNs: nowNs,
			birthtimeNs: nowNs,
			atimeMs: nowMsBigInt,
			mtimeMs: nowMsBigInt,
			ctimeMs: nowMsBigInt,
			birthtimeMs: nowMsBigInt,
			isFile: () => true,
			isDirectory: () => false,
			isSymbolicLink: () => false,
			isBlockDevice: () => false,
			isCharacterDevice: () => false,
			isFIFO: () => false,
			isSocket: () => false,
			mode: 0n,
			nlink: 0n,
			uid: 0n,
			gid: 0n,
			rdev: 0n,
			blksize: 0n,
			blocks: 0n,
			dev: 0n,
			atime: new Date(nowMs),
			mtime: new Date(nowMs),
			ctime: new Date(nowMs),
			birthtime: new Date(nowMs),
		};

		return new WatchrStats(fallbackStats);
	}

	/**
	 * Closes all watchers for a given folder path
	 * @param folderPath The folder path to close watchers for
	 * @param filePath The file path to close watchers for
	 */
	watchersClose(folderPath?: Path, filePath?: Path): void {
		if (!folderPath) {
			for (const folderPath of Object.keys(this.watchers)) {
				this.watchersClose(folderPath, filePath);
			}
		} else {
			// It's important to clone the array, as items will be deleted from it
			for (const watcherConfig of [ ...this.watchers[folderPath] ?? [] ]) {
				if (!filePath || watcherConfig.filePath === filePath) { this.watcherClose(watcherConfig) }
			}
		}
	}

	/**
	 * Sets the watcher to the ready state
	 * @returns true if there were any listeners for the ready event, false otherwise
	 */
	private setReady() {
		if (this.isClosed() || this.isReady()) { return false }

		this.ready = true;

		return this.emit(WatcherEvent.READY);
	}

	/** Restores the watchers from a previous state */
	private watchersRestore() {
		delete this.watchersRestoreTimeout;

		if (this.isClosed()) { return }

		const restorable = { ...this.watchersRestorable };
		this.watchersRestorable = {};

		for (const [ targetPath, { options, handler } ] of Object.entries(restorable)) {
			void this.watchPath(targetPath, options, handler);
		}
	}

	/**
	 * Adds a new watcher
	 * @param config The configuration for the watcher
	 * @returns The file system event manager for the new watcher
	 */
	private async addWatcher(config: WatchrConfig) {
		this.addWatcherConfig(config);

		const eventManager = await FileSystemEventManager.newInstance(this._renameHandler.fileStateManager, this, config);
		config.eventManager = eventManager;

		return eventManager;
	}

	/**
	 * Watches a directory for changes
	 * @param folderPath The path of the folder to watch
	 * @param options The options for the watcher
	 * @param handler The handler to call when changes are detected
	 * @param filePath The path of the file to watch (if any)
	 * @returns A promise that resolves when the watcher is active
	 */
	private async watchDirectory(folderPath: Path, options: WatchrOptions, handler?: Handler, filePath?: Path) {
		if (this.isClosed() || this.isIgnored(folderPath, options.ignore)) { return }

		// Node.js 20.16+ supports recursive watching natively on all platforms
		return this.synchronizeWatchers(async () => {
			if (this.isClosed() || this._abortSignal.aborted) { return }

			await this.addWatcher({
				watcher: watch(folderPath, options),
				options,
				folderPath,
				...(handler === undefined ? {} : { handler }),
				...(filePath === undefined ? {} : { filePath }),
			});
		});
	}

	/**
	 * Synchronizes the watchers by locking them for a given callback
	 * @param callback The callback to execute while the watchers are locked
	 * @returns A promise that resolves when the callback is complete
	 */
	private async synchronizeWatchers(callback: AsyncCallable) {
		await this._watchersLock;

		return this._watchersLock = callback();
	}

	/**
	 * Watches a file for changes
	 * @param filePath The path of the file to watch
	 * @param options The options for the watcher
	 * @param handler The handler to call when changes are detected
	 * @returns A promise that resolves when the watcher is active
	 */
	private async watchFile(filePath: Path, options: WatchrOptions, handler?: Handler) {
		if (this.isClosed() || this.isIgnored(filePath, options.ignore)) { return }

		return this.watchDirectory(dirname(filePath), { ...options, recursive: false }, handler, filePath);
	}

	/**
	 * Watches multiple paths for changes
	 * @param targetPaths The paths to watch
	 * @param options The options for the watcher
	 * @param handler The handler to call when changes are detected
	 * @returns A promise that resolves when all watchers are active
	 */
	private async watchPaths(targetPaths: Path[], options: WatchrOptions, handler: Handler = noop) {
		if (this.isClosed() || this._abortSignal.aborted) { return }

		if (targetPaths.length === 1) { return this.watchPath(targetPaths[0]!, options, handler) }

		// Sort and deduplicate the paths
		targetPaths = uniqueSortedArray(targetPaths);

		// NOTE: Parallelization at the directory traversal level (readDirectory) has been implemented to improve latency.
		// This method watches paths serially when subpaths are detected to prevent duplicate watchers on the same folder.
		// For independent paths, parallelization via Promise.all() is used below.
		let hasSubPaths = false;
		const length = targetPaths.length;
		outer: for (let i = 0; i < length; i++) {
			for (let j = i + 1; j < length; j++) {
				if (FileSystem.isSubPath(targetPaths[i]!, targetPaths[j]!)) {
					hasSubPaths = true;
					break outer;
				}
			}
		}

		if (hasSubPaths) {
			// Watching serially
			for (let i = 0; i < length; i++) {
				if (this._abortSignal.aborted) { return }
				await this.watchPath(targetPaths[i]!, options, handler);
			}
		} else {
			// All paths are about separate subtrees, so we can start watching in parallel safely
			await Promise.all(targetPaths.map((targetPath) => this._abortSignal.aborted ? Promise.resolve() : this.watchPath(targetPath, options, handler)));
		}
	}

	/**
	 * Watches a path for changes
	 * @param targetPath The path to watch
	 * @param options The options for the watcher
	 * @param handler The handler to call when changes are detected
	 * @returns A promise that resolves when the watcher is active
	 */
	private async watchPath(targetPath: Path, options: WatchrOptions, handler?: Handler) {
		if (this.isClosed()) { return }

		targetPath = resolve(targetPath);

		if (this.isIgnored(targetPath, options.ignore)) { return }

		const stats = await FileSystem.getStats(targetPath);

		if (this.isClosed() || this._abortSignal.aborted) { return }

		if (!stats) {
			// Double-check if closed after async operation to avoid race condition during cleanup
			// The abort signal might not be set yet due to event listener timing, so also check this.closed directly
			if (this.closed || this._abortSignal.aborted) { return }

			throw new Error('🚨 Path not found');
		}

		if (stats.isFile()) {
			return this.watchFile(targetPath, options, handler);
		} else if (stats.isDirectory()) {
			return this.watchDirectory(targetPath, options, handler);
		} else {
			this.error('🚨 Target path type is not supported');
		}
	}

	/**
	 * Watches a set of paths for changes
	 * @param target The paths to watch
	 * @param options The options for the watcher
	 * @param handler The handler to call when changes are detected
	 * @returns A promise that resolves when all watchers are active
	 */
	private async watch(target: Path[], options: WatchrOptions, handler?: Handler) {
		if (this.isClosed()) { return }

		for (const targetPath of target) { this.roots.add(targetPath) }

		await this.watchPaths(target, options, handler);

		if (this.isClosed()) { return }

		if (handler !== undefined && !this.allEventHandlers.has(handler)) {
			this.allEventHandlers.add(handler);
			this.on(WatcherEvent.ALL, (...args: Parameters<Handler>) => {
				try {
					handler(...args);
				} catch (error: unknown) {
					this.error(error);
				}
			});
		}

		this.setReady();
	}

	/**
	 * Closes a watcher for a specific config
	 * @param config The config for the watcher
	 */
	private watcherClose(config: WatchrConfig) {
		config.eventManager?.cleanup();
		config.watcher.close();

		const configs = this.watchers[config.folderPath];

		if (configs) {
			configs.splice(configs.indexOf(config), 1);

			if (!configs.length) { delete this.watchers[config.folderPath] }
		}

		const rootPath = config.filePath || config.folderPath;

		if (this.roots.has(rootPath)) {
			// I am root!
			this.watchersRestorable[rootPath] = config;

			if (!this.watchersRestoreTimeout) {
				this.watchersRestoreTimeout = setTimeout(() => this.watchersRestore());
			}
		}
	}

	/**
	 * Maps Watchr options to native watcher options.
	 * @param options User-provided watch options.
	 * @returns Native watch options.
	 */
	private toNodeWatchOptions(options: WatchrOptions): WatchOptions {
		const ignore = options.ignore;
		const watchOptions: WatchOptions = {
			...(options.persistent === undefined ? {} : { persistent: options.persistent }),
			...(options.recursive === undefined ? {} : { recursive: options.recursive }),
			...(options.encoding === undefined ? {} : { encoding: options.encoding }),
			...(options.throwIfNoEntry === undefined ? {} : { throwIfNoEntry: options.throwIfNoEntry }),
		};

		if (typeof ignore !== 'function') {
			return {
				...watchOptions,
				...(ignore === undefined ? {} : { ignore }),
			};
		}

		return {
			...watchOptions,
			ignore,
		};
	}

	/**
	 * Validates runtime watch arguments to prevent unsafe configuration.
	 * @param options The watcher options
	 * @param handler Optional event handler
	 */
	private static validateWatchArguments(options: WatchrOptions, handler?: Handler): void {
		if (handler !== undefined && typeof handler !== 'function') {
			throw new Error('🚨 handler must be a function.');
		}

		if (options.ignore !== undefined && !Watchr.isValidIgnoreOption(options.ignore)) {
			throw new Error('🚨 ignore must be a function, string, RegExp, or array of these values.');
		}

		if (options.debounce !== undefined && (!Number.isFinite(options.debounce) || options.debounce < 0)) {
			throw new Error('🚨 debounce must be a non-negative finite number.');
		}

		if (options.renameTimeout !== undefined && (!Number.isFinite(options.renameTimeout) || options.renameTimeout < 0)) {
			throw new Error('🚨 renameTimeout must be a non-negative finite number.');
		}

		if (options.maxQueue !== undefined && (!Number.isInteger(options.maxQueue) || options.maxQueue <= 0)) {
			throw new Error('🚨 maxQueue must be a positive integer.');
		}

		if (options.overflow !== undefined && options.overflow !== 'ignore' && options.overflow !== 'throw') {
			throw new Error('🚨 overflow must be either "ignore" or "throw".');
		}
	}

	/**
	 * Applies safe defaults for watch options.
	 * @param options The incoming watch options
	 * @returns Normalized watch options
	 */
	private static normalizeWatchOptions(options: WatchrOptions): WatchrOptions {
		const usesNativeQueueOptions = options.maxQueue !== undefined || options.overflow !== undefined;

		return {
			...options,
			debounce: options.debounce ?? (usesNativeQueueOptions ? 0 : debounceWait),
			renameTimeout: options.renameTimeout ?? renameTimeout
		};
	}

	/**
	 * Validates native and callback-style ignore options.
	 * @param ignore The ignore option to validate.
	 * @returns True if the ignore option is valid.
	 */
	private static isValidIgnoreOption(ignore: WatchIgnore): boolean {
		if (typeof ignore === 'function' || typeof ignore === 'string' || ignore instanceof RegExp) {
			return true;
		}

		if (!Array.isArray(ignore)) { return false }

		return ignore.every((value) => typeof value === 'string' || value instanceof RegExp || typeof value === 'function');
	}
}

export { Watchr, WatchrStats, type FileSystemEvent, type WatchrOptions };
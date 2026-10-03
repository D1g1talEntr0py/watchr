import { watch } from 'node:fs';
import { EventEmitter } from 'node:events';
import { resolve, dirname, basename, matchesGlob } from 'node:path';
import { FileSystem } from './file-system';
import { castError, noop, uniqueSortedArray } from './utils';
import { FileRenameHandler } from './file-rename-handler';
import { LockResolver } from './lock-resolver';
import { WatchrStats } from './watchr-stats';
import { FileEvent, DirectoryEvent, FileSystemEvent, WatcherEvent, renameTimeout, statTimeout, fallbackScanInterval } from './constants';
import { FileSystemEventManager } from './file-system-event-manager';
import type { WatchOptions } from 'node:fs';
import type { Handler, WatchIgnore, IgnoreMatcher, Path, WatchrOptions, WatchrEventMap, NormalizedWatchrOptions, WatchrConfig, AsyncCallable, Closable, NodeError } from './@types/index';

type NativeIgnoreEntry = string | RegExp | ((filename: string) => boolean);
/** A root whose watcher died and is awaiting re-attachment. */
type RestorableWatcher = { config: WatchrConfig, attempt: number, timer?: NodeJS.Timeout | undefined };
/** File system events that carry a destination path. */
type RenameEvent = typeof FileSystemEvent.RENAME | typeof FileSystemEvent.RENAME_DIR;

/** Set once the Tier 2 platform warning has been emitted for this process. */
let platformWarningEmitted = false;

/**
 * Type guard for native ignore entries.
 * @param entry - The entry to check.
 * @returns True if the entry is a native ignore entry.
 */
function isNativeIgnoreEntry(entry: unknown): entry is NativeIgnoreEntry {
	return !Array.isArray(entry) && (typeof entry === 'string' || entry instanceof RegExp || typeof entry === 'function');
}

/**
 * Watches files and directories for changes.
 * Created primarily for build tooling.
 */
class Watchr extends EventEmitter<WatchrEventMap> implements Closable {
	#closed: boolean;
	#ready: boolean;
	#watchersLock: Promise<void>;
	readonly #watchersRestorable: Map<Path, RestorableWatcher>;
	readonly #abortController: AbortController;
	readonly #abortSignal: AbortSignal;
	readonly #readyLock: Promise<void>;
	readonly #readyReject: (reason?: unknown) => void;
	readonly #renameHandler: FileRenameHandler;
	readonly #roots: Set<Path>;
	readonly #watchers: Map<Path, WatchrConfig[]>;
	readonly #allEventHandlers = new WeakSet<Handler>();
	static readonly FileEvent: typeof FileEvent = FileEvent;
	static readonly DirectoryEvent: typeof DirectoryEvent = DirectoryEvent;
	static readonly Event: typeof WatcherEvent = WatcherEvent;
	/** Delays between root restore attempts; the last value repeats until the root reappears or the watcher closes. */
	static readonly #restoreBackoffMs: readonly number[] = [ 100, 250, 500, 1000, 2000 ];

	/**
	 * @param target The target files or directories to watch
	 * @param options The options for the watcher
	 * @param handler The handler to call when a change is detected
	 */
	constructor(target: Path[] | Path = [], options: WatchrOptions = {}, handler?: Handler) {
		super();

		if (process.platform === 'win32' && !platformWarningEmitted) {
			platformWarningEmitted = true;
			Watchr.#warn('Windows support is best-effort (Tier 2).', 'WATCHR_PLATFORM_TIER2', 'Use WSL for guaranteed behavior.');
		}

		Watchr.#validateWatchArguments(options, handler);
		this.#closed = false;
		this.#ready = false;
		this.#abortController = new AbortController();
		this.#abortSignal = this.#abortController.signal;
		let rejectReady: (reason?: unknown) => void = noop;
		this.#readyLock = new Promise((resolve, reject) => {
			rejectReady = reject;
			const cleanup = (): void => {
				this.off(WatcherEvent.READY, onReady);
				this.off(WatcherEvent.CLOSE, onClose);
			};

			const onReady = (): void => {
				cleanup();
				resolve();
			};

			const onClose = (): void => {
				cleanup();
				reject(new Error('watcher closed before becoming ready.'));
			};

			this.on(WatcherEvent.READY, onReady);
			this.on(WatcherEvent.CLOSE, onClose);
		});
		this.#readyReject = rejectReady;
		this.#readyLock.catch(noop);
		this.#roots = new Set();
		this.#renameHandler = new FileRenameHandler(this.#emitEvent.bind(this), this.#error.bind(this), new LockResolver({ onError: (error) => void this.#error(error) }));
		this.#watchers = new Map();
		this.#watchersLock = Promise.resolve();
		this.#watchersRestorable = new Map();
		this.on(WatcherEvent.CLOSE, () => this.#abortController.abort());
		// Initialize watching with proper error handling
		this.#watch(Array.isArray(target) ? target : [ target ], options, handler).catch((error) => this.#error(error));
	}

	/**
	 * Returns the abort signal for the watcher
	 * @returns The abort signal for the watcher
	 */
	get abortSignal(): AbortSignal {
		return this.#abortSignal;
	}

	/**
	 * Returns the ready lock for the watcher
	 * @returns The ready lock for the watcher
	 */
	get readyLock(): Promise<void> {
		return this.#readyLock;
	}

	/**
	 * Adds a watcher configuration to the watcher
	 * @param config The watcher configuration to add
	 * @internal
	 */
	#addWatcherConfig(config: WatchrConfig): void {
		const { folderPath } = config;
		const configs = this.#watchers.get(folderPath);

		if (configs === undefined) {
			this.#watchers.set(folderPath, [ config ]);
		} else {
			configs.push(config);
		}
	}

	/**
	 * Checks if the watcher is closed
	 * @returns True if the watcher is closed, false otherwise
	 */
	isClosed(): boolean {
		return this.#closed;
	}

	/**
	 * Checks if the target path is ignored.
	 * Pass the precompiled `ignoreMatcher` from normalized options on hot paths; a raw ignore option is compiled per call.
	 * @param targetPath The target path to check
	 * @param ignore The ignore option or precompiled matcher to use
	 * @returns True if the target path is ignored, false otherwise
	 */
	isIgnored(targetPath: Path, ignore?: WatchIgnore | IgnoreMatcher): boolean {
		if (ignore === undefined) { return false }

		try {
			return typeof ignore === 'function' ? ignore(targetPath) : Watchr.#compileIgnore(ignore)(targetPath);
		} catch (error: unknown) {
			this.#error(new Error('ignore callback failed.', { cause: error }));
			return true;
		}
	}

	/**
	 * Compiles an ignore option into a single predicate so per-path checks do no pattern parsing or branching.
	 * @param ignore The ignore option to compile.
	 * @returns The predicate, or `undefined` when nothing is ignored.
	 */
	static #compileIgnore(ignore: WatchIgnore): IgnoreMatcher;
	static #compileIgnore(ignore: WatchIgnore | undefined): IgnoreMatcher | undefined;
	static #compileIgnore(ignore: WatchIgnore | undefined) {
		if (ignore === undefined) { return undefined }

		if (isNativeIgnoreEntry(ignore)) { return Watchr.#compileIgnoreEntry(ignore, false) }

		const matchers = ignore.map((entry) => Watchr.#compileIgnoreEntry(entry, true));

		if (matchers.length === 1) { return matchers[0]! }

		return (targetPath: Path): boolean => {
			for (const matcher of matchers) {
				if (matcher(targetPath)) { return true }
			}

			return false;
		};
	}

	/**
	 * Compiles one ignore entry. Strings and RegExps match the full path or its basename; a top-level callback receives
	 * the full path only, while a callback nested in an array is also offered the basename (native `fs.watch` semantics).
	 * @param entry The ignore entry to compile.
	 * @param nested Whether the entry came from an array.
	 * @returns The predicate for the entry.
	 */
	static #compileIgnoreEntry(entry: NativeIgnoreEntry, nested: boolean): IgnoreMatcher {
		if (typeof entry === 'function') {
			return nested ? (targetPath: Path) => entry(targetPath) || entry(basename(targetPath)) : entry;
		}

		if (typeof entry === 'string') {
			return (targetPath: Path): boolean => {
				if (targetPath === entry || matchesGlob(targetPath, entry)) { return true }

				const basenamePath = basename(targetPath);

				return basenamePath === entry || matchesGlob(basenamePath, entry);
			};
		}

		// Only global/sticky patterns carry state across `test()` calls.
		const stateful = entry.global || entry.sticky;

		return (targetPath: Path): boolean => {
			if (stateful) { entry.lastIndex = 0 }
			if (entry.test(targetPath)) { return true }
			if (stateful) { entry.lastIndex = 0 }

			return entry.test(basename(targetPath));
		};
	}

	/**
	 * Checks if the watcher is ready
	 * @returns True if the watcher is ready, false otherwise
	 */
	isReady(): boolean {
		return this.#ready;
	}

	/**
	 * Closes the watcher
	 */
	close(): void {
		if (this.isClosed()) { return }

		this.#closed = true;
		this.#abortController.abort();
		this.#readyReject(new Error('watcher closed before becoming ready.'));
		this.#renameHandler.reset();
		this.#roots.clear();
		this.#watchersClose();
		this.#clearRestorableWatchers();

		this.emit(WatcherEvent.CLOSE);
	}

	/**
	 * Cancels every pending root restore and forgets the restorable roots.
	 */
	#clearRestorableWatchers() {
		for (const restorable of this.#watchersRestorable.values()) {
			if (restorable.timer !== undefined) { clearTimeout(restorable.timer) }
		}

		this.#watchersRestorable.clear();
	}

	/**
	 * Disposes the watcher using the explicit resource management protocol.
	 */
	[Symbol.dispose](): void {
		this.close();
	}

	/**
	 * Emits an error event. A throwing (or missing) `error` listener is reported through `process.emitWarning`
	 * so watcher-internal failures can never surface as uncaught exceptions.
	 * Consumers should listen for `error` rather than call this.
	 * @param exception The error to emit
	 * @returns True if the event was delivered to a listener, false otherwise
	 * @internal
	 */
	#error(exception: unknown) {
		if (this.isClosed()) { return false }

		const error = castError(exception);

		try {
			return this.emit(WatcherEvent.ERROR, error);
		} catch (listenerError: unknown) {
			if (this.listenerCount(WatcherEvent.ERROR) === 0) {
				Watchr.#warn(error.message, 'WATCHR_UNHANDLED_ERROR', 'Attach an "error" listener to receive watcher errors.', error);
			} else {
				const thrown = castError(listenerError);

				Watchr.#warn(thrown.message, 'WATCHR_UNHANDLED_ERROR', 'An "error" listener threw while handling a watcher error.', thrown);
			}

			return false;
		}
	}

	/**
	 * Emits a `WatchrWarning` process warning.
	 * @param message The warning message
	 * @param code The warning code
	 * @param detail Guidance appended to the warning
	 * @param cause The error that triggered the warning, if any
	 */
	static #warn(message: string, code: string, detail: string, cause?: Error) {
		// Node ignores `options.code`/`detail` for Error instances, so mirror them onto the warning object itself.
		const warning = Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { name: 'WatchrWarning', code, detail });

		process.emitWarning(warning, { code, detail });
	}

	/**
	 * Emits a file system event
	 * @param event The file system event to emit
	 * @param targetPath The target path of the event
	 * @param stats The stats to deliver with the event (previous stats for removals, current stats otherwise)
	 * @param targetPathNext The next target path of the event
	 * @internal
	 */
	#emitEvent(event: FileSystemEvent, targetPath: Path, stats: WatchrStats, targetPathNext?: Path) {
		if (this.isClosed()) { return }

		if (Watchr.#isRenameEvent(event)) {
			if (targetPathNext === undefined) {
				this.#error(new Error('Rename event is missing its destination path.'));

				return;
			}

			this.#emitSafely(WatcherEvent.ALL, event, stats, targetPath, targetPathNext);
			this.#emitSafely(event, stats, targetPath, targetPathNext);

			return;
		}

		this.#emitSafely(WatcherEvent.ALL, event, stats, targetPath);
		this.#emitSafely(event, stats, targetPath);
	}

	/**
	 * Narrows a file system event to the rename events, which carry a destination path.
	 * @param event The event to classify
	 * @returns True for `rename` and `renameDir`
	 */
	static #isRenameEvent(event: FileSystemEvent): event is RenameEvent {
		return event === FileSystemEvent.RENAME || event === FileSystemEvent.RENAME_DIR;
	}

	/**
	 * Emits an event, routing listener exceptions to `error` instead of letting them escape a timer tick.
	 * @param eventName The event to emit
	 * @param args The event arguments
	 */
	#emitSafely<K extends keyof WatchrEventMap>(eventName: K, ...args: WatchrEventMap[K]): void {
		try {
			// Node's `emit` defers its argument type behind a conditional on `K`; the map already constrains `args`.
			(this.emit as (eventName: K, ...args: WatchrEventMap[K]) => boolean)(eventName, ...args);
		} catch (error: unknown) {
			this.#error(new Error('Event listener threw.', { cause: error }));
		}
	}

	/**
	 * Closes all watchers for a given folder path
	 * @param folderPath The folder path to close watchers for
	 * @param filePath The file path to close watchers for
	 * @internal
	 */
	#watchersClose(folderPath?: Path, filePath?: Path): void {
		if (!folderPath) {
			for (const folderPath of [ ...this.#watchers.keys() ]) {
				this.#watchersClose(folderPath, filePath);
			}
		} else {
			// It's important to clone the array, as items will be deleted from it
			for (const watcherConfig of [ ...this.#watchers.get(folderPath) ?? [] ]) {
				if (!filePath || watcherConfig.filePath === filePath) { this.#watcherClose(watcherConfig) }
			}
		}
	}

	/**
	 * Sets the watcher to the ready state
	 * @returns true if there were any listeners for the ready event, false otherwise
	 */
	#setReady() {
		if (this.isClosed() || this.isReady()) { return false }

		this.#ready = true;

		return this.emit(WatcherEvent.READY);
	}

	/**
	 * Schedules a restore attempt for a root whose watcher died, using escalating backoff.
	 * @param rootPath The root to restore
	 * @param restorable The restore bookkeeping for the root
	 */
	#scheduleWatcherRestore(rootPath: Path, restorable: RestorableWatcher): void {
		const delay = Watchr.#restoreBackoffMs[Math.min(restorable.attempt, Watchr.#restoreBackoffMs.length - 1)]!;

		this.#watchersRestorable.set(rootPath, restorable);
		restorable.timer = setTimeout(() => {
			restorable.timer = undefined;
			void this.#watcherRestore(rootPath, restorable);
		}, delay);

		// A missing root must not keep the process alive on its own.
		restorable.timer.unref();
	}

	/**
	 * Re-attaches a root watcher. A still-missing root is silently retried; any other failure is
	 * reported and retried. Success removes the root from the restorable set.
	 * @param rootPath The root to restore
	 * @param restorable The restore bookkeeping for the root
	 */
	async #watcherRestore(rootPath: Path, restorable: RestorableWatcher): Promise<void> {
		if (this.isClosed() || this.#watchersRestorable.get(rootPath) !== restorable) { return }

		const { options, handler } = restorable.config;

		try {
			await this.watchPath(rootPath, options, handler);
		} catch (error: unknown) {
			if (this.isClosed() || this.#watchersRestorable.get(rootPath) !== restorable) { return }

			if (!Watchr.#isMissingPathError(error)) { this.#error(error) }

			restorable.attempt++;
			this.#scheduleWatcherRestore(rootPath, restorable);

			return;
		}

		if (this.#watchersRestorable.get(rootPath) === restorable) { this.#watchersRestorable.delete(rootPath) }
	}

	/**
	 * Detects the "root does not exist (yet)" failure class, which is expected while a root is being recreated.
	 * @param error The failure to classify
	 * @returns True when the failure only means the path is absent
	 */
	static #isMissingPathError(error: unknown): boolean {
		if (!(error instanceof Error)) { return false }

		return error.message === 'Path not found' || (error as NodeError).code === 'ENOENT' || (error.cause instanceof Error && (error.cause as NodeError).code === 'ENOENT');
	}

	/**
	 * Adds a new watcher
	 * @param config The configuration for the watcher
	 * @returns The file system event manager for the new watcher
	 */
	async #addWatcher(config: WatchrConfig) {
		this.#addWatcherConfig(config);

		try {
			const eventManager = await FileSystemEventManager.newInstance(this.#renameHandler.fileStateManager, this, config, {
				renameHandler: this.#renameHandler,
				reportError: (error) => this.#error(error),
				closeWatchers: (folderPath?: Path, filePath?: Path) => this.#watchersClose(folderPath, filePath)
			});
			config.eventManager = eventManager;

			return eventManager;
		} catch (error: unknown) {
			this.#removeWatcherConfig(config);
			config.watcher.close();
			throw error;
		}
	}

	/**
	 * Removes a watcher configuration after failed asynchronous initialization.
	 * @param config The watcher configuration to remove.
	 */
	#removeWatcherConfig(config: WatchrConfig): void {
		const configs = this.#watchers.get(config.folderPath);
		if (!configs) { return }

		const index = configs.indexOf(config);
		if (index !== -1) { configs.splice(index, 1) }
		if (configs.length === 0) { this.#watchers.delete(config.folderPath) }
	}

	/**
	 * Watches a directory for changes
	 * @param folderPath The path of the folder to watch
	 * @param options The options for the watcher
	 * @param handler The handler to call when changes are detected
	 * @param filePath The path of the file to watch (if any)
	 * @returns A promise that resolves when the watcher is active
	 */
	async #watchDirectory(folderPath: Path, options: NormalizedWatchrOptions, handler?: Handler, filePath?: Path) {
		if (this.isClosed() || this.isIgnored(folderPath, options.ignoreMatcher)) { return }
		const watchOptions = this.#toNodeWatchOptions(options);

		// Node.js 20.16+ supports recursive watching natively on all platforms
		return this.#synchronizeWatchers(async () => {
			if (this.isClosed() || this.#abortSignal.aborted) { return }

			const config: WatchrConfig = {
				watcher: watch(folderPath, { ...watchOptions, signal: this.#abortSignal }, () => {}),
				options,
				folderPath
			};

			if (filePath !== undefined) { config.filePath = filePath }

			if (handler !== undefined) { config.handler = handler }

			await this.#addWatcher(config);
		});
	}

	/**
	 * Synchronizes the watchers by locking them for a given callback
	 * @param callback The callback to execute while the watchers are locked
	 * @returns A promise that resolves when the callback is complete
	 */
	async #synchronizeWatchers(callback: AsyncCallable) {
		await this.#watchersLock;

		const task = this.#watchersLock.then(() => callback(), () => callback());
		this.#watchersLock = task.catch(noop);

		return task;
	}

	/**
	 * Watches a file for changes
	 * @param filePath The path of the file to watch
	 * @param options The options for the watcher
	 * @param handler The handler to call when changes are detected
	 * @returns A promise that resolves when the watcher is active
	 */
	async #watchFile(filePath: Path, options: NormalizedWatchrOptions, handler?: Handler) {
		if (this.isClosed() || this.isIgnored(filePath, options.ignoreMatcher)) { return }

		const folderPath = dirname(filePath);
		const fileWatchOptions: NormalizedWatchrOptions = { ...options, recursive: false };
		const watchOptions = this.#toNodeWatchOptions(fileWatchOptions);

		return this.#synchronizeWatchers(async () => {
			if (this.isClosed() || this.#abortSignal.aborted) { return }

			const config: WatchrConfig = {
				// Watch the parent directory so atomic-save inode replacement keeps emitting events for the target file.
				watcher: watch(folderPath, { ...watchOptions, signal: this.#abortSignal }, () => {}),
				options: fileWatchOptions,
				folderPath,
				filePath
			};

			if (handler !== undefined) { config.handler = handler }

			await this.#addWatcher(config);
		});
	}

	/**
	 * Watches multiple paths for changes
	 * @param targetPaths The paths to watch
	 * @param options The options for the watcher
	 * @param handler The handler to call when changes are detected
	 * @returns A promise that resolves when all watchers are active
	 */
	async #watchPaths(targetPaths: Path[], options: WatchrOptions, handler: Handler = noop) {
		if (this.isClosed() || this.#abortSignal.aborted) { return }

		if (targetPaths.length === 1) { return this.watchPath(targetPaths[0]!, options, handler) }

		// Resolve, sort, and deduplicate once so ancestor checks use canonical paths.
		targetPaths = uniqueSortedArray(targetPaths.map((targetPath) => resolve(targetPath)));

		// NOTE: Parallelization at the directory traversal level (readDirectory) has been implemented to improve latency.
		// This method watches paths serially when subpaths are detected to prevent duplicate watchers on the same folder.
		// For independent paths, parallelization via Promise.all() is used below.
		const length = targetPaths.length;
		// Collect every proper ancestor once (walks stop at already-seen ancestors), then check targets against it.
		const ancestorPaths = new Set<Path>();

		for (const targetPath of targetPaths) {
			let currentPath = targetPath;
			let parentPath = dirname(currentPath);

			while (parentPath !== currentPath && !ancestorPaths.has(parentPath)) {
				ancestorPaths.add(parentPath);
				currentPath = parentPath;
				parentPath = dirname(currentPath);
			}
		}

		const hasSubPaths = targetPaths.some((targetPath) => ancestorPaths.has(targetPath));

		if (hasSubPaths) {
			// Watching serially
			for (let i = 0; i < length; i++) {
				if (this.#abortSignal.aborted) { return }
				await this.watchPath(targetPaths[i]!, options, handler);
			}
		} else {
			// All paths are about separate subtrees, so we can start watching in parallel safely
			await Promise.all(targetPaths.map((targetPath) => this.#abortSignal.aborted ? Promise.resolve() : this.watchPath(targetPath, options, handler)));
		}
	}

	/**
	 * Watches a path for changes
	 * @param targetPath The path to watch
	 * @param options The options for the watcher; defaults are applied and the ignore option compiled here
	 * @param handler The handler to call when changes are detected
	 * @returns A promise that resolves when the watcher is active
	 */
	async watchPath(targetPath: Path, options: WatchrOptions, handler?: Handler): Promise<void> {
		if (this.isClosed()) { return }

		targetPath = resolve(targetPath);
		const normalizedOptions = Watchr.#normalizeWatchOptions(options);

		if (this.isIgnored(targetPath, normalizedOptions.ignoreMatcher)) { return }

		const stats = await FileSystem.getStats(targetPath, { timeout: normalizedOptions.statTimeout });

		if (this.isClosed() || this.#abortSignal.aborted) { return }

		if (!stats) {
			// Double-check if closed after async operation to avoid race condition during cleanup
			// The abort signal might not be set yet due to event listener timing, so also check this.closed directly
			if (this.#closed || this.#abortSignal.aborted) { return }

			throw new Error('Path not found');
		}

		if (stats.isFile()) {
			return this.#watchFile(targetPath, normalizedOptions, handler);
		} else if (stats.isDirectory()) {
			return this.#watchDirectory(targetPath, normalizedOptions, handler);
		} else {
			this.#error('Target path type is not supported');
		}
	}

	/**
	 * Watches a set of paths for changes
	 * @param target The paths to watch
	 * @param options The options for the watcher
	 * @param handler The handler to call when changes are detected
	 * @returns A promise that resolves when all watchers are active
	 */
	async #watch(target: Path[], options: WatchrOptions, handler?: Handler) {
		if (this.isClosed()) { return }

		for (const targetPath of target) { this.#roots.add(resolve(targetPath)) }

		try {
			await this.#watchPaths(target, options, handler);
		} catch (error: unknown) {
			this.#readyReject(error);
			// Report before closing: `error()` is a no-op once the watcher is closed.
			this.#error(error);
			this.close();

			return;
		}

		if (this.isClosed()) { return }

		if (handler !== undefined && !this.#allEventHandlers.has(handler)) {
			this.#allEventHandlers.add(handler);
			this.on(WatcherEvent.ALL, (...args: Parameters<Handler>) => {
				try {
					handler(...args);
				} catch (error: unknown) {
					this.#error(error);
				}
			});
		}

		this.#setReady();
	}

	/**
	 * Closes a watcher for a specific config.
	 * @param config The config for the watcher
	 */
	#watcherClose(config: WatchrConfig) {
		config.eventManager?.cleanup();
		config.watcher.close();
		this.#removeWatcherConfig(config);

		if (this.isClosed()) { return }

		const rootPath = config.filePath || config.folderPath;

		if (!this.#roots.has(rootPath)) { return }

		// I am root! Keep trying to re-attach until the path comes back or the watcher closes.
		const previous = this.#watchersRestorable.get(rootPath);

		if (previous?.timer !== undefined) { clearTimeout(previous.timer) }

		this.#scheduleWatcherRestore(rootPath, { config, attempt: 0 });
	}

	/**
	 * Maps Watchr options to native watcher options.
	 * @param options User-provided watch options.
	 * @returns Native watch options.
	 */
	#toNodeWatchOptions(options: NormalizedWatchrOptions): WatchOptions {
		const ignore = options.ignore;
		const watchOptions: WatchOptions = {
			...(options.persistent === undefined ? {} : { persistent: options.persistent }),
			recursive: options.recursive,
			...(options.encoding === undefined ? {} : { encoding: options.encoding }),
			...(options.throwIfNoEntry === undefined ? {} : { throwIfNoEntry: options.throwIfNoEntry })
		};

		if (ignore === undefined) { return watchOptions }
		if (typeof ignore === 'function' || (Array.isArray(ignore) && ignore.some((entry) => typeof entry === 'function'))) {
			return { ...watchOptions, ignore: (targetPath: string) => this.isIgnored(targetPath, ignore) };
		}

		return { ...watchOptions, ignore };
	}

	/**
	 * Validates runtime watch arguments to prevent unsafe configuration.
	 * @param options The watcher options
	 * @param handler Optional event handler
	 */
	static #validateWatchArguments(options: WatchrOptions, handler?: Handler): void {
		if (handler !== undefined && typeof handler !== 'function') {
			throw new Error('handler must be a function.');
		}

		if (options.ignore !== undefined && !Watchr.#isValidIgnoreOption(options.ignore)) {
			throw new Error('ignore must be a function, string, RegExp, or array of these values.');
		}

		if (options.renameTimeout !== undefined && (!Number.isFinite(options.renameTimeout) || options.renameTimeout < 0)) {
			throw new Error('renameTimeout must be a non-negative finite number.');
		}

		if (options.statTimeout !== undefined && (!Number.isFinite(options.statTimeout) || options.statTimeout < 0)) {
			throw new Error('statTimeout must be a non-negative finite number.');
		}

		if (options.fallbackScanInterval !== undefined && (!Number.isFinite(options.fallbackScanInterval) || options.fallbackScanInterval < 0)) {
			throw new Error('fallbackScanInterval must be a non-negative finite number.');
		}

		if (options.followSymlinks !== undefined && typeof options.followSymlinks !== 'boolean') {
			throw new Error('followSymlinks must be a boolean.');
		}
	}

	/**
	 * Applies defaults and precompiles the ignore option (once per watched root, not per path).
	 * @param options The incoming watch options
	 * @returns Normalized watch options
	 */
	static #normalizeWatchOptions(options: WatchrOptions): NormalizedWatchrOptions {
		const ignoreMatcher = Watchr.#compileIgnore(options.ignore);

		return {
			...options,
			recursive: options.recursive ?? true,
			renameTimeout: options.renameTimeout ?? renameTimeout,
			statTimeout: options.statTimeout ?? statTimeout,
			fallbackScanInterval: options.fallbackScanInterval ?? fallbackScanInterval,
			followSymlinks: options.followSymlinks ?? true,
			...(ignoreMatcher === undefined ? {} : { ignoreMatcher })
		};
	}

	/**
	 * Validates native and callback-style ignore options.
	 * @param ignore The ignore option to validate.
	 * @returns True if the ignore option is valid.
	 */
	static #isValidIgnoreOption(ignore: WatchIgnore): boolean {
		if (typeof ignore === 'function' || typeof ignore === 'string' || ignore instanceof RegExp) { return true }

		if (!Array.isArray(ignore)) { return false }

		return ignore.every((value) => typeof value === 'string' || value instanceof RegExp || typeof value === 'function');
	}
}

export default Watchr;
export { Watchr, WatchrStats, FileSystemEvent, WatcherEvent, FileEvent, DirectoryEvent, type WatchrOptions, type WatchrEventMap, type Handler, type WatchIgnore, type Path };

import { watch } from 'node:fs';
import { resolve, dirname, basename, matchesGlob } from 'node:path';
import { FileSystem } from './file-system';
import { castError, noop, uniqueSortedArray } from './utils';
import { FileRenameHandler } from './file-rename-handler';
import { LockResolver } from './lock-resolver';
import { WatchrStats } from './watchr-stats';
import { FileEvent, DirectoryEvent, FileSystemEvent, renameTimeout, statTimeout, fallbackScanInterval } from './constants';
import { FileSystemEventManager } from './file-system-event-manager';
import type { WatchOptions } from 'node:fs';
import type { WatchIgnore, IgnoreMatcher, Path, WatchrOptions, WatchrEventMap, WatchrEvent, WatchrHandlers, WatchrState, NormalizedWatchrOptions, WatchrConfig, AsyncCallable, Closable, NodeError } from './@types/index';

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
class Watchr implements Closable {
	#state: WatchrState = 'idle';
	#watchersLock: Promise<void>;
	readonly #watchersRestorable: Map<Path, RestorableWatcher>;
	readonly #abortController: AbortController;
	readonly #abortSignal: AbortSignal;
	#startPromise: Promise<this> | undefined;
	#startReject: (reason?: unknown) => void = noop;
	readonly #target: Path[];
	readonly #options: WatchrOptions;
	readonly #handlers: WatchrHandlers = {};
	readonly #renameHandler: FileRenameHandler;
	readonly #roots: Set<Path>;
	readonly #watchers: Map<Path, WatchrConfig[]>;
	/** Delays between root restore attempts; the last value repeats until the root reappears or the watcher closes. */
	static readonly #restoreBackoffMs: readonly number[] = [ 100, 250, 500, 1000, 2000 ];

	/**
	 * Configures an idle watcher. Call `start()` to begin watching.
	 * @param target The target files or directories to watch
	 * @param options The options for the watcher
	 */
	constructor(target: Path[] | Path, options: WatchrOptions = {}) {
		if (arguments.length > 2) { throw new Error('Only target and options are accepted.') }
		if (process.platform === 'win32' && !platformWarningEmitted) {
			platformWarningEmitted = true;
			Watchr.#warn('Windows support is best-effort (Tier 2).', 'WATCHR_PLATFORM_TIER2', 'Use WSL for guaranteed behavior.');
		}

		Watchr.#validateWatchArguments(target, options);
		this.#abortController = new AbortController();
		this.#abortSignal = this.#abortController.signal;
		this.#target = Array.isArray(target) ? [ ...target ] : [ target ];
		const { handlers, ...watchOptions } = options;
		this.#options = watchOptions;
		for (const name of Object.keys(handlers ?? {}) as (keyof WatchrHandlers)[]) {
			const entry = handlers![name];
			if (entry !== undefined) { Object.assign(this.#handlers, { [name]: typeof entry === 'function' ? { handler: entry } : { ...entry } }) }
		}
		this.#roots = new Set();
		this.#renameHandler = new FileRenameHandler(this.#emitEvent.bind(this), this.#error.bind(this), new LockResolver({ onError: (error) => void this.#error(error) }));
		this.#watchers = new Map();
		this.#watchersLock = Promise.resolve();
		this.#watchersRestorable = new Map();
	}

	/** The current read-only lifecycle state. */
	get state(): WatchrState {
		return this.#state;
	}

	/**
	 * Returns the abort signal for the watcher
	 * @returns The abort signal for the watcher
	 */
	get abortSignal(): AbortSignal {
		return this.#abortSignal;
	}

	/**
	 * Starts watching the configured paths, delivering requested initial inventory before resolving.
	 * Repeated calls share the same initialization promise; closed watchers cannot be restarted.
	 * @returns A promise that resolves after watcher attachment and the initial scan, or rejects if startup fails or is cancelled.
	 */
	start(): Promise<this> {
		if (this.#state === 'closed') { return Promise.reject(new Error('watcher is closed.')) }
		if (this.#startPromise !== undefined) { return this.#startPromise }

		const { promise, resolve, reject } = Promise.withResolvers<this>();
		this.#startPromise = promise;
		this.#startReject = reject;
		this.#state = 'starting';
		void this.#watch(this.#target, this.#options).then(() => {
			if (this.#state === 'closed') { return }
			this.#state = 'watching';
			this.#startReject = noop;
			resolve(this);
		}, (error: unknown) => this.#failStartup(error));

		return promise;
	}

	/**
	 * Rejects fatal startup failures once and releases all resources.
	 * @param error The startup failure
	 */
	#failStartup(error: unknown): void {
		if (this.#state !== 'starting') { return }

		this.#startReject(castError(error));
		this.#startReject = noop;
		this.close();
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
	 * Checks if the target path is ignored.
	 * Pass the precompiled `ignoreMatcher` from normalized options on hot paths; a raw ignore option is compiled per call.
	 * @param targetPath The target path to check
	 * @param ignore The ignore option or precompiled matcher to use
	 * @returns True if the target path is ignored, false otherwise
	 */
	#isIgnored(targetPath: Path, ignore?: WatchIgnore | IgnoreMatcher): boolean {
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

		if (isNativeIgnoreEntry(ignore)) { return Watchr.#compileIgnoreEntry(ignore) }

		const matchers = ignore.map((entry) => Watchr.#compileIgnoreEntry(entry));

		if (matchers.length === 1) { return matchers[0]! }

		return (targetPath: Path): boolean => {
			for (const matcher of matchers) {
				if (matcher(targetPath)) { return true }
			}

			return false;
		};
	}

	/**
	 * Compiles one ignore entry. Callbacks receive only the full absolute path.
	 * @param entry The ignore entry to compile.
	 * @returns The predicate for the entry.
	 */
	static #compileIgnoreEntry(entry: NativeIgnoreEntry): IgnoreMatcher {
		if (typeof entry === 'function') {
			return entry;
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
	 * Closes the watcher
	 */
	close(): void {
		if (this.#state === 'closed') { return }

		const closeEntry = this.#handlers.close;
		this.#state = 'closed';
		for (const name of Object.keys(this.#handlers) as (keyof WatchrHandlers)[]) { delete this.#handlers[name] }
		delete this.#options.ignore;
		this.#abortController.abort();
		this.#startReject(new Error('watcher closed before becoming ready.'));
		this.#startReject = noop;
		this.#renameHandler.reset();
		this.#roots.clear();
		this.#watchersClose();
		this.#clearRestorableWatchers();
		if (closeEntry !== undefined) {
			const handler = typeof closeEntry === 'function' ? closeEntry : closeEntry.handler;
			this.#invoke(handler, [], 'close');
		}
	}

	/**
	 * Cancels every pending root restore and forgets the restorable roots.
	 */
	#clearRestorableWatchers() {
		for (const restorable of this.#watchersRestorable.values()) {
			if (restorable.timer !== undefined) { clearTimeout(restorable.timer) }
			delete restorable.config.options.ignore;
			delete restorable.config.options.ignoreMatcher;
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
	 * Delivers an error. A throwing (or missing) `error` callback is reported through `process.emitWarning`
	 * so watcher-internal failures can never surface as uncaught exceptions.
	 * Async callback failures after close are reported as warnings.
	 * @param exception The error to emit
	 * @returns True if the event was delivered to a listener, false otherwise
	 * @internal
	 */
	#error(exception: unknown): boolean {
		const error = castError(exception);
		if (this.#state === 'closed' || this.#handlers.error === undefined) {
			Watchr.#warn(error.message, 'WATCHR_UNHANDLED_ERROR', 'No active error handler can receive this failure.', error);
			return false;
		}
		this.#dispatch('error', error);
		return true;
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
	 * @param initial Whether this is initial inventory
	 * @internal
	 */
	#emitEvent(event: FileSystemEvent, targetPath: Path, stats: WatchrStats, targetPathNext?: Path, initial = false): void {
		if (this.#state === 'closed') { return }
		let payload: WatchrEvent;

		if (Watchr.#isRenameEvent(event)) {
			if (targetPathNext === undefined) {
				this.#error(new Error('Rename event is missing its destination path.'));

				return;
			}

			payload = Object.freeze({ type: event, from: targetPath, to: targetPathNext, stats, initial: false });
		} else {
			payload = Object.freeze({ type: event, path: targetPath, stats, initial });
		}
		this.#dispatch('all', payload);
		this.#dispatch(payload.type, payload);
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
	 * @param name The configured handler name
	 * @param event The event payload
	 */
	#dispatch<K extends Exclude<keyof WatchrEventMap, 'close'>>(name: K, event: WatchrEventMap[K]): void {
		if (this.#state === 'closed') { return }
		const entry = this.#handlers[name];
		if (entry === undefined) { return }
		const handler = typeof entry === 'function' ? entry : entry.handler;
		if (typeof entry !== 'function' && entry.once === true) { delete this.#handlers[name] }
		this.#invoke(handler as (event: WatchrEventMap[K]) => void | PromiseLike<void>, [ event ], name === 'error' ? 'error' : undefined);
	}

	/**
	 * Invokes a callback and observes failures without extending a filesystem barrier.
	 * @param handler The callback to invoke
	 * @param args The callback arguments
	 * @param warningHandler The handler name when failures must bypass the error callback
	 */
	#invoke<Args extends unknown[]>(handler: (...args: Args) => void | PromiseLike<void>, args: Args, warningHandler?: 'error' | 'close'): void {
		const report = (exception: unknown, failureMode: 'throw' | 'rejection'): void => {
			const error = castError(exception);
			if (warningHandler !== undefined) {
				Watchr.#warn(error.message, 'WATCHR_UNHANDLED_ERROR', `The "${warningHandler}" handler ${failureMode === 'throw' ? 'threw synchronously' : 'returned a rejected promise'}.`, error);
			} else {
				this.#error(error);
			}
		};
		try {
			const result = handler(...args);
			if (result !== undefined) { void Promise.resolve(result).catch((error: unknown) => report(error, 'rejection')) }
		} catch (error: unknown) {
			report(error, 'throw');
		}
	}

	/**
	 * Closes all watchers for a given folder path
	 * @param folderPath The folder path to close watchers for
	 * @param filePath The file path to close watchers for
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
		if (this.#state === 'closed' || this.#watchersRestorable.get(rootPath) !== restorable) { return }

		const { options } = restorable.config;

		try {
			await this.#watchPath(rootPath, options, false);
		} catch (error: unknown) {
			if (this.#abortSignal.aborted || this.#watchersRestorable.get(rootPath) !== restorable) { return }

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
				closeWatchers: (folderPath?: Path, filePath?: Path) => this.#watchersClose(folderPath, filePath),
				isIgnored: (path, ignore) => this.#isIgnored(path, ignore),
				emitInitial: (event, path, stats) => this.#emitEvent(event, path, stats, undefined, true),
				startupFailure: (error) => this.#failStartup(error)
			});
			config.eventManager = eventManager;

			return eventManager;
		} catch (error: unknown) {
			config.eventManager?.cleanup();
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
	 * @param initial Whether this attachment belongs to initial startup
	 * @param filePath The path of the file to watch (if any)
	 * @returns A promise that resolves when the watcher is active
	 */
	async #watchDirectory(folderPath: Path, options: NormalizedWatchrOptions, initial: boolean, filePath?: Path) {
		if (this.#state === 'closed') { return }
		const watchOptions = this.#toNodeWatchOptions(options);

		// Node.js 20.16+ supports recursive watching natively on all platforms
		return this.#synchronizeWatchers(async () => {
			if (this.#abortSignal.aborted) { return }

			const config: WatchrConfig = {
				watcher: watch(folderPath, { ...watchOptions, signal: this.#abortSignal }, () => {}),
				options,
				folderPath,
				initial
			};

			if (filePath !== undefined) { config.filePath = filePath }

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
	 * Uses recursive parent watching on macOS so FSEvents observes child-content changes rather than only directory changes.
	 * @param filePath The path of the file to watch
	 * @param options The options for the watcher
	 * @param initial Whether this attachment belongs to initial startup
	 * @returns A promise that resolves when the watcher is active
	 */
	async #watchFile(filePath: Path, options: NormalizedWatchrOptions, initial: boolean) {
		if (this.#state === 'closed') { return }

		const folderPath = dirname(filePath);
		const fileWatchOptions: NormalizedWatchrOptions = { ...options, recursive: process.platform === 'darwin' };
		const watchOptions = this.#toNodeWatchOptions(fileWatchOptions);

		return this.#synchronizeWatchers(async () => {
			if (this.#abortSignal.aborted) { return }

			const config: WatchrConfig = {
				// Watch the parent directory so atomic-save inode replacement keeps emitting events for the target file.
				watcher: watch(folderPath, { ...watchOptions, signal: this.#abortSignal }, () => {}),
				options: fileWatchOptions,
				folderPath,
				filePath,
				initial
			};

			await this.#addWatcher(config);
		});
	}

	/**
	 * Watches multiple paths for changes
	 * @param targetPaths The paths to watch
	 * @param options The options for the watcher
	 * @returns A promise that resolves when all watchers are active
	 */
	async #watchPaths(targetPaths: Path[], options: WatchrOptions) {
		if (this.#abortSignal.aborted) { return }

		if (targetPaths.length === 1) { return this.#watchPath(targetPaths[0]!, options) }

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
				await this.#watchPath(targetPaths[i]!, options);
			}
		} else {
			// All paths are about separate subtrees, so we can start watching in parallel safely
			await Promise.all(targetPaths.map((targetPath) => this.#abortSignal.aborted ? Promise.resolve() : this.#watchPath(targetPath, options)));
		}
	}

	/**
	 * Watches a path for changes
	 * @param targetPath The path to watch
	 * @param options The options for the watcher; defaults are applied and the ignore option compiled here
	 * @param initial Whether this attachment belongs to initial startup
	 * @returns A promise that resolves when the watcher is active
	 */
	async #watchPath(targetPath: Path, options: WatchrOptions, initial = true): Promise<void> {
		if (this.#state === 'closed') { return }

		targetPath = resolve(targetPath);
		const normalizedOptions = Watchr.#normalizeWatchOptions(options);

		if (this.#isIgnored(targetPath, normalizedOptions.ignoreMatcher)) { return }

		const stats = await FileSystem.getStats(targetPath, { signal: this.#abortSignal });

		if (this.#abortSignal.aborted) { return }

		if (!stats) {
			// Double-check if closed after async operation to avoid race condition during cleanup
			// The abort signal might not be set yet due to event listener timing, so also check this.closed directly
			if (this.#abortSignal.aborted) { return }

			throw new Error('Path not found');
		}

		if (stats.isFile()) {
			return this.#watchFile(targetPath, normalizedOptions, initial);
		} else if (stats.isDirectory()) {
			return this.#watchDirectory(targetPath, normalizedOptions, initial);
		} else {
			throw new Error('Target path type is not supported');
		}
	}

	/**
	 * Watches a set of paths for changes
	 * @param target The paths to watch
	 * @param options The options for the watcher
	 * @returns A promise that resolves when all watchers are active
	 */
	async #watch(target: Path[], options: WatchrOptions): Promise<void> {
		if (this.#state === 'closed') { return }

		for (const targetPath of target) { this.#roots.add(resolve(targetPath)) }
		await this.#watchPaths(target, options);
	}

	/**
	 * Closes a watcher for a specific config.
	 * @param config The config for the watcher
	 */
	#watcherClose(config: WatchrConfig) {
		config.eventManager?.cleanup();
		config.watcher.close();
		this.#removeWatcherConfig(config);

		if (this.#state === 'closed') {
			delete config.options.ignore;
			delete config.options.ignoreMatcher;
			return;
		}

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
		return {
			...(options.persistent === undefined ? {} : { persistent: options.persistent }),
			recursive: options.recursive,
			encoding: 'utf8'
		};
	}

	/**
	 * Validates runtime watch arguments to prevent unsafe configuration.
	 * @param target Required nonempty target paths
	 * @param options The watcher options
	 */
	static #validateWatchArguments(target: Path | Path[], options: WatchrOptions): void {
		const targets = Array.isArray(target) ? Array.from(target) : [ target ];
		if (targets.length === 0 || targets.some((path) => typeof path !== 'string' || path.trim().length === 0)) {
			throw new Error('target must be a nonempty string or array of nonempty strings.');
		}
		if (options === null || typeof options !== 'object' || Array.isArray(options)) {
			throw new Error('options must be an object.');
		}
		const optionNames = new Set<string>([ 'persistent', 'recursive', 'ignore', 'emitInitial', 'handlers', 'renameTimeout', 'statTimeout', 'fallbackScanInterval', 'followSymlinks' ] satisfies (keyof WatchrOptions)[]);
		for (const name of Reflect.ownKeys(options)) {
			if (typeof name !== 'string' || !optionNames.has(name)) { throw new Error(`Unknown option: ${String(name)}.`) }
		}
		if (options.handlers !== undefined) {
			if (options.handlers === null || typeof options.handlers !== 'object' || Array.isArray(options.handlers)) { throw new Error('handlers must be an object.') }
			const names = new Set([ 'add', 'addDir', 'change', 'unlink', 'unlinkDir', 'rename', 'renameDir', 'all', 'error', 'close' ]);
			for (const [ name, entry ] of Object.entries(options.handlers)) {
				if (!names.has(name)) { throw new Error(`Unknown handler: ${name}`) }
				if (entry === undefined || typeof entry === 'function') { continue }
				if (entry === null || typeof entry !== 'object' || typeof entry.handler !== 'function' || (entry.once !== undefined && typeof entry.once !== 'boolean')) { throw new Error(`Invalid handler: ${name}`) }
			}
		}
		if (options.emitInitial !== undefined && typeof options.emitInitial !== 'boolean') { throw new Error('emitInitial must be a boolean.') }

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
			emitInitial: options.emitInitial ?? false,
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

export { Watchr, WatchrStats, FileSystemEvent, FileEvent, DirectoryEvent };
export type { WatchrOptions, WatchrHandlers, WatchrHandlerOptions, WatchrEventHandler, WatchrErrorHandler, WatchrErrorHandlerOptions, WatchrCloseHandler, WatchrCloseHandlerOptions, WatchrEvent, WatchrEventMap, WatchrPathEvent, WatchrRenameEvent, WatchrState, WatchIgnore, Path, WatchrAddEvent, WatchrAddDirEvent, WatchrChangeEvent, WatchrUnlinkEvent, WatchrUnlinkDirEvent, WatchrRenameFileEvent, WatchrRenameDirectoryEvent } from './@types/index';

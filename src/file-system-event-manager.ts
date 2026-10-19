import { basename, dirname, resolve } from 'node:path';
import type { FSWatcher } from 'node:fs';
import { FileSystem } from './file-system';
import { DirectoryScanner } from './directory-scanner';
import { createWatcherFallback, type WatcherFallback } from './watcher-fallback';
import { NodeWatcherEvent, NodeTargetEvent, FileSystemEvent } from './constants';
import type { Watchr } from './watchr';
import type { FileRenameHandler } from './file-rename-handler';
import type { FileSystemStateManager } from './file-system-state-manager';
import type { WatchrStats } from './watchr-stats';
import type { Closable, DirectoryReadOptions, Event, NodeEventHandler, Path, StateUpdateOptions, NormalizedWatchrOptions, WatchrConfig, WatchIgnore } from './@types/index';

type WatchrEventHooks = {
	renameHandler: FileRenameHandler;
	reportError: (error: unknown) => boolean;
	closeWatchers: (folderPath?: Path, filePath?: Path) => void;
	isIgnored: (path: Path, ignore: WatchIgnore) => boolean;
	emitInitial: (event: FileSystemEvent, path: Path, stats: WatchrStats) => void;
	startupFailure: (error: unknown) => void;
};

/**
 * Manages file system events for a specific folder
 * @internal
 */
export class FileSystemEventManager implements Closable {
	#lock: Promise<void>;
	#initializing = true;
	#initialSymlinks: ReadonlySet<Path> | undefined;
	#flushQueued: boolean;
	#flushAfterLockScheduled: boolean;
	readonly #directoryScanner: DirectoryScanner;
	readonly #watcherFallback: WatcherFallback | undefined;
	readonly #initial: boolean;
	readonly #fileSystemPoller: FileSystemStateManager;
	readonly #hooks: WatchrEventHooks;
	readonly #watcher: FSWatcher;
	readonly #options: NormalizedWatchrOptions;
	/** Precompiled ignore predicate; falls back to the raw option for configs built without normalization. */
	#ignore: WatchIgnore | undefined;
	readonly #folderPath: Path;
	readonly #filePath: Path | undefined;
	readonly #regulars: Set<Path>;
	readonly #nodeEventHandler: NodeEventHandler | undefined;
	/** Aborted on disposal or watcher closure so in-flight scans cannot feed a stale manager. */
	readonly #abortController: AbortController;
	readonly #abortSignal: AbortSignal;
	readonly #watchrAbortSignal: AbortSignal;
	/** Stat options for the initial scan: cancellable, never time-limited. */
	readonly #initialStatOptions: StateUpdateOptions;
	/** {@link initialStatOptions} for entries `readdir` reported as symlinks, so their stats carry the symlink flag. */
	readonly #initialSymlinkStatOptions: StateUpdateOptions;
	/** Stat options for live polls: time-limited so a stuck stat cannot stall a batch. */
	readonly #liveStatOptions: StateUpdateOptions;
	readonly #releaseInitialization: () => void;
	/** Symlink entries of the in-progress initial scan; undefined outside the scan. */
	readonly #watcherChangeHandler: (event?: NodeTargetEvent, targetName?: string | null) => void;
	readonly #watcherErrorHandler: (error: NodeJS.ErrnoException) => void;
	static readonly #maxConcurrentWatcherEventDispatches = 32;
	/** Longest the initial scan may block the event loop before yielding. */
	static readonly #initialScanSliceMs = 8;
	/** Event priorities used to keep the highest-priority event per path during deduplication. */
	static readonly #eventPriorities: Map<FileSystemEvent, number> = new Map([
		[ FileSystemEvent.ADD, 4 ],
		[ FileSystemEvent.ADD_DIR, 4 ],
		[ FileSystemEvent.CHANGE, 3 ],
		[ FileSystemEvent.RENAME, 2 ],
		[ FileSystemEvent.RENAME_DIR, 2 ],
		[ FileSystemEvent.UNLINK, 1 ],
		[ FileSystemEvent.UNLINK_DIR, 1 ]
	]);

	/**
	 * Creates a new instance of FileSystemEventManager
	 * @param fileSystemPoller The file system poller to use
	 * @param watchr The watchr instance
	 * @param watcherConfig The watcher configuration
	 * @param hooks Capabilities supplied by the owning watcher
	 */
	private constructor(fileSystemPoller: FileSystemStateManager, watchr: Watchr, watcherConfig: WatchrConfig, hooks: WatchrEventHooks) {
		const gate = Promise.withResolvers<void>();
		this.#lock = gate.promise;
		this.#releaseInitialization = gate.resolve;
		this.#initial = watcherConfig.initial ?? true;
		this.#fileSystemPoller = fileSystemPoller;
		this.#hooks = hooks;
		this.#regulars = new Set();
		this.#flushQueued = false;
		this.#flushAfterLockScheduled = false;
		this.#watcherChangeHandler = this.#onWatcherChange.bind(this);
		this.#watcherErrorHandler = this.#handleWatchrError.bind(this);
		({ watcher: this.#watcher, options: this.#options, folderPath: this.#folderPath, filePath: this.#filePath, nodeHandler: this.#nodeEventHandler } = watcherConfig);
		this.#ignore = this.#options.ignoreMatcher ?? this.#options.ignore;
		this.#abortController = new AbortController();
		this.#watchrAbortSignal = watchr.abortSignal;
		this.#abortSignal = AbortSignal.any([ this.#watchrAbortSignal, this.#abortController.signal ]);
		this.#initialStatOptions = { signal: this.#abortSignal, followSymlinks: this.#options.followSymlinks, sync: true };
		this.#initialSymlinkStatOptions = { ...this.#initialStatOptions, isSymbolicLink: true };
		this.#liveStatOptions = { timeout: this.#options.statTimeout, followSymlinks: this.#options.followSymlinks };
		this.#directoryScanner = new DirectoryScanner({
			folderPath: this.#folderPath,
			interval: this.#options.fallbackScanInterval,
			readOptions: this.#directoryReadOptions(),
			trackedPaths: () => this.#fileSystemPoller.stats.keys(),
			isIgnored: (path) => this.#isIgnored(path),
			onWatcherEvent: (event, path) => this.#onWatcherEvent(event, path),
			onError: (error) => this.#hooks.reportError(error)
		}, this.#abortSignal);
		this.#watcherFallback = createWatcherFallback({
			folderPath: this.#folderPath,
			filePath: this.#filePath,
			persistent: this.#options.persistent,
			signal: this.#abortSignal,
			notifyPath: this.#watcherChangeHandler,
			requestSnapshot: this.#directoryScanner.schedule.bind(this.#directoryScanner),
			reconcileTracked: this.#directoryScanner.reconcile.bind(this.#directoryScanner),
			closeNativeRoot: this.#watcher.close.bind(this.#watcher)
		});
		this.#fileSystemPoller.configureRenameTimeout(this.#options.renameTimeout);
		this.#initialSymlinks = undefined;
	}

	/**
	 * Creates a new instance of FileSystemEventManager
	 * @param fileSystemPoller The file system poller to use
	 * @param watchr The watchr instance
	 * @param watcherConfig The watcher configuration
	 * @param hooks Capabilities supplied by the owning watcher
	 * @returns A Promise of a FileSystemEventManager
	 */
	static async newInstance(fileSystemPoller: FileSystemStateManager, watchr: Watchr, watcherConfig: WatchrConfig, hooks: WatchrEventHooks): Promise<FileSystemEventManager> {
		const manager = new FileSystemEventManager(fileSystemPoller, watchr, watcherConfig, hooks);
		watcherConfig.eventManager = manager;
		try {
			return await manager.#initializeEvents();
		} finally {
			manager.#initializing = false;
			manager.#releaseInitialization();
		}
	}

	/**
	 * Initializes event listeners and handles initial scan
	 * @returns A Promise that resolves to a FileSystemEventManager
	 */
	async #initializeEvents() {
		this.#watcher.on(NodeWatcherEvent.CHANGE, this.#watcherChangeHandler);
		this.#watcher.on(NodeWatcherEvent.ERROR, this.#watcherErrorHandler);

		// Single initial path
		if (this.#filePath) {
			// Already polled
			if (this.#fileSystemPoller.stats.has(this.#filePath)) { return this }

			await this.#scanInitialPaths([ this.#filePath ], true);
		} else {
			// Multiple initial paths; `readDirectory` applies the ignore matcher, so only the root itself is re-checked.
			const { directories, files, symlinks } = await FileSystem.readDirectory(this.#folderPath, this.#directoryReadOptions());
			const rootPaths = this.#isIgnored(this.#folderPath) ? [] : [ this.#folderPath ];

			this.#initialSymlinks = symlinks.size === 0 ? undefined : symlinks;

			try {
				await this.#scanInitialPaths([ ...rootPaths, ...directories, ...files ], true);
			} finally {
				this.#initialSymlinks = undefined;
			}
		}

		this.#watcherFallback?.start();

		return this;
	}

	/**
	 * Checks a path against the watcher's ignore option.
	 * @param targetPath The path to check
	 * @returns True when the path is ignored
	 */
	#isIgnored(targetPath: Path): boolean {
		return this.#ignore !== undefined && this.#hooks.isIgnored(targetPath, this.#ignore);
	}

	/**
	 * Builds the options for reading the watched root: honors `recursive` and `followSymlinks`, applies the ignore
	 * matcher, and is cancelled by this manager's signal.
	 * @returns The directory read options
	 */
	#directoryReadOptions(): DirectoryReadOptions {
		const options: DirectoryReadOptions = { recursive: this.#options.recursive, followSymlinks: this.#options.followSymlinks, signal: this.#abortSignal };

		if (this.#ignore !== undefined) { options.ignore = (targetPath: Path) => this.#isIgnored(targetPath) }

		return options;
	}

	/**
	 * Polls the initial paths sequentially with blocking stats, yielding to the event loop every few milliseconds.
	 * A failing child is reported and skipped; an unavailable original root fails startup. The loop stops once
	 * the watcher aborts, and fallback inventories remain live scans.
	 * @param targetPaths The paths discovered for the initial scan
	 * @param isInitial Whether these paths belong to an attachment inventory scan
	 */
	async #scanInitialPaths(targetPaths: Path[], isInitial: boolean): Promise<void> {
		const signal = this.#abortSignal;
		let sliceStart = performance.now();

		for (const targetPath of targetPaths) {
			if (signal.aborted) { return }

			if (performance.now() - sliceStart >= FileSystemEventManager.#initialScanSliceMs) {
				await new Promise(setImmediate);
				if (signal.aborted) { return }
				sliceStart = performance.now();
			}

			// Already polled
			if (this.#fileSystemPoller.stats.has(targetPath)) { continue }

			const requiredRoot = this.#initial && targetPath === (this.#filePath ?? this.#folderPath);
			try {
				await this.#onWatcherEvent(NodeTargetEvent.CHANGE, targetPath, isInitial);
				if (signal.aborted) { return }
				if (requiredRoot && !this.#fileSystemPoller.stats.has(targetPath)) {
					throw new Error('Configured root is unavailable during initial scan', { cause: { targetPath } });
				}
			} catch (error: unknown) {
				if (signal.aborted) { return }
				if (requiredRoot) { throw error }

				this.#hooks.reportError(new Error('Initial scan skipped path.', { cause: error }));
			}
		}
	}

	/**
	 * Removes watcher listeners, aborts any in-flight scan, and closes the native watcher so no stale handles remain.
	 */
	close(): void {
		this.#abortController.abort();
		this.#ignore = undefined;
		this.#regulars.clear();

		this.#watcherFallback?.close();
		this.#directoryScanner.close();
		this.#watcher.removeListener(NodeWatcherEvent.CHANGE, this.#watcherChangeHandler);
		this.#watcher.removeListener(NodeWatcherEvent.ERROR, this.#watcherErrorHandler);
		this.#watcher.close();
	}

	/** Closes the manager on scope exit. */
	[Symbol.dispose](): void {
		this.close();
	}

	/**
	 * Checks if the target path is within the watched root
	 * @param targetPath The path to check
	 * @returns True if the path is within the watched root, false otherwise
	 */
	#isSubRoot(targetPath: Path) {
		return this.#filePath ? targetPath === this.#filePath : targetPath === this.#folderPath || FileSystem.isSubPath(this.#folderPath, targetPath);
	}

	/**
	 * Acquires a lock for the current event batch
	 * @param regulars Regular target paths captured for this batch
	 * @returns A Promise that resolves when the lock is acquired
	 */
	async #getLock(regulars: Set<Path>): Promise<void> {
		if (regulars.size === 0 || this.#abortSignal.aborted) { return }

		if (regulars.size === 1) {
			const singleTargetPath: Path | undefined = regulars.values().next().value;

			if (singleTargetPath === undefined) { return }

			const singleEvents = await this.#fileSystemPoller.update(singleTargetPath, this.#liveStatOptions);

			if (singleEvents.length === 0) { return }

			const events = singleEvents.map<Event>(({ type, stats }) => [ type, singleTargetPath, stats ]);
			await this.#reconcileRemovedDirectories(events, regulars);
			this.#onTargetEvents(events);

			return;
		}

		const regularEvents = await this.#populateEvents(regulars);
		await this.#reconcileRemovedDirectories(regularEvents, regulars);
		const allEvents = regularEvents;

		if (allEvents.length === 0) { return }

		this.#onTargetEvents(this.#deduplicateEvents(allEvents));
	}

	/**
	 * Flushes the current event batch.
	 * Batch through a microtask so events observed in the same turn settle together.
	 */
	#flush() {
		if (this.#flushQueued) { return }

		this.#flushQueued = true;
		queueMicrotask(() => {
			this.#flushQueued = false;
			this.#flushImmediate();
		});
	}

	/**
	 * Flushes the current event batch immediately.
	 */
	#flushImmediate() {
		if (this.#abortSignal.aborted) { return }

		const regulars = new Set(this.#regulars);
		this.#regulars.clear();
		this.#lock = this.#getLock(regulars).catch((error: unknown) => {
			if (!this.#abortSignal.aborted) { this.#hooks.reportError(error) }
		});
	}

	/**
	 * Updates and delivers one initial inventory entry asynchronously.
	 * @param targetPath The inventory path
	 */
	async #onInitialEvent(targetPath: Path): Promise<void> {
		const events = await this.#fileSystemPoller.update(targetPath, this.#initialSymlinks?.has(targetPath) === true ? this.#initialSymlinkStatOptions : this.#initialStatOptions);
		if (this.#abortSignal.aborted) { return }
		if (!this.#initial) {
			this.#onTargetEvents(events.map<Event>(({ type, stats }) => [ type, targetPath, stats ]));
		} else if (this.#options.emitInitial === true) {
			for (const { type, stats } of events) {
				if (this.#abortSignal.aborted) { break }
				this.#hooks.emitInitial(type, targetPath, stats);
			}
		}
	}

	/**
	 * Admits a live path without allocating a per-notification promise.
	 * @param targetPath The dirty path
	 */
	#admitLivePath(targetPath: Path): void {
		this.#regulars.add(targetPath);
		this.#scheduleFlushAfterLock();
	}

	/**
	 * Schedules a single flush once the current lock chain settles.
	 */
	#scheduleFlushAfterLock(): void {
		if (this.#flushAfterLockScheduled) { return }

		this.#flushAfterLockScheduled = true;

		void this.#lock.then(() => this.#onFlushAfterLock()).catch((error) => {
			this.#flushAfterLockScheduled = false;
			this.#hooks.reportError(error);
			void this.#flush();
		});
	}

	/**
	 * Runs when the current lock chain resolves.
	 */
	#onFlushAfterLock(): void {
		this.#flushAfterLockScheduled = false;
		void this.#flush();
	}

	/**
	 * Deduplicates events to avoid redundant notifications
	 * @param events The events to deduplicate
	 * @returns The deduplicated events
	 */
	#deduplicateEvents(events: Event[]) {
		if (events.length < 2) { return events }

		const uniqueEvents: Event[] = [];
		const eventIndexes = new Map<Path, number>();

		for (const event of events) {
			const [ targetEvent, targetPath ] = event;
			const existingIndex = eventIndexes.get(targetPath);

			if (existingIndex === undefined) {
				eventIndexes.set(targetPath, uniqueEvents.length);
				uniqueEvents.push(event);

				continue;
			}

			const previousEvent = uniqueEvents[existingIndex]!;
			if (FileSystemEventManager.#isReplacementTransition(previousEvent[0], targetEvent)) {
				eventIndexes.set(targetPath, uniqueEvents.length);
				uniqueEvents.push(event);
				continue;
			}

			const previousPriority = FileSystemEventManager.#eventPriorities.get(previousEvent[0]) ?? 0;
			const currentPriority = FileSystemEventManager.#eventPriorities.get(targetEvent) ?? 0;

			if (currentPriority > previousPriority) {
				uniqueEvents[existingIndex] = event;
			}
		}

		return uniqueEvents;
	}

	/**
	 * Checks whether two events describe a type-replacement transition.
	 * @param previousEvent The preceding event for the path
	 * @param currentEvent The following event for the path
	 * @returns True when both events must be preserved
	 */
	static #isReplacementTransition(previousEvent: FileSystemEvent, currentEvent: FileSystemEvent): boolean {
		return (previousEvent === FileSystemEvent.UNLINK && currentEvent === FileSystemEvent.ADD_DIR)
			|| (previousEvent === FileSystemEvent.UNLINK_DIR && currentEvent === FileSystemEvent.ADD);
	}

	/**
	 * Populates events for the given target paths
	 * @param targetPaths The target paths to populate events for
	 * @param events The events to populate
	 * @param statOptions Stat cancellation/timeout options; defaults to the live-poll options
	 * @returns The populated events
	 */
	async #populateEvents(targetPaths: Iterable<Path>, events: Event[] = [], statOptions: StateUpdateOptions = this.#liveStatOptions) {
		const paths = Array.from(targetPaths, (targetPath): Path => targetPath);

		await Promise.all(paths.map(async (targetPath) => {
			try {
				for (const { type, stats } of await this.#fileSystemPoller.update(targetPath, statOptions)) {
					events.push([ type, targetPath, stats ]);
				}
			} catch (error: unknown) {
				if (!this.#abortSignal.aborted) { this.#hooks.reportError(error) }
			}
		}));

		return events;
	};

	/**
	 * Reconciles known descendants before a removed directory can close its manager.
	 * @param events Derived events to extend with descendant transitions
	 * @param polledPaths Paths already settled by the current batch
	 */
	async #reconcileRemovedDirectories(events: Event[], polledPaths: ReadonlySet<Path>): Promise<void> {
		const directories = events.filter(([ type ]) => type === FileSystemEvent.UNLINK_DIR).map(([ , path ]) => path);
		if (directories.length === 0 || this.#abortSignal.aborted) { return }

		const descendants: Path[] = [];
		for (const path of this.#fileSystemPoller.stats.keys()) {
			if (!polledPaths.has(path) && this.#isSubRoot(path) && directories.some((directory) => FileSystem.isSubPath(directory, path)) && !this.#isIgnored(path)) {
				descendants.push(path);
			}
		}

		for (let index = 0; index < descendants.length && !this.#abortSignal.aborted; index += FileSystemEventManager.#maxConcurrentWatcherEventDispatches) {
			await this.#populateEvents(descendants.slice(index, index + FileSystemEventManager.#maxConcurrentWatcherEventDispatches), events);
		}
	}

	/**
	 * Handles the given target events
	 * @param events The target events to handle
	 */
	#onTargetEvents(events: Event[]) {
		if (this.#abortSignal.aborted) { return }
		this.#hooks.renameHandler.handleBatch(events.filter(([ , path ]) => this.#isSubRoot(path)), this.#options.renameTimeout, () => !this.#abortSignal.aborted);

		for (const [ targetEvent, targetPath ] of events) {
			if (this.#watchrAbortSignal.aborted) { return }
			if (targetEvent === FileSystemEvent.UNLINK && this.#filePath === undefined) {
				this.#hooks.closeWatchers(dirname(targetPath), targetPath);
			} else if (targetEvent === FileSystemEvent.UNLINK_DIR && this.#filePath === undefined) {
				this.#hooks.closeWatchers(dirname(targetPath), targetPath);
				this.#hooks.closeWatchers(targetPath);
			}
		}
	}

	/**
	 * Handles the given watcher event
	 * @param event The watcher event to handle
	 * @param targetPath The target path of the event
	 * @param isInitial Whether this is an initial event
	 * @returns A promise for inventory or custom handling, otherwise nothing after live admission
	 */
	#onWatcherEvent(event: NodeTargetEvent, targetPath: Path = '', isInitial: boolean = false): void | Promise<void> {
		if (this.#abortSignal.aborted) { return }
		if (this.#nodeEventHandler !== undefined) {
			if (isInitial) { return this.#nodeEventHandler(event, targetPath, isInitial) }
			try {
				return this.#nodeEventHandler(event, targetPath, isInitial).catch((error: unknown) => {
					if (!this.#abortSignal.aborted) { this.#hooks.reportError(error) }
				});
			} catch (error: unknown) {
				if (!this.#abortSignal.aborted) { this.#hooks.reportError(error) }
				return;
			}
		}
		if (isInitial) { return this.#onInitialEvent(targetPath) }

		this.#admitLivePath(targetPath);
	}

	/**
	 * Handles the given watcher change event
	 * @param event The watcher change event to handle
	 * @param targetName The target name of the event
	 */
	#onWatcherChange(event: NodeTargetEvent = NodeTargetEvent.CHANGE, targetName: string | null = '') {
		if (this.#abortSignal.aborted) { return }

		if (this.#filePath !== undefined) {
			if (this.#isIgnored(this.#filePath)) { return }

			void this.#onWatcherEvent(event, this.#filePath);

			return;
		}

		if (targetName !== null && targetName !== '') {
			const targetPath = resolve(this.#folderPath, targetName);

			this.#watcherFallback?.onNamedEvent?.(event);

			// libuv reports inotify self-events (e.g. IN_DELETE_SELF) using the watched directory's own basename,
			// so also poll the root itself; if it is unchanged the extra stat derives nothing.
			if (targetName === basename(this.#folderPath) && !this.#isIgnored(this.#folderPath)) {
				void this.#onWatcherEvent(event, this.#folderPath);
			}

			if (this.#isIgnored(targetPath)) { return }

			void this.#onWatcherEvent(event, targetPath);

			return;
		}

		void this.#onEmptyDirectoryWatcherChange(event);
	}

	/**
	 * Handles a directory watcher event without a usable target name.
	 * First polls tracked paths, then schedules one bounded snapshot scan.
	 * @param event The watcher change event.
	 */
	#onEmptyDirectoryWatcherChange(event: NodeTargetEvent): void {
		this.#directoryScanner.reconcile(event);
	}

	/**
	 * Handles the given watcher error event
	 * @param error The watcher error event to handle
	 */
	#handleWatchrError(error: NodeJS.ErrnoException) {
		if (this.#watcherFallback?.handleError?.(error)) { return }

		const sanitized = this.#sanitizeWatcherError(error);
		if (this.#initializing && this.#initial) {
			this.#hooks.startupFailure(sanitized);
		} else if (!this.#abortSignal.aborted) {
			this.#hooks.reportError(sanitized);
		}
	}

	/**
	 * Sanitizes watcher errors to avoid leaking absolute file system paths.
	 * @param error The original watcher error
	 * @returns A sanitized error with a stable message and error code
	 */
	#sanitizeWatcherError(error: NodeJS.ErrnoException): Error {
		const message = error.code ? `Watcher error (${error.code})` : 'Watcher error';
		const sanitizedError = new Error(message, { cause: error }) as NodeJS.ErrnoException;
		sanitizedError.code = error.code ?? 'UNKNOWN';

		return sanitizedError;
	}
}

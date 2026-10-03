import { basename, dirname, resolve } from 'node:path';
import { watchFile, unwatchFile, type FSWatcher, type Stats } from 'node:fs';
import { FileSystem } from './file-system';
import { NodeWatcherEvent, NodeTargetEvent, FileSystemEvent } from './constants';
import type { Watchr } from './watchr';
import type { FileRenameHandler } from './file-rename-handler';
import type { FileSystemStateManager } from './file-system-state-manager';
import type { DirectoryReadOptions, Event, NodeEventHandler, Path, StateUpdateOptions, NormalizedWatchrOptions, WatchrConfig, WatchIgnore } from './@types/index';

type WatchrEventHooks = {
	renameHandler: FileRenameHandler;
	reportError: (error: unknown) => boolean;
	closeWatchers: (folderPath?: Path, filePath?: Path) => void;
};

/**
 * Manages file system events for a specific folder
 * @internal
 */
export class FileSystemEventManager {
	#lock: Promise<void>;
	#initialSymlinks: ReadonlySet<Path> | undefined;
	#flushQueued: boolean;
	#flushAfterLockScheduled: boolean;
	#directoryFallbackScanScheduled: boolean;
	#directoryFallbackScanQueued: boolean;
	#directoryFallbackScanTimer: ReturnType<typeof setTimeout> | undefined;
	#directoryFallbackScanInFlight: Promise<void> | undefined;
	#directoryFallbackScanEvent: NodeTargetEvent | undefined;
	#lastDirectoryFallbackScanAt: number;
	readonly #fileSystemPoller: FileSystemStateManager;
	readonly #watchr: Watchr;
	readonly #hooks: WatchrEventHooks;
	readonly #watcher: FSWatcher;
	readonly #options: NormalizedWatchrOptions;
	/** Precompiled ignore predicate; falls back to the raw option for configs built without normalization. */
	readonly #ignore: WatchIgnore | undefined;
	readonly #folderPath: Path;
	readonly #filePath: Path | undefined;
	readonly #initials: Event[];
	readonly #regulars: Set<Path>;
	readonly #nodeEventHandler: NodeEventHandler;
	/** Aborted by {@link cleanup} (or by the watcher closing) so in-flight scans cannot feed a stale manager. */
	readonly #abortController: AbortController;
	readonly #abortSignal: AbortSignal;
	/** Stat options for the initial scan: cancellable, never time-limited. */
	readonly #initialStatOptions: StateUpdateOptions;
	/** {@link initialStatOptions} for entries `readdir` reported as symlinks, so their stats carry the symlink flag. */
	readonly #initialSymlinkStatOptions: StateUpdateOptions;
	/** Stat options for live polls: time-limited so a stuck stat cannot stall a batch. */
	readonly #liveStatOptions: StateUpdateOptions;
	/** Symlink entries of the in-progress initial scan; undefined outside the scan. */
	readonly #watcherChangeHandler: (event?: NodeTargetEvent, targetName?: string | null) => void;
	readonly #watcherErrorHandler: (error: NodeJS.ErrnoException) => void;
	/** Windows needs stat polling to detect deletion of the watched directory itself. */
	#rootStatListener: ((current: Stats, previous: Stats) => void) | undefined;
	/** macOS file targets need a fallback for changes missed during native watcher startup. */
	#fileStatPollTimer: ReturnType<typeof setInterval> | undefined;
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
		this.#lock = watchr.readyLock;
		this.#fileSystemPoller = fileSystemPoller;
		this.#watchr = watchr;
		this.#hooks = hooks;
		this.#initials = [];
		this.#regulars = new Set();
		this.#flushQueued = false;
		this.#flushAfterLockScheduled = false;
		this.#directoryFallbackScanScheduled = false;
		this.#directoryFallbackScanQueued = false;
		this.#directoryFallbackScanTimer = undefined;
		this.#directoryFallbackScanInFlight = undefined;
		this.#directoryFallbackScanEvent = undefined;
		this.#lastDirectoryFallbackScanAt = 0;
		this.#watcherChangeHandler = this.#onWatcherChange.bind(this);
		this.#watcherErrorHandler = this.#handleWatchrError.bind(this);
		({ watcher: this.#watcher, options: this.#options, folderPath: this.#folderPath, filePath: this.#filePath, nodeHandler: this.#nodeEventHandler = this.#generateNodeEventHandler() } = watcherConfig);
		this.#ignore = this.#options.ignoreMatcher ?? this.#options.ignore;
		this.#abortController = new AbortController();
		this.#abortSignal = AbortSignal.any([ watchr.abortSignal, this.#abortController.signal ]);
		this.#initialStatOptions = { signal: this.#abortSignal, followSymlinks: this.#options.followSymlinks, sync: true };
		this.#initialSymlinkStatOptions = { ...this.#initialStatOptions, isSymbolicLink: true };
		this.#liveStatOptions = { timeout: this.#options.statTimeout, followSymlinks: this.#options.followSymlinks };
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
		return new FileSystemEventManager(fileSystemPoller, watchr, watcherConfig, hooks).#initializeEvents();
	}

	/**
	 * Initializes event listeners and handles initial scan
	 * @returns A Promise that resolves to a FileSystemEventManager
	 */
	async #initializeEvents() {
		this.#watcher.on(NodeWatcherEvent.CHANGE, this.#watcherChangeHandler);
		this.#watcher.on(NodeWatcherEvent.ERROR, this.#watcherErrorHandler);

		// "isInitial" => is ignorable via the "ignoreInitial" option
		const isInitial = !this.#watchr.isReady();

		// Single initial path
		if (this.#filePath) {
			// Already polled
			if (this.#fileSystemPoller.stats.has(this.#filePath)) { return this }

			await this.#onWatcherEvent(NodeTargetEvent.CHANGE, this.#filePath, isInitial);
		} else {
			// Multiple initial paths; `readDirectory` applies the ignore matcher, so only the root itself is re-checked.
			const { directories, files, symlinks } = await FileSystem.readDirectory(this.#folderPath, this.#directoryReadOptions());
			const rootPaths = this.#isIgnored(this.#folderPath) ? [] : [ this.#folderPath ];

			this.#initialSymlinks = symlinks.size === 0 ? undefined : symlinks;

			try {
				await this.#scanInitialPaths([ ...rootPaths, ...directories, ...files ], isInitial);
			} finally {
				this.#initialSymlinks = undefined;
			}
		}

		if (process.platform === 'win32' && this.#filePath === undefined && !this.#abortSignal.aborted) {
			this.#rootStatListener = (current: Stats, _previous: Stats): void => {
				if (current.nlink !== 0 || this.#watchr.isClosed()) { return }

				this.#watcher.close();
				this.#onWatcherChange(NodeTargetEvent.RENAME);
			};
			watchFile(this.#folderPath, { interval: 100, persistent: this.#options.persistent ?? true }, this.#rootStatListener);
		}

		if (process.platform === 'darwin' && this.#filePath !== undefined && !this.#abortSignal.aborted) {
			this.#fileStatPollTimer = setInterval(() => {
				if (this.#abortSignal.aborted) { return }

				this.#onWatcherChange(NodeTargetEvent.CHANGE);
			}, 100);
			if (this.#options.persistent === false) { this.#fileStatPollTimer.unref() }
		}

		return this;
	}

	/**
	 * Checks a path against the watcher's ignore option.
	 * @param targetPath The path to check
	 * @returns True when the path is ignored
	 */
	#isIgnored(targetPath: Path): boolean {
		return this.#ignore !== undefined && this.#watchr.isIgnored(targetPath, this.#ignore);
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
	 * A failing path is reported as an error and skipped so one bad entry can never fail the whole scan; the loop
	 * stops early once the watcher aborts.
	 * @param targetPaths The paths discovered for the initial scan
	 * @param isInitial Whether the resulting events are ignorable via `ignoreInitial`
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

			try {
				await this.#onWatcherEvent(NodeTargetEvent.CHANGE, targetPath, isInitial);
			} catch (error: unknown) {
				if (signal.aborted) { return }

				this.#hooks.reportError(new Error('Initial scan skipped path.', { cause: error }));
			}
		}
	}

	/**
	 * Removes watcher listeners, aborts any in-flight scan, and closes the native watcher so no stale handles remain.
	 */
	cleanup(): void {
		this.#abortController.abort();

		if (this.#rootStatListener !== undefined) {
			unwatchFile(this.#folderPath, this.#rootStatListener);
			this.#rootStatListener = undefined;
		}

		if (this.#fileStatPollTimer !== undefined) {
			clearInterval(this.#fileStatPollTimer);
			this.#fileStatPollTimer = undefined;
		}

		if (this.#directoryFallbackScanTimer !== undefined) {
			clearTimeout(this.#directoryFallbackScanTimer);
			this.#directoryFallbackScanTimer = undefined;
		}

		this.#directoryFallbackScanQueued = false;
		this.#directoryFallbackScanScheduled = false;
		this.#directoryFallbackScanEvent = undefined;
		this.#watcher.removeListener(NodeWatcherEvent.CHANGE, this.#watcherChangeHandler);
		this.#watcher.removeListener(NodeWatcherEvent.ERROR, this.#watcherErrorHandler);
		this.#watcher.close();
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
	 * @param initials Initial events captured for this batch
	 * @param regulars Regular target paths captured for this batch
	 * @returns A Promise that resolves when the lock is acquired
	 */
	async #getLock(initials: Event[], regulars: Set<Path>): Promise<void> {
		const includeInitials = !this.#options.ignoreInitial && initials.length > 0;

		if (!includeInitials && regulars.size === 0) { return }

		if (!includeInitials && regulars.size === 1) {
			const singleTargetPath: Path | undefined = regulars.values().next().value;

			if (singleTargetPath === undefined) { return }

			const singleEvents = await this.#fileSystemPoller.update(singleTargetPath, this.#liveStatOptions);

			if (singleEvents.length === 0) { return }

			this.#onTargetEvents(singleEvents.map<Event>(({ type, stats }) => [ type, singleTargetPath, stats ]));

			return;
		}

		const regularEvents = await this.#populateEvents(regulars);
		const allEvents = includeInitials ? [ ...initials, ...regularEvents ] : regularEvents;

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
		if (this.#watchr.isClosed()) { return }

		const initials = this.#initials.splice(0);
		const regulars = new Set(this.#regulars);
		this.#regulars.clear();
		this.#lock = this.#getLock(initials, regulars).catch((error: unknown) => {
			this.#hooks.reportError(error);
		});
	}

	/**
	 * Generates a Node event handler
	 * @returns A NodeEventHandler
	 */
	#generateNodeEventHandler() {
		return async (_event: NodeTargetEvent, targetPath: Path = '', isInitial: boolean = false): Promise<void> => {
			if (isInitial) {
				// Poll immediately
				await this.#populateEvents([ targetPath ], this.#initials, this.#initialSymlinks?.has(targetPath) === true ? this.#initialSymlinkStatOptions : this.#initialStatOptions);
			} else {
				// Poll later
				this.#regulars.add(targetPath);
			}

			this.#scheduleFlushAfterLock();
		};
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
			for (const { type, stats } of await this.#fileSystemPoller.update(targetPath, statOptions)) {
				events.push([ type, targetPath, stats ]);
			}
		}));

		return events;
	};

	/**
	 * Handles the given target events
	 * @param events The target events to handle
	 */
	#onTargetEvents(events: Event[]) {
		// Same-path stat transitions (e.g. atomic-save inode swaps) already resolve as a single CHANGE;
		// exclude those paths from rename-sibling correlation so a co-batched temp-file unlink/add doesn't
		// also emit a redundant RENAME for the same target. Collect the full set first, then process the
		// original batch in order so event emission and watcher cleanup retain their observed ordering.
		const changedPaths = new Set<Path>();

		for (const [ targetEvent, targetPath ] of events) {
			if (targetEvent === FileSystemEvent.CHANGE) { changedPaths.add(targetPath) }
		}

		for (const [ targetEvent, targetPath, stats ] of events) {
			if (targetEvent === FileSystemEvent.UNLINK && this.#filePath === undefined) {
				this.#hooks.closeWatchers(dirname(targetPath), targetPath);
			} else if (targetEvent === FileSystemEvent.UNLINK_DIR && this.#filePath === undefined) {
				this.#hooks.closeWatchers(dirname(targetPath), targetPath);
				this.#hooks.closeWatchers(targetPath);
			}

			if (this.#isSubRoot(targetPath)) {
				if (targetEvent === FileSystemEvent.CHANGE) {
					this.#hooks.renameHandler.handleChange(targetPath, stats);
				} else {
					this.#hooks.renameHandler.getLockTargetEvent(targetEvent, targetPath, stats, this.#options.renameTimeout, changedPaths);
				}
			}
		}
	}

	/**
	 * Handles the given watcher event
	 * @param event The watcher event to handle
	 * @param targetPath The target path of the event
	 * @param isInitial Whether this is an initial event
	 * @returns A Promise that resolves when the event is handled
	 */
	#onWatcherEvent(event: NodeTargetEvent, targetPath?: Path, isInitial: boolean = false) {
		return this.#nodeEventHandler(event, targetPath, isInitial);
	}

	/**
	 * Handles the given watcher change event
	 * @param event The watcher change event to handle
	 * @param targetName The target name of the event
	 */
	#onWatcherChange(event: NodeTargetEvent = NodeTargetEvent.CHANGE, targetName: string | null = '') {
		if (this.#watchr.isClosed()) { return }

		if (this.#filePath !== undefined) {
			if (this.#isIgnored(this.#filePath)) { return }

			void this.#onWatcherEvent(event, this.#filePath);

			return;
		}

		if (targetName !== null && targetName !== '') {
			const targetPath = resolve(this.#folderPath, targetName);

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
		void this.#dispatchWatcherEvents(event, this.#collectTrackedDirectoryTargets());

		this.#scheduleDirectoryFallbackScan(event);
	}

	/**
	 * Schedules a single fallback directory scan for ambiguous empty-name events.
	 * @param event The watcher change event.
	 */
	#scheduleDirectoryFallbackScan(event: NodeTargetEvent): void {
		this.#directoryFallbackScanQueued = true;
		this.#directoryFallbackScanEvent = this.#mergeDirectoryFallbackScanEvent(this.#directoryFallbackScanEvent, event);

		if (this.#directoryFallbackScanScheduled || this.#directoryFallbackScanInFlight !== undefined) { return }

		const delay = Math.max(0, this.#options.fallbackScanInterval - (performance.now() - this.#lastDirectoryFallbackScanAt));
		this.#directoryFallbackScanScheduled = true;

		if (delay === 0) {
			queueMicrotask(() => this.#startDirectoryFallbackScan());
			return;
		}

		this.#directoryFallbackScanTimer = setTimeout(() => {
			this.#directoryFallbackScanTimer = undefined;
			this.#startDirectoryFallbackScan();
		}, delay);
	}

	/**
	 * Starts a queued fallback directory scan.
	 */
	#startDirectoryFallbackScan(): void {
		this.#directoryFallbackScanScheduled = false;

		if (!this.#directoryFallbackScanQueued || this.#directoryFallbackScanInFlight !== undefined) { return }

		this.#directoryFallbackScanQueued = false;
		this.#lastDirectoryFallbackScanAt = performance.now();

		const event = this.#directoryFallbackScanEvent ?? NodeTargetEvent.CHANGE;
		this.#directoryFallbackScanEvent = undefined;

		const scanPromise = this.#runDirectoryFallbackScan(event).finally(() => {
			if (this.#directoryFallbackScanInFlight !== scanPromise) { return }

			this.#directoryFallbackScanInFlight = undefined;

			if (this.#directoryFallbackScanQueued) {
				this.#scheduleDirectoryFallbackScan(this.#directoryFallbackScanEvent ?? NodeTargetEvent.CHANGE);
			}
		});

		this.#directoryFallbackScanInFlight = scanPromise;
	}

	/**
	 * Merges queued empty-name watcher events so rename pressure is preserved.
	 * @param previousEvent The previously queued watcher event.
	 * @param nextEvent The next watcher event.
	 * @returns The merged watcher event.
	 */
	#mergeDirectoryFallbackScanEvent(previousEvent: NodeTargetEvent | undefined, nextEvent: NodeTargetEvent): NodeTargetEvent {
		if (previousEvent === NodeTargetEvent.RENAME || nextEvent === NodeTargetEvent.RENAME) {
			return NodeTargetEvent.RENAME;
		}

		return nextEvent;
	}

	/**
	 * Executes the fallback snapshot scan for ambiguous empty-name events.
	 * @param event The watcher change event.
	 */
	async #runDirectoryFallbackScan(event: NodeTargetEvent): Promise<void> {
		if (this.#watchr.isClosed() || this.#abortSignal.aborted) { return }

		const targetPaths = await this.#collectSnapshotDirectoryTargets();

		if (this.#abortSignal.aborted) { return }

		await this.#dispatchWatcherEvents(event, targetPaths);
	}

	/**
	 * Dispatches watcher events in bounded concurrent batches to avoid event storms; stops once this manager is aborted.
	 * @param event The watcher event to dispatch.
	 * @param targetPaths The target paths to dispatch.
	 */
	async #dispatchWatcherEvents(event: NodeTargetEvent, targetPaths: Iterable<Path>): Promise<void> {
		const paths = Array.from(targetPaths, (targetPath): Path => targetPath);

		for (let index = 0; index < paths.length && !this.#abortSignal.aborted; index += FileSystemEventManager.#maxConcurrentWatcherEventDispatches) {
			await Promise.all(paths.slice(index, index + FileSystemEventManager.#maxConcurrentWatcherEventDispatches).map((targetPath) => this.#onWatcherEvent(event, targetPath)));
		}
	}

	/**
	 * Collects tracked candidate paths under the watched root.
	 * @returns Tracked target paths for quick polling.
	 */
	#collectTrackedDirectoryTargets(): Path[] {
		const targets: Path[] = [];

		for (const trackedTargetPath of this.#fileSystemPoller.stats.keys()) {
			if (!this.#isSubRoot(trackedTargetPath)) { continue }
			if (this.#isIgnored(trackedTargetPath)) { continue }

			targets.push(trackedTargetPath);
		}

		return targets;
	}

	/**
	 * Collects snapshot candidate paths under the watched root; yields nothing once this manager is aborted.
	 * @returns Snapshot target paths for fallback polling.
	 */
	async #collectSnapshotDirectoryTargets(): Promise<Path[]> {
		const targets = new Set<Path>();

		try {
			const { directories, files } = await FileSystem.readDirectory(this.#folderPath, this.#directoryReadOptions());

			if (this.#abortSignal.aborted) { return [] }

			if (!this.#isIgnored(this.#folderPath)) { targets.add(this.#folderPath) }
			for (const targetPath of directories) { targets.add(targetPath) }
			for (const targetPath of files) { targets.add(targetPath) }
		} catch {
			// If the root vanishes transiently, tracked targets still allow unlink derivation.
		}

		return [ ...targets ];
	}

	/**
	 * Handles the given watcher error event
	 * @param error The watcher error event to handle
	 */
	#handleWatchrError(error: NodeJS.ErrnoException) {
		// Windows raises EPERM on the handle when a watched directory is deleted or locked; re-poll instead of erroring.
		if (process.platform === 'win32' && error.code === 'EPERM') {
			this.#onWatcherChange(NodeTargetEvent.RENAME);
			return;
		}

		this.#hooks.reportError(this.#sanitizeWatcherError(error));
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

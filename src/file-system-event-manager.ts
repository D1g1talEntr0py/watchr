import { dirname, resolve } from 'node:path';
import type { FSWatcher } from 'node:fs';
import { FileSystem } from './file-system';
import { NodeWatcherEvent, NodeTargetEvent, FileSystemEvent } from './constants';
import type { Watchr } from './watchr';
import type { FileSystemStateManager } from './file-system-state-manager';
import type { Event, NodeEventHandler, Path, WatchrOptions, WatchrConfig } from './@types/index';

/** Manages file system events for a specific folder */
export class FileSystemEventManager {
	// TODO: Consider exposing this as a watch option for platform/workload tuning.
	private static readonly directoryFallbackScanIntervalMs = 10;
	private static readonly maxConcurrentWatcherEventDispatches = 32;
	/** Event priorities used to keep the highest-priority event per path during deduplication. */
	private static readonly eventPriorities = new Map<FileSystemEvent, number>([
		[ FileSystemEvent.ADD, 4 ],
		[ FileSystemEvent.ADD_DIR, 4 ],
		[ FileSystemEvent.CHANGE, 3 ],
		[ FileSystemEvent.RENAME, 2 ],
		[ FileSystemEvent.RENAME_DIR, 2 ],
		[ FileSystemEvent.UNLINK, 1 ],
		[ FileSystemEvent.UNLINK_DIR, 1 ]
	]);

	private lock: Promise<void>;
	private readonly fileSystemPoller: FileSystemStateManager;
	private readonly watchr: Watchr;
	private readonly watcher: FSWatcher;
	private readonly options: WatchrOptions;
	private readonly folderPath: Path;
	private readonly filePath: Path | undefined;
	private readonly initials: Event[];
	private readonly regulars: Set<Path>;
	private readonly nodeEventHandler: NodeEventHandler;
	private batchRevision: number;
	private flushQueued: boolean;
	private flushAfterLockScheduled: boolean;
	private directoryFallbackScanScheduled: boolean;
	private directoryFallbackScanQueued: boolean;
	private directoryFallbackScanTimer: ReturnType<typeof setTimeout> | undefined;
	private directoryFallbackScanInFlight: Promise<void> | undefined;
	private directoryFallbackScanEvent: NodeTargetEvent | undefined;
	private lastDirectoryFallbackScanAt: number;
	private readonly watcherChangeHandler: (event?: NodeTargetEvent, targetName?: string) => void;
	private readonly watcherErrorHandler: (error: NodeJS.ErrnoException) => void;

	/**
	 * Creates a new instance of FileSystemEventManager
	 * @param fileSystemPoller The file system poller to use
	 * @param watchr The watchr instance
	 * @param watcherConfig The watcher configuration
	 */
	private constructor(fileSystemPoller: FileSystemStateManager, watchr: Watchr, watcherConfig: WatchrConfig) {
		this.lock = watchr.readyLock;
		this.fileSystemPoller = fileSystemPoller;
		this.watchr = watchr;
		this.initials = [];
		this.regulars = new Set();
		this.batchRevision = 0;
		this.flushQueued = false;
		this.flushAfterLockScheduled = false;
		this.directoryFallbackScanScheduled = false;
		this.directoryFallbackScanQueued = false;
		this.directoryFallbackScanTimer = undefined;
		this.directoryFallbackScanInFlight = undefined;
		this.directoryFallbackScanEvent = undefined;
		this.lastDirectoryFallbackScanAt = 0;
		this.watcherChangeHandler = this.onWatcherChange.bind(this);
		this.watcherErrorHandler = this.handleWatchrError.bind(this);
		({ watcher: this.watcher, options: this.options, folderPath: this.folderPath, filePath: this.filePath, nodeHandler: this.nodeEventHandler = this.generateNodeEventHandler() } = watcherConfig);
	}

	/**
	 * Creates a new instance of FileSystemEventManager
	 * @param fileSystemPoller The file system poller to use
	 * @param watchr The watchr instance
	 * @param watcherConfig The watcher configuration
	 * @returns A Promise of a FileSystemEventManager
	 */
	static async newInstance(fileSystemPoller: FileSystemStateManager, watchr: Watchr, watcherConfig: WatchrConfig): Promise<FileSystemEventManager> {
		return new FileSystemEventManager(fileSystemPoller, watchr, watcherConfig).initializeEvents();
	}

	/**
	 * Initializes event listeners and handles initial scan
	 * @returns A Promise that resolves to a FileSystemEventManager
	 */
	private async initializeEvents() {
		this.watcher.on(NodeWatcherEvent.CHANGE, this.watcherChangeHandler);
		this.watcher.on(NodeWatcherEvent.ERROR, this.watcherErrorHandler);

		// "isInitial" => is ignorable via the "ignoreInitial" option
		const isInitial = !this.watchr.isReady();

		// Single initial path
		if (this.filePath) {
			// Already polled
			if (this.fileSystemPoller.stats.has(this.filePath)) { return this }

			await this.onWatcherEvent(NodeTargetEvent.CHANGE, this.filePath, isInitial);
		} else {
			// Multiple initial paths
			const ignore = (targetPath: Path) => this.watchr.isIgnored(targetPath, this.options.ignore);
			const { directories, files } = await FileSystem.readDirectory(this.folderPath, { signal: this.watchr.abortSignal, ignore });

			await Promise.all([ this.folderPath, ...directories, ...files ].map(async (targetPath) => {
				// Already polled
				if (this.fileSystemPoller.stats.has(targetPath)) { return }

				if (this.watchr.isIgnored(targetPath, this.options.ignore)) { return }

				return this.onWatcherEvent(NodeTargetEvent.CHANGE, targetPath, isInitial);
			}));
		}

		return this;
	}

	/**
	 * Removes watcher listeners and closes the native watcher so no stale handles remain.
	 */
	cleanup(): void {
		if (this.directoryFallbackScanTimer !== undefined) {
			clearTimeout(this.directoryFallbackScanTimer);
			this.directoryFallbackScanTimer = undefined;
		}

		this.directoryFallbackScanQueued = false;
		this.directoryFallbackScanScheduled = false;
		this.directoryFallbackScanEvent = undefined;
		this.watcher.removeListener(NodeWatcherEvent.CHANGE, this.watcherChangeHandler);
		this.watcher.removeListener(NodeWatcherEvent.ERROR, this.watcherErrorHandler);
		this.watcher.close();
	}

	/**
	 * Checks if the target path is within the watched root
	 * @param targetPath The path to check
	 * @returns True if the path is within the watched root, false otherwise
	 */
	private isSubRoot(targetPath: Path) {
		return this.filePath ? targetPath === this.filePath : targetPath === this.folderPath || FileSystem.isSubPath(this.folderPath, targetPath);
	}

	/**
	 * Acquires a lock for the current event batch
	 * @returns A Promise that resolves when the lock is acquired
	 */
	private async getLock(): Promise<void> {
		const includeInitials = !this.options.ignoreInitial && this.initials.length > 0;

		if (!includeInitials && this.regulars.size === 0) { return }

		if (!includeInitials && this.regulars.size === 1) {
			const singleTargetPath: Path | undefined = this.regulars.values().next().value;

			if (singleTargetPath === undefined) { return }

			const singleEvents = await this.fileSystemPoller.update(singleTargetPath);

			if (singleEvents.length === 0) { return }

			this.onTargetEvents(singleEvents.map<Event>((event) => [ event, singleTargetPath ]));

			return;
		}

		const regularEvents = await this.populateEvents(this.regulars);
		const allEvents = includeInitials ? [ ...this.initials, ...regularEvents ] : regularEvents;

		if (allEvents.length === 0) { return }

		this.onTargetEvents(this.deduplicateEvents(allEvents));
	}

	/**
	 * Flushes the current event batch.
	 * Batch through a microtask so events observed in the same turn settle together.
	 */
	private flush() {
		if (this.flushQueued) { return }

		this.flushQueued = true;
		queueMicrotask(() => {
			this.flushQueued = false;
			this.flushImmediate();
		});
	}

	/**
	 * Flushes the current event batch immediately.
	 */
	private flushImmediate() {
		if (this.watchr.isClosed()) { return }

		this.lock = this.getLock();
		this.initials.length = 0;
		this.regulars.clear();
	}

	/**
	 * Generates a Node event handler
	 * @returns A NodeEventHandler
	 */
	private generateNodeEventHandler() {
		return async (_event: NodeTargetEvent, targetPath: Path = '', isInitial: boolean = false): Promise<void> => {
			if (isInitial) {
				// Poll immediately
				await this.populateEvents([ targetPath ], this.initials);
				this.batchRevision++;
			} else {
				// Poll later
				this.regulars.add(targetPath);
				this.batchRevision++;
			}

			this.scheduleFlushAfterLock();
		};
	}

	/**
	 * Schedules a single flush once the current lock chain settles.
	 */
	private scheduleFlushAfterLock(): void {
		if (this.flushAfterLockScheduled) { return }

		this.flushAfterLockScheduled = true;

		void this.lock.then(() => this.onFlushAfterLock()).catch((error) => {
			this.flushAfterLockScheduled = false;
			this.watchr.error(error);
			void this.flush();
		});
	}

	/**
	 * Runs when the current lock chain resolves.
	 */
	private onFlushAfterLock(): void {
		this.flushAfterLockScheduled = false;
		void this.flush();
	}

	/**
	 * Deduplicates events to avoid redundant notifications
	 * @param events The events to deduplicate
	 * @returns The deduplicated events
	 */
	private deduplicateEvents(events: Event[]) {
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
			const previousPriority = FileSystemEventManager.eventPriorities.get(previousEvent[0]) ?? 0;
			const currentPriority = FileSystemEventManager.eventPriorities.get(targetEvent) ?? 0;

			if (currentPriority > previousPriority) {
				uniqueEvents[existingIndex] = event;
			}
		}

		return uniqueEvents;
	}

	/**
	 * Populates events for the given target paths
	 * @param targetPaths The target paths to populate events for
	 * @param events The events to populate
	 * @returns The populated events
	 */
	private async populateEvents(targetPaths: Iterable<Path>, events: Event[] = []) {
		const paths = Array.from(targetPaths, (targetPath): Path => targetPath);

		await Promise.all(paths.map(async (targetPath) => {
			for (const event of await this.fileSystemPoller.update(targetPath)) {
				events.push([ event, targetPath ]);
			}
		}));

		return events;
	};

	/**
	 * Handles the given target events
	 * @param events The target events to handle
	 */
	private onTargetEvents(events: Event[]) {
		// Same-path stat transitions (e.g. atomic-save inode swaps) already resolve as a single CHANGE;
		// exclude those paths from rename-sibling correlation so a co-batched temp-file unlink/add doesn't
		// also emit a redundant RENAME for the same target. Collect the full set first, then process the
		// original batch in order so event emission and watcher cleanup retain their observed ordering.
		const changedPaths = new Set<Path>();

		for (const [ targetEvent, targetPath ] of events) {
			if (targetEvent === FileSystemEvent.CHANGE) { changedPaths.add(targetPath) }
		}

		for (const [ targetEvent, targetPath ] of events) {
			if (targetEvent === FileSystemEvent.UNLINK && this.filePath === undefined) {
				this.watchr.watchersClose(dirname(targetPath), targetPath);
			} else if (targetEvent === FileSystemEvent.UNLINK_DIR && this.filePath === undefined) {
				this.watchr.watchersClose(dirname(targetPath), targetPath);
				this.watchr.watchersClose(targetPath);
			}

			if (this.isSubRoot(targetPath)) {
				if (targetEvent === FileSystemEvent.CHANGE) {
					this.watchr.emitEvent(targetEvent, targetPath);
				} else {
					this.watchr.renameWatchr.getLockTargetEvent(targetEvent, targetPath, this.options.renameTimeout, changedPaths);
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
	private onWatcherEvent(event: NodeTargetEvent, targetPath?: Path, isInitial: boolean = false) {
		return this.nodeEventHandler(event, targetPath, isInitial);
	}

	/**
	 * Handles the given watcher change event
	 * @param event The watcher change event to handle
	 * @param targetName The target name of the event
	 */
	private onWatcherChange(event: NodeTargetEvent = NodeTargetEvent.CHANGE, targetName: string = '') {
		if (this.watchr.isClosed()) { return }

		if (this.filePath !== undefined) {
			if (this.watchr.isIgnored(this.filePath, this.options.ignore)) { return }

			void this.onWatcherEvent(event, this.filePath);

			return;
		}

		if (targetName !== '') {
			const targetPath = resolve(this.folderPath, targetName);

			if (this.watchr.isIgnored(targetPath, this.options.ignore)) { return }

			void this.onWatcherEvent(event, targetPath);

			return;
		}

		void this.onEmptyDirectoryWatcherChange(event);
	}

	/**
	 * Handles a directory watcher event without a usable target name.
	 * First polls tracked paths, then schedules one bounded snapshot scan.
	 * @param event The watcher change event.
	 */
	private onEmptyDirectoryWatcherChange(event: NodeTargetEvent): void {
		void this.dispatchWatcherEvents(event, this.collectTrackedDirectoryTargets());

		this.scheduleDirectoryFallbackScan(event);
	}

	/**
	 * Schedules a single fallback directory scan for ambiguous empty-name events.
	 * @param event The watcher change event.
	 */
	private scheduleDirectoryFallbackScan(event: NodeTargetEvent): void {
		this.directoryFallbackScanQueued = true;
		this.directoryFallbackScanEvent = this.mergeDirectoryFallbackScanEvent(this.directoryFallbackScanEvent, event);

		if (this.directoryFallbackScanScheduled || this.directoryFallbackScanInFlight !== undefined) { return }

		const delay = Math.max(0, FileSystemEventManager.directoryFallbackScanIntervalMs - (performance.now() - this.lastDirectoryFallbackScanAt));
		this.directoryFallbackScanScheduled = true;

		if (delay === 0) {
			queueMicrotask(() => this.startDirectoryFallbackScan());
			return;
		}

		this.directoryFallbackScanTimer = setTimeout(() => {
			this.directoryFallbackScanTimer = undefined;
			this.startDirectoryFallbackScan();
		}, delay);
	}

	/**
	 * Starts a queued fallback directory scan.
	 */
	private startDirectoryFallbackScan(): void {
		this.directoryFallbackScanScheduled = false;

		if (!this.directoryFallbackScanQueued || this.directoryFallbackScanInFlight !== undefined) { return }

		this.directoryFallbackScanQueued = false;
		this.lastDirectoryFallbackScanAt = performance.now();

		const event = this.directoryFallbackScanEvent ?? NodeTargetEvent.CHANGE;
		this.directoryFallbackScanEvent = undefined;

		const scanPromise = this.runDirectoryFallbackScan(event).finally(() => {
			if (this.directoryFallbackScanInFlight !== scanPromise) { return }

			this.directoryFallbackScanInFlight = undefined;

			if (this.directoryFallbackScanQueued) {
				this.scheduleDirectoryFallbackScan(this.directoryFallbackScanEvent ?? NodeTargetEvent.CHANGE);
			}
		});

		this.directoryFallbackScanInFlight = scanPromise;
	}

	/**
	 * Merges queued empty-name watcher events so rename pressure is preserved.
	 * @param previousEvent The previously queued watcher event.
	 * @param nextEvent The next watcher event.
	 * @returns The merged watcher event.
	 */
	private mergeDirectoryFallbackScanEvent(previousEvent: NodeTargetEvent | undefined, nextEvent: NodeTargetEvent): NodeTargetEvent {
		if (previousEvent === NodeTargetEvent.RENAME || nextEvent === NodeTargetEvent.RENAME) {
			return NodeTargetEvent.RENAME;
		}

		return nextEvent;
	}

	/**
	 * Executes the fallback snapshot scan for ambiguous empty-name events.
	 * @param event The watcher change event.
	 */
	private async runDirectoryFallbackScan(event: NodeTargetEvent): Promise<void> {
		if (this.watchr.isClosed()) { return }

		await this.dispatchWatcherEvents(event, await this.collectSnapshotDirectoryTargets());
	}

	/**
	 * Dispatches watcher events in bounded concurrent batches to avoid event storms.
	 * @param event The watcher event to dispatch.
	 * @param targetPaths The target paths to dispatch.
	 */
	private async dispatchWatcherEvents(event: NodeTargetEvent, targetPaths: Iterable<Path>): Promise<void> {
		const paths = Array.from(targetPaths, (targetPath): Path => targetPath);

		for (let index = 0; index < paths.length; index += FileSystemEventManager.maxConcurrentWatcherEventDispatches) {
			await Promise.all(paths.slice(index, index + FileSystemEventManager.maxConcurrentWatcherEventDispatches).map((targetPath) => this.onWatcherEvent(event, targetPath)));
		}
	}

	/**
	 * Collects tracked candidate paths under the watched root.
	 * @returns Tracked target paths for quick polling.
	 */
	private collectTrackedDirectoryTargets(): Path[] {
		const targets: Path[] = [];

		for (const trackedTargetPath of this.fileSystemPoller.stats.keys()) {
			if (!this.isSubRoot(trackedTargetPath)) { continue }
			if (this.watchr.isIgnored(trackedTargetPath, this.options.ignore)) { continue }

			targets.push(trackedTargetPath);
		}

		return targets;
	}

	/**
	 * Collects snapshot candidate paths under the watched root.
	 * @returns Snapshot target paths for fallback polling.
	 */
	private async collectSnapshotDirectoryTargets(): Promise<Path[]> {
		const targets = new Set<Path>();

		const ignore = (targetPath: Path) => this.watchr.isIgnored(targetPath, this.options.ignore);

		try {
			const { directories, files } = await FileSystem.readDirectory(this.folderPath, { signal: this.watchr.abortSignal, ignore });

			if (!ignore(this.folderPath)) { targets.add(this.folderPath) }
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
	private handleWatchrError(error: NodeJS.ErrnoException) {
		this.watchr.error(this.sanitizeWatcherError(error));
	}

	/**
	 * Sanitizes watcher errors to avoid leaking absolute file system paths.
	 * @param error The original watcher error
	 * @returns A sanitized error with a stable message and error code
	 */
	private sanitizeWatcherError(error: NodeJS.ErrnoException): Error {
		const message = error.code ? `🚨 Watcher error (${error.code})` : '🚨 Watcher error';
		const sanitizedError = new Error(message, { cause: error }) as NodeJS.ErrnoException;
		sanitizedError.code = error.code ?? 'UNKNOWN';

		return sanitizedError;
	}
}

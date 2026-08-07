import { dirname, resolve } from 'node:path';
import type { FSWatcher } from 'node:fs';
import { FileSystem } from './file-system';
import { NodeWatcherEvent, NodeTargetEvent, FileSystemEvent, isWindows } from './constants';
import type { Watchr } from './watchr';
import type { FileSystemStateManager } from './file-system-state-manager';
import type { Event, NodeEventHandler, Path, WatchrOptions, WatchrConfig } from './@types';

/** Manages file system events for a specific folder */
export class FileSystemEventManager {
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
	 * Removes watcher listeners so closed watchers do not retain stale handlers.
	 */
	cleanup(): void {
		this.watcher.removeListener(NodeWatcherEvent.CHANGE, this.watcherChangeHandler);
		this.watcher.removeListener(NodeWatcherEvent.ERROR, this.watcherErrorHandler);
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

		const eventPriorities = new Map<FileSystemEvent, number>([
			[ FileSystemEvent.ADD, 4 ],
			[ FileSystemEvent.ADD_DIR, 4 ],
			[ FileSystemEvent.CHANGE, 3 ],
			[ FileSystemEvent.RENAME, 2 ],
			[ FileSystemEvent.RENAME_DIR, 2 ],
			[ FileSystemEvent.UNLINK, 1 ],
			[ FileSystemEvent.UNLINK_DIR, 1 ],
		]);
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
			const previousPriority = eventPriorities.get(previousEvent[0]) ?? 0;
			const currentPriority = eventPriorities.get(targetEvent) ?? 0;

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
		for (const [ targetEvent, targetPath ] of events) {
			if (targetEvent === FileSystemEvent.UNLINK) {
				this.watchr.watchersClose(dirname(targetPath), targetPath);
			} else if (targetEvent === FileSystemEvent.UNLINK_DIR) {
				this.watchr.watchersClose(dirname(targetPath), targetPath);
				this.watchr.watchersClose(targetPath);
			}

			if (this.isSubRoot(targetPath)) {
				if (targetEvent !== FileSystemEvent.CHANGE) {
					this.watchr.renameWatchr.getLockTargetEvent(targetEvent, targetPath, this.options.renameTimeout);
				} else {
					this.watchr.emitEvent(targetEvent, targetPath);
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

		const targetPath = targetName === '' && this.filePath
			? this.filePath
			: resolve(this.folderPath, targetName);

		if ((this.filePath && targetPath !== this.folderPath && targetPath !== this.filePath) || this.watchr.isIgnored(targetPath, this.options.ignore)) { return }

		void this.onWatcherEvent(event, targetPath);
	}

	/**
	 * Handles the given watcher error event
	 * @param error The watcher error event to handle
	 */
	private handleWatchrError(error: NodeJS.ErrnoException) {
		if (isWindows && error.code === 'EPERM') {
			// EPERM can be thrown on Windows when a file is locked by another process.
			// In this case, we can't do anything but wait for the file to be unlocked.
			// We can't even stat the file to see if it's a file or a directory.
			// We'll just emit a change event and let the poller handle it.
			this.onWatcherChange(NodeTargetEvent.CHANGE);
		} else {
			this.watchr.error(this.sanitizeWatcherError(error));
		}
	}

	/**
	 * Sanitizes watcher errors to avoid leaking absolute file system paths.
	 * @param error The original watcher error
	 * @returns A sanitized error with a stable message and error code
	 */
	private sanitizeWatcherError(error: NodeJS.ErrnoException): Error {
		const message = error.code ? `🚨 Watcher error (${error.code})` : '🚨 Watcher error';
		const sanitizedError = new Error(message) as NodeJS.ErrnoException;
		sanitizedError.code = error.code ?? 'UNKNOWN';

		return sanitizedError;
	}
}
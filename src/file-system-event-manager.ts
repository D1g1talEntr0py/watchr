import { dirname, resolve } from 'node:path';
import { FileSystem } from './file-system';
import { debounce } from './decorators/debounce';
import { NodeWatcherEvent, NodeTargetEvent, FileSystemEvent, debounceWait, isWindows } from './constants';
import type { FSWatcher } from 'node:fs';
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
	private async initializeEvents(): Promise<FileSystemEventManager> {
		this.watcher.on(NodeWatcherEvent.CHANGE, this.onWatcherChange.bind(this));
		this.watcher.on(NodeWatcherEvent.ERROR, this.handleWatchrError.bind(this));

		// "isInitial" => is ignorable via the "ignoreInitial" option
		const isInitial = !this.watchr.isReady();

		// Single initial path
		if (this.filePath) {
			// Already polled
			if (this.fileSystemPoller.stats.has(this.filePath)) { return this }

			await this.onWatcherEvent(NodeTargetEvent.CHANGE, this.filePath, isInitial);
		} else {
			// Multiple initial paths
			const { directories, files } = await FileSystem.readDirectory(this.folderPath, { ignore: this.options.ignore, signal: this.watchr.abortSignal });

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
	 * Checks if the target path is within the watched root
	 * @param targetPath The path to check
	 * @returns True if the path is within the watched root, false otherwise
	 */
	private isSubRoot(targetPath: Path): boolean {
		return this.filePath ? targetPath === this.filePath : targetPath === this.folderPath || FileSystem.isSubPath(this.folderPath, targetPath);
	}

	/**
	 * Acquires a lock for the current event batch
	 * @returns A Promise that resolves when the lock is acquired
	 */
	private async getLock(): Promise<void> {
		this.onTargetEvents(this.deduplicateEvents([ ...(this.options.ignoreInitial ? [] : this.initials), ...(await this.populateEvents(Array.from(this.regulars))) ]));
	}

	/**
	 * Flushes the current event batch
	 */
	@debounce(debounceWait)
	private flush(): void {
		if (this.watchr.isClosed()) { return }

		this.lock = this.getLock();
		this.initials.length = 0;
		this.regulars.clear();
	}

	/**
	 * Generates a Node event handler
	 * @returns A NodeEventHandler
	 */
	private generateNodeEventHandler(): NodeEventHandler {
		return async (_event: NodeTargetEvent, targetPath: Path = '', isInitial: boolean = false): Promise<void> => {
			if (isInitial) {
				// Poll immediately
				await this.populateEvents([ targetPath ], this.initials);
			} else {
				// Poll later
				this.regulars.add(targetPath);
			}

			void this.lock.then(this.flush.bind(this));
		};
	}

	/**
	 * Deduplicates events to avoid redundant notifications
	 * @param events The events to deduplicate
	 * @returns The deduplicated events
	 */
	private deduplicateEvents(events: Event[]): Event[] {
		if (events.length < 2) { return events }

		const previousEventTargets = new Map<Path, FileSystemEvent>();

		return events.reduce<Event[]>((uniqueEvents, event): Event[] => {
			const [ targetEvent, targetPath ] = event;
			const previousEventTarget = previousEventTargets.get(targetPath);

			// Same event, ignoring
			if (targetEvent === previousEventTarget) { return uniqueEvents }

			// "change" after "add", ignoring
			if (targetEvent === FileSystemEvent.CHANGE && previousEventTarget === FileSystemEvent.ADD) { return uniqueEvents }

			previousEventTargets.set(targetPath, targetEvent);

			uniqueEvents.push(event);

			return uniqueEvents;
		}, []);
	}

	/**
	 * Populates events for the given target paths
	 * @param targetPaths The target paths to populate events for
	 * @param events The events to populate
	 * @returns The populated events
	 */
	private async populateEvents(targetPaths: Path[], events: Event[] = []): Promise<Event[]> {
		await Promise.all(targetPaths.map(async (targetPath) => {
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
	private onTargetEvents(events: Event[]): void {
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
	private onWatcherEvent(event: NodeTargetEvent, targetPath?: Path, isInitial: boolean = false): Promise<void> {
		return this.nodeEventHandler(event, targetPath, isInitial);
	}

	/**
	 * Handles the given watcher change event
	 * @param event The watcher change event to handle
	 * @param targetName The target name of the event
	 */
	private onWatcherChange(event: NodeTargetEvent = NodeTargetEvent.CHANGE, targetName: string = ''): void {
		if (this.watchr.isClosed()) { return }

		const targetPath = resolve(this.folderPath, targetName);

		if ((this.filePath && targetPath !== this.folderPath && targetPath !== this.filePath) || this.watchr.isIgnored(targetPath, this.options.ignore)) { return }

		void this.onWatcherEvent(event, targetPath);
	}

	/**
	 * Handles the given watcher error event
	 * @param error The watcher error event to handle
	 */
	private handleWatchrError(error: NodeJS.ErrnoException): void {
		if (isWindows && error.code === 'EPERM') {
			// EPERM can be thrown on Windows when a file is locked by another process.
			// In this case, we can't do anything but wait for the file to be unlocked.
			// We can't even stat the file to see if it's a file or a directory.
			// We'll just emit a change event and let the poller handle it.
			this.onWatcherChange(NodeTargetEvent.CHANGE);
		} else {
			this.watchr.error(error);
		}
	}
}
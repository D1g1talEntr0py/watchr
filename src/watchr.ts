import EventEmitter from 'node:events';
import { resolve, dirname } from 'node:path';
import { watch } from 'node:fs';
import { FileSystem } from './file-system';
import { castError, noop, uniqueSortedArray } from './utils';
import { FileRenameHandler } from './file-rename-handler';
import { WatchrStats } from './watchr-stats';
import { FileEvent, DirectoryEvent, WatcherEvent } from './constants';
import { FileSystemEventManager } from './file-system-event-manager';
import type { Handler, Ignore, Path, WatchrOptions, WatchrConfig, AsyncCallable, Closable, FileSystemEvent } from './@types';

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
		this.closed = false;
		this.ready = false;
		this.abortController = new AbortController();
		this._abortSignal = this.abortController.signal;
		this._readyLock = new Promise((resolve) => this.on(WatcherEvent.READY, resolve));
		this.roots = new Set();
		this._renameHandler = new FileRenameHandler(this.emitEvent.bind(this));
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
	 * @param ignore The ignore function to use
	 * @returns True if the target path is ignored, false otherwise
	 */
	isIgnored(targetPath: Path, ignore?: Ignore): boolean {
		return ignore?.(targetPath) ?? false;
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

		if (this.isClosed()) { return }

		this.closed = true;

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

		const targetStats = this._renameHandler.fileStateManager.stats.get(targetPath);
		this.emit(WatcherEvent.ALL, event, targetStats, targetPath, targetPathNext);
		this.emit(event, targetStats, targetPath, targetPathNext);
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
	private setReady(): boolean {
		if (this.isClosed() || this.isReady()) { return false }

		this.ready = true;

		return this.emit(WatcherEvent.READY);
	}

	/** Restores the watchers from a previous state */
	private watchersRestore(): void {
		delete this.watchersRestoreTimeout;

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
	private async addWatcher(config: WatchrConfig): Promise<FileSystemEventManager> {
		this.addWatcherConfig(config);

		return FileSystemEventManager.newInstance(this._renameHandler.fileStateManager, this, config);
	}

	/**
	 * Watches a directory for changes
	 * @param folderPath The path of the folder to watch
	 * @param options The options for the watcher
	 * @param handler The handler to call when changes are detected
	 * @param filePath The path of the file to watch (if any)
	 * @returns A promise that resolves when the watcher is active
	 */
	private async watchDirectory(folderPath: Path, options: WatchrOptions, handler?: Handler, filePath?: Path): Promise<void> {
		if (this.isClosed() || this.isIgnored(folderPath, options.ignore)) { return }

		// Node.js 20.16+ supports recursive watching natively on all platforms
		return this.synchronizeWatchers(async () => {
			await this.addWatcher({ watcher: watch(folderPath, options), handler, options, folderPath, filePath });
		});
	}

	/**
	 * Synchronizes the watchers by locking them for a given callback
	 * @param callback The callback to execute while the watchers are locked
	 * @returns A promise that resolves when the callback is complete
	 */
	private async synchronizeWatchers(callback: AsyncCallable): Promise<void> {
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
	private async watchFile(filePath: Path, options: WatchrOptions, handler?: Handler): Promise<void> {
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
	private async watchPaths(targetPaths: Path[], options: WatchrOptions, handler: Handler = noop): Promise<void> {
		if (this.isClosed() || this._abortSignal.aborted) { return }

		if (targetPaths.length === 1) { return this.watchPath(targetPaths[0], options, handler) }

		// Sort and deduplicate the paths
		targetPaths = uniqueSortedArray(targetPaths);

		// TODO: Find parallelizable chunks rather than using an all or nothing approach
		let hasSubPaths = false;
		const length = targetPaths.length;
		outer: for (let i = 0; i < length; i++) {
			for (let j = i + 1; j < length; j++) {
				if (FileSystem.isSubPath(targetPaths[i], targetPaths[j])) {
					hasSubPaths = true;
					break outer;
				}
			}
		}

		if (hasSubPaths) {
			// Watching serially
			for (let i = 0; i < length; i++) {
				if (this._abortSignal.aborted) { return }
				await this.watchPath(targetPaths[i], options, handler);
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
	private async watchPath(targetPath: Path, options: WatchrOptions, handler?: Handler): Promise<void> {
		if (this.isClosed()) { return }

		targetPath = resolve(targetPath);

		if (this.isIgnored(targetPath, options.ignore)) { return }

		const stats = await FileSystem.getStats(targetPath);

		if (!stats) { throw new Error(`🚨 Path not found: "${targetPath}"`) }

		if (stats.isFile()) {
			return this.watchFile(targetPath, options, handler);
		} else if (stats.isDirectory()) {
			return this.watchDirectory(targetPath, options, handler);
		} else {
			this.error(`"${targetPath}" is not supported`);
		}
	}

	/**
	 * Watches a set of paths for changes
	 * @param target The paths to watch
	 * @param options The options for the watcher
	 * @param handler The handler to call when changes are detected
	 * @returns A promise that resolves when all watchers are active
	 */
	private async watch(target: Path[], options: WatchrOptions, handler?: Handler): Promise<void> {
		if (this.isClosed()) { return }

		for (const targetPath of target) { this.roots.add(targetPath) }

		await this.watchPaths(target, options, handler);

		if (this.isClosed()) { return }

		if (handler !== undefined) { this.on(WatcherEvent.ALL, handler) }

		this.setReady();
	}

	/**
	 * Closes a watcher for a specific config
	 * @param config The config for the watcher
	 */
	private watcherClose(config: WatchrConfig): void {
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
}

export { Watchr, WatchrStats, type FileSystemEvent, type WatchrOptions };
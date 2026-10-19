import { FileSystem } from './file-system';
import { NodeTargetEvent } from './constants';
import { castError } from './utils';
import type { Closable, DirectoryReadOptions, Path } from './@types/index';

type DirectoryScannerConfiguration = Readonly<{
	folderPath: Path;
	interval: number;
	readOptions: Readonly<DirectoryReadOptions>;
	trackedPaths: () => Iterable<Path>;
	isIgnored: (path: Path) => boolean;
	onWatcherEvent: (event: NodeTargetEvent, path: Path) => void | Promise<void>;
	onError: (error: unknown) => void;
}>;

/**
 * Reconciles tracked directory paths and throttled snapshots without overlapping scans.
 * @internal
 */
export class DirectoryScanner implements Closable {
	#scheduled = false;
	#queued = false;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#inFlight: Promise<void> | undefined;
	#event: NodeTargetEvent | undefined;
	#lastAt = 0;
	readonly #configuration: DirectoryScannerConfiguration;
	readonly #abortController = new AbortController();
	readonly #signal: AbortSignal;
	static readonly #maxConcurrentDispatches = 32;

	/**
	 * Creates directory reconciliation owned by the manager's cancellation lifetime.
	 * @param configuration Directory reading and event admission capabilities
	 * @param signal The owning manager's abort signal
	 */
	constructor(configuration: DirectoryScannerConfiguration, signal: AbortSignal) {
		this.#signal = AbortSignal.any([ signal, this.#abortController.signal ]);
		this.#configuration = { ...configuration, readOptions: { ...configuration.readOptions, signal: this.#signal } };
	}

	/**
	 * Polls tracked paths immediately, then schedules a bounded snapshot.
	 * @param event The native watcher event
	 */
	reconcile(event: NodeTargetEvent): void {
		if (this.#signal.aborted) { return }

		void this.#dispatch(event, this.#collectTrackedTargets()).catch((error: unknown) => this.#reportError(error));
		this.schedule(event);
	}

	/**
	 * Coalesces snapshot requests, preserving rename priority and start-to-start throttling.
	 * @param event The native watcher event
	 */
	schedule(event: NodeTargetEvent): void {
		if (this.#signal.aborted) { return }

		this.#queued = true;
		this.#event = this.#event === NodeTargetEvent.RENAME || event === NodeTargetEvent.RENAME ? NodeTargetEvent.RENAME : event;

		if (this.#scheduled || this.#inFlight !== undefined) { return }

		const delay = Math.max(0, this.#configuration.interval - (performance.now() - this.#lastAt));
		this.#scheduled = true;

		if (delay === 0) { return queueMicrotask(() => this.#start()) }

		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#start();
		}, delay);
	}

	/**
	 * Cancels in-flight reads and dispatch and clears pending work synchronously.
	 */
	close(): void {
		this.#abortController.abort();

		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}

		this.#queued = false;
		this.#scheduled = false;
		this.#event = undefined;
	}

	/** Closes the scanner on scope exit. */
	[Symbol.dispose](): void {
		this.close();
	}

	/**
	 * Starts one queued scan and schedules at most one follow-up after it settles.
	 */
	#start(): void {
		this.#scheduled = false;

		if (!this.#queued || this.#inFlight !== undefined) { return }

		this.#queued = false;
		this.#lastAt = performance.now();
		const event = this.#event ?? NodeTargetEvent.CHANGE;
		this.#event = undefined;

		const scanPromise = this.#run(event).catch((error: unknown) => this.#reportError(error)).finally(() => {
			if (this.#inFlight !== scanPromise) { return }

			this.#inFlight = undefined;

			if (this.#queued) { this.schedule(this.#event ?? NodeTargetEvent.CHANGE) }
		});

		this.#inFlight = scanPromise;
	}

	/**
	 * Reports unexpected scan or dispatch failures while the scanner is active.
	 * @param error The failure to report
	 */
	#reportError(error: unknown): void {
		if (!this.#signal.aborted) { this.#configuration.onError(error) }
	}

	/**
	 * Reads a snapshot and admits it only while the owning manager remains active.
	 * @param event The native watcher event
	 */
	async #run(event: NodeTargetEvent): Promise<void> {
		if (this.#signal.aborted) { return }

		const targets = await this.#collectSnapshotTargets();

		// Early exit if the scan was aborted during snapshot collection
		if (this.#signal.aborted) { return }

		await this.#dispatch(event, targets);
	}

	/**
	 * Admits paths in bounded concurrent chunks, awaiting custom handlers between chunks.
	 * @param event The native watcher event
	 * @param targetPaths The paths to admit
	 */
	async #dispatch(event: NodeTargetEvent, targetPaths: Iterable<Path>) {
		const paths = Array.from(targetPaths, (targetPath): Path => targetPath);
		for (let index = 0; index < paths.length && !this.#signal.aborted; index += DirectoryScanner.#maxConcurrentDispatches) {
			const dispatches: Promise<void>[] = [];
			for (const targetPath of paths.slice(index, index + DirectoryScanner.#maxConcurrentDispatches)) {
				try {
					dispatches.push(Promise.resolve(this.#configuration.onWatcherEvent(event, targetPath)));
				} catch (error: unknown) {
					dispatches.push(Promise.reject(castError(error)));
				}
			}

			for (const result of await Promise.allSettled(dispatches)) {
				if (result.status === 'rejected') { this.#reportError(result.reason) }
			}
		}
	}

	/**
	 * Collects non-ignored tracked paths inside the watched directory.
	 * @returns Paths for immediate polling
	 */
	#collectTrackedTargets(): Path[] {
		const targets: Path[] = [];
		const { folderPath, trackedPaths, isIgnored } = this.#configuration;

		for (const targetPath of trackedPaths()) {
			if ((targetPath !== folderPath && !FileSystem.isSubPath(folderPath, targetPath)) || isIgnored(targetPath)) { continue }

			targets.push(targetPath);
		}

		return targets;
	}

	/**
	 * Collects a snapshot, swallowing transient directory read failures.
	 * @returns Paths for fallback polling
	 */
	async #collectSnapshotTargets(): Promise<Path[]> {
		const targets = new Set<Path>();
		const { folderPath, readOptions, isIgnored } = this.#configuration;

		try {
			const { directories, files } = await FileSystem.readDirectory(folderPath, readOptions);

			if (this.#signal.aborted) { return [] }

			if (!isIgnored(folderPath)) { targets.add(folderPath) }

			for (const targetPath of directories) { targets.add(targetPath) }

			for (const targetPath of files) { targets.add(targetPath) }
		} catch {
			// Swallow transient directory read failures
		}

		return [ ...targets ];
	}
}

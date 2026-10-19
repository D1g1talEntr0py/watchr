import { NodeTargetEvent } from './constants';
import type { WatcherFallback, WatcherFallbackConfiguration } from './watcher-fallback';

/** Owns bounded directory startup reconciliation and file polling on macOS. */
export class MacOSWatcherFallback implements WatcherFallback {
	#directoryStartupScanTimer: ReturnType<typeof setTimeout> | undefined;
	#fileStatPollTimer: ReturnType<typeof setInterval> | undefined;
	readonly #configuration: WatcherFallbackConfiguration;
	readonly #abortController = new AbortController();
	static readonly #directoryStartupScanDelays: readonly number[] = [ 100, 250, 500, 1000 ];

	/**
	 * Creates fallback without starting timers before the initial scan.
	 * @param configuration Fallback capabilities and cancellation lifetime
	 */
	constructor(configuration: WatcherFallbackConfiguration) {
		this.#configuration = { ...configuration, signal: AbortSignal.any([ configuration.signal, this.#abortController.signal ]) };
	}

	/** Starts file polling or bounded directory reconciliation after initial scanning. */
	start(): void {
		const { filePath, signal, persistent, notifyPath } = this.#configuration;

		if (signal.aborted || this.#directoryStartupScanTimer !== undefined || this.#fileStatPollTimer !== undefined) { return }

		if (filePath === undefined) {
			this.#scheduleDirectoryStartupScan();

			return;
		}

		this.#fileStatPollTimer = setInterval(() => {
			if (signal.aborted) { return }

			notifyPath(NodeTargetEvent.CHANGE);
		}, 100);

		if (persistent === false) { this.#fileStatPollTimer.unref() }
	}

	/**
	 * Requests a snapshot for named rename notifications, including ignored entries.
	 * @param event The native directory event
	 */
	onNamedEvent(event: NodeTargetEvent): void {
		if (!this.#configuration.signal.aborted && event === NodeTargetEvent.RENAME) { this.#configuration.requestSnapshot(event) }
	}

	/** Clears both timer kinds synchronously and idempotently. */
	close(): void {
		this.#abortController.abort();

		if (this.#directoryStartupScanTimer !== undefined) {
			clearTimeout(this.#directoryStartupScanTimer);
			this.#directoryStartupScanTimer = undefined;
		}

		if (this.#fileStatPollTimer !== undefined) {
			clearInterval(this.#fileStatPollTimer);
			this.#fileStatPollTimer = undefined;
		}
	}

	/** Closes the fallback on scope exit. */
	[Symbol.dispose](): void {
		this.close();
	}

	/**
	 * Schedules the next bounded startup reconciliation, preserving cumulative delays.
	 * @param attempt Index of the next startup delay
	 */
	#scheduleDirectoryStartupScan(attempt = 0): void {
		const delay = MacOSWatcherFallback.#directoryStartupScanDelays[attempt];

		if (delay === undefined || this.#configuration.signal.aborted) { return }

		this.#directoryStartupScanTimer = setTimeout(() => {
			this.#directoryStartupScanTimer = undefined;

			if (this.#configuration.signal.aborted) { return }

			this.#configuration.reconcileTracked(NodeTargetEvent.RENAME);
			this.#scheduleDirectoryStartupScan(attempt + 1);
		}, delay);

		if (this.#configuration.persistent === false) { this.#directoryStartupScanTimer.unref() }
	}
}

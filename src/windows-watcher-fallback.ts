import { watchFile, unwatchFile, type Stats } from 'node:fs';
import { NodeTargetEvent } from './constants';
import type { WatcherFallback, WatcherFallbackConfiguration } from './watcher-fallback';

/** Owns Windows root deletion polling and EPERM fallback. */
export class WindowsWatcherFallback implements WatcherFallback {
	#rootStatListener: ((current: Stats, previous: Stats) => void) | undefined;
	readonly #configuration: WatcherFallbackConfiguration;
	readonly #abortController = new AbortController();

	/**
	 * Creates fallback without registering polling before the initial scan.
	 * @param configuration Fallback capabilities and cancellation lifetime
	 */
	constructor(configuration: WatcherFallbackConfiguration) {
		this.#configuration = { ...configuration, signal: AbortSignal.any([ configuration.signal, this.#abortController.signal ]) };
	}

	/** Registers root-only polling after a successful initial directory scan. */
	start(): void {
		const { filePath, signal, folderPath, persistent } = this.#configuration;

		if (filePath !== undefined || signal.aborted || this.#rootStatListener !== undefined) { return }

		this.#rootStatListener = (current: Stats, _previous: Stats): void => {
			if (current.nlink !== 0 || signal.aborted) { return }

			this.#configuration.closeNativeRoot();
			this.#configuration.notifyPath(NodeTargetEvent.RENAME);
		};

		watchFile(folderPath, { interval: 100, persistent: persistent ?? true }, this.#rootStatListener);
	}

	/**
	 * Re-polls deleted or locked targets instead of reporting Windows EPERM.
	 * @param error The native watcher error
	 * @returns Whether the error was consumed
	 */
	handleError(error: NodeJS.ErrnoException): boolean {
		if (this.#configuration.signal.aborted || error.code !== 'EPERM') { return false }

		this.#configuration.notifyPath(NodeTargetEvent.RENAME);

		return true;
	}

	/** Removes only this fallback instance's exact stat listener. */
	close(): void {
		this.#abortController.abort();

		if (this.#rootStatListener !== undefined) {
			unwatchFile(this.#configuration.folderPath, this.#rootStatListener);
			this.#rootStatListener = undefined;
		}
	}

	/** Closes the fallback on scope exit. */
	[Symbol.dispose](): void {
		this.close();
	}
}

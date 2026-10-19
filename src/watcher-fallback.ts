import { MacOSWatcherFallback } from './macos-watcher-fallback';
import { WindowsWatcherFallback } from './windows-watcher-fallback';
import type { NodeTargetEvent } from './constants';
import type { Closable, Path } from './@types/index';

/** Capabilities for platform fallback, independent of native watcher attachment. */
export type WatcherFallbackConfiguration = Readonly<{
	folderPath: Path;
	filePath: Path | undefined;
	persistent: boolean | undefined;
	signal: AbortSignal;
	notifyPath: (event: NodeTargetEvent) => void;
	requestSnapshot: (event: NodeTargetEvent) => void;
	reconcileTracked: (event: NodeTargetEvent) => void;
	closeNativeRoot: () => void;
}>;

/** Fallback lifetime and optional platform-specific native notification policies. */
export interface WatcherFallback extends Closable {
	/** Starts fallback after the initial scan. */
	start(): void;
	/** Requests fallback for a named directory notification. */
	onNamedEvent?(event: NodeTargetEvent): void;
	/** Consumes a recoverable native error. */
	handleError?(error: NodeJS.ErrnoException): boolean;
}

/**
 * Selects fallback once for the current native backend.
 * @param configuration Narrow fallback capabilities
 * @returns Watcher fallback, or undefined when none is required
 */
export function createWatcherFallback(configuration: WatcherFallbackConfiguration): WatcherFallback | undefined {
	if (process.platform === 'darwin') { return new MacOSWatcherFallback(configuration) }
	if (process.platform === 'win32') { return new WindowsWatcherFallback(configuration) }
	return undefined;
}

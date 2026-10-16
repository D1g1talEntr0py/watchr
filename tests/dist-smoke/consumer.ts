/**
 * Consumer-side smoke check for the published typings: compiled by `pnpm type-check:dist` against `dist/` only,
 * without `skipLibCheck`, so a broken or leaking declaration file fails the build.
 */
import { Watchr, FileSystemEvent, WatchrStats } from '../../dist/watchr.js';
import type { Path, WatchIgnore, WatchrEventMap, WatchrOptions, WatchrHandlers, WatchrHandlerOptions, WatchrEventHandler, WatchrErrorHandler, WatchrErrorHandlerOptions, WatchrCloseHandler, WatchrCloseHandlerOptions, WatchrEvent, WatchrAddEvent, WatchrPathEvent, WatchrRenameEvent, WatchrRenameDirectoryEvent, WatchrState } from '../../dist/watchr.js';

const options: WatchrOptions = { recursive: true, statTimeout: 500, fallbackScanInterval: 50, followSymlinks: false, emitInitial: true };
const handler: WatchrEventHandler = (event) => {
	const payload: WatchrEvent = event;
	const label: FileSystemEvent = event.type;
	const size: number = event.stats.size;
	if (event.type === 'rename' || event.type === 'renameDir') {
		const rename: WatchrRenameEvent = event;
		const next: Path = rename.to;
		const initial: false = rename.initial;
		void next; void initial;
		// @ts-expect-error renames do not expose path
		void event.path;
	} else {
		const ordinary: WatchrPathEvent = event;
		const path: Path = ordinary.path;
		void path;
		// @ts-expect-error ordinary events do not expose to
		void event.to;
	}
	// @ts-expect-error event payload is readonly
	event.initial = false;
	void payload; void label; void size;
};
const ignore: WatchIgnore = [ '**/node_modules/**', /\.git\// ];
const once: WatchrHandlerOptions = { handler, once: true };
const add: WatchrEventHandler<WatchrAddEvent> = (event) => void [ event.stats.modifiedTimeNs, event.path ];
const error: WatchrErrorHandler = (error) => void error;
const errorOptions: WatchrErrorHandlerOptions = { handler: error, once: true };
const close: WatchrCloseHandler = () => undefined;
const closeOptions: WatchrCloseHandlerOptions = { handler: close, once: true };
const handlers: WatchrHandlers = {
	all: once,
	add,
	rename: (event) => void event.to,
	error: errorOptions,
	close: closeOptions
};
const watcher = new Watchr('.', { ...options, ignore, handlers });
const startup: Promise<Watchr> = watcher.start();
const started: Watchr = await startup;
const state: WatchrState = started.state;
void state;
watcher.close();
using scoped = await new Watchr('.').start();
void scoped;

const rename: WatchrRenameDirectoryEvent = { type: 'renameDir', stats: WatchrStats.synthetic(true), from: '/a', to: '/b', initial: false };
const renamePayload: WatchrEventMap['renameDir'] = rename;
void renamePayload;
void rename;
const modifiedTime: Temporal.Instant = WatchrStats.synthetic(false).modifiedTime;
void modifiedTime;

// Internals must not be part of the public contract.
// @ts-expect-error startup is explicit; the old promise getter has been removed
void watcher.readyLock;
// @ts-expect-error root attachment cannot bypass start
void watcher.watchPath;
// @ts-expect-error renameWatchr is internal
void watcher.renameWatchr;
// @ts-expect-error emitEvent is internal
void watcher.emitEvent;
// @ts-expect-error error is internal
void watcher.error;

// @ts-expect-error target is required
new Watchr();
// @ts-expect-error third argument handlers are removed
new Watchr('.', {}, handler);
// @ts-expect-error EventEmitter subscriptions are removed
void watcher.on;
// @ts-expect-error EventEmitter subscriptions are removed
void watcher.once;
// @ts-expect-error EventEmitter subscriptions are removed
void watcher.off;
// @ts-expect-error public emission is removed
void watcher.emit;
// @ts-expect-error lifecycle uses state
void watcher.isReady;
// @ts-expect-error lifecycle uses state
void watcher.isClosed;
// @ts-expect-error ignore matching is private
void watcher.isIgnored;
// @ts-expect-error watcher wiring is private
void watcher.watchersClose;
// @ts-expect-error initial delivery uses emitInitial
new Watchr('.', { ignoreInitial: false });
// @ts-expect-error encoding is not supported
new Watchr('.', { encoding: 'utf8' });
// @ts-expect-error throwIfNoEntry is not supported
new Watchr('.', { throwIfNoEntry: false });
// @ts-expect-error abortSignal is readonly
watcher.abortSignal = new AbortController().signal;
// @ts-expect-error state is readonly
watcher.state = 'idle';

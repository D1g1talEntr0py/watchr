/**
 * Consumer-side smoke check for the published typings: compiled by `pnpm type-check:dist` against `dist/` only,
 * without `skipLibCheck`, so a broken or leaking declaration file fails the build.
 */
import Watchr, { FileSystemEvent, WatcherEvent, WatchrStats } from '../../dist/watchr.js';
import type { Handler, Path, WatchIgnore, WatchrEventMap, WatchrOptions } from '../../dist/watchr.js';

const options: WatchrOptions = { recursive: true, statTimeout: 500, fallbackScanInterval: 50, followSymlinks: false, ignoreInitial: true };
const handler: Handler = (event, stats, targetPath, targetPathNext) => {
	const label: FileSystemEvent = event;
	const size: number = stats.size;
	const next: Path | undefined = targetPathNext;

	void label; void size; void next; void targetPath;
};
const ignore: WatchIgnore = [ '**/node_modules/**', /\.git\// ];
const watcher = new Watchr('.', { ...options, ignore }, handler);

watcher.on('add', (stats: WatchrStats, targetPath: Path) => void [ stats.modifiedTimeNs, targetPath ]);
watcher.on('rename', (_stats, _from, to: Path) => void to);
watcher.on(WatcherEvent.ERROR, (error: Error) => void error);
watcher.on(WatcherEvent.READY, () => watcher.close());

const renameArgs: WatchrEventMap['renameDir'] = [ WatchrStats.synthetic(true), '/a', '/b' ];
void renameArgs;
const modifiedTime: Temporal.Instant = WatchrStats.synthetic(false).modifiedTime;
void modifiedTime;

// Internals must not be part of the public contract.
// @ts-expect-error renameWatchr is internal
void watcher.renameWatchr;
// @ts-expect-error emitEvent is internal
void watcher.emitEvent;
// @ts-expect-error error is internal
void watcher.error;

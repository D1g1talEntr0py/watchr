import { describe, expectTypeOf, it } from 'vitest';
import { Watchr, type WatchrEventMap, type WatchrOptions, type Path, type FileSystemEvent, type WatchrStats } from '../src/watchr';

describe('Watchr typings', () => {
	const watcher = new Watchr();

	it('types listener parameters for add', () => {
		watcher.on('add', (...args) => {
			expectTypeOf(args).toEqualTypeOf<[ stats: WatchrStats, targetPath: Path ]>();
		});
	});

	it('types listener parameters for rename', () => {
		watcher.on('rename', (...args) => {
			expectTypeOf(args).toEqualTypeOf<[ stats: WatchrStats, targetPath: Path, targetPathNext: Path ]>();
		});
	});

	it('types listener parameters for all', () => {
		watcher.on('all', (...args) => {
			expectTypeOf(args).toEqualTypeOf<[ event: FileSystemEvent, stats: WatchrStats, targetPath: Path, targetPathNext?: Path ]>();
		});
	});

	it('types listener parameters for error', () => {
		watcher.on('error', (...args) => {
			expectTypeOf(args).toEqualTypeOf<[ error: Error ]>();
		});
	});

	it('exposes watchersClose in the public API', () => {
		expectTypeOf(watcher.watchersClose).toEqualTypeOf<(folderPath?: Path, filePath?: Path) => void>();
	});

	it('still accepts untyped event names', () => {
		watcher.on('custom', (...args) => {
			expectTypeOf(args).toEqualTypeOf<any[]>();
		});
	});

	it('exposes the event map', () => {
		expectTypeOf<WatchrEventMap['unlinkDir']>().toEqualTypeOf<[ stats: WatchrStats, targetPath: Path ]>();
		expectTypeOf<WatchrEventMap['ready']>().toEqualTypeOf<[]>();
	});

	it('accepts the new options', () => {
		expectTypeOf<WatchrOptions>().toHaveProperty('statTimeout').toEqualTypeOf<number | undefined>();
		expectTypeOf<WatchrOptions>().toHaveProperty('fallbackScanInterval').toEqualTypeOf<number | undefined>();
		expectTypeOf<WatchrOptions>().toHaveProperty('recursive').toEqualTypeOf<boolean | undefined>();
		expectTypeOf<WatchrOptions>().toHaveProperty('followSymlinks').toEqualTypeOf<boolean | undefined>();
	});

	it('exposes Temporal and nanosecond timestamps on WatchrStats', () => {
		expectTypeOf<WatchrStats['modifiedTime']>().toEqualTypeOf<Temporal.Instant>();
		expectTypeOf<WatchrStats['modifiedTimeNs']>().toEqualTypeOf<bigint>();
	});
});

import { describe, expectTypeOf, it } from 'vitest';
import { Watchr, type WatchrEventMap, type WatchrOptions, type WatchrHandlers, type WatchrHandlerOptions, type WatchrEventHandler, type WatchrEvent, type WatchrPathEvent, type WatchrRenameEvent, type WatchrState, type WatchIgnore, type Path, type WatchrStats } from '../src/watchr';
import type { WatchrAddEvent, WatchrAddDirEvent, WatchrChangeEvent, WatchrUnlinkEvent, WatchrUnlinkDirEvent, WatchrRenameFileEvent, WatchrRenameDirectoryEvent } from '../src/watchr';

describe('Watchr typings', () => {
	const watcher = new Watchr('.');

	it('returns the watcher from startup and supports resource management', async () => {
		expectTypeOf(watcher.start).toEqualTypeOf<() => Promise<Watchr>>();
		expectTypeOf(watcher.state).toEqualTypeOf<WatchrState>();
		expectTypeOf(watcher.abortSignal).toEqualTypeOf<AbortSignal>();
		expectTypeOf<Watchr>().toExtend<Disposable>();
		using scoped = new Watchr('.');
		expectTypeOf(await scoped.start()).toEqualTypeOf<Watchr>();
		expectTypeOf(await new Watchr('.').start()).toEqualTypeOf<Watchr>();
	});

	it('types standalone handlers and their options', () => {
		const add: WatchrEventHandler<'add'> = (event) => {
			expectTypeOf(event).toEqualTypeOf<WatchrEventMap['add']>();
			expectTypeOf(event.type).toEqualTypeOf<'add'>();
			expectTypeOf(event.path).toEqualTypeOf<Path>();
			expectTypeOf(event.stats).toEqualTypeOf<WatchrStats>();
			expectTypeOf(event.initial).toEqualTypeOf<boolean>();
			// @ts-expect-error payloads are readonly
			event.path = 'changed';
			// @ts-expect-error ordinary events have no rename destination
			void event.to;
		};
		const once: WatchrHandlerOptions<'add'> = { handler: add, once: true };
		const handlers: WatchrHandlers = {
			add: once,
			rename: async (event) => {
				expectTypeOf(event.from).toEqualTypeOf<Path>();
				expectTypeOf(event.to).toEqualTypeOf<Path>();
				expectTypeOf(event.initial).toEqualTypeOf<false>();
				// @ts-expect-error rename events do not have an ambiguous path
				void event.path;
				// @ts-expect-error rename source is readonly
				event.from = 'changed';
			},
			error: (error) => { expectTypeOf(error).toEqualTypeOf<Error>() },
			close: (...args) => { expectTypeOf(args).toEqualTypeOf<[]>() }
		};
		expectTypeOf<WatchrEventMap['error']>().toEqualTypeOf<Error>();
		expectTypeOf<Parameters<WatchrEventHandler<'close'>>>().toEqualTypeOf<[]>();
		new Watchr('.', { handlers }).close();
	});

	it('narrows the all channel by its discriminant', () => {
		const all: WatchrEventHandler<'all'> = (event) => {
			expectTypeOf(event).toEqualTypeOf<WatchrEvent>();
			if (event.type === 'rename' || event.type === 'renameDir') {
				expectTypeOf(event).toEqualTypeOf<WatchrRenameEvent>();
				expectTypeOf(event.initial).toEqualTypeOf<false>();
				// @ts-expect-error renames have from and to rather than path
				void event.path;
			} else {
				expectTypeOf(event).toEqualTypeOf<WatchrPathEvent>();
				expectTypeOf(event.path).toEqualTypeOf<Path>();
				// @ts-expect-error ordinary events have no source
				void event.from;
			}
			// @ts-expect-error the discriminant is readonly
			event.type = 'add';
			// @ts-expect-error stats reference is readonly
			event.stats = {} as WatchrStats;
			// @ts-expect-error initial is readonly
			event.initial = false;
		};
		new Watchr('.', { handlers: { all } }).close();
	});

	it('accepts current options and full-path ignore callbacks', () => {
		const ignore: WatchIgnore = [ '*.log', /ignored/, (path) => path.endsWith('/secret') ];
		const options: WatchrOptions = { emitInitial: true, recursive: false, followSymlinks: false, statTimeout: 500, fallbackScanInterval: 50, ignore };
		new Watchr([ '.', './tests' ], options).close();
		expectTypeOf<WatchrOptions>().toHaveProperty('emitInitial').toEqualTypeOf<boolean | undefined>();
		expectTypeOf<WatchrStats['modifiedTime']>().toEqualTypeOf<Temporal.Instant>();
		expectTypeOf<WatchrStats['modifiedTimeNs']>().toEqualTypeOf<bigint>();
	});

	it('exports named payload types matching the handler map', () => {
		expectTypeOf<WatchrEventMap['add']>().toEqualTypeOf<WatchrAddEvent>();
		expectTypeOf<WatchrEventMap['addDir']>().toEqualTypeOf<WatchrAddDirEvent>();
		expectTypeOf<WatchrEventMap['change']>().toEqualTypeOf<WatchrChangeEvent>();
		expectTypeOf<WatchrEventMap['unlink']>().toEqualTypeOf<WatchrUnlinkEvent>();
		expectTypeOf<WatchrEventMap['unlinkDir']>().toEqualTypeOf<WatchrUnlinkDirEvent>();
		expectTypeOf<WatchrEventMap['rename']>().toEqualTypeOf<WatchrRenameFileEvent>();
		expectTypeOf<WatchrEventMap['renameDir']>().toEqualTypeOf<WatchrRenameDirectoryEvent>();
	});

	it('rejects removed APIs, options, and legacy positional handlers', () => {
		// @ts-expect-error target is required
		new Watchr();
		// @ts-expect-error third-argument handlers are removed
		new Watchr('.', {}, () => undefined);
		// @ts-expect-error initial event delivery uses emitInitial
		new Watchr('.', { ignoreInitial: true });
		// @ts-expect-error encoding is not a watcher option
		new Watchr('.', { encoding: 'utf8' });
		// @ts-expect-error missing entries always reject startup
		new Watchr('.', { throwIfNoEntry: false });
		// @ts-expect-error event handlers receive one payload
		new Watchr('.', { handlers: { add: (_stats: WatchrStats, _path: Path) => undefined } });
		// @ts-expect-error custom handler channels are not supported
		new Watchr('.', { handlers: { custom: () => undefined } });
		// @ts-expect-error startup completion is represented by the start promise
		new Watchr('.', { handlers: { ready: () => undefined } });
		// @ts-expect-error state is readonly
		watcher.state = 'closed';
		// @ts-expect-error abortSignal is readonly
		watcher.abortSignal = new AbortController().signal;
		expectTypeOf<Watchr>().not.toHaveProperty('on');
		expectTypeOf<Watchr>().not.toHaveProperty('once');
		expectTypeOf<Watchr>().not.toHaveProperty('off');
		expectTypeOf<Watchr>().not.toHaveProperty('emit');
		expectTypeOf<Watchr>().not.toHaveProperty('isReady');
		expectTypeOf<Watchr>().not.toHaveProperty('isClosed');
		expectTypeOf<Watchr>().not.toHaveProperty('isIgnored');
		expectTypeOf<Watchr>().not.toHaveProperty('watchersClose');
		expectTypeOf<Watchr>().not.toHaveProperty('readyLock');
		expectTypeOf<Watchr>().not.toHaveProperty('watchPath');
	});
});

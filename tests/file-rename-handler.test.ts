import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileRenameHandler } from '../src/file-rename-handler';
import { LockResolver } from '../src/lock-resolver';
import { FileSystemEvent, renameTimeout, statTimeout } from '../src/constants';
import type { Event, Path } from '../src/@types/index';
import { WatchrStats } from '../src/watchr-stats';
import { cleanupTempRoots, createTempRoot } from './helpers/fs-fixtures';

type Emitted = [ event: FileSystemEvent, path: Path, next?: Path ];

describe('FileRenameHandler', () => {
	const handlers: FileRenameHandler[] = [];

	beforeEach(() => {
		vi.useFakeTimers({ toFake: [ 'setTimeout', 'clearTimeout', 'performance' ] });
	});

	afterEach(() => {
		for (const handler of handlers.splice(0)) { handler.close() }
		vi.useRealTimers();
		cleanupTempRoots();
	});

	/**
	 * Creates a handler that records emitted events.
	 * @param maxResolvers - Optional capacity limit for delayed event settlement.
	 * @returns The handler and its recorded events.
	 */
	function createHandler(maxResolvers?: number) {
		const emitted: Emitted[] = [];
		const emittedStats: WatchrStats[] = [];
		const errors: unknown[] = [];
		const resolver = new LockResolver({ onError: () => undefined, ...(maxResolvers === undefined ? {} : { maxResolvers }) });
		const handler = new FileRenameHandler(
			(event, path, stats, next) => { emitted.push(next === undefined ? [ event, path ] : [ event, path, next ]); emittedStats.push(stats) },
			(error) => { errors.push(error); return true },
			resolver
		);
		handlers.push(handler);

		return { handler, emitted, emittedStats, errors, resolver };
	}

	it('disposes its pending resolver work on scope exit', () => {
		const callback = vi.fn();
		const { handler, resolver } = createHandler();
		{
			using scopedHandler = handler;
			resolver.add(callback, 50);
			expect(scopedHandler).toBe(handler);
			expect(vi.getTimerCount()).toBe(1);
		}
		handler.close();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(100);
		expect(callback).not.toHaveBeenCalled();
	});

	it.each([ [ false, false ], [ true, false ], [ false, true ], [ true, true ] ])('correlates a completed batch (destination first=%s, directory=%s)', (destinationFirst, directory) => {
		const { handler, emitted } = createHandler();
		const root = createTempRoot();
		const from = join(root, 'from');
		const to = join(root, 'to');
		if (directory) { mkdirSync(from) }
		else { writeFileSync(from, 'contents') }
		const stats = WatchrStats.fromStats(statSync(from, { bigint: true }));
		const events: Event[] = [[ directory ? FileSystemEvent.UNLINK_DIR : FileSystemEvent.UNLINK, from, stats ], [ directory ? FileSystemEvent.ADD_DIR : FileSystemEvent.ADD, to, stats ]];
		if (destinationFirst) { events.reverse() }
		const lock = vi.spyOn(handler, 'getLockTargetEvent');
		handler.handleBatch(events);
		expect(emitted).toEqual([[ directory ? FileSystemEvent.RENAME_DIR : FileSystemEvent.RENAME, from, to ]]);
		expect(lock).not.toHaveBeenCalled();
	});

	it.each([ 'kind', 'zero', 'missing', 'same-path', 'many-adds', 'many-unlinks', 'many-both', 'tracked-link', 'changed-target', 'replacement' ])('preserves all plain events for unsafe batch identity: %s', (scenario) => {
		const { handler, emitted, resolver } = createHandler();
		const root = createTempRoot();
		const from = join(root, 'from');
		const to = join(root, 'to');
		writeFileSync(from, 'contents');
		const stats = WatchrStats.fromStats(statSync(from, { bigint: true }));
		const events: Event[] = [[ FileSystemEvent.UNLINK, from, stats ], [ FileSystemEvent.ADD, to, stats ]];
		if (scenario === 'kind') { events[1]![0] = FileSystemEvent.ADD_DIR }
		if (scenario === 'zero') { vi.spyOn(stats, 'inodeNumber', 'get').mockReturnValue(0) }
		if (scenario === 'missing') { vi.spyOn(stats, 'inodeNumber', 'get').mockReturnValue(undefined as never) }
		if (scenario === 'same-path') { events[1]![1] = from }
		if (scenario === 'many-adds') { events.push([ FileSystemEvent.ADD, join(root, 'third'), stats ]) }
		if (scenario === 'many-unlinks') { events.push([ FileSystemEvent.UNLINK, join(root, 'third'), stats ]) }
		if (scenario === 'many-both') { events.push([ FileSystemEvent.UNLINK, join(root, 'third'), stats ], [ FileSystemEvent.ADD, join(root, 'fourth'), stats ]) }
		if (scenario === 'tracked-link') { handler.fileStateManager.paths.set(stats.inodeNumber, join(root, 'third')) }
		if (scenario === 'changed-target') { events.push([ FileSystemEvent.CHANGE, to, stats ]) }
		if (scenario === 'replacement') { events.push([ FileSystemEvent.ADD_DIR, from, stats ]) }
		const lock = vi.spyOn(handler, 'getLockTargetEvent');
		const timer = vi.spyOn(resolver, 'add');
		handler.handleBatch(events);
		expect(emitted).toEqual(events.map(([ type, path ]) => [ type, path ]));
		expect(lock).not.toHaveBeenCalled();
		expect(timer).not.toHaveBeenCalled();
	});

	it('uses destination stats, preserves independent changes and honors cancellation', () => {
		const { handler, emitted, emittedStats, resolver } = createHandler();
		const root = createTempRoot();
		const from = join(root, 'from');
		const to = join(root, 'to');
		writeFileSync(from, 'old');
		const previous = WatchrStats.fromStats(statSync(from, { bigint: true }));
		writeFileSync(from, 'new contents');
		const next = WatchrStats.fromStats(statSync(from, { bigint: true }));
		const events: Event[] = [[ FileSystemEvent.ADD, to, next ], [ FileSystemEvent.CHANGE, join(root, 'other'), next ], [ FileSystemEvent.UNLINK, from, previous ]];
		const timer = vi.spyOn(resolver, 'add');
		handler.handleBatch(events);
		expect(emitted).toEqual([[ FileSystemEvent.RENAME, from, to ], [ FileSystemEvent.CHANGE, join(root, 'other') ]]);
		expect(emittedStats).toEqual([ next, next ]);
		expect(timer).not.toHaveBeenCalled();
		emitted.length = 0;
		handler.handleBatch(events, 0, () => false);
		expect(emitted).toEqual([]);
	});

	it('stops the completed batch when an emitted callback resets the handler', () => {
		const emitted: FileSystemEvent[] = [];
		const handler = new FileRenameHandler((event) => { emitted.push(event); handler.reset() }, () => true, new LockResolver({ onError: () => undefined }));
		handlers.push(handler);
		const stats = WatchrStats.synthetic(false);
		handler.handleBatch([[ FileSystemEvent.ADD, '/batch/first', stats ], [ FileSystemEvent.ADD, '/batch/second', stats ]]);
		expect(emitted).toEqual([ FileSystemEvent.ADD ]);
	});

	it('defaults to no timed hold and never correlates separate zero-timeout batches', () => {
		const { handler, emitted, resolver } = createHandler();
		const stats = WatchrStats.synthetic(false);
		vi.spyOn(stats, 'inodeNumber', 'get').mockReturnValue(123);
		const timer = vi.spyOn(resolver, 'add');
		expect(renameTimeout).toBe(0);
		expect(statTimeout).toBe(1000);
		handler.handleBatch([[ FileSystemEvent.UNLINK, '/batch/from', stats ]]);
		handler.handleBatch([[ FileSystemEvent.ADD, '/batch/to', stats ]]);
		expect(emitted).toEqual([[ FileSystemEvent.UNLINK, '/batch/from' ], [ FileSystemEvent.ADD, '/batch/to' ]]);
		expect(timer).not.toHaveBeenCalled();
	});

	it('classifies more than the inode-history capacity directly from payload stats', () => {
		const { handler, emitted } = createHandler();
		const stats = WatchrStats.synthetic(false);
		vi.spyOn(stats, 'inodeNumber', 'get').mockReturnValue(123);
		const events: Event[] = Array.from({ length: 50001 }, (_, index) => [ FileSystemEvent.CHANGE, `/batch/other-${index}`, stats ]);
		events.unshift([ FileSystemEvent.UNLINK, '/batch/from', stats ]);
		events.push([ FileSystemEvent.ADD, '/batch/to', stats ]);
		vi.spyOn(handler.fileStateManager, 'getInodeNumber').mockImplementation(() => { throw new Error('history must not be consulted') });
		handler.handleBatch(events);
		expect(emitted).toHaveLength(50002);
		expect(emitted[0]).toEqual([ FileSystemEvent.RENAME, '/batch/from', '/batch/to' ]);
	});

	/**
	 * Polls a path and feeds every derived event to the handler, like one event-manager batch.
	 * @param handler - The handler under test.
	 * @param paths - Paths polled in the batch, all stat'd before any lock event is processed.
	 * @param timeout - The rename timeout.
	 */
	async function batch(handler: FileRenameHandler, paths: Path[], timeout: number) {
		const events = [];
		handler.fileStateManager.configureRenameTimeout(timeout);

		for (const path of paths) {
			for (const { type, stats } of await handler.fileStateManager.update(path)) { events.push({ type, path, stats }) }
		}

		for (const { type, path, stats } of events) { handler.getLockTargetEvent(type, path, stats, timeout, new Set()) }
	}

	it('emits add immediately for an inode no tracked path gave up', async () => {
		const { handler, emitted } = createHandler();
		const file = join(createTempRoot('watchr-rename-handler-'), 'new.txt');
		writeFileSync(file, 'x');

		await batch(handler, [ file ], 25);

		expect(emitted).toEqual([[ FileSystemEvent.ADD, file ]]);
	});

	it('holds an add whose inode was just vacated and pairs it with the unlink as a rename', async () => {
		const { handler, emitted } = createHandler();
		const root = createTempRoot('watchr-rename-handler-');
		const from = join(root, 'a.txt');
		const to = join(root, 'b.txt');
		writeFileSync(from, 'x');
		await batch(handler, [ from ], 25);
		emitted.length = 0;

		renameSync(from, to);
		// Destination first: the add is processed before the unlink that pairs with it.
		await batch(handler, [ to, from ], 25);

		expect(emitted).toEqual([[ FileSystemEvent.RENAME, from, to ]]);
	});

	it('does not let a rename target\'s own add swallow its later unlink', async () => {
		const { handler, emitted } = createHandler();
		const root = createTempRoot('watchr-rename-handler-');
		const from = join(root, 'a.txt');
		const to = join(root, 'b.txt');
		writeFileSync(from, 'x');
		await batch(handler, [ from ], 25);
		emitted.length = 0;

		renameSync(from, to);
		// Source first: the unlink resolves as a rename via the tracked sibling before the destination's add is seen.
		await batch(handler, [ from, to ], 25);
		rmSync(to);
		await batch(handler, [ to ], 25);
		await vi.advanceTimersByTimeAsync(25);

		expect(emitted).toEqual([[ FileSystemEvent.RENAME, from, to ], [ FileSystemEvent.UNLINK, to ]]);
	});

	it('does not emit a rename twice when destination and source polls arrive separately', async () => {
		const { handler, emitted } = createHandler();
		const root = createTempRoot('watchr-rename-handler-');
		const from = join(root, 'a.txt');
		const to = join(root, 'b.txt');
		writeFileSync(from, 'x');
		await batch(handler, [ from ], 25);
		emitted.length = 0;

		renameSync(from, to);
		await batch(handler, [ to ], 25);
		await Promise.resolve();
		await batch(handler, [ from ], 25);

		expect(emitted).toEqual([[ FileSystemEvent.RENAME, from, to ]]);
	});

	it('emits add for a deleted rename destination recreated with the same inode', async () => {
		const { handler, emitted } = createHandler();
		const root = createTempRoot('watchr-rename-recreated-');
		const from = join(root, 'source.txt');
		const to = join(root, 'target.txt');
		const saved = join(createTempRoot('watchr-rename-saved-'), 'saved.txt');
		writeFileSync(from, 'original');
		linkSync(from, saved);
		await batch(handler, [ from ], 25);
		emitted.length = 0;
		renameSync(from, to);
		await batch(handler, [ to ], 25);
		await handler.fileStateManager.update(from);
		rmSync(to);
		await batch(handler, [ to ], 25);
		await vi.advanceTimersByTimeAsync(26);
		linkSync(saved, to);
		await batch(handler, [ to ], 25);

		expect(emitted).toEqual([
			[ FileSystemEvent.RENAME, from, to ],
			[ FileSystemEvent.UNLINK, to ],
			[ FileSystemEvent.ADD, to ]
		]);
	});

	it('emits addDir immediately for a new directory', async () => {
		const { handler, emitted } = createHandler();
		const dir = join(createTempRoot('watchr-rename-handler-'), 'dir');
		mkdirSync(dir);

		await batch(handler, [ dir ], 25);

		expect(emitted).toEqual([[ FileSystemEvent.ADD_DIR, dir ]]);
	});

	it('settles an evicted unlink and reports capacity pressure without dropping the removal', async () => {
		const { handler, emitted, errors } = createHandler(1);
		const root = createTempRoot('watchr-rename-capacity-');
		const first = join(root, 'first.txt');
		const second = join(root, 'second.txt');
		writeFileSync(first, 'first');
		writeFileSync(second, 'second');
		await batch(handler, [ first, second ], 25);
		emitted.length = 0;
		rmSync(first);
		rmSync(second);
		await batch(handler, [ first, second ], 25);

		expect(emitted).toEqual([[ FileSystemEvent.UNLINK, first ]]);
		expect(errors).toEqual([ expect.objectContaining({ message: 'Lock resolver capacity exceeded.' }) ]);
	});

	it('settles an evicted pending add and reports capacity pressure without dropping the addition', async () => {
		const { handler, emitted, errors } = createHandler(1);
		const root = createTempRoot('watchr-rename-capacity-');
		const first = join(root, 'first.txt');
		const second = join(root, 'second.txt');
		const firstTarget = join(root, 'first-target.txt');
		const secondTarget = join(root, 'second-target.txt');
		writeFileSync(first, 'first');
		writeFileSync(second, 'second');
		await batch(handler, [ first, second ], 25);
		emitted.length = 0;
		renameSync(first, firstTarget);
		renameSync(second, secondTarget);
		writeFileSync(first, 'replacement first');
		writeFileSync(second, 'replacement second');
		await batch(handler, [ first, second, firstTarget, secondTarget ], 25);

		expect(emitted).toEqual([[ FileSystemEvent.ADD, firstTarget ]]);
		expect(errors).toEqual([ expect.objectContaining({ message: 'Lock resolver capacity exceeded.' }) ]);
	});
});

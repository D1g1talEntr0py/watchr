import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileSystemEvent } from '../../src/watchr';
import { observeEvent, cleanupTempRoots, closeWatchers, collectEvents, createReadyWatcher, createTempRoot, delay, waitForEvent } from '../helpers/fs-fixtures';

describe('regression B3: watched root removed and recreated', () => {
	afterEach(() => {
		closeWatchers();
		cleanupTempRoots();
	});

	// Non-recursive uses libuv inotify directly (root self-events arrive as basename(root));
	// recursive uses Node's JS recursive watcher (root self-events arrive as an empty name).
	it.each([ false, true ])('should emit unlinkDir, then addDir on recreate, then add for a new file (recursive: %s)', async (recursive) => {
		const root = createTempRoot('watchr-root-lifecycle-');
		const watcher = await createReadyWatcher(root, { emitInitial: false, recursive });

		const unlinkDir = waitForEvent(watcher, FileSystemEvent.UNLINK_DIR, { path: root, timeoutMs: 2000 });
		rmSync(root, { recursive: true });
		await expect(unlinkDir).resolves.toBe(root);
		expect(watcher.state).not.toBe('closed');

		const addDir = waitForEvent(watcher, FileSystemEvent.ADD_DIR, { path: root, timeoutMs: 3000 });
		mkdirSync(root);
		await expect(addDir).resolves.toBe(root);
		expect(watcher.state).not.toBe('closed');

		const after = join(root, 'after.txt');
		const add = waitForEvent(watcher, FileSystemEvent.ADD, { path: after, timeoutMs: 2000 });
		writeFileSync(after, 'x');
		await expect(add).resolves.toBe(after);
		expect(watcher.state).not.toBe('closed');
	});

	it.each([ 'delete', 'move' ])('delivers a populated root %s and restores every path once with native notifications', async (operation) => {
		const parent = createTempRoot('watchr-populated-root-');
		const root = join(parent, 'root');
		const replacement = join(parent, 'replacement');
		for (const directory of [ root, replacement ]) {
			mkdirSync(join(directory, 'nested'), { recursive: true });
			writeFileSync(join(directory, 'direct.txt'), 'direct');
			writeFileSync(join(directory, 'nested', 'leaf.txt'), 'leaf');
		}
		const watcher = await createReadyWatcher(root);
		const { events } = collectEvents(watcher);
		const errors: Error[] = [];
		observeEvent(watcher, 'error', (error) => errors.push(error));
		const paths = [ root, join(root, 'nested'), join(root, 'direct.txt'), join(root, 'nested', 'leaf.txt') ];
		if (operation === 'move') { renameSync(root, join(parent, 'moved')) }
		else { rmSync(root, { recursive: true }) }
		await vi.waitFor(() => expect(events).toHaveLength(paths.length));
		expect(events.map(({ path }) => path).sort()).toEqual([ ...paths ].sort());
		expect(events.every(({ event }) => event === FileSystemEvent.UNLINK || event === FileSystemEvent.UNLINK_DIR)).toBe(true);
		events.length = 0;
		renameSync(replacement, root);
		await vi.waitFor(() => expect(events).toHaveLength(paths.length), { timeout: 3000 });
		expect(events.map(({ path }) => path).sort()).toEqual([ ...paths ].sort());
		expect(events.every(({ event }) => event === FileSystemEvent.ADD || event === FileSystemEvent.ADD_DIR)).toBe(true);
		events.length = 0;
		const file = join(root, 'nested', 'leaf.txt');
		const change = waitForEvent(watcher, FileSystemEvent.CHANGE, { path: file });
		writeFileSync(file, 'changed after restoration');
		await change;
		expect(events).toHaveLength(1);
		expect(errors).toEqual([]);
	});

	it.each([
		[ 'parent-first', 'move' ],
		[ 'child-first', 'move' ],
		[ 'parent-first', 'delete' ],
		[ 'child-first', 'delete' ]
	] as const)('restores overlapping nonrecursive roots with native notifications (targets=%s, operation=%s)', async (targetOrder, operation) => {
		const outside = createTempRoot('watchr-overlapping-roots-');
		const parent = join(outside, 'parent');
		const child = join(parent, 'child');
		const leaf = join(child, 'leaf.txt');
		const replacement = join(outside, 'replacement');
		for (const directory of [ parent, replacement ]) {
			mkdirSync(join(directory, 'child'), { recursive: true });
			writeFileSync(join(directory, 'child', 'leaf.txt'), 'leaf');
		}
		const watcher = await createReadyWatcher(targetOrder === 'parent-first' ? [ parent, child ] : [ child, parent ], { recursive: false });
		const { events } = collectEvents(watcher);
		const errors: Error[] = [];
		observeEvent(watcher, 'error', (error) => errors.push(error));
		if (operation === 'move') { renameSync(parent, join(outside, 'moved')) }
		else { rmSync(parent, { recursive: true }) }
		await vi.waitFor(() => expect(events).toHaveLength(3));
		expect(events.map(({ event, path }) => [ event, path ]).sort()).toEqual([
			[ FileSystemEvent.UNLINK_DIR, parent ], [ FileSystemEvent.UNLINK_DIR, child ], [ FileSystemEvent.UNLINK, leaf ]
		].sort());
		events.length = 0;
		renameSync(replacement, parent);
		await vi.waitFor(() => expect(events).toHaveLength(3), { timeout: 3000 });
		expect(events.map(({ event, path }) => [ event, path ]).sort()).toEqual([
			[ FileSystemEvent.ADD_DIR, parent ], [ FileSystemEvent.ADD_DIR, child ], [ FileSystemEvent.ADD, leaf ]
		].sort());
		events.length = 0;
		const change = waitForEvent(watcher, FileSystemEvent.CHANGE, { path: leaf });
		writeFileSync(leaf, 'after recovery');
		await change;
		expect(events).toHaveLength(1);
		expect(watcher.state).toBe('watching');
		expect(watcher.abortSignal.aborted).toBe(false);
		expect(errors).toEqual([]);
	});

	it('does not restore a deleted root after close', async () => {
		const root = createTempRoot('watchr-root-close-');
		const watcher = await createReadyWatcher(root, { emitInitial: false, recursive: false });
		const unlink = waitForEvent(watcher, FileSystemEvent.UNLINK_DIR, { path: root });
		rmSync(root, { recursive: true });
		await unlink;
		const events: FileSystemEvent[] = [];
		observeEvent(watcher, 'all', (event) => events.push(event));
		watcher.close();
		mkdirSync(root);
		await delay(350);

		expect(watcher.state).toBe('closed');
		expect(events).toEqual([]);
	});
});

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileSystemEvent } from '../../src/watchr';
import { cleanupTempRoots, closeWatchers, collectEvents, createReadyWatcher, createTempRoot, delay, waitForEvent } from '../helpers/fs-fixtures';

// A long renameTimeout makes any hold on brand-new files obvious.
const renameTimeout = 2_000;

describe('add latency for brand-new inodes', () => {
	afterEach(() => {
		closeWatchers();
		cleanupTempRoots();
	});

	it('emits add for a new file without waiting for renameTimeout', async () => {
		const root = createTempRoot('watchr-add-latency-');
		const watcher = await createReadyWatcher(root, { ignoreInitial: true, renameTimeout });
		const path = join(root, 'new.txt');
		const added = waitForEvent(watcher, FileSystemEvent.ADD, { path, timeoutMs: renameTimeout / 2 });

		writeFileSync(path, 'x');

		await expect(added).resolves.toBe(path);
	});

	it('emits addDir for a new directory without waiting for renameTimeout', async () => {
		const root = createTempRoot('watchr-add-latency-');
		const watcher = await createReadyWatcher(root, { ignoreInitial: true, renameTimeout });
		const path = join(root, 'dir');
		const added = waitForEvent(watcher, FileSystemEvent.ADD_DIR, { path, timeoutMs: renameTimeout / 2 });

		mkdirSync(path);

		await expect(added).resolves.toBe(path);
	});

	it('still correlates a rename of a tracked file into a single rename event', async () => {
		const root = createTempRoot('watchr-add-latency-');
		const from = join(root, 'a.txt');
		const to = join(root, 'b.txt');
		writeFileSync(from, 'x');
		const watcher = await createReadyWatcher(root, { ignoreInitial: true, renameTimeout });
		const { events, dispose } = collectEvents(watcher);
		const renamed = waitForEvent(watcher, FileSystemEvent.RENAME, { path: from, timeoutMs: renameTimeout * 2 });

		renameSync(from, to);
		await renamed;
		await delay(50);
		dispose();

		expect(events.map(({ event, path, pathNext }) => [ event, path, pathNext ])).toEqual([[ FileSystemEvent.RENAME, from, to ]]);
	});

	it('reports a short-lived file as add followed by unlink', async () => {
		const root = createTempRoot('watchr-add-latency-');
		const watcher = await createReadyWatcher(root, { ignoreInitial: true, renameTimeout: 150 });
		const { events, dispose } = collectEvents(watcher);
		const path = join(root, 'temp.txt');
		const added = waitForEvent(watcher, FileSystemEvent.ADD, { path });

		writeFileSync(path, 'x');
		await added;
		const removed = waitForEvent(watcher, FileSystemEvent.UNLINK, { path });
		rmSync(path);
		await removed;
		dispose();

		expect(events.map(({ event }) => event)).toEqual([ FileSystemEvent.ADD, FileSystemEvent.UNLINK ]);
	});
});

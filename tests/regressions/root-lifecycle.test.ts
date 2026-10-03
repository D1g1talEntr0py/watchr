import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileSystemEvent } from '../../src/watchr';
import { cleanupTempRoots, closeWatchers, createReadyWatcher, createTempRoot, delay, waitForEvent } from '../helpers/fs-fixtures';

describe('regression B3: watched root removed and recreated', () => {
	afterEach(() => {
		closeWatchers();
		cleanupTempRoots();
	});

	// Non-recursive uses libuv inotify directly (root self-events arrive as basename(root));
	// recursive uses Node's JS recursive watcher (root self-events arrive as an empty name).
	it.each([ false, true ])('should emit unlinkDir, then addDir on recreate, then add for a new file (recursive: %s)', async (recursive) => {
		const root = createTempRoot('watchr-root-lifecycle-');
		const watcher = await createReadyWatcher(root, { ignoreInitial: true, recursive });

		const unlinkDir = waitForEvent(watcher, FileSystemEvent.UNLINK_DIR, { path: root, timeoutMs: 2000 });
		rmSync(root, { recursive: true });
		await expect(unlinkDir).resolves.toBe(root);
		expect(watcher.isClosed()).toBe(false);

		const addDir = waitForEvent(watcher, FileSystemEvent.ADD_DIR, { path: root, timeoutMs: 3000 });
		mkdirSync(root);
		await expect(addDir).resolves.toBe(root);
		expect(watcher.isClosed()).toBe(false);

		const after = join(root, 'after.txt');
		const add = waitForEvent(watcher, FileSystemEvent.ADD, { path: after, timeoutMs: 2000 });
		writeFileSync(after, 'x');
		await expect(add).resolves.toBe(after);
		expect(watcher.isClosed()).toBe(false);
	});

	it('does not restore a deleted root after close', async () => {
		const root = createTempRoot('watchr-root-close-');
		const watcher = await createReadyWatcher(root, { ignoreInitial: true, recursive: false });
		const unlink = waitForEvent(watcher, FileSystemEvent.UNLINK_DIR, { path: root });
		rmSync(root, { recursive: true });
		await unlink;
		const events: FileSystemEvent[] = [];
		watcher.on('all', (event) => events.push(event));
		watcher.close();
		mkdirSync(root);
		await delay(350);

		expect(watcher.isClosed()).toBe(true);
		expect(events).toEqual([]);
	});
});

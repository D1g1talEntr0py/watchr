import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Watchr, WatcherEvent, FileSystemEvent } from '../../src/watchr';
import { cleanupTempRoots, createTempRoot, waitForEvent } from '../helpers/fs-fixtures';

describe('regression B1: large tree initial scan', { timeout: 30_000 }, () => {
	afterEach(() => {
		cleanupTempRoots();
	});

	it('should become ready for 10k flat + 2k nested files without emitting error', async () => {
		const root = createTempRoot('watchr-large-tree-');

		for (let i = 0; i < 10_000; i++) {
			writeFileSync(join(root, `f${i}.txt`), '');
		}

		const nested = join(root, 'l1', 'l2', 'l3');
		mkdirSync(nested, { recursive: true });

		for (let i = 0; i < 2_000; i++) {
			writeFileSync(join(nested, `n${i}.txt`), '');
		}

		const watcher = new Watchr(root, { ignoreInitial: true, recursive: true });
		const errors: Error[] = [];
		watcher.on(WatcherEvent.ERROR, (error: Error) => errors.push(error));

		try {
			const timeout = new Promise<never>((_resolve, reject) => {
				setTimeout(() => reject(new Error('readyLock did not resolve within 15s')), 15_000).unref();
			});

			await Promise.race([ watcher.readyLock, timeout ]);

			expect(errors, errors.map((error) => error.message).join('\n')).toEqual([]);
			expect(watcher.isClosed()).toBe(false);
		} finally {
			watcher.close();
		}
	});

	it('should admit concurrent initial scans across separate watchers', async () => {
		const roots = Array.from({ length: 5 }, () => createTempRoot('watchr-concurrent-scan-'));
		for (const root of roots) {
			for (let index = 0; index < 1_000; index++) {
				writeFileSync(join(root, `file-${index}.txt`), '');
			}
		}

		const watchers = roots.map((root) => new Watchr(root, { ignoreInitial: true }));
		const errors: Error[] = [];
		for (const watcher of watchers) {
			watcher.on(WatcherEvent.ERROR, (error) => errors.push(error));
		}
		try {
			await Promise.all(watchers.map((watcher) => watcher.readyLock));
			const addedPath = join(roots[0]!, 'after-ready.txt');
			const added = waitForEvent(watchers[0]!, FileSystemEvent.ADD, { path: addedPath });
			writeFileSync(addedPath, 'ready');
			await added;
			expect(errors).toEqual([]);
		} finally {
			for (const watcher of watchers) { watcher.close() }
		}
	});

	it('should cancel one initial scan without delaying the others', async () => {
		const roots = Array.from({ length: 5 }, () => createTempRoot('watchr-canceled-scan-'));
		for (const root of roots) {
			for (let index = 0; index < 2_000; index++) {
				writeFileSync(join(root, `file-${index}.txt`), '');
			}
		}

		const watchers = roots.map((root) => new Watchr(root, { ignoreInitial: true }));
		for (const watcher of watchers) { watcher.on(WatcherEvent.ERROR, () => undefined) }
		try {
			await new Promise(setImmediate);
			expect(watchers[0]!.isReady()).toBe(false);
			watchers[0]!.close();
			await expect(watchers[0]!.readyLock).rejects.toThrow('watcher closed before becoming ready');
			await Promise.all(watchers.slice(1).map((watcher) => watcher.readyLock));
			expect(watchers.slice(1).every((watcher) => watcher.isReady())).toBe(true);
		} finally {
			for (const watcher of watchers) { watcher.close() }
		}
	});

	it('should close promptly during manual traversal of linked entries', async () => {
		const root = createTempRoot('watchr-linked-scan-');
		const target = join(root, 'target.txt');
		writeFileSync(target, 'content');
		for (let index = 0; index < 500; index++) {
			symlinkSync(target, join(root, `link-${index}.txt`));
		}

		const watcher = new Watchr(root, { ignoreInitial: true, ignore: () => false });
		watcher.on(WatcherEvent.ERROR, () => undefined);
		await delay(10);
		watcher.close();
		await expect(watcher.readyLock).rejects.toThrow('watcher closed before becoming ready');
	});

});

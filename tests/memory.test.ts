import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Watchr } from '../src/watchr';
import { FileSystemEvent, WatcherEvent } from '../src/watchr';
import { cleanupTempRoots, closeWatchers, createReadyWatcher, createTempRoot, delay, waitForEvent } from './helpers/fs-fixtures';

const hasGc = typeof globalThis.gc === 'function';
const skipReason = process.platform !== 'linux'
	? 'heap budgets are calibrated on Linux only'
	: hasGc ? '' : 'requires node --expose-gc (see vitest.config.ts execArgv)';

/**
 * Forces two full collections with a pause so finalizers and weak refs settle, then samples `heapUsed`.
 * @returns Bytes currently used on the V8 heap.
 */
async function settledHeapUsed(): Promise<number> {
	globalThis.gc!();
	await delay(20);
	globalThis.gc!();

	return process.memoryUsage().heapUsed;
}

/**
 * Populates `root` with `count` empty files named `f<i>.txt`.
 * @param root Directory to fill.
 * @param count Number of files.
 */
function buildFlat(root: string, count: number): void {
	for (let i = 0; i < count; i++) {
		writeFileSync(join(root, `f${i}.txt`), '');
	}
}

describe.skipIf(skipReason !== '')(`memory budgets${skipReason ? ` (skipped: ${skipReason})` : ''}`, { timeout: 60_000 }, () => {
	afterEach(() => {
		closeWatchers();
		cleanupTempRoots();
	});

	it('should retain at most 700 bytes of heap per tracked path for a non-recursive 20k flat tree', async () => {
		const root = createTempRoot('watchr-mem-flat-');
		const fileCount = 20_000;
		buildFlat(root, fileCount);

		// One warm-up open/close so lazily initialised module state is not charged to the sample.
		(await createReadyWatcher(root, { ignoreInitial: true, recursive: false })).close();

		const before = await settledHeapUsed();
		await createReadyWatcher(root, { ignoreInitial: true, recursive: false });
		const tracked = fileCount + 1;
		const after = await settledHeapUsed();
		const bytesPerPath = (after - before) / tracked;

		expect(bytesPerPath, `${bytesPerPath.toFixed(0)} B/path over ${tracked} tracked paths`).toBeLessThanOrEqual(700);
	});

	it('should leave at most 2 MB of residual heap after 50 open/close cycles on a 200-file tree', async () => {
		const root = createTempRoot('watchr-mem-cycles-');
		buildFlat(root, 200);

		(await createReadyWatcher(root, { ignoreInitial: true })).close();

		const before = await settledHeapUsed();

		for (let cycle = 0; cycle < 50; cycle++) {
			const watcher = new Watchr(root, { ignoreInitial: true });
			await watcher.readyLock;
			watcher.close();
			expect(watcher.isClosed()).toBe(true);
		}

		const residual = await settledHeapUsed() - before;

		expect(residual, `${(residual / 1024 / 1024).toFixed(2)} MB residual heap`).toBeLessThanOrEqual(2 * 1024 * 1024);
	});

	it('should treat a deleted path as a new addition after each churn round', async () => {
		const root = createTempRoot('watchr-mem-churn-');
		const watcher = await createReadyWatcher(root, { ignoreInitial: true, renameTimeout: 20 });
		const errors: Error[] = [];
		watcher.on(WatcherEvent.ERROR, (error: Error) => errors.push(error));

		for (let round = 0; round < 3; round++) {
			for (let i = 0; i < 200; i++) {
				const source = join(root, `r${round}-a${i}.txt`);
				const target = join(root, `r${round}-b${i}.txt`);

				writeFileSync(source, 'x');
				await delay(2);
				renameSync(source, target);
				await delay(2);
				writeFileSync(target, 'yy');
				await delay(2);
				rmSync(target);
				await delay(2);
			}

			const target = join(root, `r${round}-probe.txt`);
			const added = waitForEvent(watcher, FileSystemEvent.ADD, { path: target });
			writeFileSync(target, 'tracked');
			await added;
			const unlinked = waitForEvent(watcher, FileSystemEvent.UNLINK, { path: target });
			rmSync(target);
			await unlinked;
			const readded = waitForEvent(watcher, FileSystemEvent.ADD, { path: target });
			writeFileSync(target, 'recreated');
			await readded;
			const removed = waitForEvent(watcher, FileSystemEvent.UNLINK, { path: target });
			rmSync(target);
			await removed;
		}

		expect(errors).toEqual([]);
	});
});

// Keep the churn suite honest when a directory is involved: a subdir that is created and removed must also be released.
describe.skipIf(skipReason !== '')('memory budgets: directory churn', { timeout: 30_000 }, () => {
	afterEach(() => {
		closeWatchers();
		cleanupTempRoots();
	});

	it('should recognize a recreated subdirectory after removing it and its files', async () => {
		const root = createTempRoot('watchr-mem-dir-');
		const watcher = await createReadyWatcher(root, { ignoreInitial: true });
		const sub = join(root, 'sub');

		const added = waitForEvent(watcher, FileSystemEvent.ADD_DIR, { path: sub });
		mkdirSync(sub);
		await added;
		for (let i = 0; i < 20; i++) { writeFileSync(join(sub, `f${i}.txt`), '') }

		const removed = waitForEvent(watcher, FileSystemEvent.UNLINK_DIR, { path: sub });
		rmSync(sub, { recursive: true, force: true });
		await removed;
		const readded = waitForEvent(watcher, FileSystemEvent.ADD_DIR, { path: sub });
		mkdirSync(sub);
		await readded;
	});
});

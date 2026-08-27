import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Watchr } from '../src/watchr';
import type { WatchrStats } from '../src/watchr-stats';
import type { WatchrOptions } from '../src/@types';

/** Event payload delivered to file system event listeners */
type EventPayload = [ stats: WatchrStats, targetPath: string, targetPathNext?: string ];

const tempDirs: string[] = [];
const watchers: Watchr[] = [];

/**
 * Creates a fresh temporary directory registered for cleanup
 * @returns The absolute path of the created directory
 */
function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'watchr-integration-'));
	tempDirs.push(dir);

	return dir;
}

/**
 * Creates a watcher registered for cleanup and waits for it to become ready
 * @param target The target path or paths to watch
 * @param options The watcher options
 * @returns A promise resolving to the ready watcher
 */
async function createWatcher(target: string[] | string, options: WatchrOptions = { ignoreInitial: true }): Promise<Watchr> {
	const watcher = new Watchr(target, options);
	watchers.push(watcher);
	await watcher.readyLock;

	return watcher;
}

/**
 * Waits for a single emission of the given watcher event
 * @param watcher The watcher to listen on
 * @param eventName The file system event name to wait for
 * @param timeoutMs Maximum time to wait before rejecting
 * @returns A promise resolving to the event arguments [stats, targetPath, targetPathNext?]
 */
function waitForEvent(watcher: Watchr, eventName: string, timeoutMs: number = 5000): Promise<EventPayload> {
	return new Promise<EventPayload>((resolve, reject) => {
		const onEvent = (stats: WatchrStats, targetPath: string, targetPathNext?: string): void => {
			clearTimeout(timeout);
			resolve([ stats, targetPath, targetPathNext ]);
		};

		const timeout = setTimeout(() => {
			watcher.off(eventName, onEvent);
			reject(new Error(`timed out after ${timeoutMs}ms waiting for '${eventName}' event`));
		}, timeoutMs);

		watcher.once(eventName, onEvent);
	});
}

afterEach(() => {
	for (const watcher of watchers.splice(0)) {
		if (!watcher.isClosed()) {
			watcher.close();
		}
	}

	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('Watchr integration', () => {
	it('emits add events for a newly created file', async () => {
		const watchDir = createTempDir();
		const watcher = await createWatcher(watchDir);
		const eventPromise = waitForEvent(watcher, 'add');

		writeFileSync(join(watchDir, 'hello.txt'), 'hi');

		const [ , emittedPath ] = await eventPromise;
		expect(emittedPath).toBe(join(watchDir, 'hello.txt'));
	});

	it('emits change events when an existing file is written', async () => {
		const watchDir = createTempDir();
		const filePath = join(watchDir, 'existing.txt');
		writeFileSync(filePath, 'original');

		const watcher = await createWatcher(watchDir);
		const eventPromise = waitForEvent(watcher, 'change');

		writeFileSync(filePath, 'modified content with different size');

		const [ , emittedPath ] = await eventPromise;
		expect(emittedPath).toBe(filePath);
	});

	it('emits unlink events when a file is deleted', async () => {
		const watchDir = createTempDir();
		const filePath = join(watchDir, 'doomed.txt');
		writeFileSync(filePath, 'to be deleted');

		const watcher = await createWatcher(watchDir);
		const eventPromise = waitForEvent(watcher, 'unlink');

		rmSync(filePath);

		const [ , emittedPath ] = await eventPromise;
		expect(emittedPath).toBe(filePath);
	});

	it('emits addDir on directory create and unlinkDir on directory delete', async () => {
		const watchDir = createTempDir();
		const dirPath = join(watchDir, 'subdir');

		const watcher = await createWatcher(watchDir);
		const addDirPromise = waitForEvent(watcher, 'addDir');

		mkdirSync(dirPath);

		const [ , addedPath ] = await addDirPromise;
		expect(addedPath).toBe(dirPath);

		const unlinkDirPromise = waitForEvent(watcher, 'unlinkDir');

		rmSync(dirPath, { recursive: true });

		const [ , unlinkedPath ] = await unlinkDirPromise;
		expect(unlinkedPath).toBe(dirPath);
	});

	it('emits rename events when a file is renamed', async () => {
		const watchDir = createTempDir();
		const oldPath = join(watchDir, 'before.txt');
		const newPath = join(watchDir, 'after.txt');
		writeFileSync(oldPath, 'contents');

		const watcher = await createWatcher(watchDir);
		const eventPromise = waitForEvent(watcher, 'rename');

		renameSync(oldPath, newPath);

		const [ , emittedOldPath, emittedNewPath ] = await eventPromise;
		expect(emittedOldPath).toBe(oldPath);
		expect(emittedNewPath).toBe(newPath);
	});

	it('emits renameDir events when a directory is renamed', async () => {
		const watchDir = createTempDir();
		const oldPath = join(watchDir, 'dir-before');
		const newPath = join(watchDir, 'dir-after');
		mkdirSync(oldPath);

		const watcher = await createWatcher(watchDir);
		const eventPromise = waitForEvent(watcher, 'renameDir');

		renameSync(oldPath, newPath);

		const [ , emittedOldPath, emittedNewPath ] = await eventPromise;
		expect(emittedOldPath).toBe(oldPath);
		expect(emittedNewPath).toBe(newPath);
	});

	it('filters out events for ignored paths', async () => {
		const watchDir = createTempDir();
		const ignoredPath = join(watchDir, 'ignored.txt');
		const visiblePath = join(watchDir, 'visible.txt');

		const watcher = await createWatcher(watchDir, {
			ignoreInitial: true,
			ignore: (targetPath: string) => targetPath.includes('ignored')
		});

		const observedPaths: string[] = [];
		watcher.on('all', (_event: string, _stats: WatchrStats, targetPath: string) => observedPaths.push(targetPath));

		const addPromise = waitForEvent(watcher, 'add');

		writeFileSync(ignoredPath, 'should not be seen');
		writeFileSync(visiblePath, 'should be seen');

		const [ , emittedPath ] = await addPromise;
		expect(emittedPath).toBe(visiblePath);
		expect(observedPaths).not.toContain(ignoredPath);
	});

	it('delivers events for each of multiple watched paths', async () => {
		const dirA = createTempDir();
		const dirB = createTempDir();
		const fileA = join(dirA, 'a.txt');
		const fileB = join(dirB, 'b.txt');

		const watcher = await createWatcher([ dirA, dirB ]);

		const seenPaths = new Set<string>();
		const bothAddsPromise = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error(`timed out waiting for adds; saw: ${[ ...seenPaths ].join(', ') || '(none)'}`));
			}, 5000);

			watcher.on('add', (_stats: WatchrStats, targetPath: string) => {
				seenPaths.add(targetPath);

				if (seenPaths.has(fileA) && seenPaths.has(fileB)) {
					clearTimeout(timeout);
					resolve();
				}
			});
		});

		writeFileSync(fileA, 'in dir A');
		writeFileSync(fileB, 'in dir B');

		await bothAddsPromise;
		expect(seenPaths).toContain(fileA);
		expect(seenPaths).toContain(fileB);
	});

	it('does not deliver events after close()', async () => {
		const watchDir = createTempDir();
		const watcher = await createWatcher(watchDir);

		const observedEvents: string[] = [];
		watcher.on('all', (event: string, _stats: WatchrStats, targetPath: string) => observedEvents.push(`${event}:${targetPath}`));

		watcher.close();
		expect(watcher.isClosed()).toBe(true);

		writeFileSync(join(watchDir, 'after-close.txt'), 'should not be observed');

		// Asserting absence: allow a bounded grace period for any stray emission to surface
		await delay(300);
		expect(observedEvents).toEqual([]);
	});
});

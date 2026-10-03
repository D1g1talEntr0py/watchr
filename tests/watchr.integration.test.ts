import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, closeSync, linkSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Watchr, type WatchrStats, type WatchrOptions } from '../src/watchr';

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
			resolve(targetPathNext === undefined ? [ stats, targetPath ] : [ stats, targetPath, targetPathNext ]);
		};

		const timeout = setTimeout(() => {
			watcher.off(eventName, onEvent);
			reject(new Error(`timed out after ${timeoutMs}ms waiting for '${eventName}' event`));
		}, timeoutMs);

		watcher.once(eventName, onEvent);
	});
}

/**
 * Reads the inode of a path in the same representation WatchrStats exposes
 * @param targetPath The path to stat
 * @returns The inode number
 */
function inodeOf(targetPath: string): number {
	return Number(statSync(targetPath, { bigint: true }).ino);
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

	it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('recovers from an unreadable parent during live file stats', async () => {
		const watchDir = createTempDir();
		const parent = join(watchDir, 'private');
		mkdirSync(parent);
		const filePath = join(parent, 'file.txt');
		writeFileSync(filePath, 'original');
		const watcher = await createWatcher(filePath, { ignoreInitial: true, recursive: false, statTimeout: 250 });
		const errors: Error[] = [];
		watcher.on('error', (error) => errors.push(error));
		const descriptor = openSync(filePath, 'r+');
		chmodSync(parent, 0);

		try {
			writeSync(descriptor, 'updated', 0, 'utf8');
			await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), { timeout: 3000 });
		} finally {
			closeSync(descriptor);
			chmodSync(parent, 0o700);
		}

		const changed = waitForEvent(watcher, 'change');
		writeFileSync(filePath, 'after recovery');
		expect((await changed)[1]).toBe(filePath);
	});

	it('emits unlink events when a file is deleted', async () => {
		const watchDir = createTempDir();
		const filePath = join(watchDir, 'doomed.txt');
		writeFileSync(filePath, 'to be deleted');
		const inode = inodeOf(filePath);

		const watcher = await createWatcher(watchDir);
		const eventPromise = waitForEvent(watcher, 'unlink');

		rmSync(filePath);

		const [ stats, emittedPath ] = await eventPromise;
		expect(emittedPath).toBe(filePath);
		expect(stats.isSynthetic).toBe(false);
		expect(stats.inodeNumber).toBe(inode);
		expect(stats.isFile()).toBe(true);
	});

	it('emits addDir on directory create and unlinkDir on directory delete', async () => {
		const watchDir = createTempDir();
		const dirPath = join(watchDir, 'subdir');

		const watcher = await createWatcher(watchDir);
		const addDirPromise = waitForEvent(watcher, 'addDir');

		mkdirSync(dirPath);

		const [ addedStats, addedPath ] = await addDirPromise;
		expect(addedPath).toBe(dirPath);
		const inode = inodeOf(dirPath);
		expect(addedStats.inodeNumber).toBe(inode);

		const unlinkDirPromise = waitForEvent(watcher, 'unlinkDir');

		rmSync(dirPath, { recursive: true });

		const [ unlinkedStats, unlinkedPath ] = await unlinkDirPromise;
		expect(unlinkedPath).toBe(dirPath);
		expect(unlinkedStats.isSynthetic).toBe(false);
		expect(unlinkedStats.inodeNumber).toBe(inode);
		expect(unlinkedStats.isDirectory()).toBe(true);
	});

	it('reports removal and addition when a file path becomes a directory', async () => {
		const watchDir = createTempDir();
		const targetPath = join(watchDir, 'entry');
		writeFileSync(targetPath, 'original');
		const watcher = await createWatcher(watchDir, { ignoreInitial: true, renameTimeout: 0 });
		const events: string[] = [];
		watcher.on('all', (event, _stats, path) => {
			if (path === targetPath) { events.push(event) }
		});

		const removedFile = waitForEvent(watcher, 'unlink');
		rmSync(targetPath);
		expect((await removedFile)[1]).toBe(targetPath);
		const addedDirectory = waitForEvent(watcher, 'addDir');
		mkdirSync(targetPath);
		expect((await addedDirectory)[1]).toBe(targetPath);
		expect(events).toContain('unlink');
		expect(events).toContain('addDir');
	});

	it('emits rename events when a file is renamed', async () => {
		const watchDir = createTempDir();
		const oldPath = join(watchDir, 'before.txt');
		const newPath = join(watchDir, 'after.txt');
		writeFileSync(oldPath, 'contents');
		const inode = inodeOf(oldPath);

		const watcher = await createWatcher(watchDir);
		const eventPromise = waitForEvent(watcher, 'rename');

		renameSync(oldPath, newPath);

		const [ stats, emittedOldPath, emittedNewPath ] = await eventPromise;
		expect(emittedOldPath).toBe(oldPath);
		expect(emittedNewPath).toBe(newPath);
		expect(stats.isSynthetic).toBe(false);
		expect(stats.inodeNumber).toBe(inode);
	});

	it('keeps watching hard-linked paths when one link is renamed', async () => {
		const watchDir = createTempDir();
		const original = join(watchDir, 'original.txt');
		const linked = join(watchDir, 'linked.txt');
		const renamed = join(watchDir, 'renamed.txt');
		writeFileSync(original, 'shared inode');
		linkSync(original, linked);
		const watcher = await createWatcher(watchDir);
		const observed: Array<{ path: string, pathNext: string | undefined, inode: number | bigint }> = [];
		watcher.on('all', (_event, stats, path, pathNext) => observed.push({ path, pathNext, inode: stats.inodeNumber }));

		renameSync(linked, renamed);
		await vi.waitFor(() => expect(observed.some(({ path, pathNext }) => path === renamed || pathNext === renamed)).toBe(true));
		expect(observed.find(({ path, pathNext }) => path === renamed || pathNext === renamed)?.inode).toBe(inodeOf(original));
	});

	it('emits renameDir events when a directory is renamed', async () => {
		const watchDir = createTempDir();
		const oldPath = join(watchDir, 'dir-before');
		const newPath = join(watchDir, 'dir-after');
		mkdirSync(oldPath);
		const inode = inodeOf(oldPath);

		const watcher = await createWatcher(watchDir);
		const eventPromise = waitForEvent(watcher, 'renameDir');

		renameSync(oldPath, newPath);

		const [ stats, emittedOldPath, emittedNewPath ] = await eventPromise;
		expect(emittedOldPath).toBe(oldPath);
		expect(emittedNewPath).toBe(newPath);
		expect(stats.isSynthetic).toBe(false);
		expect(stats.inodeNumber).toBe(inode);
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

	it('matches mixed ignore patterns without suppressing visible files', async () => {
		const watchDir = createTempDir();
		const visiblePath = join(watchDir, 'visible.txt');
		const watcher = await createWatcher(watchDir, {
			ignoreInitial: true,
			ignore: [ '*.log', /hidden\.tmp/g, (path: string) => path === 'secret.txt' ]
		});
		const seenPaths: string[] = [];
		watcher.on('all', (_event, _stats, path) => seenPaths.push(path));
		const visibleAdd = waitForEvent(watcher, 'add');

		writeFileSync(join(watchDir, 'debug.log'), 'ignored by glob');
		writeFileSync(join(watchDir, 'hidden.tmp'), 'ignored by regex');
		writeFileSync(join(watchDir, 'secret.txt'), 'ignored by callback');
		writeFileSync(visiblePath, 'visible');

		expect((await visibleAdd)[1]).toBe(visiblePath);
		await delay(100);
		expect(seenPaths).toEqual([ visiblePath ]);
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

	it('watches an ancestor and nested target in the same constructor', async () => {
		const root = createTempDir();
		const nested = join(root, 'nested');
		mkdirSync(nested);
		const watcher = await createWatcher([ root, nested ], { ignoreInitial: true });
		const filePath = join(nested, 'new.txt');
		const added = waitForEvent(watcher, 'add');

		writeFileSync(filePath, 'nested');
		expect((await added)[1]).toBe(filePath);
	});

	it('watches two file targets in one parent without observing other files', async () => {
		const watchDir = createTempDir();
		const fileA = join(watchDir, 'a.txt');
		const fileB = join(watchDir, 'b.txt');
		const other = join(watchDir, 'other.txt');
		writeFileSync(fileA, 'a');
		writeFileSync(fileB, 'b');
		writeFileSync(other, 'other');
		const watcher = await createWatcher([ fileA, fileB ], { ignoreInitial: true, renameTimeout: 0 });
		const changes = new Set<string>();
		watcher.on('change', (_stats, path) => changes.add(path));

		writeFileSync(other, 'unwatched');
		writeFileSync(fileA, 'updated a');
		writeFileSync(fileB, 'updated b');
		await vi.waitFor(() => expect(changes).toEqual(new Set([ fileA, fileB ])));
		await delay(100);
		expect(changes.has(other)).toBe(false);
	});

	it('rejects a non-callable handler from JavaScript callers', () => {
		const watchDir = createTempDir();
		expect(() => Reflect.construct(Watchr, [ watchDir, {}, 'not a function' ])).toThrow('handler must be a function');
	});

	it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('closes failed startup after a real directory permission error', async () => {
		const watchDir = createTempDir();
		const unreadable = join(watchDir, 'unreadable');
		mkdirSync(unreadable);
		chmodSync(unreadable, 0);
		const watcher = new Watchr(watchDir);
		const errors: Error[] = [];
		watcher.on('error', (error) => errors.push(error));

		try {
			await expect(watcher.readyLock).rejects.toMatchObject({ code: 'EACCES' });
			expect(watcher.isClosed()).toBe(true);
			expect(errors).toHaveLength(1);
		} finally {
			watcher.close();
			chmodSync(unreadable, 0o700);
		}

		const recovered = await createWatcher(watchDir);
		expect(recovered.isReady()).toBe(true);
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

	describe('symbolic links', () => {
		it('traverses in-root symlinks under an ignore callback without following loops or missing targets', async () => {
			const watchDir = createTempDir();
			const actualDir = join(watchDir, 'actual');
			const linkedDir = join(watchDir, 'linked');
			const linkedFile = join(linkedDir, 'inside.txt');
			mkdirSync(actualDir);
			writeFileSync(join(actualDir, 'inside.txt'), 'content');
			symlinkSync(actualDir, linkedDir, 'dir');
			symlinkSync(watchDir, join(watchDir, 'loop'), 'dir');
			symlinkSync(join(watchDir, 'missing'), join(watchDir, 'dangling'), 'dir');
			const watcher = new Watchr(watchDir, { renameTimeout: 0, ignore: () => false });
			watchers.push(watcher);
			const observed = new Set<string>();
			watcher.on('all', (_event, _stats, path) => observed.add(path));

			await watcher.readyLock;
			await vi.waitFor(() => expect(observed.has(linkedFile)).toBe(true));
			expect(observed.has(join(watchDir, 'dangling'))).toBe(false);
			expect(observed.size).toBeLessThan(30);
		});

		it('discovers an in-root symlinked directory and its descendants', async () => {
			const watchDir = createTempDir();
			const actualDir = join(watchDir, 'actual');
			const linkDir = join(watchDir, 'alias');
			mkdirSync(actualDir);
			writeFileSync(join(actualDir, 'inside.txt'), 'content');
			symlinkSync(actualDir, linkDir, 'dir');
			const watcher = new Watchr(watchDir, { renameTimeout: 0 });
			watchers.push(watcher);
			const observed: Array<{ path: string, next?: string, symlink: boolean }> = [];
			watcher.on('all', (_event, stats, path, next) => observed.push({ path, ...(next === undefined ? {} : { next }), symlink: stats.isSymbolicLink() }));

			await watcher.readyLock;
			await vi.waitFor(() => expect(observed.some(({ path, next, symlink }) => (path === linkDir || next === linkDir) && symlink)).toBe(true));
		});

		it('emits add for a symlinked file on the initial scan with isSymbolicLink() set when followSymlinks is true', async () => {
			const watchDir = createTempDir();
			const targetDir = createTempDir();
			const targetFile = join(targetDir, 'target.txt');
			const linkPath = join(watchDir, 'link.txt');
			const regularPath = join(watchDir, 'regular.txt');
			writeFileSync(targetFile, 'linked content');
			writeFileSync(regularPath, 'regular');
			symlinkSync(targetFile, linkPath);

			const watcher = new Watchr(watchDir, { renameTimeout: 0 });
			watchers.push(watcher);
			const added = new Map<string, WatchrStats>();
			watcher.on('add', (stats, targetPath) => added.set(targetPath, stats));
			await watcher.readyLock;
			await delay(50);

			expect(added.get(linkPath)?.isSymbolicLink()).toBe(true);
			expect(added.get(linkPath)?.isFile()).toBe(true);
			expect(added.get(linkPath)?.inodeNumber).toBe(inodeOf(targetFile));
			expect(added.get(regularPath)?.isSymbolicLink()).toBe(false);
		});

		it('ignores symlinks on the initial scan and for live adds when followSymlinks is false', async () => {
			const watchDir = createTempDir();
			const targetDir = createTempDir();
			const targetFile = join(targetDir, 'target.txt');
			const initialLink = join(watchDir, 'initial-link.txt');
			const liveLink = join(watchDir, 'live-link.txt');
			const liveFile = join(watchDir, 'live-file.txt');
			writeFileSync(targetFile, 'linked content');
			symlinkSync(targetFile, initialLink);

			const watcher = new Watchr(watchDir, { followSymlinks: false, renameTimeout: 0 });
			watchers.push(watcher);
			const observed: string[] = [];
			watcher.on('all', (event, _stats, targetPath) => observed.push(`${event}:${targetPath}`));
			await watcher.readyLock;

			const liveAdd = waitForEvent(watcher, 'add');
			symlinkSync(targetFile, liveLink);
			writeFileSync(liveFile, 'regular');

			const [ , liveAddPath ] = await liveAdd;
			await delay(100);

			expect(liveAddPath).toBe(liveFile);
			expect(observed.filter((entry) => entry.includes('-link.txt'))).toEqual([]);
			expect(observed).toContain(`add:${liveFile}`);
		});
	});
});

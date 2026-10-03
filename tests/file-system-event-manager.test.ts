import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { linkSync, mkdirSync, renameSync, rmSync, writeFileSync, type FSWatcher } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FileSystemEvent } from '../src/watchr';
import { cleanupTempRoots, closeWatchers, collectEvents, createReadyWatcher, createTempRoot, delay, settle } from './helpers/fs-fixtures';

const { nativeWatchers, scans } = vi.hoisted(() => ({
	nativeWatchers: new Map<string, FSWatcher>(),
	scans: { gate: undefined as Promise<void> | undefined, failure: undefined as Error | undefined }
}));

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>();

	return {
		...actual,
		watch: vi.fn((target: string) => {
			const watcher = new EventEmitter() as FSWatcher;
			watcher.close = vi.fn(() => { watcher.emit('close') });
			watcher.ref = vi.fn(() => watcher);
			watcher.unref = vi.fn(() => watcher);
			nativeWatchers.set(target, watcher);
			return watcher;
		})
	};
});

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return {
		...actual,
		readdir: vi.fn(async (...args: Parameters<typeof actual.readdir>) => {
			await scans.gate;
			if (scans.failure !== undefined) { throw scans.failure }
			return actual.readdir(...args);
		})
	};
});

describe('Watchr native notification boundary', () => {
	afterEach(() => {
		closeWatchers();
		cleanupTempRoots();
		nativeWatchers.clear();
		scans.gate = undefined;
		scans.failure = undefined;
		vi.mocked(readdir).mockClear();
		vi.restoreAllMocks();
	});

	it.each([ '', null ])('discovers new files through an unnamed notification (%s)', async (filename) => {
		const root = createTempRoot();
		const watcher = await createReadyWatcher(root, { ignoreInitial: true, renameTimeout: 0 });
		const { events } = collectEvents(watcher);
		const file = join(root, 'new.txt');
		writeFileSync(file, 'new contents');
		nativeWatchers.get(root)!.emit('change', 'rename', filename);

		await vi.waitFor(() => expect(events.filter(({ path }) => path === file)).toHaveLength(1));
		expect(events.find(({ path }) => path === file)).toMatchObject({ event: FileSystemEvent.ADD, stats: { size: 12 } });
		await settle();
		expect(events.filter(({ path }) => path === file)).toHaveLength(1);
	});

	it.each([ 'EIO', undefined ])('sanitizes native watcher errors with code %s', async (code) => {
		const root = createTempRoot();
		const watcher = await createReadyWatcher(root, { ignoreInitial: true });
		const errors: Error[] = [];
		watcher.on('error', (error) => errors.push(error));
		const original = Object.assign(new Error(`Cannot watch ${root}`), { code });
		nativeWatchers.get(root)!.emit('error', original);

		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({
			message: code === undefined ? 'Watcher error' : `Watcher error (${code})`,
			code: code ?? 'UNKNOWN',
			cause: original
		});
		expect(errors[0]?.message).not.toContain(root);
		expect(watcher.isClosed()).toBe(false);
	});

	it('preserves file-to-directory replacement events in a multi-path batch', async () => {
		const root = createTempRoot();
		const target = join(root, 'entry');
		const other = join(root, 'other.txt');
		writeFileSync(target, 'file');
		const watcher = await createReadyWatcher(root, { ignoreInitial: true, renameTimeout: 0 });
		const { events } = collectEvents(watcher);
		rmSync(target);
		mkdirSync(target);
		writeFileSync(other, 'other');
		const native = nativeWatchers.get(root)!;
		native.emit('change', 'rename', 'entry');
		native.emit('change', 'rename', 'other.txt');

		await vi.waitFor(() => expect(events.filter(({ path }) => path === target)).toHaveLength(2));
		expect(events.filter(({ path }) => path === target).map(({ event }) => event)).toEqual([
			FileSystemEvent.UNLINK,
			FileSystemEvent.ADD_DIR
		]);
		expect(events.find(({ path }) => path === other)?.event).toBe(FileSystemEvent.ADD);
	});

	it('coalesces notification storms during a scan and discovers files in the queued scan', async () => {
		const root = createTempRoot();
		const watcher = await createReadyWatcher(root, { ignoreInitial: true, renameTimeout: 0, fallbackScanInterval: 25 });
		const { events } = collectEvents(watcher);
		vi.mocked(readdir).mockClear();
		const scan = Promise.withResolvers<void>();
		scans.gate = scan.promise;
		const native = nativeWatchers.get(root)!;
		native.emit('change', 'change', '');
		await vi.waitFor(() => expect(readdir).toHaveBeenCalledTimes(1));

		for (let index = 0; index < 10; index++) { native.emit('change', 'rename', null) }
		expect(readdir).toHaveBeenCalledTimes(1);
		const file = join(root, 'queued.txt');
		writeFileSync(file, 'queued');
		scan.resolve();
		await vi.waitFor(() => expect(readdir).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(events.filter(({ path }) => path === file)).toHaveLength(1));
		expect(events.find(({ path }) => path === file)?.event).toBe(FileSystemEvent.ADD);
	});

	it('does not emit stale events after closing during a snapshot scan', async () => {
		const root = createTempRoot();
		const watcher = await createReadyWatcher(root, { ignoreInitial: true, renameTimeout: 0 });
		const { events } = collectEvents(watcher);
		vi.mocked(readdir).mockClear();
		const scan = Promise.withResolvers<void>();
		scans.gate = scan.promise;
		const native = nativeWatchers.get(root)!;
		native.emit('change', 'rename', '');
		await vi.waitFor(() => expect(readdir).toHaveBeenCalledOnce());
		writeFileSync(join(root, 'late.txt'), 'late');
		watcher.close();
		scan.resolve();
		await vi.waitFor(() => expect(vi.mocked(readdir).mock.settledResults[0]?.type).toBe('fulfilled'));
		await settle(10);
		expect(events).toEqual([]);
		expect(native.close).toHaveBeenCalled();
		expect(native.listenerCount('change')).toBe(0);
		expect(native.listenerCount('error')).toBe(0);
	});

	it('recovers on the next notification after a snapshot read fails', async () => {
		const root = createTempRoot();
		const watcher = await createReadyWatcher(root, { ignoreInitial: true, renameTimeout: 0, fallbackScanInterval: 0 });
		const { events } = collectEvents(watcher);
		vi.mocked(readdir).mockClear();
		scans.failure = Object.assign(new Error('snapshot unavailable'), { code: 'EIO' });
		const native = nativeWatchers.get(root)!;
		native.emit('change', 'change', '');
		await vi.waitFor(() => expect(vi.mocked(readdir).mock.settledResults[0]?.type).toBe('rejected'));
		await settle();
		scans.failure = undefined;
		const file = join(root, 'recovered.txt');
		writeFileSync(file, 'recovered');
		native.emit('change', 'rename', '');
		await vi.waitFor(() => expect(events.find(({ path }) => path === file)?.event).toBe(FileSystemEvent.ADD));
		expect(watcher.isClosed()).toBe(false);
	});

	it.each([ false, true ])('correlates a delayed source notification with its destination (directory=%s)', async (directory) => {
		const root = createTempRoot();
		const source = join(root, 'source');
		const target = join(root, 'target');
		if (directory) { mkdirSync(source) } else { writeFileSync(source, 'original') }
		const watcher = await createReadyWatcher(root, { ignoreInitial: true, renameTimeout: 1000 });
		const { events } = collectEvents(watcher);
		const native = nativeWatchers.get(root)!;
		renameSync(source, target);
		writeFileSync(join(root, 'marker.txt'), 'marker');
		native.emit('change', 'rename', 'source');
		native.emit('change', 'rename', 'marker.txt');
		await vi.waitFor(() => expect(events.some(({ path }) => path === join(root, 'marker.txt'))).toBe(true));
		expect(events.filter(({ path }) => path === source)).toEqual([]);
		native.emit('change', 'rename', 'target');
		await vi.waitFor(() => expect(events.find(({ path }) => path === source)).toMatchObject({
			event: directory ? FileSystemEvent.RENAME_DIR : FileSystemEvent.RENAME,
			pathNext: target
		}));
		expect(events.filter(({ path }) => path === target)).toEqual([]);
	});

	it('reports a same-path inode restoration as change instead of unlink and add', async () => {
		const root = createTempRoot();
		const outside = createTempRoot();
		const file = join(root, 'restored.txt');
		const saved = join(outside, 'saved.txt');
		writeFileSync(file, 'original');
		linkSync(file, saved);
		const watcher = await createReadyWatcher(root, { ignoreInitial: true, renameTimeout: 1000 });
		const { events } = collectEvents(watcher);
		rmSync(file);
		writeFileSync(join(root, 'marker.txt'), 'marker');
		const native = nativeWatchers.get(root)!;
		native.emit('change', 'rename', 'restored.txt');
		native.emit('change', 'rename', 'marker.txt');
		await vi.waitFor(() => expect(events.some(({ path }) => path === join(root, 'marker.txt'))).toBe(true));
		linkSync(saved, file);
		writeFileSync(file, 'restored contents');
		native.emit('change', 'rename', 'restored.txt');
		await vi.waitFor(() => expect(events.filter(({ path }) => path === file)).toHaveLength(1));
		expect(events.find(({ path }) => path === file)).toMatchObject({ event: FileSystemEvent.CHANGE, stats: { size: 17 } });
	});

	it.each([ 'settle', 'delete', 'close' ])('handles a pending add after an inode moves out of a replaced path: %s', async (action) => {
		const root = createTempRoot();
		const source = join(root, 'source.txt');
		const target = join(root, 'target.txt');
		writeFileSync(source, 'original');
		const watcher = await createReadyWatcher(root, { ignoreInitial: true, renameTimeout: 1000 });
		const { events } = collectEvents(watcher);
		const native = nativeWatchers.get(root)!;
		renameSync(source, target);
		writeFileSync(source, 'replacement');
		native.emit('change', 'rename', 'source.txt');
		native.emit('change', 'rename', 'target.txt');
		await vi.waitFor(() => expect(events.find(({ path }) => path === source)?.event).toBe(FileSystemEvent.CHANGE));
		expect(events.filter(({ path }) => path === target)).toEqual([]);

		writeFileSync(target, 'latest contents');
		writeFileSync(join(root, 'marker.txt'), 'marker');
		native.emit('change', 'change', 'target.txt');
		native.emit('change', 'rename', 'marker.txt');
		await vi.waitFor(() => expect(events.some(({ path }) => path === join(root, 'marker.txt'))).toBe(true));
		expect(events.filter(({ path }) => path === target)).toEqual([]);

		if (action === 'delete') {
			rmSync(target);
			writeFileSync(join(root, 'deleted-marker.txt'), 'marker');
			native.emit('change', 'rename', 'target.txt');
			native.emit('change', 'rename', 'deleted-marker.txt');
			await vi.waitFor(() => expect(events.some(({ path }) => path === join(root, 'deleted-marker.txt'))).toBe(true));
		} else if (action === 'close') {
			watcher.close();
		}

		await delay(1100);
		const targetEvents = events.filter(({ path }) => path === target);
		if (action === 'settle') {
			expect(targetEvents).toHaveLength(1);
			expect(targetEvents[0]).toMatchObject({ event: FileSystemEvent.ADD, stats: { size: 15 } });
		} else {
			expect(targetEvents).toEqual([]);
		}
	});
});

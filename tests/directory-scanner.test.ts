import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join, resolve } from 'node:path';
import { NodeTargetEvent } from '../src/constants';
import { DirectoryScanner } from '../src/directory-scanner';
import { FileSystem } from '../src/file-system';
import { FileSystemEntries } from '../src/file-system-entries';

describe('DirectoryScanner', () => {
	const root = resolve('scanner-root');
	let controller: AbortController;
	let scanners: DirectoryScanner[];

	const createScanner = (options: Partial<ConstructorParameters<typeof DirectoryScanner>[0]> = {}) => {
		const scanner = new DirectoryScanner({
			folderPath: root,
			interval: 25,
			readOptions: { recursive: true, followSymlinks: true, signal: controller.signal },
			trackedPaths: () => [],
			isIgnored: () => false,
			onWatcherEvent: vi.fn(),
			onError: vi.fn(),
			...options
		}, controller.signal);
		scanners.push(scanner);
		return scanner;
	};

	beforeEach(() => {
		controller = new AbortController();
		scanners = [];
		vi.useFakeTimers({ toFake: [ 'setTimeout', 'clearTimeout', 'performance' ] });
		vi.advanceTimersByTime(100);
		vi.spyOn(FileSystem, 'readDirectory').mockResolvedValue(new FileSystemEntries());
	});

	afterEach(() => {
		controller.abort();
		for (const scanner of scanners) { scanner.close() }
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('polls only nonignored tracked descendants synchronously before the snapshot microtask', async () => {
		const tracked = join(root, 'tracked.txt');
		const ignored = join(root, 'ignored.txt');
		const discovered = join(root, 'discovered.txt');
		const onWatcherEvent = vi.fn();
		const isIgnored = vi.fn((path: string) => path === ignored);
		vi.mocked(FileSystem.readDirectory).mockResolvedValue(new FileSystemEntries().addFile(discovered).addFile(discovered));
		const scanner = createScanner({
			trackedPaths: () => [ root, tracked, ignored, `${root}-sibling`, resolve('outside.txt') ],
			isIgnored,
			onWatcherEvent
		});

		scanner.reconcile(NodeTargetEvent.CHANGE);
		expect(onWatcherEvent.mock.calls).toEqual([ [ NodeTargetEvent.CHANGE, root ], [ NodeTargetEvent.CHANGE, tracked ] ]);
		expect(FileSystem.readDirectory).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(0);
		expect(onWatcherEvent.mock.calls.slice(2)).toEqual([ [ NodeTargetEvent.CHANGE, root ], [ NodeTargetEvent.CHANGE, discovered ] ]);
		expect(isIgnored.mock.calls.flat()).toEqual([ root, tracked, ignored, root ]);
	});

	it('coalesces scheduled and in-flight requests with rename priority and start-to-start throttling', async () => {
		const release = Promise.withResolvers<FileSystemEntries>();
		vi.mocked(FileSystem.readDirectory).mockReturnValueOnce(release.promise);
		const onWatcherEvent = vi.fn();
		const scanner = createScanner({ onWatcherEvent });
		scanner.schedule(NodeTargetEvent.CHANGE);
		scanner.schedule(NodeTargetEvent.RENAME);
		scanner.schedule(NodeTargetEvent.CHANGE);
		expect(FileSystem.readDirectory).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(0);
		for (let index = 0; index < 10; index++) {
			scanner.schedule(NodeTargetEvent.CHANGE);
			scanner.schedule(NodeTargetEvent.RENAME);
			scanner.schedule(NodeTargetEvent.CHANGE);
		}
		await vi.advanceTimersByTimeAsync(10);
		expect(FileSystem.readDirectory).toHaveBeenCalledTimes(1);
		release.resolve(new FileSystemEntries());
		await vi.advanceTimersByTimeAsync(0);
		expect(onWatcherEvent.mock.calls).toEqual([ [ NodeTargetEvent.RENAME, root ] ]);
		await vi.advanceTimersByTimeAsync(14);
		expect(FileSystem.readDirectory).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(FileSystem.readDirectory).toHaveBeenCalledTimes(2);
		expect(onWatcherEvent.mock.calls).toEqual([ [ NodeTargetEvent.RENAME, root ], [ NodeTargetEvent.RENAME, root ] ]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('serializes long scans and starts the queued follow-up immediately after an elapsed interval', async () => {
		const release = Promise.withResolvers<FileSystemEntries>();
		vi.mocked(FileSystem.readDirectory).mockReturnValueOnce(release.promise);
		const scanner = createScanner();
		scanner.schedule(NodeTargetEvent.CHANGE);
		await vi.advanceTimersByTimeAsync(0);
		scanner.schedule(NodeTargetEvent.CHANGE);
		await vi.advanceTimersByTimeAsync(80);
		expect(FileSystem.readDirectory).toHaveBeenCalledTimes(1);
		release.resolve(new FileSystemEntries());
		await vi.advanceTimersByTimeAsync(0);
		expect(FileSystem.readDirectory).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([ 'tracked', 'snapshot' ])('awaits each 32-path %s dispatch chunk', async (source) => {
		const paths = Array.from({ length: 33 }, (_unused, index) => join(root, `entry-${index}.txt`));
		const release = Promise.withResolvers<void>();
		const onWatcherEvent = vi.fn(() => release.promise);
		const entries = new FileSystemEntries();
		for (const path of paths) { entries.addFile(path) }
		vi.mocked(FileSystem.readDirectory).mockResolvedValue(entries);
		const scanner = createScanner({ trackedPaths: () => [ root, ...paths ], onWatcherEvent });
		if (source === 'tracked') {
			vi.mocked(FileSystem.readDirectory).mockResolvedValue(new FileSystemEntries());
			scanner.reconcile(NodeTargetEvent.CHANGE);
			expect(onWatcherEvent).toHaveBeenCalledTimes(32);
		} else {
			scanner.schedule(NodeTargetEvent.CHANGE);
			await vi.advanceTimersByTimeAsync(0);
			expect(onWatcherEvent).toHaveBeenCalledTimes(32);
		}
		release.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(onWatcherEvent).toHaveBeenCalledTimes(source === 'tracked' ? 35 : 34);
	});

	it('keeps a snapshot in flight until its custom handlers finish', async () => {
		const release = Promise.withResolvers<void>();
		const onWatcherEvent = vi.fn(() => release.promise);
		const scanner = createScanner({ onWatcherEvent });
		scanner.schedule(NodeTargetEvent.CHANGE);
		await vi.advanceTimersByTimeAsync(0);
		expect(onWatcherEvent).toHaveBeenCalledTimes(1);
		scanner.schedule(NodeTargetEvent.RENAME);
		await vi.advanceTimersByTimeAsync(100);
		expect(FileSystem.readDirectory).toHaveBeenCalledTimes(1);
		release.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(FileSystem.readDirectory).toHaveBeenCalledTimes(2);
		expect(onWatcherEvent.mock.calls).toEqual([ [ NodeTargetEvent.CHANGE, root ], [ NodeTargetEvent.RENAME, root ] ]);
	});

	it.each([ 'tracked', 'snapshot' ])('reports rejected %s dispatches', async (source) => {
		const error = new Error('dispatch failed');
		const onError = vi.fn();
		const onWatcherEvent = vi.fn()
			.mockRejectedValueOnce(error)
			.mockResolvedValue(undefined);
		const scanner = createScanner({
			trackedPaths: source === 'tracked' ? () => [ root ] : () => [],
			onWatcherEvent,
			onError
		});

		if (source === 'tracked') {
			scanner.reconcile(NodeTargetEvent.CHANGE);
			await vi.advanceTimersByTimeAsync(0);
		} else {
			scanner.schedule(NodeTargetEvent.CHANGE);
			await vi.advanceTimersByTimeAsync(0);
		}

		expect(onError).toHaveBeenCalledExactlyOnceWith(error);
	});

	it('continues dispatching later chunks after a handler rejection', async () => {
		const entries = new FileSystemEntries();
		for (let index = 0; index < 33; index++) { entries.addFile(join(root, `entry-${index}.txt`)) }
		vi.mocked(FileSystem.readDirectory).mockResolvedValue(entries);
		const error = new Error('handler failed');
		const onWatcherEvent = vi.fn((_event: NodeTargetEvent, path: string) => path === root ? Promise.reject(error) : undefined);
		const onError = vi.fn();
		const scanner = createScanner({ onWatcherEvent, onError });

		scanner.schedule(NodeTargetEvent.CHANGE);
		await vi.advanceTimersByTimeAsync(0);

		expect(onWatcherEvent).toHaveBeenCalledTimes(34);
		expect(onError).toHaveBeenCalledExactlyOnceWith(error);
	});

	it('does not admit another dispatch chunk after cancellation', async () => {
		const entries = new FileSystemEntries();
		for (let index = 0; index < 40; index++) { entries.addFile(join(root, `${index}.txt`)) }
		vi.mocked(FileSystem.readDirectory).mockResolvedValue(entries);
		const release = Promise.withResolvers<void>();
		const onWatcherEvent = vi.fn(() => release.promise);
		const scanner = createScanner({ onWatcherEvent });
		scanner.schedule(NodeTargetEvent.CHANGE);
		await vi.advanceTimersByTimeAsync(0);
		expect(onWatcherEvent).toHaveBeenCalledTimes(32);
		controller.abort();
		scanner.close();
		release.resolve();
		await vi.advanceTimersByTimeAsync(100);
		expect(onWatcherEvent).toHaveBeenCalledTimes(32);
	});

	it.each([ 'microtask', 'timer', 'scan' ])('cleans up pending %s work synchronously and suppresses queued follow-ups', async (phase) => {
		const release = Promise.withResolvers<FileSystemEntries>();
		const onWatcherEvent = vi.fn();
		if (phase === 'scan') { vi.mocked(FileSystem.readDirectory).mockReturnValueOnce(release.promise) }
		const scanner = createScanner({ onWatcherEvent });
		scanner.schedule(NodeTargetEvent.CHANGE);
		if (phase !== 'microtask') {
			await vi.advanceTimersByTimeAsync(0);
			scanner.schedule(NodeTargetEvent.RENAME);
		}
		expect(vi.getTimerCount()).toBe(phase === 'timer' ? 1 : 0);
		const scansBefore = vi.mocked(FileSystem.readDirectory).mock.calls.length;
		onWatcherEvent.mockClear();
		scanner.close();
		scanner.close();
		expect(vi.getTimerCount()).toBe(0);
		release.resolve(new FileSystemEntries().addFile(join(root, 'late.txt')));
		await vi.advanceTimersByTimeAsync(100);
		expect(FileSystem.readDirectory).toHaveBeenCalledTimes(scansBefore);
		expect(onWatcherEvent).not.toHaveBeenCalled();
	});

	it('preserves read settings and cancels an in-flight read on disposal', async () => {
		const release = Promise.withResolvers<FileSystemEntries>();
		vi.mocked(FileSystem.readDirectory).mockReturnValueOnce(release.promise);
		const ignore = vi.fn(() => false);
		const readOptions = { recursive: false, followSymlinks: false, signal: controller.signal, ignore };
		const onWatcherEvent = vi.fn();
		const scanner = createScanner({ readOptions, onWatcherEvent });
		scanner.schedule(NodeTargetEvent.CHANGE);
		await vi.advanceTimersByTimeAsync(0);
		expect(FileSystem.readDirectory).toHaveBeenCalledWith(root, { ...readOptions, signal: expect.any(AbortSignal) });
		const signal = vi.mocked(FileSystem.readDirectory).mock.calls[0]![1]!.signal!;
		expect(signal.aborted).toBe(false);
		scanner.close();
		expect(signal.aborted).toBe(true);
		expect(controller.signal.aborted).toBe(false);
		release.resolve(new FileSystemEntries().addFile(join(root, 'late.txt')));
		await vi.advanceTimersByTimeAsync(0);
		expect(onWatcherEvent).not.toHaveBeenCalled();
	});

	it('keeps tracked polling and recovers on the next request after a transient snapshot failure', async () => {
		vi.mocked(FileSystem.readDirectory).mockRejectedValueOnce(new Error('transient read failure'));
		const onWatcherEvent = vi.fn();
		const scanner = createScanner({ trackedPaths: () => [ root ], onWatcherEvent });
		scanner.reconcile(NodeTargetEvent.CHANGE);
		expect(onWatcherEvent.mock.calls).toEqual([ [ NodeTargetEvent.CHANGE, root ] ]);
		await vi.advanceTimersByTimeAsync(0);
		expect(onWatcherEvent).toHaveBeenCalledTimes(1);
		scanner.schedule(NodeTargetEvent.RENAME);
		await vi.advanceTimersByTimeAsync(25);
		expect(FileSystem.readDirectory).toHaveBeenCalledTimes(2);
		expect(onWatcherEvent.mock.calls).toEqual([ [ NodeTargetEvent.CHANGE, root ], [ NodeTargetEvent.RENAME, root ] ]);
	});

	it('supports scope disposal and cannot schedule more work afterward', async () => {
		const onWatcherEvent = vi.fn();
		const scanner = createScanner({ trackedPaths: () => [ root ], onWatcherEvent });
		const close = vi.spyOn(scanner, 'close');
		{
			using scopedScanner = scanner;
			scopedScanner.schedule(NodeTargetEvent.CHANGE);
		}
		expect(close).toHaveBeenCalledOnce();
		scanner.schedule(NodeTargetEvent.RENAME);
		scanner.reconcile(NodeTargetEvent.RENAME);
		await vi.advanceTimersByTimeAsync(100);
		expect(FileSystem.readDirectory).not.toHaveBeenCalled();
		expect(onWatcherEvent).not.toHaveBeenCalled();
		expect(controller.signal.aborted).toBe(false);
	});

	it('omits an ignored root from the snapshot', async () => {
		const onWatcherEvent = vi.fn();
		const scanner = createScanner({ isIgnored: () => true, onWatcherEvent });
		scanner.reconcile(NodeTargetEvent.CHANGE);
		await vi.advanceTimersByTimeAsync(0);
		expect(FileSystem.readDirectory).toHaveBeenCalledTimes(1);
		expect(onWatcherEvent).not.toHaveBeenCalled();
	});
});

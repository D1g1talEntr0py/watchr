import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileSystemEvent, NodeTargetEvent } from '../src/constants';
import { FileSystemEventManager } from '../src/file-system-event-manager';
import { FileSystemStateManager } from '../src/file-system-state-manager';
import { Watchr } from '../src/watchr';
import type { WatchrConfig, WatchrOptions } from '../src/@types';

const tmpDir = resolve(__dirname, '.tmp', 'file-system-event-manager');
const defaultOptions: WatchrOptions = {
	persistent: false,
	recursive: false,
	renameTimeout: 100,
	ignore: (() => false),
	ignoreInitial: true,
};

class MockWatcher extends EventEmitter {
	closed: boolean = false;

	close(): void {
		this.closed = true;
	}
}

describe('FileSystemEventManager', () => {
	let watchr: Watchr;
	let poller: FileSystemStateManager;
	let watcher: MockWatcher;

	beforeAll(async () => {
		await fs.mkdir(tmpDir, { recursive: true });
	});

	afterAll(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	beforeEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		await fs.mkdir(tmpDir, { recursive: true });
		watchr = new Watchr();
		poller = new FileSystemStateManager();
		watcher = new MockWatcher();
		await watchr.readyLock;
	});

	afterEach(() => {
		watchr.close();
		vi.restoreAllMocks();
	});

	it('creates and cleans up without relying on internals', async () => {
		const manager = await FileSystemEventManager.newInstance(poller, watchr, {
			watcher: watcher as unknown as WatchrConfig['watcher'],
			options: defaultOptions,
			folderPath: tmpDir,
		});

		expect(manager).toBeInstanceOf(FileSystemEventManager);
		expect(watcher.closed).toBe(false);

		manager.cleanup();
		expect(watcher.closed).toBe(true);
	});

	it('sanitizes watcher errors before emitting', async () => {
		await FileSystemEventManager.newInstance(poller, watchr, {
			watcher: watcher as unknown as WatchrConfig['watcher'],
			options: defaultOptions,
			folderPath: tmpDir,
		});

		const errorPromise = new Promise<Error>((resolveError) => {
			watchr.once('error', resolveError);
		});

		const rawError = new Error('raw details') as NodeJS.ErrnoException;
		rawError.code = 'ENOENT';
		watcher.emit('error', rawError);

		const emittedError = await errorPromise;
		expect(emittedError.message).toBe('🚨 Watcher error (ENOENT)');
		expect(emittedError.message).not.toContain('raw details');
		expect((emittedError as NodeJS.ErrnoException).code).toBe('ENOENT');
	});

	it('routes watcher filename callbacks through the configured node handler', async () => {
		const nodeHandler = vi.fn(async () => undefined);
		await FileSystemEventManager.newInstance(poller, watchr, {
			watcher: watcher as unknown as WatchrConfig['watcher'],
			options: defaultOptions,
			folderPath: tmpDir,
			nodeHandler,
		});

		watcher.emit('change', NodeTargetEvent.CHANGE, 'example.txt');
		await Promise.resolve();

		expect(nodeHandler).toHaveBeenCalled();
		expect(nodeHandler).toHaveBeenLastCalledWith(NodeTargetEvent.CHANGE, resolve(tmpDir, 'example.txt'), false);
	});

	it('stops handling watcher callbacks after cleanup', async () => {
		const nodeHandler = vi.fn(async () => undefined);
		const manager = await FileSystemEventManager.newInstance(poller, watchr, {
			watcher: watcher as unknown as WatchrConfig['watcher'],
			options: defaultOptions,
			folderPath: tmpDir,
			nodeHandler,
		});

		manager.cleanup();
		nodeHandler.mockClear();
		watcher.emit('change', NodeTargetEvent.CHANGE, 'ignored.txt');
		await Promise.resolve();

		expect(nodeHandler).not.toHaveBeenCalled();
	});

	describe('batch deduplication', () => {
		/**
		 * Creates an event manager whose poller yields the given events per path,
		 * with the watchr emit/lock sinks mocked so batch output can be captured
		 * @param eventsByPath The file system events the poller should report per absolute path
		 * @returns The capture spies for direct emissions and rename-lock routing
		 */
		async function setupBatchCapture(eventsByPath: Map<string, FileSystemEvent[]>) {
			const emitEventSpy = vi.spyOn(watchr, 'emitEvent').mockImplementation(() => undefined);
			const lockSpy = vi.spyOn(watchr.renameWatchr, 'getLockTargetEvent').mockImplementation(() => undefined);
			vi.spyOn(poller, 'update').mockImplementation(async (targetPath) => eventsByPath.get(targetPath) ?? []);

			await FileSystemEventManager.newInstance(poller, watchr, {
				watcher: watcher as unknown as WatchrConfig['watcher'],
				options: defaultOptions,
				folderPath: tmpDir,
			});

			return { emitEventSpy, lockSpy };
		}

		/**
		 * Emits watcher change callbacks for the given file names within a single turn,
		 * so the paths land in the same event batch
		 * @param fileNames The file names relative to the watched folder
		 */
		function emitBatch(...fileNames: string[]): void {
			for (const fileName of fileNames) {
				watcher.emit('change', NodeTargetEvent.CHANGE, fileName);
			}
		}

		it('collapses duplicate same-priority events for one path into a single emission', async () => {
			const pathA = resolve(tmpDir, 'a.txt');
			const pathB = resolve(tmpDir, 'b.txt');
			const { emitEventSpy } = await setupBatchCapture(new Map([
				[ pathA, [ FileSystemEvent.CHANGE, FileSystemEvent.CHANGE ] ],
				[ pathB, [ FileSystemEvent.CHANGE ] ],
			]));

			emitBatch('a.txt', 'b.txt');

			await vi.waitFor(() => expect(emitEventSpy).toHaveBeenCalledTimes(2));
			// Give any stray duplicate emission a bounded chance to surface
			await delay(25);

			expect(emitEventSpy).toHaveBeenCalledTimes(2);
			expect(emitEventSpy).toHaveBeenCalledWith(FileSystemEvent.CHANGE, pathA);
			expect(emitEventSpy).toHaveBeenCalledWith(FileSystemEvent.CHANGE, pathB);
		});

		it('keeps only the higher-priority event when a path has competing events in one batch', async () => {
			const pathA = resolve(tmpDir, 'a.txt');
			const pathB = resolve(tmpDir, 'b.txt');
			// CHANGE (priority 3) then ADD (priority 4): ADD must win
			const { emitEventSpy, lockSpy } = await setupBatchCapture(new Map([
				[ pathA, [ FileSystemEvent.CHANGE, FileSystemEvent.ADD ] ],
				[ pathB, [ FileSystemEvent.CHANGE ] ],
			]));

			emitBatch('a.txt', 'b.txt');

			await vi.waitFor(() => expect(lockSpy).toHaveBeenCalledTimes(1));
			await delay(25);

			expect(lockSpy).toHaveBeenCalledWith(FileSystemEvent.ADD, pathA, defaultOptions.renameTimeout, expect.any(Set));
			expect(emitEventSpy).toHaveBeenCalledTimes(1);
			expect(emitEventSpy).toHaveBeenCalledWith(FileSystemEvent.CHANGE, pathB);
			expect(emitEventSpy).not.toHaveBeenCalledWith(FileSystemEvent.CHANGE, pathA);
		});

		it('emits events for all distinct paths in one batch', async () => {
			const paths = [ 'a.txt', 'b.txt', 'c.txt' ].map((fileName) => resolve(tmpDir, fileName));
			const { emitEventSpy } = await setupBatchCapture(new Map(
				paths.map((path) => [ path, [ FileSystemEvent.CHANGE ] ]),
			));

			emitBatch('a.txt', 'b.txt', 'c.txt');

			await vi.waitFor(() => expect(emitEventSpy).toHaveBeenCalledTimes(3));
			await delay(25);

			expect(emitEventSpy).toHaveBeenCalledTimes(3);

			for (const path of paths) {
				expect(emitEventSpy).toHaveBeenCalledWith(FileSystemEvent.CHANGE, path);
			}
		});

		it('passes a single-event batch through unchanged', async () => {
			const pathA = resolve(tmpDir, 'a.txt');
			const { emitEventSpy } = await setupBatchCapture(new Map([
				[ pathA, [ FileSystemEvent.CHANGE ] ],
			]));

			emitBatch('a.txt');

			await vi.waitFor(() => expect(emitEventSpy).toHaveBeenCalledTimes(1));
			await delay(25);

			expect(emitEventSpy).toHaveBeenCalledTimes(1);
			expect(emitEventSpy).toHaveBeenCalledWith(FileSystemEvent.CHANGE, pathA);
		});
	});
});

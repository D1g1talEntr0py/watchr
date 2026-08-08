import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeTargetEvent } from '../src/constants';
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
});

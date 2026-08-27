import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import type { WatchOptions } from 'node:fs';
import { join } from 'node:path';
import { Watchr } from '../src/watchr';

vi.mock('node:fs', async () => {
	const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
	return {
		...actual,
		watch: Object.assign(vi.fn(actual.watch), actual.watch),
	};
});

describe('Watchr fs.watch invocation', () => {
	const testDir = join(__dirname, '.tmp', 'watchr-fs-watch-calls');

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}

		mkdirSync(testDir, { recursive: true });
		vi.clearAllMocks();
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	/**
	 * Returns the fs.watch spy calls made by Watchr itself.
	 * Watchr always passes an AbortSignal; Node's own recursive-watch implementation
	 * also calls fs.watch internally per directory (without a signal) and is filtered out.
	 * @returns The list of Watchr-originated fs.watch calls.
	 */
	function watchrCalls(): Array<[unknown, WatchOptions & { signal?: AbortSignal }]> {
		return vi.mocked(watch).mock.calls
			.map((call) => [call[0], call[1] as WatchOptions & { signal?: AbortSignal }] as [unknown, WatchOptions & { signal?: AbortSignal }])
			.filter(([, options]) => options?.signal instanceof AbortSignal);
	}

	/**
	 * Returns the paths passed to Watchr-originated fs.watch calls.
	 * @returns The list of watched paths.
	 */
	function watchedPaths(): unknown[] {
		return watchrCalls().map(([path]) => path);
	}

	it('should call fs.watch when watching a directory', async () => {
		const watchr = new Watchr(testDir);
		await watchr.readyLock;

		expect(watchrCalls().length).toBeGreaterThan(0);

		watchr.close();
	});

	it('should forward AbortSignal to fs.watch and abort it on close', async () => {
		const watchr = new Watchr(testDir);
		await watchr.readyLock;

		expect(watchrCalls().length).toBeGreaterThan(0);

		const firstCallOptions = watchrCalls()[0]?.[1];
		expect(firstCallOptions).toBeDefined();
		expect(firstCallOptions?.signal).toBeInstanceOf(AbortSignal);
		expect(firstCallOptions?.signal?.aborted).toBe(false);

		watchr.close();

		expect(firstCallOptions?.signal?.aborted).toBe(true);
	});

	it('should not call fs.watch when watchPath is invoked on a closed watcher', async () => {
		const filePath = join(testDir, 'file.txt');
		writeFileSync(filePath, '');

		vi.mocked(watch).mockClear();
		const watchr = new Watchr();
		watchr.close();

		await watchr.watchPath(filePath, {});

		expect(watchrCalls().length).toBe(0);
	});

	it('should watch the parent directory for file targets', async () => {
		const filePath = join(testDir, 'direct-file.txt');
		writeFileSync(filePath, '');

		vi.mocked(watch).mockClear();
		const watchr = new Watchr(filePath);
		await watchr.readyLock;

		expect(watchrCalls().length).toBeGreaterThan(0);
		expect(watchedPaths()[0]).toBe(testDir);

		watchr.close();
	});

	it('should watch paths serially if one is a sub-path of another', async () => {
		const subDir = join(testDir, 'sub');
		const subSubDir = join(subDir, 'subsub');
		mkdirSync(subSubDir, { recursive: true });
		vi.mocked(watch).mockClear();

		const watchr = new Watchr([subDir, subSubDir]);
		await watchr.readyLock;

		expect(watchedPaths()).toContain(subDir);
		expect(watchedPaths()).toContain(subSubDir);

		watchr.close();
	});

	it('should create a single watcher with native recursive watching', async () => {
		const level1 = join(testDir, 'level1');
		const level2 = join(level1, 'level2');
		const level3 = join(level2, 'level3');
		mkdirSync(level3, { recursive: true });
		vi.mocked(watch).mockClear();

		const watchr = new Watchr(testDir, { recursive: true });
		await watchr.readyLock;

		expect(watchedPaths()).toContain(testDir);
		expect(watchedPaths()).not.toContain(level1);
		expect(watchedPaths()).not.toContain(level2);
		expect(watchedPaths()).not.toContain(level3);
		expect(watchrCalls().length).toBe(1);

		watchr.close();
	});

	it('should create only one watcher for non-recursive watching', async () => {
		const level1 = join(testDir, 'level1');
		mkdirSync(level1, { recursive: true });
		vi.mocked(watch).mockClear();

		const watchr = new Watchr(testDir, { recursive: false });
		await watchr.readyLock;

		expect(watchedPaths()).toContain(testDir);
		expect(watchedPaths()).not.toContain(level1);
		expect(watchrCalls().length).toBe(1);

		watchr.close();
	});
});

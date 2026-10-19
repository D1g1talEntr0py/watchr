import { afterEach, describe, expect, it, vi } from 'vitest';
import { stat, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as setAsyncTimeout } from 'node:timers/promises';
import type { TimerOptions } from 'node:timers';
import { FileSystem } from '../src/file-system';
import { cleanupTempRoots, createTempRoot } from './helpers/fs-fixtures';

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>();

	return { ...actual, statSync: vi.fn(actual.statSync), stat: vi.fn(actual.stat) };
});

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();

	return { ...actual, readdir: vi.fn(actual.readdir) };
});

vi.mock('node:timers/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:timers/promises')>();

	return { ...actual, setTimeout: vi.fn(actual.setTimeout) };
});

/**
 * Builds a Node-style error with a `code`.
 * @param code - The error code.
 * @returns The error.
 */
const nodeError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

describe('FileSystem.getStats({ sync: true })', () => {
	afterEach(() => {
		vi.mocked(statSync).mockClear();
		cleanupTempRoots();
	});

	it('returns bigint stats for an existing path without the async path', async () => {
		const root = createTempRoot('watchr-fs-sync-');
		const file = join(root, 'a.txt');
		writeFileSync(file, 'a');

		const stats = await FileSystem.getStats(file, { sync: true });

		expect(typeof stats?.ino).toBe('bigint');
		expect(stats?.isFile()).toBe(true);
		expect(statSync).toHaveBeenCalledTimes(1);
	});

	it('returns undefined for a missing path and for a path below a file (ENOTDIR)', async () => {
		const root = createTempRoot('watchr-fs-sync-');
		const file = join(root, 'a.txt');
		writeFileSync(file, 'a');

		await expect(FileSystem.getStats(join(root, 'missing'), { sync: true })).resolves.toBeUndefined();
		await expect(FileSystem.getStats(join(file, 'child'), { sync: true })).resolves.toBeUndefined();
	});

	it('rejects with AbortError when the signal is already aborted', async () => {
		const root = createTempRoot('watchr-fs-sync-');

		await expect(FileSystem.getStats(root, { sync: true, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
		expect(statSync).not.toHaveBeenCalled();
	});

	it('falls back to the async retrying stat on a retryable error', async () => {
		const root = createTempRoot('watchr-fs-sync-');
		const file = join(root, 'a.txt');
		writeFileSync(file, 'a');
		vi.mocked(statSync).mockImplementationOnce(() => { throw nodeError('EMFILE') });

		const stats = await FileSystem.getStats(file, { sync: true });

		expect(stats?.isFile()).toBe(true);
	});

	it('rethrows a non-retryable error', async () => {
		const root = createTempRoot('watchr-fs-sync-');
		vi.mocked(statSync).mockImplementationOnce(() => { throw nodeError('ELOOP') });

		await expect(FileSystem.getStats(root, { sync: true })).rejects.toMatchObject({ code: 'ELOOP' });
	});
});

describe('FileSystem.getStats timeout', () => {
	afterEach(() => {
		vi.mocked(stat).mockReset();
		cleanupTempRoots();
	});

	it('rejects with sanitized timeout details when the timeout expires', async () => {
		const root = createTempRoot('watchr-fs-timeout-');
		vi.mocked(stat).mockImplementationOnce((_path, _options, _callback) => {});

		await expect(FileSystem.getStats(root, { timeout: 1 })).rejects.toMatchObject({
			name: 'TimeoutError',
			code: 'WATCHR_STAT_TIMEOUT',
			message: 'Stat operation timed out after 1ms',
			cause: { targetPath: root }
		});
	});

	it('preserves AbortError when the caller cancels the operation', async () => {
		const root = createTempRoot('watchr-fs-abort-');
		const controller = new AbortController();
		vi.mocked(stat).mockImplementationOnce((_path, _options, _callback) => {});

		const result = FileSystem.getStats(root, { signal: controller.signal, timeout: 10_000 });
		controller.abort();

		await expect(result).rejects.toMatchObject({ name: 'AbortError' });
	});
});

describe('FileSystem.getStats callback transport', () => {
	afterEach(() => {
		vi.mocked(stat).mockClear();
		vi.mocked(setAsyncTimeout).mockClear();
		vi.useRealTimers();
		vi.restoreAllMocks();
		cleanupTempRoots();
	});

	it('returns bigint stats and confirms missing and ENOTDIR paths', async () => {
		const root = createTempRoot();
		const file = join(root, 'entry.txt');
		writeFileSync(file, 'contents');
		const stats = await FileSystem.getStats(file);
		expect(typeof stats?.ino).toBe('bigint');
		expect(stats?.isFile()).toBe(true);
		await expect(FileSystem.getStats(join(root, 'missing'))).resolves.toBeUndefined();
		await expect(FileSystem.getStats(join(file, 'child'))).resolves.toBeUndefined();
	});

	it('retries a transient callback failure and stops after the retry budget', async () => {
		const root = createTempRoot();
		vi.spyOn(Math, 'random').mockReturnValue(0);
		vi.mocked(stat).mockImplementationOnce((_path, _options, callback) => callback(nodeError('EMFILE'), undefined));
		await expect(FileSystem.getStats(root)).resolves.toBeDefined();
		expect(stat).toHaveBeenCalledTimes(2);
		vi.mocked(stat).mockClear();
		for (let attempt = 0; attempt < 11; attempt++) {
			vi.mocked(stat).mockImplementationOnce((_path, _options, callback) => callback(nodeError('EBUSY'), undefined));
		}
		await expect(FileSystem.getStats(root)).rejects.toMatchObject({ code: 'EBUSY' });
		expect(stat).toHaveBeenCalledTimes(11);
	});

	it('does not retry an indeterminate nonretryable error or invoke stat after pre-abort', async () => {
		const root = createTempRoot();
		vi.mocked(stat).mockImplementationOnce((_path, _options, callback) => callback(nodeError('EIO'), undefined));
		await expect(FileSystem.getStats(root)).rejects.toMatchObject({ code: 'EIO' });
		expect(stat).toHaveBeenCalledTimes(1);
		vi.mocked(stat).mockClear();
		await expect(FileSystem.getStats(root, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
		expect(stat).not.toHaveBeenCalled();
	});

	it('cancels an admitted stat and ignores its late successful callback', async () => {
		const root = createTempRoot();
		const controller = new AbortController();
		const admitted = Promise.withResolvers<void>();
		let complete: (() => void) | undefined;
		vi.mocked(stat).mockImplementationOnce((_path, _options, callback) => {
			complete = () => callback(null, statSync(root, { bigint: true }));
			admitted.resolve();
		});
		const result = FileSystem.getStats(root, { signal: controller.signal });
		const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
		await admitted.promise;
		controller.abort();
		await rejection;
		complete!();
		await expect(FileSystem.getStats(root)).resolves.toBeDefined();
		expect(stat).toHaveBeenCalledTimes(2);
	});

	it.each([ 'EMFILE', 'ENOENT', 'ENOTDIR' ])('ignores late callback %s after timeout and permits subsequent stat work', async (code) => {
		const root = createTempRoot();
		let complete: (() => void) | undefined;
		vi.mocked(stat).mockImplementationOnce((_path, _options, callback) => {
			complete = () => callback(nodeError(code), undefined);
		});
		await expect(FileSystem.getStats(root, { timeout: 1 })).rejects.toMatchObject({ code: 'WATCHR_STAT_TIMEOUT' });
		expect(complete).toBeDefined();
		complete!();
		await expect(FileSystem.getStats(root)).resolves.toBeDefined();
		expect(stat).toHaveBeenCalledTimes(2);
	});

	it.each([ 'ENOENT', 'ENOTDIR' ])('rejects when an admitted %s callback is followed by microtask abort', async (code) => {
		const controller = new AbortController();
		const admitted = Promise.withResolvers<void>();
		let complete: (() => void) | undefined;
		vi.mocked(stat).mockImplementationOnce((_path, _options, callback) => {
			complete = () => callback(nodeError(code), undefined);
			admitted.resolve();
		});
		const result = FileSystem.getStats('/virtual/missing', { signal: controller.signal });
		const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
		await admitted.promise;
		complete!();
		queueMicrotask(() => controller.abort());
		await rejection;
		expect(controller.signal.aborted).toBe(true);
		expect(stat).toHaveBeenCalledTimes(1);
	});

	it.each([ 'ENOENT', 'ENOTDIR', undefined ])('preserves admitted cancellation with abort reason code %s', async (code) => {
		const root = createTempRoot();
		const controller = new AbortController();
		const admitted = Promise.withResolvers<void>();
		let complete: (() => void) | undefined;
		vi.mocked(stat).mockImplementationOnce((_path, _options, callback) => {
			complete = () => callback(nodeError('EIO'), undefined);
			admitted.resolve();
		});
		const result = FileSystem.getStats(root, { signal: controller.signal });
		const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
		await admitted.promise;
		controller.abort(code === undefined ? new Error('custom cancellation') : nodeError(code));
		await rejection;
		expect(stat).toHaveBeenCalledTimes(1);
		complete!();
		await expect(FileSystem.getStats(root)).resolves.toBeDefined();
		expect(stat).toHaveBeenCalledTimes(2);
	});

	it.each([ 'ENOENT', 'ENOTDIR' ])('keeps fully settled %s absence after a later abort', async (code) => {
		const controller = new AbortController();
		vi.mocked(stat).mockImplementationOnce((_path, _options, callback) => callback(nodeError(code), undefined));
		const result = FileSystem.getStats('/virtual/missing', { signal: controller.signal });
		await expect(result).resolves.toBeUndefined();
		controller.abort();
		await expect(result).resolves.toBeUndefined();
		expect(stat).toHaveBeenCalledTimes(1);
	});

	it.each([ 'ENOENT', 'ENOTDIR' ])('confirms %s absence after a retryable callback failure', async (code) => {
		vi.spyOn(Math, 'random').mockReturnValue(0);
		vi.mocked(stat).mockImplementationOnce((_path, _options, callback) => callback(nodeError('EMFILE'), undefined));
		vi.mocked(stat).mockImplementationOnce((_path, _options, callback) => callback(nodeError(code), undefined));
		await expect(FileSystem.getStats('/virtual/missing')).resolves.toBeUndefined();
		expect(stat).toHaveBeenCalledTimes(2);
	});

	it('cancels retry backoff without advancing the clock or leaving a timer', async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, 'random').mockReturnValue(0.8);
		const controller = new AbortController();
		const backoff = Promise.withResolvers<void>();
		vi.mocked(setAsyncTimeout).mockImplementationOnce(async <Value = void>(delay?: number, value?: Value, options?: TimerOptions): Promise<Value> => {
			await new Promise<void>((resolve, reject) => {
				const signal = options?.signal;
				const onAbort = (): void => {
					clearTimeout(timer);
					reject(new DOMException('The operation was aborted', 'AbortError'));
				};
				const timer = setTimeout(() => {
					signal?.removeEventListener('abort', onAbort);
					resolve();
				}, delay);
				if (signal?.aborted) { onAbort() } else { signal?.addEventListener('abort', onAbort, { once: true }) }
				backoff.resolve();
			});
			return value as Value;
		});
		vi.mocked(stat).mockImplementationOnce((_path, _options, callback) => callback(nodeError('EMFILE'), undefined));
		let settled = false;
		const rejection = expect(FileSystem.getStats('/virtual/backoff', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' }).then(() => { settled = true });
		try {
			await backoff.promise;
			expect(setAsyncTimeout).toHaveBeenCalledTimes(1);
			expect(vi.mocked(setAsyncTimeout).mock.calls[0]?.[0]).toBe(80);
			expect(vi.getTimerCount()).toBe(1);
			controller.abort();
			await vi.advanceTimersByTimeAsync(0);
			expect(settled).toBe(true);
			expect(stat).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			controller.abort();
			await vi.runAllTimersAsync();
			await rejection;
		}
	});
});

describe('FileSystem.isSymbolicLink(path, sync)', () => {
	afterEach(() => {
		cleanupTempRoots();
	});

	it('detects links synchronously and treats missing paths as non-links', async () => {
		const root = createTempRoot('watchr-fs-link-');
		const file = join(root, 'a.txt');
		const link = join(root, 'link');
		writeFileSync(file, 'a');
		symlinkSync(file, link);

		await expect(FileSystem.isSymbolicLink(link, true)).resolves.toBe(true);
		await expect(FileSystem.isSymbolicLink(file, true)).resolves.toBe(false);
		await expect(FileSystem.isSymbolicLink(join(root, 'missing'), true)).resolves.toBe(false);
	});
});

describe('FileSystem.readDirectory()', () => {
	afterEach(() => {
		vi.mocked(readdir).mockClear();
		cleanupTempRoots();
	});

	it('uses native recursion when no ignore predicate is provided', async () => {
		const root = createTempRoot('watchr-fs-read-');

		await FileSystem.readDirectory(root);

		expect(readdir).toHaveBeenCalledWith(root, { recursive: true, withFileTypes: true });
	});
});

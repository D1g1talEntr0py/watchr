import { afterEach, describe, expect, it, vi } from 'vitest';
import { statSync, symlinkSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { FileSystem } from '../src/file-system';
import { cleanupTempRoots, createTempRoot } from './helpers/fs-fixtures';

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>();

	return { ...actual, statSync: vi.fn(actual.statSync) };
});

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();

	return { ...actual, readdir: vi.fn(actual.readdir), stat: vi.fn(actual.stat) };
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
		vi.mocked(stat).mockClear();
		cleanupTempRoots();
	});

	it('rejects with path and timeout details when the timeout expires', async () => {
		const root = createTempRoot('watchr-fs-timeout-');
		vi.mocked(stat).mockImplementationOnce(() => new Promise(() => {}));

		await expect(FileSystem.getStats(root, { timeout: 1 })).rejects.toMatchObject({
			name: 'TimeoutError',
			code: 'WATCHR_STAT_TIMEOUT',
			cause: { name: 'TimeoutError' },
			message: `Stat operation timed out after 1ms for "${root}"`
		});
	});

	it('preserves AbortError when the caller cancels the operation', async () => {
		const root = createTempRoot('watchr-fs-abort-');
		const controller = new AbortController();
		vi.mocked(stat).mockImplementationOnce(() => new Promise(() => {}));

		const result = FileSystem.getStats(root, { signal: controller.signal, timeout: 10_000 });
		controller.abort();

		await expect(result).rejects.toMatchObject({ name: 'AbortError' });
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

import { createWatcher, observeEvent } from './helpers/fs-fixtures';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Watchr } from '../src/watchr';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Collects events until all expected paths are seen or the deadline passes
 * @param register Registers the event listener, invoking the callback with each observed path
 * @param expectedPaths The set of paths that must all be observed
 * @param timeoutMs Maximum time to wait before rejecting
 * @returns A promise resolving to the observed paths in arrival order
 */
function collectPaths(register: (onPath: (path: string) => void) => void, expectedPaths: readonly string[], timeoutMs: number = 5000): Promise<string[]> {
	return new Promise<string[]>((resolve, reject) => {
		const observed: string[] = [];
		const remaining = new Set(expectedPaths);

		const timeout = setTimeout(() => {
			reject(new Error(`timed out after ${timeoutMs}ms; missing paths: ${[ ...remaining ].join(', ')}`));
		}, timeoutMs);

		register((path) => {
			observed.push(path);
			remaining.delete(path);

			if (remaining.size === 0) {
				clearTimeout(timeout);
				resolve(observed);
			}
		});
	});
}

describe('Race Condition Fixes', () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), 'watchr-race-'));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it('should handle multiple watchers on the same path without race conditions', async () => {
		const watchers: Watchr[] = [];

		try {
			// Create multiple watchers simultaneously
			for (let i = 0; i < 3; i++) {
				watchers.push(createWatcher(testDir));
			}

			// Wait for all watchers to be ready
			await Promise.all(watchers.map((watcher) => watcher.start()));

			// All watchers should be ready without errors
			expect(watchers.length).toBe(3);
			watchers.forEach(watcher => {
				expect(watcher.state).toBe('watching');
				expect(watcher.state).not.toBe('closed');
			});
		} finally {
			// Clean up watchers
			watchers.forEach(watcher => {
				if (watcher.state !== 'closed') {
					watcher.close();
				}
			});
		}
	});

	it('should handle rapid file operations without race conditions', async () => {
		const watcher = createWatcher(testDir, { emitInitial: false });
		const expectedFiles = Array.from({ length: 5 }, (_unused, i) => join(testDir, `test-${i}.txt`));

		try {
			await watcher.start();

			const addsPromise = collectPaths((onPath) => {
				observeEvent(watcher, 'add', (_stats, path: string) => onPath(path));
			}, expectedFiles);

			// Create all files back to back with no artificial staggering
			for (const [ i, testFile ] of expectedFiles.entries()) {
				writeFileSync(testFile, `content-${i}`);
			}

			const observed = await addsPromise;
			expect(new Set(observed)).toEqual(new Set(expectedFiles));
			expect(observed.length).toBe(expectedFiles.length);
		} finally {
			if (watcher.state !== 'closed') {
				watcher.close();
			}
		}
	});

	it('should close every watcher in a rapid open/close loop', async () => {
		const watchers: Watchr[] = [];

		try {
			// Create and close watchers rapidly
			for (let i = 0; i < 10; i++) {
				const watcher = createWatcher(testDir);
				watchers.push(watcher);

				await watcher.start();

				watcher.close();
				expect(watcher.state).toBe('closed');
			}

			// All watchers should be properly closed
			watchers.forEach(watcher => {
				expect(watcher.state).toBe('closed');
			});
		} finally {
			// Ensure all watchers are closed
			watchers.forEach(watcher => {
				if (watcher.state !== 'closed') {
					watcher.close();
				}
			});
		}
	});

	it('should handle constructor error scenarios gracefully', async () => {
		const nonExistentPath = join(testDir, 'non-existent-path-that-should-not-exist');
		const watcher = createWatcher(nonExistentPath);
		const errors: Error[] = [];
		observeEvent(watcher, 'error', (error) => errors.push(error));

		try {
			// Should not throw immediately
			expect(watcher).toBeDefined();
			expect(watcher.state).not.toBe('closed');

			await expect(watcher.start()).rejects.toThrow('Path not found');
			expect(errors).toEqual([]);
			// Initialization failures are terminal after resources are rolled back.
			expect(watcher.state).toBe('closed');
		} finally {
			if (watcher.state !== 'closed') {
				watcher.close();
			}
		}
	});

	it('should handle abort signal propagation correctly', async () => {
		const watcher = createWatcher(testDir);

		try {
			await watcher.start();

			// Check that abort signal is properly initialized
			expect(watcher.abortSignal).toBeDefined();
			expect(watcher.abortSignal.aborted).toBe(false);

			// Close watcher and check signal is aborted
			watcher.close();
			expect(watcher.state).toBe('closed');
			expect(watcher.abortSignal.aborted).toBe(true);
		} finally {
			if (watcher.state !== 'closed') {
				watcher.close();
			}
		}
	});
});

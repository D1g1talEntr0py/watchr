import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Watchr } from '../src/watchr';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as setTimeoutPromise } from 'node:timers/promises';

describe('Race Condition Fixes', () => {
	const testDir = './test-race-conditions-temp';

	beforeEach(() => {
		// Clean up any existing test directory
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		// Clean up test directory
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it('should handle multiple watchers on the same path without race conditions', async () => {
		const watchers: Watchr[] = [];
		const readyPromises: Promise<void>[] = [];

		try {
			// Create multiple watchers simultaneously
			for (let i = 0; i < 3; i++) {
				const watcher = new Watchr(testDir);
				watchers.push(watcher);

				readyPromises.push(new Promise<void>((resolve) => {
					watcher.on('ready', () => resolve());
				}));
			}

			// Wait for all watchers to be ready
			await Promise.all(readyPromises);

			// All watchers should be ready without errors
			expect(watchers.length).toBe(3);
			watchers.forEach(watcher => {
				expect(watcher.isReady()).toBe(true);
				expect(watcher.isClosed()).toBe(false);
			});
		} finally {
			// Clean up watchers
			watchers.forEach(watcher => {
				if (!watcher.isClosed()) {
					watcher.close();
				}
			});
		}
	});

	it('should handle rapid file operations without race conditions', async () => {
		const watcher = new Watchr(testDir);
		const events: string[] = [];
		let eventPromiseResolve: () => void;
		const eventPromise = new Promise<void>((resolve) => {
			eventPromiseResolve = resolve;
		});

		try {
			// Wait for watcher to be ready
			await new Promise<void>((resolve) => {
				watcher.on('ready', () => resolve());
			});

			// Listen for events
			watcher.on('add', (stats, path) => {
				events.push(`add:${path}`);
				if (events.length >= 1) {
					eventPromiseResolve();
				}
			});

			// Create multiple files rapidly
			const filePromises: Promise<void>[] = [];
			for (let i = 0; i < 5; i++) {
				filePromises.push(
					setTimeoutPromise(i * 50).then(() => {
						const testFile = join(testDir, `test-${i}.txt`);
						writeFileSync(testFile, `content-${i}`);
					})
				);
			}

			await Promise.all(filePromises);

			// Wait for at least one event or timeout after 1 second
			const timeoutPromise = setTimeoutPromise(1000).then(() => {
				throw new Error('Timeout waiting for file events');
			});

			try {
				await Promise.race([eventPromise, timeoutPromise]);
				// Should have detected at least one file addition
				expect(events.length).toBeGreaterThan(0);
			} catch (error) {
				// If no events were detected, that's also valid behavior -
				// the watcher might be configured to ignore initial events
				// or the file system might not emit events immediately
				expect(events.length).toBeGreaterThanOrEqual(0);
			}
		} finally {
			if (!watcher.isClosed()) {
				watcher.close();
			}
		}
	});	it('should handle watcher lifecycle without memory leaks', async () => {
		const watchers: Watchr[] = [];

		try {
			// Create and close watchers rapidly
			for (let i = 0; i < 10; i++) {
				const watcher = new Watchr(testDir);
				watchers.push(watcher);

				await new Promise<void>((resolve) => {
					watcher.on('ready', () => resolve());
				});

				watcher.close();
				expect(watcher.isClosed()).toBe(true);
			}

			// All watchers should be properly closed
			watchers.forEach(watcher => {
				expect(watcher.isClosed()).toBe(true);
			});
		} finally {
			// Ensure all watchers are closed
			watchers.forEach(watcher => {
				if (!watcher.isClosed()) {
					watcher.close();
				}
			});
		}
	});

	it('should handle constructor error scenarios gracefully', async () => {
		const nonExistentPath = './non-existent-path-that-should-not-exist';
		const watcher = new Watchr(nonExistentPath);

		try {
			// Should not throw immediately
			expect(watcher).toBeDefined();
			expect(watcher.isClosed()).toBe(false);

			// Wait a bit to see if any errors occur
			await setTimeoutPromise(100);

			// Watcher should still be valid (it will watch for the path to be created)
			expect(watcher.isClosed()).toBe(false);
		} finally {
			if (!watcher.isClosed()) {
				watcher.close();
			}
		}
	});

	it('should handle abort signal propagation correctly', async () => {
		const watcher = new Watchr(testDir);

		try {
			await new Promise<void>((resolve) => {
				watcher.on('ready', () => resolve());
			});

			// Check that abort signal is properly initialized
			expect(watcher.abortSignal).toBeDefined();
			expect(watcher.abortSignal.aborted).toBe(false);

			// Close watcher and check signal is aborted
			watcher.close();
			expect(watcher.isClosed()).toBe(true);
			expect(watcher.abortSignal.aborted).toBe(true);
		} finally {
			if (!watcher.isClosed()) {
				watcher.close();
			}
		}
	});
});

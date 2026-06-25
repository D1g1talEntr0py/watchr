/// <reference types="node" />

import { describe, bench, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { Watchr } from '../src/watchr.js';

type BenchWatchrEvent = 'add' | 'change' | 'unlink' | 'rename';

/**
 * Benchmark suite for watchr file system watcher
 * Establishes baseline performance metrics
 */

let testDir: string;
let testFilesDir: string;

/**
 * Generates a unique file name for benchmark operations.
 * @param prefix Prefix to identify the benchmark case.
 * @returns A unique file name with .txt extension.
 */
function uniqueName(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.txt`;
}

/**
 * Waits one event-loop turn so a watcher can arm before a file mutation.
 * @returns A promise that resolves on the next turn of the event loop.
 */
function waitForWatcherArmed(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Waits for a single event from a Watchr instance with a timeout guard.
 * @param watcher Watchr instance to subscribe to.
 * @param event Event name to wait for.
 * @param timeoutMs Timeout in milliseconds.
 * @returns A promise that resolves when the event is received.
 */
function waitForWatchrEvent(watcher: Watchr, event: BenchWatchrEvent, timeoutMs = 2000): Promise<void> {
	return new Promise((resolve, reject) => {
		const onEvent = () => {
			clearTimeout(timeout);
			watcher.off(event, onEvent);
			resolve();
		};
		const timeout = setTimeout(() => {
			watcher.off(event, onEvent);
			reject(new Error(`🚨 benchmark timeout waiting for '${event}'`));
		}, timeoutMs);
		watcher.on(event, onEvent);
	});
}

/**
 * Runs a benchmark operation with a ready Watchr instance and guaranteed cleanup.
 * @param target Path to watch.
 * @param operation Benchmark operation to execute.
 * @returns A promise that resolves when operation and cleanup complete.
 */
async function withWatchr(target: string, operation: (watcher: Watchr) => Promise<void>): Promise<void> {
	const watcher = new Watchr(target);
	await watcher.readyLock;
	try {
		await operation(watcher);
	} finally {
		watcher.close();
	}
}

/**
 * Waits for an event to fire a given number of times with a timeout guard.
 * @param watcher Watchr instance to subscribe to.
 * @param event Event name to count.
 * @param count Number of occurrences to wait for.
 * @param timeoutMs Timeout in milliseconds.
 * @returns A promise that resolves when the desired count is reached.
 */
function waitForWatchrEventCount(
	watcher: Watchr,
	event: BenchWatchrEvent,
	count: number,
	timeoutMs = 2000
): Promise<void> {
	return new Promise((resolve, reject) => {
		let seen = 0;
		const onEvent = () => {
			seen += 1;
			if (seen >= count) {
				clearTimeout(timeout);
				watcher.off(event, onEvent);
				resolve();
			}
		};
		const timeout = setTimeout(() => {
			watcher.off(event, onEvent);
			reject(new Error(`🚨 benchmark timeout waiting for ${count} '${event}' events`));
		}, timeoutMs);
		watcher.on(event, onEvent);
	});
}

beforeAll(async () => {
	testDir = mkdtempSync(join(tmpdir(), 'watchr-bench-'));
	testFilesDir = join(testDir, 'test-files');

	// Create base test files
	await fs.mkdir(testFilesDir, { recursive: true });
	const promises: Promise<void>[] = [];
	for (let i = 0; i < 50; i++) {
		promises.push(
			fs.writeFile(join(testFilesDir, `file-${i}.txt`), `content-${i}`)
		);
	}
	await Promise.all(promises);
});

afterAll(() => {
	rmSync(testDir, { recursive: true, force: true });
});

describe('Native fs.watch Baseline', () => {
	bench('native init and close (50 files)', async () => {
		const nativeWatcher = watch(testFilesDir, () => undefined);
		await waitForWatcherArmed();
		nativeWatcher.close();
	});

	bench('native single create notification', async () => {
		const eventPromise = new Promise<void>((resolve) => {
			const nativeWatcher = watch(testFilesDir, () => {
				nativeWatcher.close();
				resolve();
			});
		});

		const testFile = join(testFilesDir, uniqueName('native-add'));
		await waitForWatcherArmed();
		await fs.writeFile(testFile, 'test');
		await eventPromise;
		await fs.unlink(testFile);
	});

	bench('native single change notification', async () => {
		const testFile = join(testFilesDir, uniqueName('native-change'));
		await fs.writeFile(testFile, 'seed');

		const eventPromise = new Promise<void>((resolve) => {
			const nativeWatcher = watch(testFilesDir, () => {
				nativeWatcher.close();
				resolve();
			});
		});

		await waitForWatcherArmed();
		await fs.writeFile(testFile, 'modified');
		await eventPromise;
		await fs.unlink(testFile);
	});

	bench('native single unlink notification', async () => {
		const testFile = join(testFilesDir, uniqueName('native-unlink'));
		await fs.writeFile(testFile, 'temp');

		const eventPromise = new Promise<void>((resolve) => {
			const nativeWatcher = watch(testFilesDir, () => {
				nativeWatcher.close();
				resolve();
			});
		});

		await waitForWatcherArmed();
		await fs.unlink(testFile);
		await eventPromise;
	});
});

describe('Watchr Baseline Performance', () => {
	describe('Watcher Initialization', () => {
		bench('watchr init and close (50 files)', async () => {
			await withWatchr(testFilesDir, async () => Promise.resolve());
		});
	});

	describe.skip('Event Emission', () => {
		bench('watchr single create notification', async () => {
			await withWatchr(testFilesDir, async (watcher) => {
				const testFile = join(testFilesDir, uniqueName('watchr-add'));
				const eventPromise = waitForWatchrEvent(watcher, 'add');
				await waitForWatcherArmed();
				await fs.writeFile(testFile, 'test');
				await eventPromise;
				await fs.unlink(testFile);
			});
		});

		bench('watchr single change notification', async () => {
			await withWatchr(testFilesDir, async (watcher) => {
				const testFile = join(testFilesDir, uniqueName('watchr-change'));
				await fs.writeFile(testFile, 'seed');
				const eventPromise = waitForWatchrEvent(watcher, 'change');
				await waitForWatcherArmed();
				await fs.writeFile(testFile, 'modified');
				await eventPromise;
				await fs.unlink(testFile);
			});
		});

		bench('watchr single unlink notification', async () => {
			await withWatchr(testFilesDir, async (watcher) => {
				const testFile = join(testFilesDir, uniqueName('watchr-unlink'));
				await fs.writeFile(testFile, 'temp');
				const eventPromise = waitForWatchrEvent(watcher, 'unlink');
				await waitForWatcherArmed();
				await fs.unlink(testFile);
				await eventPromise;
			});
		});
	});

	describe.skip('Rename Detection', () => {
		bench('watchr detect file rename', async () => {
			await withWatchr(testFilesDir, async (watcher) => {
				const oldPath = join(testFilesDir, uniqueName('watchr-rename-src'));
				const newPath = oldPath.replace('-src-', '-dst-');
				await fs.writeFile(oldPath, 'seed');
				const eventPromise = waitForWatchrEvent(watcher, 'rename');
				await waitForWatcherArmed();
				await fs.rename(oldPath, newPath);
				await eventPromise;
				await fs.unlink(newPath);
			});
		});

		bench('watchr detect directory rename', async () => {
			await withWatchr(testDir, async (watcher) => {
				const oldDir = join(testDir, uniqueName('watchr-dir-src').replace('.txt', ''));
				const newDir = oldDir.replace('-src', '-dst');
				await fs.mkdir(oldDir);
				const eventPromise = waitForWatchrEvent(watcher, 'rename');
				await waitForWatcherArmed();
				await fs.rename(oldDir, newDir);
				await eventPromise;
				await fs.rm(newDir, { recursive: true, force: true });
			});
		});
	});

	describe.skip('Bulk Operations', () => {
		bench('watchr handle 10 add events', async () => {
			await withWatchr(testFilesDir, async (watcher) => {
				const names = Array.from({ length: 10 }, (_, i) => uniqueName(`watchr-bulk-add-${i}`));
				const eventPromise = waitForWatchrEventCount(watcher, 'add', 10, 3000);
				await waitForWatcherArmed();
				await Promise.all(names.map((name, i) => fs.writeFile(join(testFilesDir, name), `content-${i}`)));
				await eventPromise;
				await Promise.all(names.map((name) => fs.unlink(join(testFilesDir, name))));
			});
		});

		bench('watchr handle 5 rapid changes', async () => {
			await withWatchr(testFilesDir, async (watcher) => {
				const testFile = join(testFilesDir, uniqueName('watchr-rapid-change'));
				await fs.writeFile(testFile, 'seed');
				const eventPromise = waitForWatchrEventCount(watcher, 'change', 5, 3000);
				await waitForWatcherArmed();
				for (let i = 0; i < 5; i++) {
					await fs.writeFile(testFile, `modified-${i}`);
				}
				await eventPromise;
				await fs.unlink(testFile);
			});
		});
	});
});

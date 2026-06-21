import { describe, bench, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Watchr from '../src/watchr.js';

/**
 * Benchmark suite for watchr file system watcher
 * Establishes baseline performance metrics
 */

let testDir: string;
let testFilesDir: string;

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

describe('Watchr Baseline Performance', () => {
	describe('Watcher Initialization', () => {
		bench('init (50 files)', async () => {
			const watcher = new Watchr(testFilesDir);
			await watcher.ready;
			await watcher.close();
		});

		bench('init and close', async () => {
			const watcher = new Watchr(testFilesDir);
			await watcher.ready;
			await watcher.close();
		});
	});

	describe('Event Emission', () => {
		bench('single add event', async () => {
			const watcher = new Watchr(testFilesDir);
			await watcher.ready;

			const eventPromise = new Promise<void>((resolve) => {
				watcher.on('add', () => {
					resolve();
				});
			});

			const testFile = join(testFilesDir, 'bench-add.txt');
			await fs.writeFile(testFile, 'test');
			await eventPromise;
			await fs.unlink(testFile);
			await watcher.close();
		});

		bench('single change event', async () => {
			const watcher = new Watchr(testFilesDir);
			await watcher.ready;

			const testFile = join(testFilesDir, 'file-0.txt');

			const eventPromise = new Promise<void>((resolve) => {
				watcher.on('change', () => {
					resolve();
				});
			});

			await fs.writeFile(testFile, 'modified');
			await eventPromise;
			await fs.writeFile(testFile, 'content-0');
			await watcher.close();
		});

		bench('single unlink event', async () => {
			const watcher = new Watchr(testFilesDir);
			await watcher.ready;

			const testFile = join(testFilesDir, 'bench-unlink.txt');
			await fs.writeFile(testFile, 'temp');

			const eventPromise = new Promise<void>((resolve) => {
				watcher.on('unlink', () => {
					resolve();
				});
			});

			await fs.unlink(testFile);
			await eventPromise;
			await watcher.close();
		});
	});

	describe('Rename Detection', () => {
		bench('detect file rename', async () => {
			const watcher = new Watchr(testFilesDir);
			await watcher.ready;

			const eventPromise = new Promise<void>((resolve) => {
				watcher.on('rename', () => {
					resolve();
				});
			});

			const oldPath = join(testFilesDir, 'file-0.txt');
			const newPath = join(testFilesDir, 'file-0-renamed.txt');
			await fs.rename(oldPath, newPath);

			await eventPromise;
			await fs.rename(newPath, oldPath);
			await watcher.close();
		});

		bench('detect directory rename', async () => {
			const watcher = new Watchr(testDir);
			await watcher.ready;

			const oldDir = join(testDir, 'old-dir');
			const newDir = join(testDir, 'new-dir');
			await fs.mkdir(oldDir);

			const eventPromise = new Promise<void>((resolve) => {
				watcher.on('rename', () => {
					resolve();
				});
			});

			await fs.rename(oldDir, newDir);
			await eventPromise;
			await fs.rmdir(newDir);
			await watcher.close();
		});
	});

	describe('Bulk Operations', () => {
		bench('handle 10 add events', async () => {
			const watcher = new Watchr(testFilesDir);
			await watcher.ready;

			let count = 0;
			const eventPromise = new Promise<void>((resolve) => {
				watcher.on('add', () => {
					count++;
					if (count >= 10) resolve();
				});
			});

			const promises: Promise<void>[] = [];
			for (let i = 0; i < 10; i++) {
				promises.push(
					fs.writeFile(join(testFilesDir, `bulk-add-${i}.txt`), `content-${i}`)
				);
			}
			await Promise.all(promises);

			await eventPromise;

			// Cleanup
			for (let i = 0; i < 10; i++) {
				await fs.unlink(join(testFilesDir, `bulk-add-${i}.txt`));
			}
			await watcher.close();
		});

		bench('handle 5 rapid changes', async () => {
			const watcher = new Watchr(testFilesDir);
			await watcher.ready;

			let count = 0;
			const eventPromise = new Promise<void>((resolve) => {
				watcher.on('change', () => {
					count++;
					if (count >= 5) resolve();
				});
			});

			const testFile = join(testFilesDir, 'file-0.txt');
			for (let i = 0; i < 5; i++) {
				await fs.writeFile(testFile, `modified-${i}`);
			}

			await eventPromise;
			await fs.writeFile(testFile, 'content-0');
			await watcher.close();
		});
	});
});

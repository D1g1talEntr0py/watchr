import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Watchr } from '../src/watchr';

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('Watchr integration', () => {
	it('emits add events for the built package entry point', async () => {
		const watchDir = mkdtempSync(join(tmpdir(), 'watchr-integration-'));
		tempDirs.push(watchDir);

		const watcher = new Watchr(watchDir, { persistent: true, ignoreInitial: true });

		try {
			await watcher.readyLock;

			const eventPromise = new Promise<string>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error('timed out waiting for add event')), 2000);

				watcher.once('add', (_stats, targetPath) => {
					clearTimeout(timeout);
					resolve(targetPath);
				});
			});

			writeFileSync(join(watchDir, 'hello.txt'), 'hi');
			const emittedPath = await eventPromise;

			expect(emittedPath).toBe(join(watchDir, 'hello.txt'));
		} finally {
			watcher.close();
			await delay(50);
		}
	});
});

/// <reference types="node" />
// Micro-benchmarks for watchr's per-event and initial-scan hot paths, built from `src/` on the fly.
// Usage: node tests/benchmarks/watchr.bench.ts
// End-to-end latency, readiness and memory against other watchers live in compare.ts.

import { build } from 'esbuild';
import { bench, do_not_optimize, group, run, summary } from 'mitata';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFlat } from './helpers.ts';

type Internals = {
	FileSystem: typeof import('../../src/file-system.ts').FileSystem,
	FileSystemStateManager: typeof import('../../src/file-system-state-manager.ts').FileSystemStateManager,
	Watchr: typeof import('../../src/watchr.ts').Watchr,
	WatchrStats: typeof import('../../src/watchr-stats.ts').WatchrStats
};

// `dist/` exposes only the public API, so bundle the internals straight from source.
const { outputFiles: [ bundle ] } = await build({
	stdin: {
		contents: [ 'file-system', 'file-system-state-manager', 'watchr', 'watchr-stats' ].map((module) => `export * from './src/${module}';`).join('\n'),
		resolveDir: new URL('../..', import.meta.url).pathname,
		loader: 'ts'
	},
	bundle: true,
	write: false,
	format: 'esm',
	platform: 'node',
	target: 'esnext'
});
const { FileSystem, FileSystemStateManager, Watchr, WatchrStats } = await import(`data:text/javascript;base64,${Buffer.from(bundle!.text).toString('base64')}`) as Internals;

const root = mkdtempSync(join(tmpdir(), 'watchr-bench-'));
const target = join(root, 'target.txt');
const scanRoot = join(root, 'scan');
const scanFiles = 1_000;
writeFileSync(target, 'payload');
mkdirSync(scanRoot);
buildFlat(scanRoot, scanFiles);

const nativeStats = statSync(target, { bigint: true });
const snapshot = WatchrStats.fromStats(nativeStats);
const sameSnapshot = WatchrStats.fromStats(statSync(target, { bigint: true }));
const stateManager = new FileSystemStateManager();
await stateManager.update(target);

group('WatchrStats (per event)', () => {
	bench('WatchrStats.fromStats', () => do_not_optimize(WatchrStats.fromStats(nativeStats)));
	bench('WatchrStats#equals', () => do_not_optimize(snapshot.equals(sameSnapshot)));
});

summary(() => {
	group('stat a changed path (per event)', () => {
		bench('fs.promises.stat (bigint)', () => stat(target, { bigint: true })).baseline();
		bench('FileSystem.getStats', () => FileSystem.getStats(target, { timeout: 1_000 }));
		bench('FileSystemStateManager.update', () => stateManager.update(target, { timeout: 1_000 }));
	});
});

summary(() => {
	group(`initial scan (${scanFiles} files)`, () => {
		bench('fs.promises.readdir (recursive)', () => readdir(scanRoot, { recursive: true, withFileTypes: true })).baseline();
		bench('FileSystem.readDirectory', () => FileSystem.readDirectory(scanRoot));
		bench('new Watchr() until ready', async () => {
			const watcher = new Watchr(scanRoot, { ignoreInitial: true });
			await watcher.readyLock;
			watcher.close();
		});
	});
});

try {
	await run();
} finally {
	rmSync(root, { recursive: true, force: true });
}

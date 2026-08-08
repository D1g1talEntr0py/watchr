/// <reference types="node" />

import { bench, group, run } from 'mitata';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSystem } from '../dist/file-system.js';
import { FileSystemEventManager } from '../dist/file-system-event-manager.js';
import { FileSystemStateManager } from '../dist/file-system-state-manager.js';
import { NodeTargetEvent } from '../dist/constants.js';
import { Watchr } from '../dist/watchr.js';
import { timeout } from '../dist/decorators/timeout.js';
import type { WatchrOptions } from '../src/@types/index.js';

const startupFileCount = 50;
const fallbackDirectoryCount = 10;
const fallbackFilesPerDirectory = 100;

const benchmarkRoot = mkdtempSync(join(tmpdir(), 'watchr-diagnostics-'));
const startupRoot = join(benchmarkRoot, 'startup');
const fallbackRoot = join(benchmarkRoot, 'fallback');
const statTarget = join(benchmarkRoot, 'stat-target.txt');

const watchOptions: WatchrOptions = {
	ignoreInitial: true,
	renameTimeout: 0,
};

const benchmarkNames = {
	nativeStartup: `native watcher create and close (${startupFileCount} files)`,
	watchrStartup: `watchr ready and close (${startupFileCount} files)`,
	fallbackScan: `empty-name fallback scan (${fallbackDirectoryCount * fallbackFilesPerDirectory} files)`,
	rawStat: 'raw bigint stat',
	timedStat: 'raw bigint stat + timeout decorator',
	watchrStat: 'FileSystem.getStats (queue + timeout)',
} as const;

type StatMethod = (this: object, targetPath: string) => ReturnType<typeof fs.stat>;

const statMethod: StatMethod = function(targetPath) {
	return fs.stat(targetPath, { bigint: true });
};
const timedStatMethod = timeout()(statMethod, {} as ClassMethodDecoratorContext<object, StatMethod>);
const statReceiver = {};

function averageNs(result: Awaited<ReturnType<typeof run>>, alias: string): number {
	const trial = result.benchmarks.find((benchmark) => benchmark.alias === alias);
	const stats = trial?.runs[0]?.stats;

	if (stats === undefined) { throw new Error(`🚨 benchmark '${alias}' did not produce stats`) }

	return stats.avg;
}

function formatDuration(nanoseconds: number): string {
	if (nanoseconds >= 1_000_000) { return `${(nanoseconds / 1_000_000).toFixed(3)} ms` }
	if (nanoseconds >= 1_000) { return `${(nanoseconds / 1_000).toFixed(3)} µs` }

	return `${nanoseconds.toFixed(2)} ns`;
}

await fs.mkdir(startupRoot, { recursive: true });
await fs.mkdir(fallbackRoot, { recursive: true });
await fs.writeFile(statTarget, 'stat payload');

await Promise.all(Array.from({ length: startupFileCount }, (_, index) => (
	fs.writeFile(join(startupRoot, `file-${index}.txt`), `content-${index}`)
)));

for (let directoryIndex = 0; directoryIndex < fallbackDirectoryCount; directoryIndex++) {
	const directoryPath = join(fallbackRoot, `dir-${directoryIndex}`);

	await fs.mkdir(directoryPath);
	await Promise.all(Array.from({ length: fallbackFilesPerDirectory }, (_, fileIndex) => (
		fs.writeFile(join(directoryPath, `file-${fileIndex}.txt`), `content-${fileIndex}`)
	)));
}

const fallbackWatchr = new Watchr();
await fallbackWatchr.readyLock;

const fallbackManager = await FileSystemEventManager.newInstance(
	new FileSystemStateManager(),
	fallbackWatchr,
	{
		watcher: watch(fallbackRoot, { recursive: true }, () => undefined),
		options: watchOptions,
		folderPath: fallbackRoot,
	},
);
const runFallbackScan = (fallbackManager as unknown as {
	runDirectoryFallbackScan: (event: NodeTargetEvent) => Promise<void>,
}).runDirectoryFallbackScan.bind(fallbackManager);

group('Corrected Startup Readiness', () => {
	bench(benchmarkNames.nativeStartup, () => {
		const watcher = watch(startupRoot, () => undefined);

		watcher.close();
	}).baseline();

	bench(benchmarkNames.watchrStartup, async () => {
		const watcher = new Watchr(startupRoot, watchOptions);

		await watcher.readyLock;
		watcher.close();
	});
});

group('Ambiguous Event Fallback I/O', () => {
	bench(benchmarkNames.fallbackScan, async () => {
		await runFallbackScan(NodeTargetEvent.CHANGE);
	});
});

group('Per-stat Timeout Overhead', () => {
	bench(benchmarkNames.rawStat, async () => {
		await statMethod.call(statReceiver, statTarget);
	}).baseline();

	bench(benchmarkNames.timedStat, async () => {
		await timedStatMethod.call(statReceiver, statTarget);
	});

	bench(benchmarkNames.watchrStat, async () => {
		await FileSystem.getStats(statTarget);
	});
});

try {
	const result = await run({ throw: true });
	const nativeStartup = averageNs(result, benchmarkNames.nativeStartup);
	const watchrStartup = averageNs(result, benchmarkNames.watchrStartup);
	const fallbackScan = averageNs(result, benchmarkNames.fallbackScan);
	const rawStat = averageNs(result, benchmarkNames.rawStat);
	const timedStat = averageNs(result, benchmarkNames.timedStat);
	const watchrStat = averageNs(result, benchmarkNames.watchrStat);

	console.log('\nDiagnostic Summary:');
	console.log(`- corrected startup readiness: ${(watchrStartup / nativeStartup).toFixed(2)}x native (${formatDuration(watchrStartup)} vs ${formatDuration(nativeStartup)})`);
	console.log(`- 1,000-file empty-name fallback scan: ${formatDuration(fallbackScan)}`);
	console.log(`- timeout decorator overhead: ${(timedStat / rawStat).toFixed(2)}x raw stat (${formatDuration(timedStat)} vs ${formatDuration(rawStat)})`);
	console.log(`- complete FileSystem.getStats overhead: ${(watchrStat / rawStat).toFixed(2)}x raw stat (${formatDuration(watchrStat)} vs ${formatDuration(rawStat)})`);
} finally {
	fallbackManager.cleanup();
	fallbackWatchr.close();
	rmSync(benchmarkRoot, { recursive: true, force: true });
}
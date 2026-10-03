/// <reference types="node" />
// Readiness / retained-memory bench for the initial scan.
// Usage: pnpm build && node --expose-gc tests/benchmarks/readiness.bench.ts [--runs 3] [--json]

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Watchr } from '../../dist/watchr.js';
import { buildFlat, buildNested, median, requireGc, settleHeap, trackedPathCount } from './helpers.ts';

type Scenario = { name: string, build: (root: string) => number };
type Sample = { readyMs: number, bytesPerPath: number, trackedPaths: number, errors: string[] };
type Result = { scenario: string, files: number, trackedPaths: number, readyMs: number, bytesPerPath: number, failures: number, errors: string[] };

const { values } = parseArgs({ options: { runs: { type: 'string', default: '3' }, json: { type: 'boolean', default: false } } });
const runs = Math.max(1, Number(values.runs));
const gc = requireGc();

const scenarios: Scenario[] = [
	{ name: '1k flat', build: (root) => buildFlat(root, 1_000) },
	{ name: '5k flat', build: (root) => buildFlat(root, 5_000) },
	{ name: '20k flat', build: (root) => buildFlat(root, 20_000) },
	{ name: '5k nested (depth 3)', build: (root) => buildNested(root, 10) }
];

/**
 * Opens a watcher on `root`, waits for readiness, and measures time and retained heap.
 * @param root - Directory to watch.
 * @returns The sample, or `undefined` when readiness failed.
 */
async function sample(root: string): Promise<Sample | undefined> {
	await settleHeap(gc);
	const heapBefore = process.memoryUsage().heapUsed;
	const startedAt = performance.now();
	const watcher = new Watchr(root, { ignoreInitial: true });
	const errors: string[] = [];
	watcher.on('error', (error: Error) => errors.push(error.message));
	const ready = await watcher.readyLock.then(() => true, () => false);
	const readyMs = performance.now() - startedAt;

	if (!ready) {
		watcher.close();

		return undefined;
	}

	await settleHeap(gc);
	const heapAfter = process.memoryUsage().heapUsed;
	const trackedPaths = trackedPathCount(root);
	watcher.close();

	return { readyMs, bytesPerPath: (heapAfter - heapBefore) / trackedPaths, trackedPaths, errors };
}

const results: Result[] = [];

for (const scenario of scenarios) {
	const root = mkdtempSync(join(tmpdir(), 'watchr-readiness-'));

	try {
		const files = scenario.build(root);
		const samples: Sample[] = [];
		let failures = 0;

		for (let run = 0; run < runs; run++) {
			const result = await sample(root);

			if (result === undefined) {
				failures++;
			} else {
				samples.push(result);
			}
		}

		results.push({
			scenario: scenario.name,
			files,
			trackedPaths: samples[0]?.trackedPaths ?? 0,
			readyMs: samples.length ? median(samples.map((entry) => entry.readyMs)) : Number.NaN,
			bytesPerPath: samples.length ? median(samples.map((entry) => entry.bytesPerPath)) : Number.NaN,
			failures,
			errors: [ ...new Set(samples.flatMap((entry) => entry.errors)) ]
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

if (values.json) {
	console.log(JSON.stringify(results, null, 2));
} else {
	console.log(`readiness bench (median of ${runs}; maxConcurrentStats=${process.env.WATCHR_MAX_CONCURRENT_STATS ?? 'default'})`);
	console.log('scenario              files  tracked  ready ms  B/path  failures');

	for (const result of results) {
		console.log(`${result.scenario.padEnd(21)} ${String(result.files).padStart(5)}  ${String(result.trackedPaths).padStart(7)}  ${result.readyMs.toFixed(0).padStart(8)}  ${result.bytesPerPath.toFixed(0).padStart(6)}  ${String(result.failures).padStart(8)}${result.errors.length ? `  errors: ${result.errors.join(' | ')}` : ''}`);
	}
}

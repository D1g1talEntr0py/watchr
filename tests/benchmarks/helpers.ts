/// <reference types="node" />
// Fixture builders and measurement helpers shared by the benchmark scripts.

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Returns the number of paths in a benchmark fixture, including its root.
 * @param root The benchmark fixture directory.
 * @returns The path count.
 */
export function trackedPathCount(root: string): number {
	return readdirSync(root, { recursive: true }).length + 1;
}

/**
 * Returns the exposed `gc` hook, exiting the process with an explanation when it is missing.
 * @returns A function that forces a full collection.
 */
export function requireGc(): () => void {
	if (typeof globalThis.gc !== 'function') {
		console.error('Run with `node --expose-gc` so retained heap can be measured.');
		process.exit(1);
	}

	const gc = globalThis.gc;

	return () => { gc() };
}

/**
 * Creates `count` empty files directly under `root`.
 * @param root - Directory to populate.
 * @param count - Number of files.
 * @returns The number of files created.
 */
export function buildFlat(root: string, count: number): number {
	for (let index = 0; index < count; index++) {
		writeFileSync(join(root, `f${index}.txt`), '');
	}

	return count;
}

/**
 * Creates a 3-level directory tree (10 × 10 × 5 leaves) with `filesPerLeaf` files in each leaf.
 * @param root - Directory to populate.
 * @param filesPerLeaf - Files per leaf directory.
 * @returns The number of files created.
 */
export function buildNested(root: string, filesPerLeaf: number): number {
	let files = 0;

	for (let a = 0; a < 10; a++) {
		for (let b = 0; b < 10; b++) {
			for (let c = 0; c < 5; c++) {
				const leaf = join(root, `a${a}`, `b${b}`, `c${c}`);
				mkdirSync(leaf, { recursive: true });

				for (let index = 0; index < filesPerLeaf; index++) {
					writeFileSync(join(leaf, `f${index}.txt`), '');
					files++;
				}
			}
		}
	}

	return files;
}

/**
 * Forces two full collections with a pause in between so finalizers and weak refs settle.
 * @param gc - The exposed `gc` hook.
 */
export async function settleHeap(gc: () => void): Promise<void> {
	gc();
	await new Promise((resolve) => setTimeout(resolve, 20));
	gc();
}

/**
 * Nearest-rank percentile of a numeric array.
 * @param numbers - Samples.
 * @param fraction - Percentile in the range 0..1.
 * @returns The percentile value, or `NaN` when there are no samples.
 */
export function percentile(numbers: readonly number[], fraction: number): number {
	if (numbers.length === 0) { return Number.NaN }

	const sorted = [ ...numbers ].sort((left, right) => left - right);
	const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));

	return sorted[rank]!;
}

/**
 * Median of a numeric array.
 * @param numbers - Samples.
 * @returns The median value, or `NaN` when there are no samples.
 */
export function median(numbers: readonly number[]): number {
	if (numbers.length === 0) { return Number.NaN }

	const sorted = [ ...numbers ].sort((left, right) => left - right);
	const middle = sorted.length >> 1;

	return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

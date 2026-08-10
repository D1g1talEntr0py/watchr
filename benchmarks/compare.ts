/// <reference types="node" />

import { bench, group, run } from 'mitata';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync, watch } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Watchr } from '../dist/watchr.js';
import type { WatchrOptions } from '../src/@types/index';

const renameTimeout = 150;

const watchrFastOptions: WatchrOptions = {
	ignoreInitial: true,
	renameTimeout: 0
};

const watchrRenameOptions: WatchrOptions = {
	ignoreInitial: true,
	renameTimeout
};

const watchrRenameRawOptions: WatchrOptions = {
	ignoreInitial: true,
	renameTimeout: 0
};

const warmupDelayMs = 25;
const timeoutMs = 2_000;

const benchmarkRoot = mkdtempSync(join(tmpdir(), 'watchr-native-compare-'));
const coldNativeDir = join(benchmarkRoot, 'cold-native');
const coldWatchrDir = join(benchmarkRoot, 'cold-watchr');
const steadyCreateNativeDir = join(benchmarkRoot, 'steady-create-native');
const steadyCreateWatchrDir = join(benchmarkRoot, 'steady-create-watchr');
const steadyChangeNativeDir = join(benchmarkRoot, 'steady-change-native');
const steadyChangeWatchrDir = join(benchmarkRoot, 'steady-change-watchr');
const steadyRenameNativeDir = join(benchmarkRoot, 'steady-rename-native');
const steadyRenameWatchrSemanticDir = join(benchmarkRoot, 'steady-rename-watchr-semantic');
const steadyRenameWatchrRawDir = join(benchmarkRoot, 'steady-rename-watchr-raw');

const benchmarkNames = {
	coldNative: 'cold start + create notification / native',
	coldWatchr: 'cold start + create notification / watchr',
	steadyCreateNative: 'steady create notification / native',
	steadyCreateWatchr: 'steady create notification / watchr',
	steadyChangeNative: 'steady change notification / native',
	steadyChangeWatchr: 'steady change notification / watchr',
	steadyRenameNative: 'steady rename operation / native',
	steadyRenameWatchrSemantic: 'steady rename operation / watchr (semantic rename)',
	steadyRenameWatchrRaw: 'steady rename operation / watchr (raw event)'
} as const;

const useJsonOutput = process.argv.includes('--format') && process.argv.includes('json');

let sequence = 0;

/**
 * Returns the next unique file name.
 * @param prefix - The prefix for the file name.
 * @returns The next unique file name.
 */
function nextName(prefix: string): string {
	sequence += 1;
	return `${prefix}-${Date.now()}-${sequence}.txt`;
}

/** A simple event queue for managing asynchronous events. */
class EventQueue {
	private pending = 0;
	private readonly waiters: Array<() => void> = [];

	/** Notifies the next waiter in the queue, or increments the pending count if no waiters are present. */
	notify() {
		const resolve = this.waiters.shift();

		if (resolve === undefined) {
			this.pending += 1;
			return;
		}

		resolve();
	}

	/**
	 * Waits for an event to be notified, with an optional timeout.
	 * @param timeout - The maximum time to wait for an event, in milliseconds.
	 * @param message - The error message to use if the timeout is reached.
	 * @returns A promise that resolves when an event is notified or rejects if the timeout is reached.
	 * @throws {Error} An error if the timeout is reached before an event is notified.
	 */
	wait(timeout: number = timeoutMs, message = '🚨 benchmark timed out waiting for event'): Promise<void> {
		if (this.pending > 0) {
			this.pending -= 1;
			return Promise.resolve();
		}

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const index = this.waiters.indexOf(onResolve);
				if (index >= 0) { this.waiters.splice(index, 1) }
				reject(new Error(message));
			}, timeout);

			const onResolve = () => {
				clearTimeout(timer);
				resolve();
			};

			this.waiters.push(onResolve);
		});
	}
}

/** A simple wrapper around a native file system event stream. */
class NativeEventStream {
	private readonly path: string;
	private readonly queue = new EventQueue();
	private readonly watcher;

	constructor(path: string) {
		this.path = path;
		this.watcher = watch(this.path, () => this.queue.notify());
	}

	/**
	 * Waits for a file system event to occur, with an optional timeout.
	 * @param message - The error message to use if the timeout is reached.
	 * @returns A promise that resolves when a file system event occurs or rejects if the timeout is reached.
	 */
	wait(message: string): Promise<void> {
		return this.queue.wait(timeoutMs, message);
	}

	/** Closes the native file system event stream. */
	close(): void {
		this.watcher.close();
	}
}

/** A simple wrapper around a Watchr event stream. */
class WatchrEventStream {
	private readonly queue = new EventQueue();
	private readonly watcher: Watchr;

	private constructor(path: string, options: WatchrOptions, event: 'add' | 'change' | 'rename' | 'unlink' | 'all') {
		this.watcher = new Watchr(path, options);
		if (event === 'all') {
			this.watcher.on('all', () => this.queue.notify());
		} else {
			this.watcher.on(event, () => this.queue.notify());
		}
	}

	/**
	 * Creates a new WatchrEventStream instance and waits for the watcher to be ready.
	 * @param path - The path to watch.
	 * @param options - The Watchr options to use.
	 * @param event - The event type to listen for.
	 * @returns A promise that resolves to a new WatchrEventStream instance when the watcher is ready.
	 */
	static async create(path: string, options: WatchrOptions, event: 'add' | 'change' | 'rename' | 'unlink' | 'all'): Promise<WatchrEventStream> {
		const stream = new WatchrEventStream(path, options, event);

		await stream.watcher.readyLock;
		await delay(warmupDelayMs);

		return stream;
	}

	/**
	 * Waits for a file system event to occur, with an optional timeout.
	 * @param message - The error message to use if the timeout is reached.
	 * @returns A promise that resolves when a file system event occurs or rejects if the timeout is reached.
	 */
	wait(message: string): Promise<void> {
		return this.queue.wait(timeoutMs, message);
	}

	/** Closes the Watchr event stream. */
	close(): void {
		this.watcher.close();
	}
}

/**
 * Calculates the average time in nanoseconds for a specific benchmark alias from the benchmark results.
 * @param result - The benchmark results returned by the run function.
 * @param alias - The alias of the benchmark to calculate the average for.
 * @returns The average time in nanoseconds for the specified benchmark alias.
 * @throws {Error} If the benchmark alias is not found or if the benchmark did not produce stats.
 */
function averageNs(result: Awaited<ReturnType<typeof run>>, alias: string): number {
	const trial = result.benchmarks.find((benchmark) => benchmark.alias === alias);

	if (trial === undefined) {
		throw new Error(`🚨 missing benchmark result for '${alias}'`);
	}

	const runResult = trial.runs[0];

	if (runResult?.stats === undefined) {
		throw new Error(`🚨 benchmark '${alias}' did not produce stats`);
	}

	return runResult.stats.avg;
}

/**
 * Converts nanoseconds to milliseconds.
 * @param ns - The time in nanoseconds.
 * @returns The time in milliseconds.
 */
function ms(ns: number): number {
	return ns / 1_000_000;
}

await Promise.all([
	fs.mkdir(coldNativeDir, { recursive: true }),
	fs.mkdir(coldWatchrDir, { recursive: true }),
	fs.mkdir(steadyCreateNativeDir, { recursive: true }),
	fs.mkdir(steadyCreateWatchrDir, { recursive: true }),
	fs.mkdir(steadyChangeNativeDir, { recursive: true }),
	fs.mkdir(steadyChangeWatchrDir, { recursive: true }),
	fs.mkdir(steadyRenameNativeDir, { recursive: true }),
	fs.mkdir(steadyRenameWatchrSemanticDir, { recursive: true }),
	fs.mkdir(steadyRenameWatchrRawDir, { recursive: true })
]);

const steadyCreateNative = new NativeEventStream(steadyCreateNativeDir);
const steadyCreateWatchr = await WatchrEventStream.create(steadyCreateWatchrDir, watchrFastOptions, 'add');
const steadyChangeNative = new NativeEventStream(steadyChangeNativeDir);
const steadyChangeWatchr = await WatchrEventStream.create(steadyChangeWatchrDir, watchrFastOptions, 'change');
const steadyRenameNative = new NativeEventStream(steadyRenameNativeDir);
const steadyRenameWatchrSemantic = await WatchrEventStream.create(steadyRenameWatchrSemanticDir, watchrRenameOptions, 'rename');
const steadyRenameWatchrRaw = await WatchrEventStream.create(steadyRenameWatchrRawDir, watchrRenameRawOptions, 'all');

const nativeChangeTarget = join(steadyChangeNativeDir, 'target.txt');
const watchrChangeTarget = join(steadyChangeWatchrDir, 'target.txt');
const nativeRenameTargetA = join(steadyRenameNativeDir, 'a.txt');
const nativeRenameTargetB = join(steadyRenameNativeDir, 'b.txt');
const watchrRenameSemanticTargetA = join(steadyRenameWatchrSemanticDir, 'a.txt');
const watchrRenameSemanticTargetB = join(steadyRenameWatchrSemanticDir, 'b.txt');
const watchrRenameRawTargetA = join(steadyRenameWatchrRawDir, 'a.txt');
const watchrRenameRawTargetB = join(steadyRenameWatchrRawDir, 'b.txt');

await Promise.all([
	fs.writeFile(nativeChangeTarget, 'seed-native'),
	fs.writeFile(watchrChangeTarget, 'seed-watchr'),
	fs.writeFile(nativeRenameTargetA, 'seed-native-rename'),
	fs.writeFile(watchrRenameSemanticTargetA, 'seed-watchr-semantic-rename'),
	fs.writeFile(watchrRenameRawTargetA, 'seed-watchr-raw-rename')
]);

group('Native vs Watchr (minimal feature overhead)', () => {
	bench(benchmarkNames.coldNative, async () => {
		const filePath = join(coldNativeDir, nextName('native-cold-add'));

		const eventPromise = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('🚨 native cold benchmark timed out waiting for fs.watch event')), timeoutMs);

			const watcher = watch(coldNativeDir, () => {
				clearTimeout(timer);
				watcher.close();
				resolve();
			});
		});

		await delay(0);
		await fs.writeFile(filePath, 'x');
		await eventPromise;
		await fs.rm(filePath, { force: true });
	});

	bench(benchmarkNames.coldWatchr, async () => {
		const filePath = join(coldWatchrDir, nextName('watchr-cold-add'));
		const watcher = new Watchr(coldWatchrDir, watchrFastOptions);

		await watcher.readyLock;

		const eventPromise = new Promise<void>((resolve, reject) => {
			const onAdd = () => {
				clearTimeout(timer);
				watcher.off('add', onAdd);
				resolve();
			};

			const timer = setTimeout(() => {
				watcher.off('add', onAdd);
				reject(new Error('🚨 watchr cold benchmark timed out waiting for add'));
			}, timeoutMs);

			watcher.on('add', onAdd);
		});

		await fs.writeFile(filePath, 'x');
		await eventPromise;

		watcher.close();
		await fs.rm(filePath, { force: true });
	});

	bench(benchmarkNames.steadyCreateNative, async () => {
		const filePath = join(steadyCreateNativeDir, nextName('native-steady-add'));
		const eventPromise = steadyCreateNative.wait('🚨 native steady-create timed out waiting for fs.watch event');

		await fs.writeFile(filePath, 'x');
		await eventPromise;
	});

	bench(benchmarkNames.steadyCreateWatchr, async () => {
		const filePath = join(steadyCreateWatchrDir, nextName('watchr-steady-add'));
		const eventPromise = steadyCreateWatchr.wait('🚨 watchr steady-create timed out waiting for add');

		await fs.writeFile(filePath, 'x');
		await eventPromise;
	});

	bench(benchmarkNames.steadyChangeNative, async () => {
		const eventPromise = steadyChangeNative.wait('🚨 native steady-change timed out waiting for fs.watch event');

		await fs.writeFile(nativeChangeTarget, nextName('payload-native'));
		await eventPromise;
	});

	bench(benchmarkNames.steadyChangeWatchr, async () => {
		const eventPromise = steadyChangeWatchr.wait('🚨 watchr steady-change timed out waiting for change');

		await fs.writeFile(watchrChangeTarget, nextName('payload-watchr'));
		await eventPromise;
	});

	bench(benchmarkNames.steadyRenameNative, async () => {
		const eventPromise = steadyRenameNative.wait('🚨 native steady-rename timed out waiting for fs.watch event');
		const source = await fs.access(nativeRenameTargetA).then(() => nativeRenameTargetA).catch(() => nativeRenameTargetB);
		const destination = source === nativeRenameTargetA ? nativeRenameTargetB : nativeRenameTargetA;

		await fs.rename(source, destination);
		await eventPromise;
	});

	bench(benchmarkNames.steadyRenameWatchrSemantic, async () => {
		const eventPromise = steadyRenameWatchrSemantic.wait('🚨 watchr semantic rename timed out waiting for rename');
		const source = await fs.access(watchrRenameSemanticTargetA).then(() => watchrRenameSemanticTargetA).catch(() => watchrRenameSemanticTargetB);
		const destination = source === watchrRenameSemanticTargetA ? watchrRenameSemanticTargetB : watchrRenameSemanticTargetA;

		await fs.rename(source, destination);
		await eventPromise;
	});

	bench(benchmarkNames.steadyRenameWatchrRaw, async () => {
		const eventPromise = steadyRenameWatchrRaw.wait('🚨 watchr raw rename timed out waiting for first event');
		const source = await fs.access(watchrRenameRawTargetA).then(() => watchrRenameRawTargetA).catch(() => watchrRenameRawTargetB);
		const destination = source === watchrRenameRawTargetA ? watchrRenameRawTargetB : watchrRenameRawTargetA;

		await fs.rename(source, destination);
		await eventPromise;
	});

});

try {
	const result = await run({ throw: true, ...(useJsonOutput ? { format: 'json' as const } : {}) });

	const coldNative = averageNs(result, benchmarkNames.coldNative);
	const coldWatchr = averageNs(result, benchmarkNames.coldWatchr);
	const steadyCreateNativeAvg = averageNs(result, benchmarkNames.steadyCreateNative);
	const steadyCreateWatchrAvg = averageNs(result, benchmarkNames.steadyCreateWatchr);
	const steadyChangeNativeAvg = averageNs(result, benchmarkNames.steadyChangeNative);
	const steadyChangeWatchrAvg = averageNs(result, benchmarkNames.steadyChangeWatchr);
	const steadyRenameNativeAvg = averageNs(result, benchmarkNames.steadyRenameNative);
	const steadyRenameWatchrSemanticAvg = averageNs(result, benchmarkNames.steadyRenameWatchrSemantic);
	const steadyRenameWatchrRawAvg = averageNs(result, benchmarkNames.steadyRenameWatchrRaw);

	console.log('\nOverhead Ratios (watchr/native):');
	console.log(`- cold start + create: ${(coldWatchr / coldNative).toFixed(2)}x (${ms(coldWatchr).toFixed(3)} ms vs ${ms(coldNative).toFixed(3)} ms)`);
	console.log('- fast profile: renameTimeout=0');
	console.log(`- steady create: ${(steadyCreateWatchrAvg / steadyCreateNativeAvg).toFixed(2)}x (${ms(steadyCreateWatchrAvg).toFixed(3)} ms vs ${ms(steadyCreateNativeAvg).toFixed(3)} ms)`);
	console.log(`- steady change: ${(steadyChangeWatchrAvg / steadyChangeNativeAvg).toFixed(2)}x (${ms(steadyChangeWatchrAvg).toFixed(3)} ms vs ${ms(steadyChangeNativeAvg).toFixed(3)} ms)`);
	console.log(`- semantic rename profile: renameTimeout=${renameTimeout}`);
	console.log(`- steady rename (semantic): ${(steadyRenameWatchrSemanticAvg / steadyRenameNativeAvg).toFixed(2)}x (${ms(steadyRenameWatchrSemanticAvg).toFixed(3)} ms vs ${ms(steadyRenameNativeAvg).toFixed(3)} ms)`);
	console.log('- raw rename profile: renameTimeout=0');
	console.log(`- steady rename (raw): ${(steadyRenameWatchrRawAvg / steadyRenameNativeAvg).toFixed(2)}x (${ms(steadyRenameWatchrRawAvg).toFixed(3)} ms vs ${ms(steadyRenameNativeAvg).toFixed(3)} ms)`);
} finally {
	steadyCreateNative.close();
	steadyCreateWatchr.close();
	steadyChangeNative.close();
	steadyChangeWatchr.close();
	steadyRenameNative.close();
	steadyRenameWatchrSemantic.close();
	steadyRenameWatchrRaw.close();
	rmSync(benchmarkRoot, { recursive: true, force: true });
}

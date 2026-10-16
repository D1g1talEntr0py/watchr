/// <reference types="node" />
// End-to-end comparison: watchr (dist) vs chokidar vs @parcel/watcher, with raw `fs.watch` as reference.
// Usage: pnpm bench:compare [--runs 3] [--ops 100] [--burst-ops 500] [--mitata] [--output report.json]
//
// `baseline.json` is per-machine. `--ci` compares watchr's readiness and bytes/path against it and exits 1 on a regression
// above `--tolerance`; when the baseline came from another machine the regressions are reported as warnings only.

import { existsSync, mkdtempSync, readFileSync, rmSync, watch as fsWatch, promises as fs } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs, styleText } from 'node:util';
import { Watchr } from '../../dist/watchr.js';
import { buildFlat, buildNested, median, percentile, requireGc, settleHeap, trackedPathCount } from './helpers.ts';
import { installBenchmarkDependency, type BenchmarkDependencyName, type InstalledBenchmarkDependency } from './utils/benchmark-dependencies.ts';
import { deliveryCounts, measureLifecycle, positiveInteger } from './utils/compare-metrics.ts';

type EventKind = 'add' | 'change' | 'unlink' | 'rename' | 'other';
type Emitted = { kind: EventKind, path: string, pathNext: string | undefined, at: number };
type EventSink = (event: Emitted) => void;
type Handle = { close: () => Promise<void>, trackedPaths: () => number | undefined, errors?: () => string[] };
/** `scans`: builds a JS path table before ready (used for heap ranking). `reference`: shown for context, never ranked. */
type Adapter = { name: string, scans: boolean, reference: boolean, prepare?: (root: string, onEvent: EventSink) => () => Promise<Handle>, start: (root: string, onEvent: EventSink) => Promise<Handle> };

type ReadinessSample = { constructionMs: number, readyMs: number, closeMs: number, retainedBytes: number, rssDeltaBytes: number, trackedPaths: number | undefined };
type ReadinessEntry = { constructionMs: number, readyMs: number, closeMs: number, bytesPerPath: number | null, trackedPaths: number | null, retainedMB: number, rssDeltaMB: number, failures: number, error?: string };
type ReadinessScenario = { scenario: string, files: number, watchers: Record<string, ReadinessEntry> };
type LatencyStats = { p50Us: number, p95Us: number, missed: number, alternativeOps: number, samples: number };
const latencyWorkloads = [ 'createAdd', 'writeChange', 'deleteUnlink', 'nestedAdd', 'atomicSave' ] as const;
type LatencyWorkload = typeof latencyWorkloads[number];
type LatencyEntry = Record<LatencyWorkload, LatencyStats> & { error?: string };
type BurstEntry = { elapsedMs: number, opsPerSecond: number, received: number, missed: number, duplicates: number, unexpected: number, error?: string };
type BurstWorkload = 'create' | 'write' | 'delete';
type RenameEntry = { correlated: number, pairs: number, unresolved: number, totalEvents: number, error?: string };
type Verdict = { category: string, winners: string[], value: string, margin: string };
type Report = {
	meta: { schemaVersion: number, node: string, platform: string, cpus: string, date: string, versions: Record<string, string>, runs: number, ops: number, burstOps: number, quick: boolean },
	readiness: ReadinessScenario[],
	latency: Record<string, LatencyEntry>,
	rename: Record<string, RenameEntry>,
	directoryRename: Record<string, RenameEntry>,
	burst: Record<string, Record<BurstWorkload, BurstEntry>>,
	verdict: Verdict[],
	skipped: { name: string, reason: string }[]
};

const { values } = parseArgs({
	options: {
		ci: { type: 'boolean', default: false },
		tolerance: { type: 'string', default: '0.2' },
		'update-baseline': { type: 'boolean', default: false },
		runs: { type: 'string', default: '3' },
		ops: { type: 'string', default: '100' },
		'burst-ops': { type: 'string', default: '500' },
		quick: { type: 'boolean', default: false },
		mitata: { type: 'boolean', default: false },
		output: { type: 'string' }
	}
});

const runs = positiveInteger(values.runs, 'runs');
const ops = positiveInteger(values.ops, 'ops');
const burstOps = positiveInteger(values['burst-ops'], 'burst-ops');
const renameOps = Math.min(50, ops);
const opGapMs = 20;
const eventTimeoutMs = 2_000;
// Each latency phase stops starting new ops after this long, once it has at least `minLatencySamples`.
const latencyBudgetMs = 5_000;
const minLatencySamples = 10;
// Upper bound only: the rename phase ends as soon as every rename has been reported.
const renameSettleMs = 3_000;
const regressionThreshold = 1 + Math.max(0, Number(values.tolerance) || 0);
if (!Number.isFinite(Number(values.tolerance)) || Number(values.tolerance) < 0) { throw new Error('--tolerance must be a finite nonnegative number') }
if (values.quick && (values.ci || values['update-baseline'])) { throw new Error('--quick cannot be used with --ci or --update-baseline') }
if (values.ci && values['update-baseline']) { throw new Error('--ci cannot be used with --update-baseline') }
const watchrName = 'watchr';
const baselinePath = new URL('./baseline.json', import.meta.url);
const gc = requireGc();
const skipped: Report['skipped'] = [];
const benchmarkDependencies = new Map<BenchmarkDependencyName, InstalledBenchmarkDependency>();
let ciBaseline: Report | undefined;

if (values.ci) {
	if (!existsSync(baselinePath)) { throw new Error('No baseline found; run `pnpm bench:baseline` first') }
	ciBaseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Report;
	if (ciBaseline.meta.schemaVersion !== 2 || ciBaseline.meta.quick !== false) {
		throw new Error('Incompatible baseline methodology; record a fresh baseline with `pnpm bench:baseline`');
	}
}

/**
 * Extracts a printable message from an unknown thrown value.
 * @param error - The thrown value.
 * @returns The message.
 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the installed version of a package, or `unavailable` when it cannot be resolved.
 * @param name - Package name.
 * @returns The version string.
 */
function versionOf(name: BenchmarkDependencyName): string {
	return benchmarkDependencies.get(name)?.version ?? 'unavailable';
}

const fileKinds: Record<string, EventKind> = { add: 'add', addDir: 'add', change: 'change', unlink: 'unlink', unlinkDir: 'unlink', rename: 'rename', renameDir: 'rename' };
const parcelKinds: Record<string, EventKind> = { create: 'add', update: 'change', delete: 'unlink' };

type ChokidarWatcher = {
	on(event: 'all', listener: (event: string, path: string) => void): void;
	on(event: 'error', listener: (error: Error) => void): void;
	once(event: 'ready', listener: () => void): void;
	once(event: 'error', listener: (error: unknown) => void): void;
	close(): Promise<void>;
	getWatched(): Record<string, string[]>;
};

type ChokidarModule = {
	watch: (root: string, options: { ignoreInitial: boolean, usePolling: boolean, persistent: boolean }) => ChokidarWatcher;
};

type ParcelModule = {
	subscribe: (root: string, listener: (error: Error | null, events: { type: string, path: string }[]) => void, options?: { backend?: string }) => Promise<{ unsubscribe: () => Promise<void> }>;
};

/**
 * Builds the watchr adapter. Preparation is idle; startup awaits `watcher.start()`.
 * @returns The adapter.
 */
function watchrAdapter(): Adapter {
	return {
		name: watchrName,
		scans: true,
		reference: false,
		async start(root, onEvent) {
			return this.prepare!(root, onEvent)();
		},
		prepare(root, onEvent) {
			let failure: string | undefined;
			const watcher = new Watchr(root, {
				emitInitial: false,
				recursive: true,
				handlers: {
					error: (error) => { failure ??= error.message },
					all: (event) => {
						const at = performance.now();
						const renamed = event.type === 'rename' || event.type === 'renameDir';
						onEvent({ kind: fileKinds[event.type] ?? 'other', path: renamed ? event.from : event.path, pathNext: renamed ? event.to : undefined, at });
					}
				}
			});

			return async () => {
				try {
					await watcher.start();
				} catch (error) {
					watcher.close();
					throw new Error(failure ?? messageOf(error), { cause: error });
				}

				return { close: async () => { watcher.close() }, trackedPaths: () => trackedPathCount(root), errors: () => failure === undefined ? [] : [ failure ] };
			};
		}
	};
}

/**
 * Loads chokidar with default options (`atomic: true` delays unlinks by 100 ms).
 * @returns The adapter, or `undefined` when the package cannot be loaded.
 */
async function loadChokidar(): Promise<Adapter | undefined> {
	try {
		const dependency = await installBenchmarkDependency('chokidar');
		benchmarkDependencies.set('chokidar', dependency);
		const { watch } = await dependency.load() as ChokidarModule;

		return {
			name: 'chokidar',
			scans: true,
			reference: false,
			async start(root, onEvent) {
				const errors: string[] = [];
				const watcher = watch(root, { ignoreInitial: true, usePolling: false, persistent: true });
				watcher.on('error', (error) => { errors.push(error.message) });
				watcher.on('all', (event, path) => {
					const at = performance.now();
					onEvent({ kind: fileKinds[event] ?? 'other', path, pathNext: undefined, at });
				});

				try {
					await new Promise<void>((resolve, reject) => {
						watcher.once('ready', () => resolve());
						watcher.once('error', (error) => reject(error instanceof Error ? error : new Error(String(error))));
					});
				} catch (error) {
					await watcher.close();
					throw error;
				}

				return {
					close: () => watcher.close(),
					errors: () => errors,
					trackedPaths: () => Object.values(watcher.getWatched()).reduce((sum, entries) => sum + entries.length, 0)
				};
			}
		};
	} catch (error) {
		skipped.push({ name: 'chokidar', reason: messageOf(error) });

		return undefined;
	}
}

/**
 * Loads `@parcel/watcher` with the platform's native backend. Subscription readiness is ranked; JS heap per path is not.
 * @returns The adapter, or `undefined` when the native binding cannot be loaded.
 */
async function loadParcel(): Promise<Adapter | undefined> {
	try {
		const dependency = await installBenchmarkDependency('@parcel/watcher');
		benchmarkDependencies.set('@parcel/watcher', dependency);
		const parcel = (await dependency.load() as { default: ParcelModule }).default;
		const backend = platform() === 'linux' ? 'inotify' : platform() === 'darwin' ? 'fs-events' : platform() === 'win32' ? 'windows' : undefined;

		return {
			name: '@parcel/watcher',
			scans: false,
			reference: false,
			async start(root, onEvent) {
				const errors: string[] = [];
				const subscription = await parcel.subscribe(root, (error, events) => {
					const at = performance.now();

					if (error) { errors.push(error.message); return }

					for (const event of events) {
						onEvent({ kind: parcelKinds[event.type] ?? 'other', path: event.path, pathNext: undefined, at });
					}
				}, backend === undefined ? {} : { backend });

				return { close: () => subscription.unsubscribe(), trackedPaths: () => undefined, errors: () => errors };
			}
		};
	} catch (error) {
		skipped.push({ name: '@parcel/watcher', reason: messageOf(error) });

		return undefined;
	}
}

/**
 * Raw recursive `fs.watch`: the floor every watcher builds on. `rename` is disambiguated with `existsSync` after timestamping.
 * @returns The adapter.
 */
function fsWatchAdapter(): Adapter {
	return {
		name: 'fs.watch',
		scans: false,
		reference: true,
		start(root, onEvent) {
			const errors: string[] = [];
			const watcher = fsWatch(root, { recursive: true }, (eventType, filename) => {
				const at = performance.now();

				if (filename === null) {
					onEvent({ kind: 'other', path: root, pathNext: undefined, at });

					return;
				}

				const path = join(root, filename.toString());
				const kind: EventKind = eventType === 'change' ? 'change' : existsSync(path) ? 'add' : 'unlink';
				onEvent({ kind, path, pathNext: undefined, at });
			});
			watcher.on('error', (error) => { errors.push(error.message) });

			return Promise.resolve({ close: async () => { watcher.close() }, trackedPaths: () => undefined, errors: () => errors });
		}
	};
}

/**
 * Opens `adapter` on `root`, waits for readiness and measures elapsed time and retained memory.
 * @param adapter - Watcher under test.
 * @param root - Fixture root.
 * @returns The sample.
 */
async function sampleReadiness(adapter: Adapter, root: string): Promise<ReadinessSample> {
	await settleHeap(gc);
	const before = process.memoryUsage();
	const { observation, ...timings } = await measureLifecycle(() => adapter.prepare?.(root, () => undefined) ?? (() => adapter.start(root, () => undefined)), async (handle) => {
		await settleHeap(gc);
		const after = process.memoryUsage();
		const trackedPaths = handle.trackedPaths();
		if (handle.errors?.().length) { throw new Error(handle.errors().join('; ')) }

		return { retainedBytes: after.heapUsed - before.heapUsed, rssDeltaBytes: after.rss - before.rss, trackedPaths };
	});

	return { ...timings, ...observation };
}

/**
 * Runs `runs` readiness samples and reduces them to medians.
 * @param adapter - Watcher under test.
 * @param root - Fixture root.
 * @returns The aggregated entry.
 */
async function measureReadiness(adapter: Adapter, root: string): Promise<ReadinessEntry> {
	const samples: ReadinessSample[] = [];
	let failures = 0;
	let error: string | undefined;

	for (let run = 0; run < runs; run++) {
		try {
			samples.push(await sampleReadiness(adapter, root));
		} catch (caught) {
			failures++;
			error ??= messageOf(caught);
		}
	}

	const trackedPaths = samples[0]?.trackedPaths;
	const perPath = trackedPaths === undefined || trackedPaths === 0 ? null : median(samples.map((sample) => sample.retainedBytes / trackedPaths));

	return {
		constructionMs: median(samples.map((sample) => sample.constructionMs)),
		readyMs: median(samples.map((sample) => sample.readyMs)),
		closeMs: median(samples.map((sample) => sample.closeMs)),
		bytesPerPath: perPath !== null && perPath > 0 ? perPath : null,
		trackedPaths: trackedPaths ?? null,
		retainedMB: median(samples.map((sample) => sample.retainedBytes)) / 1_048_576,
		rssDeltaMB: median(samples.map((sample) => sample.rssDeltaBytes)) / 1_048_576,
		failures,
		...(error === undefined ? {} : { error })
	};
}

type Waiter = { kind: EventKind, alternatives: Set<EventKind>, resolve: (at: number) => void };

/**
 * Registers a waiter for `kind` at `path`, resolving with the event timestamp or `undefined` on timeout.
 * @param waiters - Shared waiter table.
 * @param path - Path to wait for.
 * @param kind - Event kind to wait for.
 * @param alternatives - Other event kinds observed at this path.
 * @returns The event timestamp, or `undefined` when it did not arrive in time.
 */
function waitFor(waiters: Map<string, Waiter>, path: string, kind: EventKind, alternatives: Set<EventKind>): Promise<number | undefined> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			waiters.delete(path);
			resolve(undefined);
		}, eventTimeoutMs);

		waiters.set(path, { kind, alternatives, resolve: (at) => { clearTimeout(timer); resolve(at) } });
	});
}

/**
 * Runs up to `ops` operations one at a time, each waiting for its event before a short gap, and returns the per-op
 * latencies in microseconds. Stops early once {@link latencyBudgetMs} has elapsed and {@link minLatencySamples} ops ran.
 * @param waiters - Shared waiter table.
 * @param label - Progress label for this phase.
 * @param operation - Describes op `index`: the path and event kind to wait for, and the fs call to perform.
 * @returns Latency statistics.
 */
async function measureOps(waiters: Map<string, Waiter>, label: string, operation: (index: number) => { path: string, kind: EventKind, perform: () => Promise<void> }): Promise<LatencyStats> {
	const latenciesUs: number[] = [];
	const phaseStartedAt = performance.now();
	let missed = 0;
	let alternativeOps = 0;
	let index = 0;

	for (; index < ops; index++) {
		if (index >= minLatencySamples && performance.now() - phaseStartedAt > latencyBudgetMs) { break }

		progressDetail(`${label} ${index + 1}/${ops}`);
		const { path, kind, perform } = operation(index);
		const alternatives = new Set<EventKind>();
		const eventAt = waitFor(waiters, path, kind, alternatives);
		const startedAt = performance.now();
		await perform();
		const at = await eventAt;

		if (at === undefined) {
			missed++;
			if (alternatives.size > 0) { alternativeOps++ }
		} else {
			latenciesUs.push((at - startedAt) * 1_000);
		}

		await delay(opGapMs);
	}

	return { p50Us: percentile(latenciesUs, 0.5), p95Us: percentile(latenciesUs, 0.95), missed, alternativeOps, samples: index };
}

/**
 * Measures `create → add` and `write → change` latency on a fresh 1k-file tree.
 * @param adapter - Watcher under test.
 * @returns The latency entry.
 */
async function measureLatency(adapter: Adapter): Promise<LatencyEntry> {
	const root = mkdtempSync(join(tmpdir(), 'watchr-compare-latency-'));
	const files = buildFlat(root, Math.max(1_000, ops));
	const nested = join(root, 'nested', 'deeper');
	await fs.mkdir(nested, { recursive: true });
	const waiters = new Map<string, Waiter>();
	const empty: LatencyStats = { p50Us: Number.NaN, p95Us: Number.NaN, missed: 0, alternativeOps: 0, samples: 0 };
	let handle: Handle | undefined;

	try {
		handle = await adapter.start(root, (event) => {
			const waiter = waiters.get(event.path);

			if (waiter !== undefined && waiter.kind === event.kind) {
				waiters.delete(event.path);
				waiter.resolve(event.at);
			} else if (waiter !== undefined) {
				waiter.alternatives.add(event.kind);
			}
		});
		await delay(100);

		const createAdd = await measureOps(waiters, 'create→add', (index) => {
			const path = join(root, `lat-${index}.txt`);

			return { path, kind: 'add', perform: () => writeFile(path, 'x') };
		});
		const writeChange = await measureOps(waiters, 'write→change', (index) => {
			const path = join(root, `f${index % files}.txt`);

			return { path, kind: 'change', perform: () => writeFile(path, `payload-${index}`) };
		});
		const deleteUnlink = await measureOps(waiters, 'delete→unlink', (index) => {
			const path = join(root, `f${index}.txt`);

			return { path, kind: 'unlink', perform: () => fs.unlink(path) };
		});
		const nestedAdd = await measureOps(waiters, 'nested create→add', (index) => {
			const path = join(nested, `nested-${index}.txt`);

			return { path, kind: 'add', perform: () => writeFile(path, 'nested') };
		});
		const atomicSave = await measureOps(waiters, 'atomic save→change', (index) => {
			const path = join(root, `lat-${index % createAdd.samples}.txt`);
			const temporary = join(root, `save-${index}.tmp`);

			return { path, kind: 'change', perform: async () => { await writeFile(temporary, `saved-${index}`); await fs.rename(temporary, path) } };
		});
		if (handle.errors?.().length) { throw new Error(handle.errors().join('; ')) }

		return { createAdd, writeChange, deleteUnlink, nestedAdd, atomicSave };
	} catch (error) {
		return { createAdd: empty, writeChange: empty, deleteUnlink: empty, nestedAdd: empty, atomicSave: empty, error: messageOf(error) };
	} finally {
		await handle?.close();
		rmSync(root, { recursive: true, force: true });
	}
}

/**
 * Renames `renameOps` files and classifies what each watcher reported per op: one correlated `rename`, an
 * `unlink`+`add` pair, or anything else.
 * @param adapter - Watcher under test.
 * @param directories - Whether to rename populated directories instead of files.
 * @returns The rename entry.
 */
async function measureRename(adapter: Adapter, directories = false): Promise<RenameEntry> {
	const root = mkdtempSync(join(tmpdir(), 'watchr-compare-rename-'));
	if (directories) {
		for (let index = 0; index < renameOps; index++) {
			await fs.mkdir(join(root, `f${index}.txt`));
			await writeFile(join(root, `f${index}.txt`, 'child.txt'), 'child');
		}
	} else {
		buildFlat(root, renameOps);
	}
	const log: Emitted[] = [];
	let handle: Handle | undefined;

	const classify = (): RenameEntry => {
		let correlated = 0;
		let pairs = 0;

		for (let index = 0; index < renameOps; index++) {
			const source = join(root, `f${index}.txt`);
			const destination = join(root, `f${index}.renamed`);

			if (log.some((event) => event.kind === 'rename' && event.path === source && event.pathNext === destination)) {
				correlated++;
			} else if (log.some((event) => event.kind === 'unlink' && event.path === source) && log.some((event) => event.kind === 'add' && event.path === destination)) {
				pairs++;
			}
		}

		return { correlated, pairs, unresolved: renameOps - correlated - pairs, totalEvents: log.length };
	};

	try {
		handle = await adapter.start(root, (event) => { log.push(event) });
		await delay(100);

		for (let index = 0; index < renameOps; index++) {
			await fs.rename(join(root, `f${index}.txt`), join(root, `f${index}.renamed`));
			await delay(opGapMs);
		}

		const deadline = performance.now() + renameSettleMs;

		while (performance.now() < deadline && classify().unresolved > 0) { await delay(25) }
		if (handle.errors?.().length) { throw new Error(handle.errors().join('; ')) }

		await handle.close();
		handle = undefined;

		return classify();
	} catch (error) {
		return { correlated: 0, pairs: 0, unresolved: renameOps, totalEvents: log.length, error: messageOf(error) };
	} finally {
		await handle?.close();
		rmSync(root, { recursive: true, force: true });
	}
}

/**
 * Measures bounded concurrent bursts by unique path delivery, not raw event volume.
 * @param adapter - Watcher under test.
 * @param workload - Filesystem operation to exercise.
 * @returns Completion throughput and delivery counts.
 */
async function measureBurst(adapter: Adapter, workload: BurstWorkload): Promise<BurstEntry> {
	const root = mkdtempSync(join(tmpdir(), 'watchr-compare-burst-'));
	const paths = Array.from({ length: burstOps }, (_unused, index) => join(root, `f${index}.txt`));
	const expected = new Set(paths);
	const delivered: string[] = [];
	const unique = new Set<string>();
	const kind = workload === 'create' ? 'add' : workload === 'write' ? 'change' : 'unlink';
	let active = false;
	let completedAt: number | undefined;
	let handle: Handle | undefined;

	try {
		if (workload !== 'create') { buildFlat(root, burstOps) }
		handle = await adapter.start(root, (event) => {
			if (!active || event.kind !== kind) { return }
			delivered.push(event.path);
			if (expected.has(event.path)) { unique.add(event.path) }
			if (unique.size === expected.size) { completedAt ??= event.at }
		});
		await delay(100);
		active = true;
		const startedAt = performance.now();

		for (let offset = 0; offset < paths.length; offset += 32) {
			await Promise.all(paths.slice(offset, offset + 32).map((path) => workload === 'delete' ? fs.unlink(path) : writeFile(path, 'burst-payload')));
		}

		const operationsDoneAt = performance.now();
		const deadline = operationsDoneAt + eventTimeoutMs;
		while (completedAt === undefined && performance.now() < deadline) { await delay(5) }
		const elapsedMs = Math.max(operationsDoneAt, completedAt ?? performance.now()) - startedAt;
		await delay(100);
		active = false;
		if (handle.errors?.().length) { throw new Error(handle.errors().join('; ')) }
		const counts = deliveryCounts(expected, delivered);

		return { elapsedMs, opsPerSecond: counts.missed === 0 ? burstOps * 1_000 / elapsedMs : Number.NaN, ...counts };
	} catch (error) {
		return { elapsedMs: Number.NaN, opsPerSecond: Number.NaN, ...deliveryCounts(expected, delivered), error: messageOf(error) };
	} finally {
		await handle?.close();
		rmSync(root, { recursive: true, force: true });
	}
}

/**
 * Runs optional statistically sampled full lifecycle cycles using mitata.
 * @returns Completion after all watcher cycles and fixture cleanup.
 */
async function measureMitata(): Promise<void> {
	type Mitata = {
		bench: (name: string, operation: () => Promise<void>) => unknown;
		group: (name: string, register: () => void) => void;
		run: (options: { throw: boolean }) => Promise<unknown>;
	};
	const dependency = await installBenchmarkDependency('mitata');
	const { bench, group, run } = await dependency.load() as Mitata;
	const root = mkdtempSync(join(tmpdir(), 'watchr-compare-mitata-'));
	buildFlat(root, values.quick ? 100 : 1_000);

	try {
		for (const scans of [ true, false ]) {
			group(scans ? 'Scan-based watchers: construct + start + close' : 'Subscribe-only cycles (not equivalent to an initial scan)', () => {
				for (const adapter of adapters.filter((entry) => entry.scans === scans)) {
					bench(`${adapter.name}${adapter.reference ? ' (raw reference)' : ''}`, async () => {
						const handle = await adapter.start(root, () => undefined);
						try {
							if (handle.errors?.().length) { throw new Error(handle.errors().join('; ')) }
						} finally {
							await handle.close();
						}
					});
				}
			});
		}
		console.log(`\nmitata ${dependency.version}: full lifecycle distributions; these include construction and close, unlike the Startup table.`);
		await run({ throw: true });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

// ---- Presentation ---------------------------------------------------------------------------------------------------

type Better = 'lower' | 'higher';
type Column = { label: string, better?: Better, format: (value: number) => string };
type Row = { name: string, values: (number | null)[], ranked: boolean, note: string };
type Table = { title: string, hint: string, columns: Column[], rows: Row[] };

/**
 * Formats milliseconds with precision that suits the magnitude.
 * @param ms - Milliseconds.
 * @returns The formatted string.
 */
function formatMs(ms: number): string {
	return `${ms.toFixed(ms >= 100 ? 0 : ms >= 10 ? 1 : 2)} ms`;
}

/**
 * Formats a byte count.
 * @param bytes - Bytes.
 * @returns The formatted string.
 */
function formatBytes(bytes: number): string {
	return bytes >= 1_024 ? `${(bytes / 1_024).toFixed(1)} KB` : `${bytes.toFixed(0)} B`;
}

/**
 * Whether a cell holds a usable number.
 * @param value - The cell value.
 * @returns True for finite numbers.
 */
function isValue(value: number | null | undefined): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Finds the best value in a column across ranked rows.
 * @param rows - Table rows.
 * @param index - Column index.
 * @param better - Ranking direction.
 * @returns The best value, or `undefined` when nothing is ranked.
 */
function bestValue(rows: Row[], index: number, better: Better | undefined): number | undefined {
	if (better === undefined) { return undefined }

	const candidates = rows.filter((row) => row.ranked).map((row) => row.values[index]).filter(isValue);

	if (candidates.length === 0) { return undefined }

	return better === 'lower' ? Math.min(...candidates) : Math.max(...candidates);
}

/**
 * Prints one aligned table; the winning cell of each ranked column is highlighted and starred.
 * @param table - The table.
 */
function printTable({ title, hint, columns, rows }: Table): void {
	const best = columns.map((column, index) => bestValue(rows, index, column.better));
	const cells = rows.map((row) => row.values.map((value, index) => isValue(value) ? columns[index]!.format(value) : '—'));
	const nameWidth = Math.max(...rows.map((row) => row.name.length));
	const widths = columns.map((column, index) => Math.max(column.label.length, ...cells.map((row) => row[index]!.length)));

	console.log(`\n${styleText('bold', title)}  ${styleText('dim', hint)}`);
	console.log(styleText('dim', `  ${''.padEnd(nameWidth)}${columns.map((column, index) => `  ${column.label.padStart(widths[index]!)}  `).join('')}`));

	rows.forEach((row, rowIndex) => {
		const line = row.values.map((value, index) => {
			const text = cells[rowIndex]![index]!.padStart(widths[index]!);

			return row.ranked && isValue(value) && value === best[index] ? `  ${styleText([ 'green', 'bold' ], text)} ★` : `  ${text}  `;
		}).join('');
		const name = row.name.padEnd(nameWidth);
		const note = row.note ? `  ${styleText('dim', row.note)}` : '';

		console.log(row.ranked ? `  ${name}${line}${note}` : styleText('dim', `  ${name}${line}`) + note);
	});
}

/**
 * Picks the winner(s) of one column and describes the margin over the runner-up.
 * @param category - Verdict label.
 * @param rows - Table rows.
 * @param index - Column index.
 * @param column - Column definition (must be ranked).
 * @returns The verdict, or `undefined` when no ranked row has a value.
 */
function decide(category: string, rows: Row[], index: number, column: Column): Verdict | undefined {
	const better = column.better ?? 'lower';
	const ranked = rows.filter((row) => row.ranked && isValue(row.values[index]))
		.map((row) => ({ name: row.name, value: row.values[index]! }))
		.sort((left, right) => better === 'lower' ? left.value - right.value : right.value - left.value);
	const top = ranked[0];

	if (top === undefined) { return undefined }

	const winners = ranked.filter((entry) => entry.value === top.value).map((entry) => entry.name);
	const runnerUp = ranked.find((entry) => entry.value !== top.value);
	let margin = winners.length > 1 ? 'tie' : 'no competitor measured';

	if (runnerUp !== undefined) {
		const word = column.format === formatBytes ? 'less than' : 'faster than';
		margin = better === 'lower' && top.value > 0 ? `${(runnerUp.value / top.value).toFixed(1)}x ${word} ${runnerUp.name} (${column.format(runnerUp.value)})` : `next best: ${runnerUp.name} (${column.format(runnerUp.value)})`;
	}

	return { category, winners, value: column.format(top.value), margin };
}

/**
 * Builds the readiness/memory rows for one metric across scenarios.
 * @param result - The report.
 * @param pick - Extracts the metric from an entry.
 * @param ranked - Whether an adapter is ranked for this metric.
 * @param unrankedNote - Note for unranked rows.
 * @returns The rows.
 */
function readinessRows(result: Report, pick: (entry: ReadinessEntry) => number | null, ranked: (adapter: Adapter) => boolean, unrankedNote: (adapter: Adapter) => string): Row[] {
	return adapters.map((adapter) => {
		const entries = result.readiness.map((scenario) => scenario.watchers[adapter.name]);
		const failures = entries.reduce((sum, entry) => sum + (entry?.failures ?? 0), 0);
		const error = entries.find((entry) => entry?.error !== undefined)?.error;
		const note = [ ranked(adapter) ? '' : unrankedNote(adapter), failures ? `${failures} failed run(s): ${error ?? 'unknown error'}` : '' ].filter(Boolean).join('; ');

		return { name: adapter.name, values: entries.map((entry) => entry === undefined || entry.failures > 0 ? null : pick(entry)), ranked: ranked(adapter), note };
	});
}

/**
 * Turns the raw report into ranked tables and a per-category verdict.
 * @param result - The report.
 * @returns The tables and verdicts.
 */
function analyze(result: Report): { tables: Table[], verdicts: Verdict[] } {
	const { meta } = result;
	const scenarioColumns = (format: (value: number) => string): Column[] => result.readiness.map((scenario) => ({ label: scenario.scenario, better: 'lower', format }));
	const largest = result.readiness.reduce((max, scenario, index) => scenario.files > result.readiness[max]!.files ? index : max, 0);
	const largestLabel = result.readiness[largest]?.scenario ?? '';
	const referenceNote = 'raw baseline, not ranked';
	const tables: Table[] = [];
	const verdicts: (Verdict | undefined)[] = [];

	const startupColumns = scenarioColumns(formatMs);
	const startupRows = readinessRows(result, (entry) => entry.readyMs, (adapter) => !adapter.reference, () => referenceNote);
	tables.push({ title: 'Startup', hint: `watchr start() to ready; others watch()/subscribe() to ready; median of ${meta.runs} · lower is better`, columns: startupColumns, rows: startupRows });
	verdicts.push(decide(`Startup (${largestLabel})`, startupRows, largest, startupColumns[largest]!));
	const constructionRows = readinessRows(result, (entry) => entry.constructionMs, (adapter) => adapter.name === watchrName, () => '').filter((row) => row.name === watchrName);
	tables.push({ title: 'Idle construction', hint: 'Watchr constructor only; no watch attachment or scan', columns: scenarioColumns(formatMs), rows: constructionRows });
	const closeRows = readinessRows(result, (entry) => entry.closeMs, (adapter) => !adapter.reference, () => referenceNote);
	tables.push({ title: 'Close', hint: 'close()/unsubscribe() completion; application callback work is not awaited', columns: scenarioColumns(formatMs), rows: closeRows });
	verdicts.push(decide(`Close (${largestLabel})`, closeRows, largest, startupColumns[largest]!));

	const memoryColumns = scenarioColumns(formatBytes);
	const memoryRows = readinessRows(result, (entry) => entry.bytesPerPath, (adapter) => adapter.scans && !adapter.reference, (adapter) => adapter.reference ? referenceNote : 'native memory, not measurable');
	tables.push({ title: 'Memory', hint: 'retained JS heap per watched path after ready · lower is better', columns: memoryColumns, rows: memoryRows });
	verdicts.push(decide(`Memory (${largestLabel})`, memoryRows, largest, memoryColumns[largest]!));

	const labels: Record<LatencyWorkload, string> = { createAdd: 'Create → add', writeChange: 'Write → change', deleteUnlink: 'Delete → unlink', nestedAdd: 'Nested create → add', atomicSave: 'Atomic replace → change' };

	for (const workload of latencyWorkloads) {
		const columns: Column[] = [
			{ label: 'p50', better: 'lower', format: formatMs },
			{ label: 'p95', better: 'lower', format: formatMs },
			{ label: 'missed', format: (value) => value.toFixed(0) },
			{ label: 'other kinds', format: (value) => value.toFixed(0) },
			{ label: 'samples', format: (value) => value.toFixed(0) }
		];
		const rows: Row[] = adapters.map((adapter) => {
			const entry = result.latency[adapter.name];
			const stats = entry?.[workload];
			const note = [ adapter.reference ? referenceNote : '', stats !== undefined && stats.samples < meta.ops ? 'time budget reached' : '', entry?.error ?? '' ].filter(Boolean).join('; ');

			return { name: adapter.name, values: stats === undefined ? [ null, null, null, null, null ] : [ stats.p50Us / 1_000, stats.p95Us / 1_000, stats.missed, stats.alternativeOps, stats.samples ], ranked: !adapter.reference && entry?.error === undefined && stats !== undefined && stats.missed === 0 && stats.samples > 0, note };
		});
		tables.push({ title: labels[workload], hint: `fs call to matching event; up to ${meta.ops} sequential operations; misses disqualify ranking`, columns, rows });
		verdicts.push(decide(`${labels[workload]} p50`, rows, 0, columns[0]!));
	}

	const count = (value: number): string => `${value}/${renameOps}`;
	const renameColumns: Column[] = [
		{ label: 'as rename', better: 'higher', format: count },
		{ label: 'as unlink+add', format: count },
		{ label: 'lost', format: count }
	];
	for (const directories of [ false, true ]) {
		const renameRows: Row[] = adapters.map((adapter) => {
			const entry = (directories ? result.directoryRename : result.rename)[adapter.name];
			const note = [ adapter.reference ? referenceNote : '', entry?.error ?? '' ].filter(Boolean).join('; ');
			const values = entry === undefined ? [ null, null, null ] : [ entry.correlated, entry.pairs, entry.unresolved ];

			return { name: adapter.name, values, ranked: !adapter.reference && entry?.error === undefined && entry !== undefined && entry.unresolved === 0, note };
		});
		const title = directories ? 'Directory rename detection' : 'File rename detection';
		tables.push({ title, hint: `${renameOps} renames, how each was reported; populated directories include child notifications`, columns: renameColumns, rows: renameRows });
		if (renameRows.some((row) => row.ranked && (row.values[0] ?? 0) > 0)) { verdicts.push(decide(title, renameRows, 0, renameColumns[0]!)) }
	}

	for (const workload of [ 'create', 'write', 'delete' ] as const) {
		const columns: Column[] = [
			{ label: 'ops/s', better: 'higher', format: (value) => value.toFixed(0) },
			{ label: 'complete', format: formatMs },
			{ label: 'received', format: (value) => `${value}/${meta.burstOps}` },
			{ label: 'missed', format: (value) => value.toFixed(0) },
			{ label: 'duplicates', format: (value) => value.toFixed(0) }
		];
		const rows: Row[] = adapters.map((adapter) => {
			const entry = result.burst[adapter.name]?.[workload];
			const note = [ adapter.reference ? referenceNote : '', entry?.unexpected ? `${entry.unexpected} unrelated matching events` : '', entry?.error ?? '' ].filter(Boolean).join('; ');

			return { name: adapter.name, values: entry === undefined ? [ null, null, null, null, null ] : [ entry.opsPerSecond, entry.elapsedMs, entry.received, entry.missed, entry.duplicates ], ranked: !adapter.reference && entry?.error === undefined && entry !== undefined && entry.missed === 0, note };
		});
		tables.push({ title: `Burst ${workload}`, hint: `${meta.burstOps} paths; 32 concurrent fs operations; completion includes matching delivery; misses disqualify ranking`, columns, rows });
		verdicts.push(decide(`Burst ${workload}`, rows, 0, columns[0]!));
	}

	return { tables, verdicts: verdicts.filter((verdict): verdict is Verdict => verdict !== undefined) };
}

/**
 * Prints the full human-readable report.
 * @param result - The report.
 * @param tables - Ranked tables from {@link analyze}.
 */
function printReport(result: Report, tables: Table[]): void {
	const { meta, verdict: decided } = result;

	console.log(styleText('bold', 'watchr comparison benchmark'));
	console.log(styleText('dim', `${meta.node} · ${meta.platform} · ${meta.cpus}`));
	console.log(styleText('dim', Object.entries(meta.versions).map(([ name, version ]) => `${name} ${version}`).join(' · ')));
	console.log(styleText('dim', `${styleText('green', '★')} marks the best ranked result in each column`));

	for (const table of tables) { printTable(table) }

	const categoryWidth = Math.max(...decided.map((verdict) => verdict.category.length));
	const winnerWidth = Math.max(...decided.map((verdict) => verdict.winners.join(', ').length));
	const valueWidth = Math.max(...decided.map((verdict) => verdict.value.length));

	console.log(`\n${styleText('bold', 'Verdict')}`);

	for (const verdict of decided) {
		console.log(`  ${verdict.category.padEnd(categoryWidth)}  ${styleText([ 'green', 'bold' ], verdict.winners.join(', ').padEnd(winnerWidth))}  ${verdict.value.padStart(valueWidth)}  ${styleText('dim', verdict.margin)}`);
	}

	const wins = new Map<string, number>();

	for (const verdict of decided) {
		for (const winner of verdict.winners) { wins.set(winner, (wins.get(winner) ?? 0) + 1) }
	}

	const tally = [ ...wins ].sort((left, right) => right[1] - left[1]).map(([ name, total ]) => `${name} ${total}/${decided.length}`).join(' · ');
	console.log(`  ${'Categories won'.padEnd(categoryWidth)}  ${styleText('bold', tally)}`);

	console.log(styleText('dim', '\nAll watchers use their default options with initial events disabled and recursive watching on.'));
	console.log(styleText('dim', 'chokidar delays unlinks by 100 ms (atomic); watchr holds an add only when its inode was just vacated.'));
	console.log(styleText('dim', 'Warm process/filesystem cache, one adapter at a time. JS heap excludes native allocations; RSS is process-wide, not isolated.'));
	console.log(styleText('dim', 'Latency misses mean the requested event kind was absent; "other kinds" counts those ops with alternative notifications. Bursts run once per workload.'));

	if (result.skipped.length) {
		console.log(styleText('yellow', `Skipped: ${result.skipped.map((entry) => `${entry.name} (${entry.reason})`).join('; ')}`));
	}
}

/**
 * Compares watchr's readiness and bytes/path against the baseline.
 * @param current - This run.
 * @param baseline - The stored baseline.
 * @returns Human-readable failure lines (empty when within threshold).
 */
function findRegressions(current: Report, baseline: Report): string[] {
	const failures: string[] = [];
	if (baseline.meta.schemaVersion !== current.meta.schemaVersion || baseline.meta.quick !== current.meta.quick) {
		return [ 'incompatible benchmark methodology; record a fresh baseline with `pnpm bench:baseline`' ];
	}

	for (const scenario of current.readiness) {
		const now = scenario.watchers[watchrName];
		const then = baseline.readiness.find((entry) => entry.scenario === scenario.scenario)?.watchers[watchrName];

		if (then === undefined) {
			failures.push(`${scenario.scenario}: not in baseline; run \`pnpm bench:baseline\``);
			continue;
		}

		if (now === undefined || !Number.isFinite(now.readyMs) || now.failures > 0) {
			failures.push(`${scenario.scenario}: watchr produced no readiness sample (${now?.error ?? 'missing'})`);
			continue;
		}
		if (!Number.isFinite(then.readyMs) || then.failures > 0) {
			failures.push(`${scenario.scenario}: baseline has no valid readiness sample; record a fresh baseline`);
			continue;
		}

		if (now.readyMs > then.readyMs * regressionThreshold) {
			failures.push(`${scenario.scenario}: readiness ${now.readyMs.toFixed(0)}ms vs baseline ${then.readyMs.toFixed(0)}ms (+${((now.readyMs / then.readyMs - 1) * 100).toFixed(0)}%)`);
		}

		if (now.bytesPerPath !== null && then.bytesPerPath !== null && now.bytesPerPath > then.bytesPerPath * regressionThreshold) {
			failures.push(`${scenario.scenario}: ${now.bytesPerPath.toFixed(0)} B/path vs baseline ${then.bytesPerPath.toFixed(0)} (+${((now.bytesPerPath / then.bytesPerPath - 1) * 100).toFixed(0)}%)`);
		}
	}

	return failures;
}

// ---- Run ------------------------------------------------------------------------------------------------------------

const quickScenarios = [
	{ name: '100 files (quick)', build: (root) => buildFlat(root, 100) },
	{ name: '500 nested (quick)', build: (root) => buildNested(root, 1) }
] satisfies { name: string, build: (root: string) => number }[];
const fullScenarios = [
	{ name: '1k files', build: (root) => buildFlat(root, 1_000) },
	{ name: '10k files', build: (root) => buildFlat(root, 10_000) },
	{ name: '50k files', build: (root) => buildFlat(root, 50_000) },
	{ name: '5k nested', build: (root) => buildNested(root, 10) }
] satisfies { name: string, build: (root: string) => number }[];
const scenarios = values.quick ? quickScenarios : fullScenarios;

const adapters = [
	watchrAdapter(),
	await loadChokidar(),
	await loadParcel(),
	fsWatchAdapter()
].filter((adapter): adapter is Adapter => adapter !== undefined);

const totalSteps = scenarios.length * adapters.length + adapters.length * 6;
let step = 0;
let stepLabel = '';

/**
 * Shows a single self-overwriting progress line on an interactive stderr; silent otherwise.
 * @param message - What is being measured.
 */
function progress(message: string): void {
	step++;
	stepLabel = message;
	progressDetail();
}

/**
 * Redraws the current progress line with an optional sub-step.
 * @param detail - Sub-step text, e.g. the current op count.
 */
function progressDetail(detail?: string): void {
	if (process.stderr.isTTY) { process.stderr.write(`\r\x1b[2K[${step}/${totalSteps}] ${stepLabel}${detail ? ` · ${detail}` : ''}`) }
}

const report: Report = {
	meta: {
		schemaVersion: 2,
		node: process.version,
		platform: `${platform()} ${release()} ${arch()}`,
		cpus: `${cpus().length}x ${cpus()[0]?.model.trim() ?? 'unknown'}`,
		date: new Date().toISOString(),
		versions: {
			watchr: `${(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version} (dist)`,
			chokidar: versionOf('chokidar'),
			'@parcel/watcher': versionOf('@parcel/watcher')
		},
		runs,
		ops,
		burstOps,
		quick: values.quick
	},
	readiness: [],
	latency: {},
	rename: {},
	directoryRename: {},
	burst: {},
	verdict: [],
	skipped
};

// One throwaway open/close per adapter so lazily-initialised code and module caches don't land in the first sample.
{
	const warmupRoot = mkdtempSync(join(tmpdir(), 'watchr-compare-warmup-'));
	buildFlat(warmupRoot, 10);

	try {
		for (const adapter of adapters) {
			await sampleReadiness(adapter, warmupRoot).catch(() => undefined);
		}
	} finally {
		rmSync(warmupRoot, { recursive: true, force: true });
	}
}

for (const scenario of scenarios) {
	const root = mkdtempSync(join(tmpdir(), 'watchr-compare-readiness-'));

	try {
		const files = scenario.build(root);
		const entry: ReadinessScenario = { scenario: scenario.name, files, watchers: {} };

		for (const adapter of adapters) {
			progress(`startup · ${scenario.name} · ${adapter.name}`);
			entry.watchers[adapter.name] = await measureReadiness(adapter, root);
		}

		report.readiness.push(entry);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

for (const adapter of adapters) {
	progress(`latency · ${adapter.name}`);
	report.latency[adapter.name] = await measureLatency(adapter);
}

for (const adapter of adapters) {
	progress(`rename · ${adapter.name}`);
	report.rename[adapter.name] = await measureRename(adapter);
	progress(`directory rename · ${adapter.name}`);
	report.directoryRename[adapter.name] = await measureRename(adapter, true);
}

for (const adapter of adapters) {
	const entries = {} as Record<BurstWorkload, BurstEntry>;
	for (const workload of [ 'create', 'write', 'delete' ] as const) {
		progress(`burst ${workload} · ${adapter.name}`);
		entries[workload] = await measureBurst(adapter, workload);
	}
	report.burst[adapter.name] = entries;
}

if (process.stderr.isTTY) { process.stderr.write('\r\x1b[2K') }

const { tables, verdicts } = analyze(report);
report.verdict = verdicts;
printReport(report, tables);

if (values.output) {
	await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`);
	console.error(`report written to ${values.output}`);
}

if (values.mitata) { await measureMitata() }

if (values['update-baseline']) {
	await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
	console.error(`baseline written to ${baselinePath.pathname}`);
}

if (ciBaseline !== undefined) {
	const baseline = ciBaseline;
	const regressions = findRegressions(report, baseline);
	const sameMachine = baseline.meta.cpus === report.meta.cpus && baseline.meta.platform === report.meta.platform && baseline.meta.node === report.meta.node;
	const thresholdLabel = `${((regressionThreshold - 1) * 100).toFixed(0)}%`;

	if (regressions.length) {
		console.error(`ci: watchr regressed >${thresholdLabel} vs baseline (${baseline.meta.date}, ${baseline.meta.node}):`);

		for (const line of regressions) { console.error(`  - ${line}`) }

		if (sameMachine) { process.exit(1) }

		console.error(`ci: WARNING only — baseline was recorded on a different machine/runtime (${baseline.meta.cpus}; ${baseline.meta.platform}; ${baseline.meta.node}); run \`pnpm bench:baseline\` here to make this check binding`);
	} else {
		console.error(`ci: watchr within ${thresholdLabel} of baseline (${baseline.meta.date}) for ${report.readiness.length} scenarios${sameMachine ? '' : ' (baseline from a different machine/runtime)'}`);
	}
}

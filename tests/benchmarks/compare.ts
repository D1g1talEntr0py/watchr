/// <reference types="node" />
// End-to-end comparison: watchr (dist) vs chokidar vs @parcel/watcher, with raw `fs.watch` as reference.
// Usage: pnpm build && node --expose-gc tests/benchmarks/compare.ts [--ci] [--tolerance 0.2] [--update-baseline] [--runs 3] [--ops 100]
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

type EventKind = 'add' | 'change' | 'unlink' | 'rename' | 'other';
type Emitted = { kind: EventKind, path: string, pathNext: string | undefined, at: number };
type EventSink = (event: Emitted) => void;
type Handle = { close: () => Promise<void>, trackedPaths: () => number | undefined };
/** `scans`: builds a path table before ready (ranked for startup/memory). `reference`: shown for context, never ranked. */
type Adapter = { name: string, scans: boolean, reference: boolean, start: (root: string, onEvent: EventSink) => Promise<Handle> };

type ReadinessSample = { readyMs: number, retainedBytes: number, rssDeltaBytes: number, trackedPaths: number | undefined };
type ReadinessEntry = { readyMs: number, bytesPerPath: number | null, trackedPaths: number | null, retainedMB: number, rssDeltaMB: number, failures: number, error?: string };
type ReadinessScenario = { scenario: string, files: number, watchers: Record<string, ReadinessEntry> };
type LatencyStats = { p50Us: number, p95Us: number, missed: number, samples: number };
type LatencyEntry = { createAdd: LatencyStats, writeChange: LatencyStats, error?: string };
type RenameEntry = { correlated: number, pairs: number, unresolved: number, totalEvents: number, error?: string };
type Verdict = { category: string, winners: string[], value: string, margin: string };
type Report = {
	meta: { node: string, platform: string, cpus: string, date: string, versions: Record<string, string>, runs: number, ops: number },
	readiness: ReadinessScenario[],
	latency: Record<string, LatencyEntry>,
	rename: Record<string, RenameEntry>,
	verdict: Verdict[],
	skipped: { name: string, reason: string }[]
};

const { values } = parseArgs({
	options: {
		ci: { type: 'boolean', default: false },
		tolerance: { type: 'string', default: '0.2' },
		'update-baseline': { type: 'boolean', default: false },
		runs: { type: 'string', default: '3' },
		ops: { type: 'string', default: '100' }
	}
});

const runs = Math.max(1, Number(values.runs));
const ops = Math.max(1, Number(values.ops));
const renameOps = Math.min(50, ops);
const opGapMs = 20;
const eventTimeoutMs = 2_000;
// Each latency phase stops starting new ops after this long, once it has at least `minLatencySamples`.
const latencyBudgetMs = 5_000;
const minLatencySamples = 10;
// Upper bound only: the rename phase ends as soon as every rename has been reported.
const renameSettleMs = 3_000;
const regressionThreshold = 1 + Math.max(0, Number(values.tolerance) || 0);
const watchrName = 'watchr';
const baselinePath = new URL('./baseline.json', import.meta.url);
const gc = requireGc();
const skipped: Report['skipped'] = [];

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
function versionOf(name: string): string {
	try {
		const manifest = JSON.parse(readFileSync(new URL(`../../node_modules/${name}/package.json`, import.meta.url), 'utf8')) as { version: string };

		return manifest.version;
	} catch {
		return 'unavailable';
	}
}

const fileKinds: Record<string, EventKind> = { add: 'add', change: 'change', unlink: 'unlink', rename: 'rename' };
const parcelKinds: Record<string, EventKind> = { create: 'add', update: 'change', delete: 'unlink' };

/**
 * Builds the watchr adapter. Directory events map to `other`; `rename` carries the destination in `pathNext`.
 * @returns The adapter.
 */
function watchrAdapter(): Adapter {
	return {
		name: watchrName,
		scans: true,
		reference: false,
		async start(root, onEvent) {
			const watcher = new Watchr(root, { ignoreInitial: true, recursive: true });
			let failure: string | undefined;
			watcher.on('error', (error: Error) => { failure ??= error.message });
			watcher.on('all', (event: string, _stats: unknown, path: string, pathNext?: string) => {
				const at = performance.now();
				onEvent({ kind: fileKinds[event] ?? 'other', path, pathNext, at });
			});

			try {
				await watcher.readyLock;
			} catch (error) {
				watcher.close();
				throw new Error(failure ?? messageOf(error), { cause: error });
			}

			return { close: async () => { watcher.close() }, trackedPaths: () => trackedPathCount(root) };
		}
	};
}

/**
 * Loads chokidar with default options (`atomic: true` delays unlinks by 100 ms).
 * @returns The adapter, or `undefined` when the package cannot be loaded.
 */
async function loadChokidar(): Promise<Adapter | undefined> {
	try {
		const { watch } = await import('chokidar');

		return {
			name: 'chokidar',
			scans: true,
			reference: false,
			async start(root, onEvent) {
				const watcher = watch(root, { ignoreInitial: true, usePolling: false, persistent: true });
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
 * Loads `@parcel/watcher` with the platform's native backend. It does no JS-side scan, so it is not ranked for startup or memory.
 * @returns The adapter, or `undefined` when the native binding cannot be loaded.
 */
async function loadParcel(): Promise<Adapter | undefined> {
	try {
		const parcel = (await import('@parcel/watcher')).default;
		const backend = platform() === 'linux' ? 'inotify' : platform() === 'darwin' ? 'fs-events' : platform() === 'win32' ? 'windows' : undefined;

		return {
			name: '@parcel/watcher',
			scans: false,
			reference: false,
			async start(root, onEvent) {
				const subscription = await parcel.subscribe(root, (error, events) => {
					const at = performance.now();

					if (error) { return }

					for (const event of events) {
						onEvent({ kind: parcelKinds[event.type] ?? 'other', path: event.path, pathNext: undefined, at });
					}
				}, backend === undefined ? {} : { backend });

				return { close: () => subscription.unsubscribe(), trackedPaths: () => undefined };
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
			watcher.on('error', () => undefined);

			return Promise.resolve({ close: async () => { watcher.close() }, trackedPaths: () => undefined });
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
	const startedAt = performance.now();
	const handle = await adapter.start(root, () => undefined);
	const readyMs = performance.now() - startedAt;
	await settleHeap(gc);
	const after = process.memoryUsage();
	const trackedPaths = handle.trackedPaths();
	await handle.close();

	return { readyMs, retainedBytes: after.heapUsed - before.heapUsed, rssDeltaBytes: after.rss - before.rss, trackedPaths };
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
		readyMs: median(samples.map((sample) => sample.readyMs)),
		bytesPerPath: perPath,
		trackedPaths: trackedPaths ?? null,
		retainedMB: median(samples.map((sample) => sample.retainedBytes)) / 1_048_576,
		rssDeltaMB: median(samples.map((sample) => sample.rssDeltaBytes)) / 1_048_576,
		failures,
		...(error === undefined ? {} : { error })
	};
}

type Waiter = { kind: EventKind, resolve: (at: number) => void };

/**
 * Registers a waiter for `kind` at `path`, resolving with the event timestamp or `undefined` on timeout.
 * @param waiters - Shared waiter table.
 * @param path - Path to wait for.
 * @param kind - Event kind to wait for.
 * @returns The event timestamp, or `undefined` when it did not arrive in time.
 */
function waitFor(waiters: Map<string, Waiter>, path: string, kind: EventKind): Promise<number | undefined> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			waiters.delete(path);
			resolve(undefined);
		}, eventTimeoutMs);

		waiters.set(path, { kind, resolve: (at) => { clearTimeout(timer); resolve(at) } });
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
	let index = 0;

	for (; index < ops; index++) {
		if (index >= minLatencySamples && performance.now() - phaseStartedAt > latencyBudgetMs) { break }

		progressDetail(`${label} ${index + 1}/${ops}`);
		const { path, kind, perform } = operation(index);
		const eventAt = waitFor(waiters, path, kind);
		const startedAt = performance.now();
		await perform();
		const at = await eventAt;

		if (at === undefined) {
			missed++;
		} else {
			latenciesUs.push((at - startedAt) * 1_000);
		}

		await delay(opGapMs);
	}

	return { p50Us: percentile(latenciesUs, 0.5), p95Us: percentile(latenciesUs, 0.95), missed, samples: index };
}

/**
 * Measures `create → add` and `write → change` latency on a fresh 1k-file tree.
 * @param adapter - Watcher under test.
 * @returns The latency entry.
 */
async function measureLatency(adapter: Adapter): Promise<LatencyEntry> {
	const root = mkdtempSync(join(tmpdir(), 'watchr-compare-latency-'));
	const files = buildFlat(root, 1_000);
	const waiters = new Map<string, Waiter>();
	const empty: LatencyStats = { p50Us: Number.NaN, p95Us: Number.NaN, missed: 0, samples: 0 };
	let handle: Handle | undefined;

	try {
		handle = await adapter.start(root, (event) => {
			const waiter = waiters.get(event.path);

			if (waiter !== undefined && waiter.kind === event.kind) {
				waiters.delete(event.path);
				waiter.resolve(event.at);
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

		return { createAdd, writeChange };
	} catch (error) {
		return { createAdd: empty, writeChange: empty, error: messageOf(error) };
	} finally {
		await handle?.close();
		rmSync(root, { recursive: true, force: true });
	}
}

/**
 * Renames `renameOps` files and classifies what each watcher reported per op: one correlated `rename`, an
 * `unlink`+`add` pair, or anything else.
 * @param adapter - Watcher under test.
 * @returns The rename entry.
 */
async function measureRename(adapter: Adapter): Promise<RenameEntry> {
	const root = mkdtempSync(join(tmpdir(), 'watchr-compare-rename-'));
	buildFlat(root, renameOps);
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
		margin = better === 'lower' && top.value > 0
			? `${(runnerUp.value / top.value).toFixed(1)}x ${word} ${runnerUp.name} (${column.format(runnerUp.value)})`
			: `next best: ${runnerUp.name} (${column.format(runnerUp.value)})`;
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

		return { name: adapter.name, values: entries.map((entry) => entry === undefined ? null : pick(entry)), ranked: ranked(adapter), note };
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
	const startupRows = readinessRows(result, (entry) => entry.readyMs, (adapter) => adapter.scans && !adapter.reference, (adapter) => adapter.reference ? referenceNote : 'no initial scan, not ranked');
	tables.push({ title: 'Startup', hint: `time from construction to ready, median of ${meta.runs} · lower is better`, columns: startupColumns, rows: startupRows });
	verdicts.push(decide(`Startup (${largestLabel})`, startupRows, largest, startupColumns[largest]!));

	const memoryColumns = scenarioColumns(formatBytes);
	const memoryRows = readinessRows(result, (entry) => entry.bytesPerPath, (adapter) => adapter.scans && !adapter.reference, (adapter) => adapter.reference ? referenceNote : 'native memory, not measurable');
	tables.push({ title: 'Memory', hint: 'retained JS heap per watched path after ready · lower is better', columns: memoryColumns, rows: memoryRows });
	verdicts.push(decide(`Memory (${largestLabel})`, memoryRows, largest, memoryColumns[largest]!));

	const latencyColumns: Column[] = [
		{ label: 'create→add p50', better: 'lower', format: formatMs },
		{ label: 'p95', better: 'lower', format: formatMs },
		{ label: 'write→change p50', better: 'lower', format: formatMs },
		{ label: 'p95', better: 'lower', format: formatMs }
	];
	const latencyRows: Row[] = adapters.map((adapter) => {
		const entry = result.latency[adapter.name];
		const missed = (entry?.createAdd.missed ?? 0) + (entry?.writeChange.missed ?? 0);
		const capped = entry !== undefined && (entry.createAdd.samples < meta.ops || entry.writeChange.samples < meta.ops)
			? `${entry.createAdd.samples} / ${entry.writeChange.samples} samples (time budget)`
			: '';
		const note = [ adapter.reference ? referenceNote : '', capped, missed ? `${missed} events missed` : '', entry?.error ?? '' ].filter(Boolean).join('; ');
		const values = entry === undefined ? [ null, null, null, null ] : [ entry.createAdd.p50Us, entry.createAdd.p95Us, entry.writeChange.p50Us, entry.writeChange.p95Us ].map((us) => us / 1_000);

		return { name: adapter.name, values, ranked: !adapter.reference, note };
	});
	tables.push({ title: 'Latency', hint: `fs call to event, one op at a time, up to ${meta.ops} per column on a 1k-file tree · lower is better`, columns: latencyColumns, rows: latencyRows });
	verdicts.push(decide('Latency, create→add p50', latencyRows, 0, latencyColumns[0]!));
	verdicts.push(decide('Latency, write→change p50', latencyRows, 2, latencyColumns[2]!));

	const count = (value: number): string => `${value}/${renameOps}`;
	const renameColumns: Column[] = [
		{ label: 'as rename', better: 'higher', format: count },
		{ label: 'as unlink+add', format: count },
		{ label: 'lost', format: count }
	];
	const renameRows: Row[] = adapters.map((adapter) => {
		const entry = result.rename[adapter.name];
		const note = [ adapter.reference ? referenceNote : '', entry?.error ?? '' ].filter(Boolean).join('; ');
		const values = entry === undefined ? [ null, null, null ] : [ entry.correlated, entry.pairs, entry.unresolved ];

		return { name: adapter.name, values, ranked: !adapter.reference, note };
	});
	tables.push({ title: 'Rename detection', hint: `${renameOps} file renames, how each was reported · higher "as rename" is better`, columns: renameColumns, rows: renameRows });
	verdicts.push(decide('Rename detection', renameRows, 0, renameColumns[0]!));

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

	console.log(styleText('dim', '\nAll watchers use their default options with ignoreInitial and recursive on.'));
	console.log(styleText('dim', 'chokidar delays unlinks by 100 ms (atomic); watchr holds an add only when its inode was just vacated.'));

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

	for (const scenario of current.readiness) {
		const now = scenario.watchers[watchrName];
		const then = baseline.readiness.find((entry) => entry.scenario === scenario.scenario)?.watchers[watchrName];

		if (then === undefined) {
			failures.push(`${scenario.scenario}: not in baseline; run \`pnpm bench:baseline\``);
			continue;
		}

		if (now === undefined || Number.isNaN(now.readyMs)) {
			failures.push(`${scenario.scenario}: watchr produced no readiness sample (${now?.error ?? 'missing'})`);
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

const scenarios: { name: string, build: (root: string) => number }[] = [
	{ name: '1k files', build: (root) => buildFlat(root, 1_000) },
	{ name: '10k files', build: (root) => buildFlat(root, 10_000) },
	{ name: '50k files', build: (root) => buildFlat(root, 50_000) },
	{ name: '5k nested', build: (root) => buildNested(root, 10) }
];

const adapters = [
	watchrAdapter(),
	await loadChokidar(),
	await loadParcel(),
	fsWatchAdapter()
].filter((adapter): adapter is Adapter => adapter !== undefined);

const totalSteps = scenarios.length * adapters.length + adapters.length * 2;
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
		ops
	},
	readiness: [],
	latency: {},
	rename: {},
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
}

if (process.stderr.isTTY) { process.stderr.write('\r\x1b[2K') }

const { tables, verdicts } = analyze(report);
report.verdict = verdicts;
printReport(report, tables);

if (values['update-baseline']) {
	await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
	console.error(`baseline written to ${baselinePath.pathname}`);
}

if (values.ci) {
	if (!existsSync(baselinePath)) {
		console.error(`ci: no baseline at ${baselinePath.pathname}; run \`pnpm bench:baseline\` first`);
		process.exit(1);
	}

	const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Report;
	const regressions = findRegressions(report, baseline);
	const sameMachine = baseline.meta.cpus === report.meta.cpus && baseline.meta.platform === report.meta.platform;
	const thresholdLabel = `${((regressionThreshold - 1) * 100).toFixed(0)}%`;

	if (regressions.length) {
		console.error(`ci: watchr regressed >${thresholdLabel} vs baseline (${baseline.meta.date}, ${baseline.meta.node}):`);

		for (const line of regressions) { console.error(`  - ${line}`) }

		if (sameMachine) { process.exit(1) }

		console.error(`ci: WARNING only — baseline was recorded on a different machine (${baseline.meta.cpus}; ${baseline.meta.platform}); run \`pnpm bench:baseline\` here to make this check binding`);
	} else {
		console.error(`ci: watchr within ${thresholdLabel} of baseline (${baseline.meta.date}) for ${report.readiness.length} scenarios${sameMachine ? '' : ' (baseline from a different machine)'}`);
	}
}

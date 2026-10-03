import { afterEach, describe, expect, it } from 'vitest';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileSystemEvent } from '../../src/watchr';
import type { CapturedEvent } from '../helpers/fs-fixtures';
import { cleanupTempRoots, closeWatchers, collectEvents, createReadyWatcher, createTempRoot, delay, waitForEvent } from '../helpers/fs-fixtures';

type Run = {
	b: string;
	events: CapturedEvent[];
};

/**
 * Runs create(a) -> rename(a, b) -> write(b) -> rm(b) with a fixed gap between operations.
 * @param gap Milliseconds to wait between operations.
 * @returns The captured events and involved paths.
 */
async function runScenario(gap: number): Promise<Run> {
	const root = createTempRoot('watchr-ordering-');
	const watcher = await createReadyWatcher(root, { ignoreInitial: true, renameTimeout: 20 });
	const { events, dispose } = collectEvents(watcher);
	const a = join(root, 'a.txt');
	const b = join(root, 'b.txt');

	writeFileSync(a, 'x');
	await delay(gap);
	renameSync(a, b);
	await delay(gap);
	writeFileSync(b, 'yy');
	await delay(gap);
	rmSync(b);
	await delay(600);
	dispose();
	const readded = waitForEvent(watcher, FileSystemEvent.ADD, { path: b });
	writeFileSync(b, 'recreated');
	await readded;
	const removed = waitForEvent(watcher, FileSystemEvent.UNLINK, { path: b });
	rmSync(b);
	await removed;

	return { b, events };
}

/**
 * Returns the paths that have been introduced (via add or as a rename target) before `index`.
 * @param events Captured events.
 * @param index Exclusive upper bound.
 * @returns The set of known paths.
 */
function knownPathsBefore(events: CapturedEvent[], index: number): Set<string> {
	const known = new Set<string>();

	for (const { event, path, pathNext } of events.slice(0, index)) {
		if (event === FileSystemEvent.ADD) { known.add(path) }
		if (event === FileSystemEvent.RENAME && pathNext !== undefined) { known.add(pathNext) }
	}

	return known;
}

/**
 * Checks the ordering invariants for one run and returns human-readable violations.
 * @param gap Gap used for the run, for labelling.
 * @param run Captured run.
 * @returns Violation descriptions; empty when the run is well-formed.
 */
function violationsFor(gap: number, { b, events }: Run): string[] {
	const violations: string[] = [];
	const sequence = events.map(({ event, path, pathNext }) => `${event}(${path === b ? 'b' : 'a'}${pathNext === undefined ? '' : '->b'})`).join(' ') || '∅';

	for (const [ index, { event, path } ] of events.entries()) {
		if (event === FileSystemEvent.CHANGE && !knownPathsBefore(events, index).has(path)) {
			violations.push(`gap=${gap}: change without prior add/rename in [${sequence}]`);
		}
	}

	const lastForB = events.filter(({ path, pathNext }) => path === b || pathNext === b).at(-1);

	if (lastForB !== undefined && lastForB.event !== FileSystemEvent.UNLINK) {
		violations.push(`gap=${gap}: last event for b is ${lastForB.event}, not unlink, in [${sequence}]`);
	}

	return violations;
}

describe('regression B2: event ordering under short timing gaps', () => {
	afterEach(() => {
		closeWatchers();
		cleanupTempRoots();
	});

	// Single test over all gaps: whether a given gap trips the bug is timing-dependent, so cover several.
	it('should never emit change before add and must settle to unlink for gaps 0/3/30ms', async () => {
		const violations: string[] = [];

		for (const gap of [ 0, 3, 30 ]) {
			for (let iteration = 0; iteration < 2; iteration++) {
				violations.push(...violationsFor(gap, await runScenario(gap)));
			}
		}

		expect(violations, violations.join('\n')).toEqual([]);
	});

	it('should emit add, rename, change, unlink at a 300ms gap (control)', async () => {
		const { events } = await runScenario(300);

		expect(events.map(({ event }) => event)).toEqual([
			FileSystemEvent.ADD,
			FileSystemEvent.RENAME,
			FileSystemEvent.CHANGE,
			FileSystemEvent.UNLINK
		]);
	});
});

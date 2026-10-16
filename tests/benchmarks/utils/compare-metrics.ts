type Closable = { close: () => Promise<void> };

/**
 * Measures idle construction, explicit startup and cleanup independently.
 * @param prepare - Constructs an idle watcher and returns its startup operation.
 * @param inspect - Observes a started watcher outside the timed lifecycle operations.
 * @returns Lifecycle timings and the observation.
 */
export async function measureLifecycle<Handle extends Closable, Observation>(prepare: () => () => Promise<Handle>, inspect: (handle: Handle) => Promise<Observation>): Promise<{ constructionMs: number, readyMs: number, closeMs: number, observation: Observation }> {
	const constructionAt = performance.now();
	const start = prepare();
	const constructionMs = performance.now() - constructionAt;
	const startedAt = performance.now();
	const handle = await start();
	const readyMs = performance.now() - startedAt;
	let closeMs: number;
	let observation: Observation;

	try {
		observation = await inspect(handle);
	} finally {
		const closeAt = performance.now();
		await handle.close();
		closeMs = performance.now() - closeAt;
	}

	return { constructionMs, readyMs, closeMs, observation };
}

/**
 * Counts unique expected deliveries without treating duplicates as completed operations.
 * @param expected - Paths modified by the workload.
 * @param delivered - Matching event paths, including duplicate notifications.
 * @returns Delivery counts.
 */
export function deliveryCounts(expected: ReadonlySet<string>, delivered: readonly string[]): { received: number, missed: number, duplicates: number, unexpected: number } {
	const unique = new Set(delivered.filter((path) => expected.has(path)));
	const matching = delivered.filter((path) => expected.has(path)).length;

	return { received: unique.size, missed: expected.size - unique.size, duplicates: matching - unique.size, unexpected: delivered.length - matching };
}

/**
 * Parses a bounded workload size, rejecting values that would silently skip measurements.
 * @param value - Command-line value.
 * @param name - Option name for diagnostics.
 * @returns The positive integer.
 */
export function positiveInteger(value: string, name: string): number {
	const parsed = Number(value);

	if (!Number.isSafeInteger(parsed) || parsed < 1) { throw new Error(`--${name} must be a positive safe integer`) }

	return parsed;
}

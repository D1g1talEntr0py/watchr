import { describe, expect, it, vi } from 'vitest';
import { deliveryCounts, measureLifecycle, nonnegativeNumber, positiveInteger } from './utils/compare-metrics.ts';

describe('comparison benchmark metrics', () => {
	it('times construction, startup and close without timing inspection', async () => {
		let now = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => now);
		const close = vi.fn(async () => { now += 3 });

		try {
			const result = await measureLifecycle(() => {
				now += 2;
				return async () => { now += 11; return { close } };
			}, async () => { now += 100; return 'heap observation' });

			expect(result).toEqual({ constructionMs: 2, readyMs: 11, closeMs: 3, observation: 'heap observation' });
			expect(close).toHaveBeenCalledExactlyOnceWith();
		} finally {
			vi.restoreAllMocks();
		}
	});

	it('closes the watcher when inspection fails', async () => {
		const close = vi.fn(async () => undefined);
		await expect(measureLifecycle(() => async () => ({ close }), async () => { throw new Error('inspection failed') })).rejects.toThrow('inspection failed');
		expect(close).toHaveBeenCalledOnce();
	});

	it('awaits actual startup before inspecting or closing the watcher', async () => {
		const startup = Promise.withResolvers<{ close: () => Promise<void> }>();
		const start = vi.fn(() => startup.promise);
		const close = vi.fn(async () => undefined);
		const inspect = vi.fn(async () => 'started');
		const result = measureLifecycle(() => start, inspect);

		expect(start).toHaveBeenCalledOnce();
		expect(inspect).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
		startup.resolve({ close });
		expect((await result).observation).toBe('started');
		expect(inspect).toHaveBeenCalledExactlyOnceWith({ close });
		expect(close).toHaveBeenCalledOnce();
	});

	it('does not mistake duplicates or unrelated events for complete delivery', () => {
		expect(deliveryCounts(new Set([ 'a', 'b', 'c' ]), [ 'a', 'a', 'b', 'outside' ])).toEqual({ received: 2, missed: 1, duplicates: 1, unexpected: 1 });
	});

	it('accepts positive workload sizes', () => {
		expect(positiveInteger('10', 'ops')).toBe(10);
	});

	it.each([ '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992' ])('rejects invalid workload size %s', (value) => {
		expect(() => positiveInteger(value, 'ops')).toThrow('--ops must be a positive safe integer');
	});

	it.each([ '0', '0.5', '10', '150' ])('accepts rename timeout %s', (value) => {
		expect(nonnegativeNumber(value, 'rename-timeout')).toBe(Number(value));
	});

	it.each([ '', ' ', '-1', 'NaN', 'Infinity', '-Infinity', '1e309', 'invalid' ])('rejects invalid rename timeout %s', (value) => {
		expect(() => nonnegativeNumber(value, 'rename-timeout')).toThrow('--rename-timeout must be a finite nonnegative number');
	});
});

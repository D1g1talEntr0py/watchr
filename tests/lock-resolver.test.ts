import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LockResolver } from '../src/lock-resolver';

describe('LockResolver', () => {
	let resolver: LockResolver;
	const onError = vi.fn<(error: unknown) => void>();

	beforeEach(() => {
		vi.useFakeTimers({ toFake: [ 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance' ] });
		onError.mockReset();
		resolver = new LockResolver({ onError });
	});

	afterEach(() => {
		resolver.close();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('uses one shared timer and resolves each callback once', () => {
		const first = vi.fn();
		const second = vi.fn();
		resolver.add(first, 50);
		resolver.add(second, 50);
		expect(vi.getTimerCount()).toBe(1);

		vi.advanceTimersByTime(49);
		expect(first).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(first).toHaveBeenCalledOnce();
		expect(second).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(100);
		expect(first).toHaveBeenCalledOnce();
	});

	it('respects custom intervals and leaves later deadlines pending', () => {
		resolver = new LockResolver({ onError, interval: 10 });
		const later = vi.fn();
		const earlier = vi.fn();
		resolver.add(later, 35);
		resolver.add(earlier, 15);

		vi.advanceTimersByTime(10);
		expect(earlier).not.toHaveBeenCalled();
		vi.advanceTimersByTime(10);
		expect(earlier).toHaveBeenCalledOnce();
		expect(later).not.toHaveBeenCalled();
		vi.advanceTimersByTime(10);
		expect(later).not.toHaveBeenCalled();
		vi.advanceTimersByTime(10);
		expect(later).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('does not invoke removed callbacks and clears the empty timer', () => {
		const callback = vi.fn();
		resolver.add(callback, 50);
		resolver.remove(callback);
		resolver.remove(callback);
		vi.advanceTimersByTime(50);
		expect(callback).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('preserves an explicit interval grid when a cancelled callback is replaced before the tick', () => {
		resolver = new LockResolver({ onError, interval: 10 });
		const cancelled = vi.fn();
		const next = vi.fn();
		resolver.add(cancelled, 30);
		vi.advanceTimersByTime(5);
		resolver.remove(cancelled);
		resolver.add(next, 1);
		vi.advanceTimersByTime(4);
		expect(next).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(cancelled).not.toHaveBeenCalled();
		expect(next).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('settles at the deadline rather than the next fixed tick, never early', () => {
		const callback = vi.fn();
		resolver.add(callback, 151.5);
		vi.advanceTimersByTime(151);
		expect(callback).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(callback).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('reschedules the shared timer when a new earliest deadline arrives', () => {
		const later = vi.fn();
		const earlier = vi.fn();
		resolver.add(later, 150);
		vi.advanceTimersByTime(25);
		resolver.add(earlier, 10);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(9);
		expect(earlier).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(earlier).toHaveBeenCalledOnce();
		expect(later).not.toHaveBeenCalled();
		vi.advanceTimersByTime(115);
		expect(later).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('keeps a later callback pending after the earliest callback is removed', () => {
		const removed = vi.fn();
		const later = vi.fn();
		resolver.add(removed, 10);
		resolver.add(later, 151);
		resolver.remove(removed);
		vi.advanceTimersByTime(150);
		expect(removed).not.toHaveBeenCalled();
		expect(later).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(1);
		expect(later).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('moves an existing deadline earlier and keeps only one timer', () => {
		const callback = vi.fn();
		resolver.add(callback, 150);
		vi.advanceTimersByTime(10);
		resolver.add(callback, 7);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(6);
		expect(callback).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(callback).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(200);
		expect(callback).toHaveBeenCalledOnce();
	});

	it('cancels the empty timer immediately, including repeated removal', () => {
		const callback = vi.fn();
		resolver.add(callback, 150);
		resolver.remove(callback);
		resolver.remove(callback);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(200);
		expect(callback).not.toHaveBeenCalled();
	});

	it('does not overflow long deadlines into early settlement', () => {
		const callback = vi.fn();
		resolver.add(callback, 2147483657);
		vi.advanceTimersByTime(2147483647);
		expect(callback).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(10);
		expect(callback).toHaveBeenCalledOnce();
	});

	it.each([ undefined, 10 ])('preserves reentrant reset and reuse with interval %s', (interval) => {
		resolver = new LockResolver({ onError, ...(interval === undefined ? {} : { interval }) });
		const cancelled = vi.fn();
		const next = vi.fn();
		resolver.add(() => {
			resolver.reset();
			resolver.add(next, 30);
		}, 10);
		resolver.add(cancelled, 10);
		vi.advanceTimersByTime(10);
		expect(cancelled).not.toHaveBeenCalled();
		expect(next).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(29);
		expect(next).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(next).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('handles reentrant peer cancellation and self-registration without orphan timers', () => {
		const cancelled = vi.fn();
		let calls = 0;
		const callback = () => {
			calls++;
			resolver.remove(cancelled);

			if (calls === 1) { resolver.add(callback, 7) }
		};
		resolver.add(callback, 10);
		resolver.add(cancelled, 10);
		vi.advanceTimersByTime(10);
		expect(calls).toBe(1);
		expect(cancelled).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(7);
		expect(calls).toBe(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('schedules work registered by an error handler after a callback failure', () => {
		const next = vi.fn();
		onError.mockImplementation(() => { resolver.add(next, 7) });
		resolver.add(() => { throw new Error('callback failed') }, 10);
		vi.advanceTimersByTime(10);
		expect(onError).toHaveBeenCalledOnce();
		expect(next).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(7);
		expect(next).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('keeps a single timer at default capacity and evicts only the oldest callback', () => {
		const onEvict = vi.fn();
		const oldest = vi.fn();
		let calls = 0;
		resolver.add(oldest, 10, onEvict);

		for (let index = 0; index < 50000; index++) {
			resolver.add(() => { calls++ }, 151);
		}

		expect(onEvict).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(150);
		expect(oldest).not.toHaveBeenCalled();
		expect(calls).toBe(0);
		vi.advanceTimersByTime(1);
		expect(calls).toBe(50000);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('resets pending callbacks and can be reused', () => {
		const cancelled = vi.fn();
		const next = vi.fn();
		resolver.add(cancelled, 50);
		resolver.reset();
		resolver.reset();
		expect(vi.getTimerCount()).toBe(0);
		resolver.add(next, 100);
		vi.advanceTimersByTime(100);
		expect(cancelled).not.toHaveBeenCalled();
		expect(next).toHaveBeenCalledOnce();
	});

	it.each([ undefined, 10 ])('disposes the shared timer and pending callbacks on scope exit (interval=%s)', (interval) => {
		const callback = vi.fn();
		{
			using scopedResolver = new LockResolver({ onError, ...(interval === undefined ? {} : { interval }) });
			resolver = scopedResolver;
			scopedResolver.add(callback, 50);
			expect(vi.getTimerCount()).toBe(1);
		}
		resolver.close();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(100);
		expect(callback).not.toHaveBeenCalled();
	});

	it('updates an existing callback deadline without evicting it', () => {
		resolver = new LockResolver({ onError, maxResolvers: 1 });
		const callback = vi.fn();
		const onEvict = vi.fn();
		resolver.add(callback, 50, onEvict);
		resolver.add(callback, 100, onEvict);
		vi.advanceTimersByTime(50);
		expect(callback).not.toHaveBeenCalled();
		expect(onEvict).not.toHaveBeenCalled();
		vi.advanceTimersByTime(50);
		expect(callback).toHaveBeenCalledOnce();
	});

	it('evicts the oldest callback at capacity and settles it through onEvict', () => {
		resolver = new LockResolver({ onError, maxResolvers: 2 });
		const oldest = vi.fn();
		const second = vi.fn();
		const newest = vi.fn();
		const onEvict = vi.fn();
		resolver.add(oldest, 50, onEvict);
		resolver.add(second, 50);
		resolver.add(newest, 50);
		expect(onEvict).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(50);
		expect(oldest).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledOnce();
		expect(newest).toHaveBeenCalledOnce();
	});

	it('allows eviction without an onEvict callback', () => {
		resolver = new LockResolver({ onError, maxResolvers: 1 });
		const oldest = vi.fn();
		const newest = vi.fn();
		resolver.add(oldest, 50);
		resolver.add(newest, 50);
		vi.advanceTimersByTime(50);
		expect(oldest).not.toHaveBeenCalled();
		expect(newest).toHaveBeenCalledOnce();
	});

	it('registers the replacement before propagating an eviction failure', () => {
		resolver = new LockResolver({ onError, maxResolvers: 1 });
		const failure = new Error('eviction failed');
		const newest = vi.fn();
		resolver.add(vi.fn(), 50, () => { throw failure });
		expect(() => resolver.add(newest, 50)).toThrow(failure);
		vi.advanceTimersByTime(50);
		expect(newest).toHaveBeenCalledOnce();
	});

	it('keeps reentrant eviction cleanup and registration on the same shared timer', () => {
		resolver = new LockResolver({ onError, maxResolvers: 2 });
		const oldest = vi.fn();
		const cancelled = vi.fn();
		const reentrant = vi.fn();
		const newest = vi.fn();
		resolver.add(oldest, 10, () => {
			resolver.remove(cancelled);
			resolver.add(reentrant, 7);
		});
		resolver.add(cancelled, 30);
		resolver.add(newest, 20);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(7);
		expect(reentrant).toHaveBeenCalledOnce();
		expect(oldest).not.toHaveBeenCalled();
		expect(cancelled).not.toHaveBeenCalled();
		expect(newest).not.toHaveBeenCalled();
		vi.advanceTimersByTime(13);
		expect(newest).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('routes callback failures to the error handler and continues resolving', () => {
		const failure = new Error('callback failed');
		const next = vi.fn();
		resolver.add(() => { throw failure }, 50);
		resolver.add(next, 50);
		expect(() => vi.advanceTimersByTime(50)).not.toThrow();
		expect(onError).toHaveBeenCalledWith(failure);
		expect(next).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([ new Error('sink failed'), 'sink failed' ])('warns when the error handler throws %s', (sinkFailure) => {
		const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
		// eslint-disable-next-line @typescript-eslint/only-throw-error -- Exercise normalization of non-Error listener failures.
		onError.mockImplementation(() => { throw sinkFailure });
		resolver.add(() => { throw new Error('callback failed') }, 50);
		expect(() => vi.advanceTimersByTime(50)).not.toThrow();
		expect(warning).toHaveBeenCalledOnce();
		expect(warning).toHaveBeenCalledWith(expect.objectContaining({
			name: 'WatchrWarning',
			message: 'sink failed',
			code: 'WATCHR_LOCK_RESOLVER_ERROR',
			detail: 'A lock resolver threw during an interval tick.',
			cause: expect.any(Error)
		}), {
			code: 'WATCHR_LOCK_RESOLVER_ERROR',
			detail: 'A lock resolver threw during an interval tick.'
		});
		expect(vi.getTimerCount()).toBe(0);
	});
});

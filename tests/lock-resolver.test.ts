import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LockResolver } from '../src/lock-resolver';

describe('LockResolver', () => {
	let resolver: LockResolver;
	const onError = vi.fn<(error: unknown) => void>();

	beforeEach(() => {
		vi.useFakeTimers({ toFake: [ 'setInterval', 'clearInterval', 'performance' ] });
		onError.mockReset();
		resolver = new LockResolver({ onError });
	});

	afterEach(() => {
		resolver.reset();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('uses one default interval and resolves each callback once', () => {
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

	it('does not invoke removed callbacks and clears the empty interval', () => {
		const callback = vi.fn();
		resolver.add(callback, 50);
		resolver.remove(callback);
		resolver.remove(callback);
		vi.advanceTimersByTime(50);
		expect(callback).not.toHaveBeenCalled();
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

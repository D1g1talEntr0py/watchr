import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RetryQueue } from '../src/retry-queue';

vi.mock('../src/constants', () => ({ maxConcurrentStats: 2 }));

describe('RetryQueue', () => {
	let queue: RetryQueue;
	let leases: Disposable[];

	const acquire = async (signal?: AbortSignal): Promise<Disposable> => {
		const lease = await queue.schedule(signal);
		leases.push(lease);
		return lease;
	};

	beforeEach(() => {
		vi.useFakeTimers();
		queue = new RetryQueue();
		leases = [];
	});

	afterEach(() => {
		for (const lease of leases) { lease[Symbol.dispose]() }
		vi.useRealTimers();
	});

	it('admits tasks below capacity without starting a timer', async () => {
		await acquire();
		await acquire();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('rejects an already aborted signal without occupying capacity', async () => {
		await expect(queue.schedule(AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
		await acquire();
		await acquire();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('holds excess tasks until a lease is released, in admission order', async () => {
		const first = await acquire();
		const second = await acquire();
		const admitted: string[] = [];
		const third = acquire().then(() => { admitted.push('third') });
		const fourth = acquire().then(() => { admitted.push('fourth') });

		await vi.advanceTimersByTimeAsync(100);
		expect(admitted).toEqual([]);
		expect(vi.getTimerCount()).toBe(1);

		first[Symbol.dispose]();
		await third;
		expect(admitted).toEqual([ 'third' ]);
		expect(vi.getTimerCount()).toBe(1);

		second[Symbol.dispose]();
		await fourth;
		expect(admitted).toEqual([ 'third', 'fourth' ]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('removes a cancelled pending task and stops its safety timer', async () => {
		const first = await acquire();
		await acquire();
		const controller = new AbortController();
		const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
		const pending = queue.schedule(controller.signal);
		const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });

		controller.abort();
		await rejection;
		expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
		expect(vi.getTimerCount()).toBe(0);

		first[Symbol.dispose]();
		await acquire();
	});

	it('keeps remaining pending tasks queued when one is cancelled', async () => {
		const first = await acquire();
		await acquire();
		const controller = new AbortController();
		const cancelled = queue.schedule(controller.signal);
		const rejection = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
		const pending = acquire();

		controller.abort();
		await rejection;
		expect(vi.getTimerCount()).toBe(1);

		first[Symbol.dispose]();
		await pending;
		expect(vi.getTimerCount()).toBe(0);
	});

	it('retains an admitted lease after its signal aborts', async () => {
		const controller = new AbortController();
		const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
		const first = await acquire(controller.signal);
		await acquire();
		expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));

		controller.abort();
		const admitted = vi.fn();
		const pending = acquire().then(admitted);
		await vi.advanceTimersByTimeAsync(50);
		expect(admitted).not.toHaveBeenCalled();

		first[Symbol.dispose]();
		await pending;
		expect(admitted).toHaveBeenCalledOnce();
	});

	it('does not release another task when a lease is disposed twice', async () => {
		const first = await acquire();
		await acquire();
		const third = acquire();
		const admitted = vi.fn();
		const fourth = acquire().then(admitted);

		first[Symbol.dispose]();
		const thirdLease = await third;
		first[Symbol.dispose]();
		await vi.advanceTimersByTimeAsync(50);
		expect(admitted).not.toHaveBeenCalled();

		thirdLease[Symbol.dispose]();
		await fourth;
		expect(admitted).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});
});

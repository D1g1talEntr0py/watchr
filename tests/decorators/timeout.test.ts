import { afterEach, describe, it, expect, vi } from 'vitest';
import { timeout } from '../../src/decorators/timeout';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('timeout decorator', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('should throw an error if timeout value is negative', () => {
		expect(() => timeout(-1)).toThrow('timeout value must be non-negative');
	});

	it('should resolve with the method\'s result if it completes before the timeout', async () => {
		class Test {
			@timeout(100)
			async method(): Promise<string | undefined> {
				await sleep(50);
				return 'done';
			}
		}

		const instance = new Test();
		const result = await instance.method();
		expect(result).toBe('done');
	});

	it('should resolve with undefined if the method times out', async () => {
		class Test {
			@timeout(50)
			async method(): Promise<string | undefined> {
				await sleep(100);
				return 'done';
			}
		}

		const instance = new Test();
		const result = await instance.method();
		expect(result).toBeUndefined();
	});

	it('should propagate rejection from the decorated method', async () => {
		const error = new Error('test error');
		class Test {
			@timeout(100)
			async method(): Promise<string | undefined> {
				await sleep(50);
				throw error;
			}
		}

		const instance = new Test();
		await expect(instance.method()).rejects.toThrow(error);
	});

	it('should work with the default timeout value', async () => {
		class Test {
			@timeout() // default is 250ms
			async method(): Promise<string | undefined> {
				await sleep(300);
				return 'done';
			}
		}

		const instance = new Test();
		const result = await instance.method();
		expect(result).toBeUndefined();
	});

	it('should pass arguments to the original method', async () => {
		class Test {
			@timeout(100)
			async method(a: number, b: string): Promise<string | undefined> {
				await sleep(50);
				return `${a}-${b}`;
			}
		}

		const instance = new Test();
		const result = await instance.method(1, 'test');
		expect(result).toBe('1-test');
	});

	it('should return undefined and suppress error if method throws after timeout', async () => {
		class Test {
			@timeout(50)
			async method(): Promise<string | undefined> {
				await sleep(100);
				throw new Error('This error should be suppressed');
			}
		}

		const instance = new Test();
		const result = await instance.method();
		expect(result).toBeUndefined();
	});

	it('should only combine the trailing signal instead of mutating an unrelated AbortSignal in the arguments', async () => {
		let unrelatedAborted = false;
		let trailingSignalAborted = false;

		class Test {
			@timeout(50)
			async method(unrelatedSignal: AbortSignal, signal?: AbortSignal): Promise<string | undefined> {
				unrelatedSignal.addEventListener('abort', () => {
					unrelatedAborted = true;
				}, { once: true });

				signal?.addEventListener('abort', () => {
					trailingSignalAborted = true;
				}, { once: true });

				await sleep(100);
				return 'done';
			}
		}

		const instance = new Test();
		const result = await instance.method(new AbortController().signal, new AbortController().signal);
		expect(result).toBeUndefined();
		expect(trailingSignalAborted).toBe(true);
		expect(unrelatedAborted).toBe(false);
	});

	it('should abort and dispose the timer when the timeout wins', async () => {
		vi.useFakeTimers();
		let signalAborted = false;

		class Test {
			@timeout(50)
			async method(signal?: AbortSignal): Promise<string | undefined> {
				signal?.addEventListener('abort', () => {
					signalAborted = true;
				}, { once: true });

				return await new Promise<string>(() => undefined);
			}
		}

		const instance = new Test();
		const resultPromise = instance.method();

		await vi.advanceTimersByTimeAsync(50);

		await expect(resultPromise).resolves.toBeUndefined();
		expect(signalAborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('should dispose the timer when the method resolves before the timeout', async () => {
		vi.useFakeTimers();
		let signalAborted = false;

		class Test {
			@timeout(100)
			async method(signal?: AbortSignal): Promise<string | undefined> {
				signal?.addEventListener('abort', () => {
					signalAborted = true;
				}, { once: true });

				return 'done';
			}
		}

		const instance = new Test();

		await expect(instance.method()).resolves.toBe('done');
		await vi.advanceTimersByTimeAsync(100);

		expect(signalAborted).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('should dispose the timer when the method rejects before the timeout', async () => {
		vi.useFakeTimers();
		const error = new Error('test error');
		let signalAborted = false;

		class Test {
			@timeout(100)
			async method(signal?: AbortSignal): Promise<string | undefined> {
				signal?.addEventListener('abort', () => {
					signalAborted = true;
				}, { once: true });

				throw error;
			}
		}

		const instance = new Test();

		await expect(instance.method()).rejects.toThrow(error);
		await vi.advanceTimersByTimeAsync(100);

		expect(signalAborted).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});
});

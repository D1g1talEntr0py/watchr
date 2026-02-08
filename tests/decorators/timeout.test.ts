import { describe, it, expect } from 'vitest';
import { timeout } from '../../src/decorators/timeout';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('timeout decorator', () => {
	it('should throw an error if timeout value is negative', () => {
		expect(() => timeout(-1)).toThrow('timeout value must be non-negative');
	});

	it('should resolve with the method\'s result if it completes before the timeout', async () => {
		class Test {
			@timeout(100)
			async method(): Promise<string> {
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
			async method(): Promise<string> {
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
			async method(): Promise<string> {
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
			async method(): Promise<string> {
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
			async method(a: number, b: string): Promise<string> {
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
			async method(): Promise<string> {
				await sleep(100);
				throw new Error('This error should be suppressed');
			}
		}

		const instance = new Test();
		const result = await instance.method();
		expect(result).toBeUndefined();
	});
});
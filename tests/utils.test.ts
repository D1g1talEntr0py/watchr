import { describe, expect, it, vi } from 'vitest';
import { castError, debounce, noop } from '../src/utils';

describe('utils', () => {
	describe('noop', () => {
		it('should be a function', () => {
			expect(typeof noop).toBe('function');
		});

		it('should return undefined', () => {
			expect(noop()).toBeUndefined();
		});
	});

	describe('debounce', () => {
		it('should debounce function calls, executing only the last one', async () => {
			const func = vi.fn();
			const debouncedFunc = debounce(func, 50);

			debouncedFunc();
			debouncedFunc();
			debouncedFunc();

			expect(func).not.toHaveBeenCalled();

			await new Promise(resolve => setTimeout(resolve, 100));

			expect(func).toHaveBeenCalledTimes(1);
		});

		it('should apply the correct `this` context and arguments', async () => {
			const func = vi.fn(function(this: { foo: string }, a: number, b: string) {
				expect(this.foo).toBe('bar');
				return `${this.foo}-${a}-${b}`;
			});
			const context = { foo: 'bar' };
			const debouncedFunc = debounce(func, 50);

			const promise = debouncedFunc.call(context, 1, 'test');

			await new Promise(resolve => setTimeout(resolve, 100));

			expect(func).toHaveBeenCalledWith(1, 'test');
			await expect(promise).resolves.toBe('bar-1-test');
		});

		it('should reject the promise if the debounced function throws an error', async () => {
			const errorMessage = 'test error';
			const func = () => {
				throw new Error(errorMessage);
			};
			const debouncedFunc = debounce(func, 50);

			await expect(debouncedFunc()).rejects.toThrow(errorMessage);
		});

		it('should resolve previous pending promises with undefined when a new call is made', async () => {
			const func = vi.fn();
			const debouncedFunc = debounce(func, 100);

			const promise1 = debouncedFunc();
			const promise2 = debouncedFunc();

			const result1 = await promise1;
			expect(result1).toBeUndefined();

			await new Promise(resolve => setTimeout(resolve, 150));
			// This will resolve with the function's return value
			await promise2;

			expect(func).toHaveBeenCalledTimes(1);
		});
	});

	describe('castError', () => {
		it('should return the same Error object if the input is an instance of Error', () => {
			const error = new Error('test error');
			expect(castError(error)).toBe(error);
		});

		it('should create a new Error object with the given message if the input is a string', () => {
			const errorMessage = 'test error string';
			const result = castError(errorMessage);
			expect(result).toBeInstanceOf(Error);
			expect(result.message).toBe(errorMessage);
		});

		it('should create a new Error with a generic message for other types of input', () => {
			const inputs = [123, { a: 1 }, null, undefined, () => {}];
			for (const input of inputs) {
				const result = castError(input);
				expect(result).toBeInstanceOf(Error);
				expect(result.message).toBe('Unknown error');
			}
		});
	});
});

import { describe, expect, it, vi } from 'vitest';
import { addJavaScriptExtension } from '../build/extension-utils';
import { castError, noop, raceWithAbort } from '../src/utils';

describe('utils', () => {
	describe('noop', () => {
		it('should be a function', () => {
			expect(typeof noop).toBe('function');
		});

		it('should return undefined', () => {
			expect(noop()).toBeUndefined();
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

	describe('raceWithAbort', () => {
		it('should return the promise result when it resolves first', async () => {
			await expect(raceWithAbort(Promise.resolve('result'))).resolves.toBe('result');
		});

		it('should reject with the abort reason when the signal aborts first', async () => {
			const abortController = new AbortController();
			const promise = raceWithAbort(new Promise(() => {}), abortController.signal);

			abortController.abort();

			await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
		});
	});

	describe('addJavaScriptExtension', () => {
		it.each([
			[ './module', './module.js' ],
			[ './module.js', './module.js' ],
			[ './data.json', './data.json' ],
			[ './native.node', './native.node' ]
		])('should rewrite %s as %s', (modulePath, expectedPath) => {
			expect(addJavaScriptExtension(modulePath)).toBe(expectedPath);
		});
	});
});

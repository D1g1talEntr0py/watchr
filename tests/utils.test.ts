import { describe, expect, it, vi } from 'vitest';
import { castError, noop } from '../src/utils';

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
});

import { describe, it, expect } from 'vitest';
import type { WatchrOptions } from '../src/@types';

describe('exactOptionalPropertyTypes', () => {
	it('should prefer omitted optional properties over explicit undefined', () => {
		const validOptions: WatchrOptions = { debounce: 100 };
		const alsoValidOptions: WatchrOptions = {};

		expect(validOptions.debounce).toBe(100);
		expect(alsoValidOptions.debounce).toBeUndefined();

		// @ts-expect-error exactOptionalPropertyTypes should reject explicit undefined here.
		const invalidOptions: WatchrOptions = { debounce: undefined };
		expect(invalidOptions).toBeDefined();
	});
});
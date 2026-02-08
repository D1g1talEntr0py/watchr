import {describe, expect, it} from 'vitest';
import {SetMultiMap} from '../src/set-multi-map';

describe('SetMultiMap', () => {
	describe('set', () => {
		it('should add a new value to a key', () => {
			const map = new SetMultiMap<string, number>();
			map.set('a', 1);
			expect(map.get('a')).toEqual(new Set([1]));
		});

		it('should add multiple unique values to the same key', () => {
			const map = new SetMultiMap<string, number>();
			map.set('a', 1);
			map.set('a', 2);
			expect(map.get('a')).toEqual(new Set([1, 2]));
		});

		it('should not add duplicate values for the same key', () => {
			const map = new SetMultiMap<string, number>();
			map.set('a', 1);
			map.set('a', 1);
			expect(map.get('a')).toEqual(new Set([1]));
			expect(map.get('a')?.size).toBe(1);
		});

		it('should allow setting a key with a pre-existing Set', () => {
			const map = new SetMultiMap<string, number>();
			const valueSet = new Set([10, 20]);
			map.set('b', valueSet);
			expect(map.get('b')).toBe(valueSet);
		});

		it('should chain `set` calls', () => {
			const map = new SetMultiMap<string, number>();
			map.set('a', 1).set('b', 2);
			expect(map.get('a')).toEqual(new Set([1]));
			expect(map.get('b')).toEqual(new Set([2]));
		});
	});

	describe('find', () => {
		it('should find a value in the set for a given key', () => {
			const map = new SetMultiMap<string, {id: number}>();
			map.set('a', {id: 1});
			map.set('a', {id: 2});
			const found = map.find('a', value => value.id === 2);
			expect(found).toEqual({id: 2});
		});

		it('should return undefined if the value is not found', () => {
			const map = new SetMultiMap<string, number>();
			map.set('a', 1);
			const found = map.find('a', value => value === 2);
			expect(found).toBeUndefined();
		});

		it('should return undefined if the key does not exist', () => {
			const map = new SetMultiMap<string, number>();
			const found = map.find('a', value => value === 1);
			expect(found).toBeUndefined();
		});
	});

	describe('deleteValue', () => {
		it('should delete a specific value from a key', () => {
			const map = new SetMultiMap<string, number>();
			map.set('a', 1);
			map.set('a', 2);
			expect(map.deleteValue('a', 1)).toBe(true);
			expect(map.get('a')).toEqual(new Set([2]));
		});

		it('should delete the key if the set becomes empty after value deletion', () => {
			const map = new SetMultiMap<string, number>();
			map.set('a', 1);
			expect(map.deleteValue('a', 1)).toBe(true);
			expect(map.has('a')).toBe(false);
		});

		it('should return false if the value to delete does not exist', () => {
			const map = new SetMultiMap<string, number>();
			map.set('a', 1);
			expect(map.deleteValue('a', 2)).toBe(false);
		});

		it('should return false if the key does not exist', () => {
			const map = new SetMultiMap<string, number>();
			expect(map.deleteValue('a', 1)).toBe(false);
		});

		it('should delete the entire key if the value to delete is undefined', () => {
			const map = new SetMultiMap<string, number>();
			map.set('a', 1);
			map.set('a', 2);
			expect(map.deleteValue('a', undefined)).toBe(true);
			expect(map.has('a')).toBe(false);
		});
	});

	describe('[Symbol.toStringTag]', () => {
		it('should return "SetMultiMap" as the string tag', () => {
			const map = new SetMultiMap();
			expect(Object.prototype.toString.call(map)).toBe('[object SetMultiMap]');
			expect(map[Symbol.toStringTag]).toBe('SetMultiMap');
		});
	});

	// Test inherited Map methods to ensure they behave as expected
	describe('Map method compatibility', () => {
		it('should get values with `get`', () => {
			const map = new SetMultiMap<string, number>();
			map.set('a', 1);
			expect(map.get('a')).toEqual(new Set([1]));
		});

		it('should check for keys with `has`', () => {
			const map = new SetMultiMap<string, number>();
			map.set('a', 1);
			expect(map.has('a')).toBe(true);
			expect(map.has('b')).toBe(false);
		});

		it('should delete keys with `delete`', () => {
			const map = new SetMultiMap<string, number>();
			map.set('a', 1);
			expect(map.delete('a')).toBe(true);
			expect(map.has('a')).toBe(false);
			expect(map.delete('b')).toBe(false);
		});

		it('should clear the map with `clear`', () => {
			const map = new SetMultiMap<string, number>();
			map.set('a', 1);
			map.clear();
			expect(map.size).toBe(0);
		});
	});
});

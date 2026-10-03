import { describe, expect, it } from 'vitest';
import { SetMultiMap } from '../src/set-multi-map';

describe('SetMultiMap', () => {
	it('supports chaining and finds inline values only when they match', () => {
		const map = new SetMultiMap<number, string>();
		expect(map.set(1, 'first')).toBe(map);
		expect(map.find(1, (value) => value === 'first')).toBe('first');
		expect(map.find(1, (value) => value === 'other')).toBeUndefined();
		expect(map.find(2, () => true)).toBeUndefined();
	});

	it('keeps distinct values in insertion order without duplicating them', () => {
		const map = new SetMultiMap<number, string>();
		map.set(1, 'first').set(1, 'first').set(1, 'second').set(1, 'third').set(1, 'second');
		const visited: string[] = [];
		expect(map.find(1, (value) => {
			visited.push(value);
			return value === 'third';
		})).toBe('third');
		expect(visited).toEqual([ 'first', 'second', 'third' ]);
		expect(map.find(1, () => false)).toBeUndefined();
	});

	it('returns false when removing a missing key or nonmatching inline value', () => {
		const map = new SetMultiMap<number, string>();
		map.set(1, 'first');
		expect(map.deleteValue(2, 'first')).toBe(false);
		expect(map.deleteValue(1, 'other')).toBe(false);
		expect(map.find(1, () => true)).toBe('first');
	});

	it('removes an inline value without affecting another key', () => {
		const map = new SetMultiMap<number, string>();
		map.set(1, 'first').set(2, 'other');
		expect(map.deleteValue(1, 'first')).toBe(true);
		expect(map.find(1, () => true)).toBeUndefined();
		expect(map.find(2, () => true)).toBe('other');
		expect(map.deleteValue(1, 'first')).toBe(false);
	});

	it('preserves remaining members when removing from a multi-value key', () => {
		const map = new SetMultiMap<number, string>();
		map.set(1, 'first').set(1, 'second').set(1, 'third');
		expect(map.deleteValue(1, 'missing')).toBe(false);
		expect(map.deleteValue(1, 'second')).toBe(true);
		expect(map.find(1, (value) => value === 'second')).toBeUndefined();
		expect(map.find(1, (value) => value === 'third')).toBe('third');
		expect(map.deleteValue(1, 'first')).toBe(true);
		expect(map.find(1, () => true)).toBe('third');
		expect(map.deleteValue(1, 'third')).toBe(true);
		expect(map.find(1, () => true)).toBeUndefined();
	});

	it('can promote a key again after it shrinks to one value', () => {
		const map = new SetMultiMap<number, string>();
		map.set(1, 'first').set(1, 'second');
		map.deleteValue(1, 'first');
		map.set(1, 'third');
		expect(map.find(1, () => true)).toBe('second');
		expect(map.find(1, (value) => value === 'third')).toBe('third');
	});

	it('clears inline and multi-value keys and remains reusable', () => {
		const map = new SetMultiMap<number, string>();
		map.set(1, 'first').set(2, 'second').set(2, 'third');
		map.clear();
		expect(map.find(1, () => true)).toBeUndefined();
		expect(map.find(2, () => true)).toBeUndefined();
		map.set(1, 'new');
		expect(map.find(1, () => true)).toBe('new');
	});
});

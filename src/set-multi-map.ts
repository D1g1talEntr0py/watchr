/** A {@link Map} that can contain multiple, unique, values for the same key. */
export class SetMultiMap<K, V> extends Map<K, Set<V>> {
	/**
	 * Adds a new element with a specified key and value to the SetMultiMap.
	 * If an element with the same key already exists, the value will be added to the underlying {@link Set}.
	 * If the value already exists in the {@link Set}, it will not be added again.
	 *
	 * @param key - The key to set.
	 * @param value - The value to add to the SetMultiMap.
	 * @returns The SetMultiMap with the updated key and value.
	 */
	override set(key: K, value: V): this;
	/**
	 * Adds a new Set with a specified key and value to the SetMultiMap.
	 * If an element with the same key already exists, the value will be added to the underlying {@link Set}.
	 * If the value already exists in the {@link Set}, it will not be added again.
	 *
	 * @param key - The key to set.
	 * @param value - The set of values to add to the SetMultiMap.
	 * @returns The SetMultiMap with the updated key and value.
	 */
	override set(key: K, value: Set<V>): this;
	/**
	 * Adds a new value with a specified key to the SetMultiMap.
	 * If an element with the same key already exists, the value will be added to the underlying {@link Set}.
	 * If the value already exists in the {@link Set}, it will not be added again.
	 *
	 * @param key - The key to set.
	 * @param value - The value to add to the SetMultiMap.
	 * @returns The SetMultiMap with the updated key and value.
	 */
	override set(key: K, value: V | Set<V>): this {
		super.set(key, value instanceof Set ? value : (super.get(key) ?? new Set<V>()).add(value));

		return this;
	}

	/**
	 * Finds a value in the Set associated with the specified key that matches the provided iterator function.
	 *
	 * @param key - The key to search for.
	 * @param iterator - The function to test each value.
	 * @returns The first value that satisfies the provided testing function, or `undefined` if no such value is found.
	 */
	find(key: K, iterator: (value: V) => boolean): V | undefined {
		const values = this.get(key);

		if (values !== undefined) {
			for (const value of values) {
				if (iterator(value)) { return value }
			}
		}

		return undefined;
	}

	/**
	 * Removes a specific value from a specific key.
	 *
	 * @param key - The key to remove the value from.
	 * @param value - The value to remove.
	 * @returns True if the value was removed, false otherwise.
	 */
	deleteValue(key: K, value: V | undefined): boolean {
		if (value === undefined) { return this.delete(key) }

		const values = super.get(key);
		if (values) {
			const deleted = values.delete(value);

			if (values.size === 0) {
				super.delete(key);
			}

			return deleted;
		}

		return false;
	}

	/**
	 * @returns The string tag for the SetMultiMap.
	 */
	override get [Symbol.toStringTag](): string {
		return 'SetMultiMap';
	}
}
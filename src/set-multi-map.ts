/**
 * A map from a key to a set of unique values.
 * A lone value is stored inline; a {@link Set} is only allocated once a key holds two or more distinct values, since the
 * overwhelmingly common case (one path per inode) needs no container.
 * @internal
 */
export class SetMultiMap<K, V> {
	readonly #slots = new Map<K, V | Set<V>>();

	/**
	 * Adds a value to a key, promoting the key to a {@link Set} on its second distinct value.
	 * If the value already exists for the key, it will not be added again.
	 * @param key - The key to set.
	 * @param value - The value to add.
	 * @returns The SetMultiMap with the updated key and value.
	 */
	set(key: K, value: V): this {
		const slot = this.#slots.get(key);

		if (slot === undefined) {
			this.#slots.set(key, value);
		} else if (slot instanceof Set) {
			slot.add(value);
		} else if (slot !== value) {
			this.#slots.set(key, new Set([ slot, value ]));
		}

		return this;
	}

	/**
	 * Finds the first value for a key that satisfies the given predicate, without allocating.
	 * @param key - The key to search.
	 * @param iterator - The function to test each value.
	 * @returns The first matching value, or `undefined` if none matches or the key does not exist.
	 */
	find(key: K, iterator: (value: V) => boolean): V | undefined {
		const slot = this.#slots.get(key);

		if (slot === undefined) { return undefined }

		if (!(slot instanceof Set)) { return iterator(slot) ? slot : undefined }

		for (const value of slot) {
			if (iterator(value)) { return value }
		}

		return undefined;
	}

	/**
	 * Removes a specific value from a key, demoting the key back to an inline value when one remains and removing
	 * the key entirely when none remain.
	 * @param key - The key to remove the value from.
	 * @param value - The value to remove.
	 * @returns True if the value was removed, false otherwise.
	 */
	deleteValue(key: K, value: V): boolean {
		const slot = this.#slots.get(key);

		if (slot === undefined) { return false }

		if (!(slot instanceof Set)) {
			if (slot !== value) { return false }

			this.#slots.delete(key);

			return true;
		}

		const deleted = slot.delete(value);

		if (slot.size === 0) {
			this.#slots.delete(key);
		} else if (slot.size === 1) {
			this.#slots.set(key, slot.values().next().value!);
		}

		return deleted;
	}

	/** Removes every key. */
	clear(): void {
		this.#slots.clear();
	}
}

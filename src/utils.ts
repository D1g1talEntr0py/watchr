/** A no-operation function. */
export const noop = (): void => {};

/**
 * Creates a unique sorted array from an array without mutating the input.
 * @param array - The array to process.
 * @returns A new unique sorted array.
 */
export const uniqueSortedArray = <T>(array: T[]): T[] => {
	return [ ...new Set(array) ].sort();
};

/**
 * Casts an unknown exception to an Error.
 * @param exception - The exception to cast.
 * @returns The casted Error.
 */
export const castError = (exception: unknown): Error => {
	if (exception instanceof Error) { return exception }

	return new Error(typeof exception === 'string' ? exception : 'Unknown error', { cause: exception });
};

import type { OptionalReturn, TypedFunction } from './@types';

/** A no-operation function. */
export const noop = (): void => {};

/**
 * Creates a unique sorted array from an array.
 * @param array - The array to process.
 * @returns A unique sorted array.
 */
export const uniqueSortedArray = <T>(array: T[]): T[] => {
	return Array.from(new Set(array.sort()));
};

/**
 * Creates a debounced version of a function.
 * @param func - The function to debounce.
 * @param wait - The number of milliseconds to wait before invoking the function.
 * @returns A debounced version of the function that returns a Promise.
 */
export const debounce = <T extends TypedFunction<T>>(func: T, wait: number): (...args: Parameters<T>) => Promise<OptionalReturn<T>> => {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	let pendingResolve: ((value: OptionalReturn<T>) => void) | undefined;

	return function(this: ThisParameterType<T>, ...args: Parameters<T>) {
		return new Promise((resolve, reject) => {
			// Clear previous timer
			if (timeoutId) { clearTimeout(timeoutId) }

			// Cancel previous promise immediately
			if (pendingResolve) { pendingResolve(undefined) }

			pendingResolve = resolve;

			timeoutId = setTimeout(() => {
				try {
					resolve(func.apply(this, args));
				} catch (error) {
					// Use the provided castError to standardize the rejection
					reject(castError(error));
				} finally {
					// Cleanup to prevent memory leaks
					pendingResolve = undefined;
					timeoutId = undefined;
				}
			}, wait);
		});
	};
};

/**
 * Casts an unknown exception to an Error.
 * @param exception - The exception to cast.
 * @returns The casted Error.
 */
export const castError = (exception: unknown): Error => {
	if (exception instanceof Error) { return exception }

	return new Error(typeof exception === 'string' ? exception : 'Unknown error');
};
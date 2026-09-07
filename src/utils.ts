import { aborted } from 'node:util';

/** A no-operation function. */
export const noop = (): void => {};

/**
 * Resolves with a promise result unless the signal aborts first.
 * @param promise - The operation to await.
 * @param signal - Optional signal that cancels waiting for the operation.
 * @returns The operation result, or rejects with the signal reason.
 */
export const raceWithAbort = async <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
	if (signal === undefined) { return promise }
	if (signal.aborted) { signal.throwIfAborted() }

	promise.catch(noop);

	const abortPromise = aborted(signal, promise).then(() => {
		signal.throwIfAborted();
		throw new DOMException('The operation was aborted', 'AbortError');
	});

	return Promise.race([ promise, abortPromise ]);
};

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

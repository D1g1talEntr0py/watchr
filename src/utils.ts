/** A no-operation function. */
export const noop = (): void => {};

/**
 * Reads a signal's abort reason as an Error so it can be used as a rejection reason.
 * @param signal - An aborted signal.
 * @returns The abort reason.
 */
const abortReason = (signal: AbortSignal): Error => signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError');

/**
 * Resolves with a promise result unless the signal aborts first.
 * The abort listener is detached as soon as the operation settles: a weak `util.aborted()` listener would linger on
 * long-lived signals until GC, and `EventTarget.addEventListener` walks every attached listener, making bursts quadratic.
 * @param promise - The operation to await.
 * @param signal - Optional signal that cancels waiting for the operation.
 * @returns The operation result, or rejects with the signal reason.
 */
export const raceWithAbort = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
	if (signal === undefined) { return promise }
	if (signal.aborted) { return Promise.reject(abortReason(signal)) }

	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(abortReason(signal));

		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
	});
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

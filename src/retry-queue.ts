import type { Resolver } from './@types/index';
import { maxConcurrentStats } from './constants';

/**
 * A class that manages a retry queue for handling tasks that need to be retried
 * @internal
 */
export class RetryQueue {
	/** The interval ID for the retry queue processing. */
	#intervalId: NodeJS.Timeout | undefined;
	/** The set of active resolvers currently being processed. */
	readonly #activeQueue: Set<Resolver> = new Set();
	/** The set of pending resolvers waiting to be processed. */
	readonly #pendingQueue: Set<Resolver> = new Set();
	/** The interval time in milliseconds for processing the queue. */
	static readonly #interval: number = 50;

	/**
	 * Schedules a task to be retried.
	 * @param signal Optional signal that cancels pending admission.
	 * @returns A promise that resolves to a disposable lease for the admitted task.
	 */
	schedule(signal?: AbortSignal): Promise<Disposable> {
		return new Promise((resolve, reject): void => {
			if (signal?.aborted) {
				reject(new DOMException('The operation was aborted', 'AbortError'));

				return;
			}

			let settled = false;
			const onAbort = () => {
				if (settled) { return }

				settled = true;
				this.#pendingQueue.delete(resolver);
				signal?.removeEventListener('abort', onAbort);

				if (!this.#pendingQueue.size) { this.#reset() }

				reject(new DOMException('The operation was aborted', 'AbortError'));
			};

			/** Resolves the task with the given value. */
			const resolver = (): void => {
				if (settled) { return }

				settled = true;
				signal?.removeEventListener('abort', onAbort);
				const release = (): void => {
					this.#activeQueue.delete(resolver);

					if (this.#pendingQueue.size) { this.#processQueue() }
				};

				resolve({ [Symbol.dispose]: release });
			};

			signal?.addEventListener('abort', onAbort, { once: true });

			this.#add(resolver);
		});
	}

	/**
	 * Adds a resolver: admitted immediately while below the concurrency limit, otherwise queued until a lease is released.
	 * @param fn - The resolver function to add.
	 */
	#add(fn: Resolver) {
		if (this.#activeQueue.size < maxConcurrentStats) {
			this.#activeQueue.add(fn);
			fn();

			return;
		}

		this.#pendingQueue.add(fn);
		// Releases drain the queue synchronously; the interval is only a safety net.
		this.#intervalId ??= setInterval(this.#processQueue.bind(this), RetryQueue.#interval);
	}

	/**
	 * Moves pending resolvers into the active queue while capacity allows.
	 * Runs synchronously on lease release and periodically as a safety net.
	 */
	#processQueue() {
		if (maxConcurrentStats <= this.#activeQueue.size) { return }

		if (!this.#pendingQueue.size) { return this.#reset() }

		for (const resolver of this.#pendingQueue) {
			if (maxConcurrentStats <= this.#activeQueue.size) { return }

			this.#pendingQueue.delete(resolver);
			this.#activeQueue.add(resolver);
			resolver();
		}

		if (!this.#pendingQueue.size) { this.#reset() }
	}

	/** Resets the interval for processing the queue */
	#reset() {
		if (!this.#intervalId) { return }

		clearInterval(this.#intervalId);
		this.#intervalId = undefined;
	}
}

import type { Resolver } from './@types/index';
import { fileDescriptorLimit } from './constants';

/** A disposable lease for admitted retry queue work. */
export interface RetryQueueLease<T> extends Disposable {
	/** Releases the queue slot and returns the provided value. */
	(value?: T): T | undefined;
	/** Releases the queue slot and returns the provided value. */
	resolve: (value?: T) => T | undefined;
	/** Releases the queue slot without resolving a value. */
	dispose: () => void;
}

/** A class that manages a retry queue for handling tasks that need to be retried */
export class RetryQueue {
	/** The interval ID for the retry queue processing. */
	private intervalId: NodeJS.Timeout | undefined;
	/** The set of active resolvers currently being processed. */
	private readonly activeQueue: Set<Resolver> = new Set();
	/** The set of pending resolvers waiting to be processed. */
	private readonly pendingQueue: Set<Resolver> = new Set();
	/** The interval time in milliseconds for processing the queue. */
	private static readonly interval: number = 50;

	/**
	 * Schedules a task to be retried.
	 * @param signal Optional signal that cancels pending admission.
	 * @returns A promise that resolves to a disposable lease for the admitted task.
	 */
	schedule<T>(signal?: AbortSignal): Promise<RetryQueueLease<T>> {
		return new Promise((resolve, reject): void => {
			if (signal?.aborted) {
				reject(new DOMException('The operation was aborted', 'AbortError'));

				return;
			}

			let settled = false;
			const onAbort = () => {
				if (settled) { return }

				settled = true;
				this.pendingQueue.delete(resolver);
				signal?.removeEventListener('abort', onAbort);

				if (!this.pendingQueue.size) { this.reset() }

				reject(new DOMException('The operation was aborted', 'AbortError'));
			};

			/** Resolves the task with the given value. */
			const resolver = (): void => {
				if (settled) { return }

				settled = true;
				signal?.removeEventListener('abort', onAbort);
				const release = (value?: T): T | undefined => {
					this.activeQueue.delete(resolver);
					return value;
				};

				const dispose = (): void => void release();

				resolve(Object.assign(release, { resolve: release, dispose, [Symbol.dispose]: dispose }));
			};

			signal?.addEventListener('abort', onAbort, { once: true });

			this.add(resolver);
		});
	}

	/**
	 * Adds a resolver function to the pending queue and processes the queue if necessary.
	 * @param fn - The resolver function to add.
	 */
	private add(fn: Resolver) {
		this.pendingQueue.add(fn);

		// Active queue not under pressure, executing immediately
		if (this.activeQueue.size < fileDescriptorLimit / 2) {
			this.processQueue();
		} else {
			if (this.intervalId) { return }
			this.intervalId = setInterval(this.processQueue.bind(this), RetryQueue.interval);
		}
	}

	/**
	 * Processes the pending queue, moving items to the active queue and executing them.
	 * This method is called at regular intervals to ensure that pending tasks are processed.
	 */
	private processQueue() {
		if (fileDescriptorLimit <= this.activeQueue.size) { return }

		if (!this.pendingQueue.size) { return this.reset() }

		for (const resolver of this.pendingQueue) {
			if (fileDescriptorLimit <= this.activeQueue.size) { return }

			this.pendingQueue.delete(resolver);
			this.activeQueue.add(resolver);
			resolver();
		}

		if (!this.pendingQueue.size) { this.reset() }
	}

	/** Resets the interval for processing the queue */
	private reset() {
		if (!this.intervalId) { return }

		clearInterval(this.intervalId);
		this.intervalId = undefined;
	}
}

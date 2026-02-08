import type { Resolver } from './@types';
import { fileDescriptorLimit } from './constants';

/** A class that manages a retry queue for handling tasks that need to be retried */
export class RetryQueue {
	/** The interval ID for the retry queue processing. */
	private intervalId?: NodeJS.Timeout = undefined;
	/** The set of active resolvers currently being processed. */
	private readonly activeQueue: Set<Resolver> = new Set();
	/** The set of pending resolvers waiting to be processed. */
	private readonly pendingQueue: Set<Resolver> = new Set();
	/** The interval time in milliseconds for processing the queue. */
	private static readonly interval: number = 50;

	/**
	 * Schedules a task to be retried.
	 * @returns A promise that resolves to a function which can be called to resolve the task.
	 */
	schedule<T>(): Promise<(value?: T) => T | undefined> {
		return new Promise((resolve): void => {
			/**
			 * Resolves the task with the given value.
			 * @returns The resolved value or undefined.
			 */
			const resolver = (): void => resolve((value?: T): T | undefined => {
				this.activeQueue.delete(resolver);
				return value;
			});

			this.add(resolver);
		});
	}

	/**
	 * Adds a resolver function to the pending queue and processes the queue if necessary.
	 * @param fn - The resolver function to add.
	 */
	private add(fn: Resolver): void {
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
	 * @returns void
	 */
	private processQueue(): void {
		if (fileDescriptorLimit <= this.activeQueue.size) { return }
		if (!this.pendingQueue.size) { return this.reset() }

		for (const fn of this.pendingQueue) {
			if (fileDescriptorLimit <= this.activeQueue.size) { return }

			this.pendingQueue.delete(fn);
			this.activeQueue.add(fn);
			fn();
		}

		if (!this.pendingQueue.size) { this.reset() }
	}

	/** Resets the interval for processing the queue */
	private reset(): void {
		if (!this.intervalId) { return }

		clearInterval(this.intervalId);
		this.intervalId = undefined;
	}
}
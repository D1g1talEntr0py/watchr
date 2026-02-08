import type { Resolver } from './@types';

/**
 * Registering a single interval scales much better than registering N timeouts
 * Timeouts are respected within the interval margin
 */
export class LockResolver {
	private static intervalId?: NodeJS.Timeout;
	private static readonly interval: number = 50;
	private static readonly resolvers: Map<Resolver, number> = new Map();

	private constructor() {
		throw new Error('This class cannot be instantiated');
	}

	/**
	 * Adds a resolver function to be called after a timeout.
	 * @param fn - The resolver function to add.
	 * @param timeout - The timeout duration in milliseconds.
	 */
	static add(fn: Resolver, timeout: number): void {
		LockResolver.resolvers.set(fn, Date.now() + timeout);

		LockResolver.init();
	}

	/**
	 * Removes a resolver function.
	 * @param fn - The resolver function to remove.
	 */
	static remove(fn: Resolver): void {
		LockResolver.resolvers.delete(fn);
	}

	/**
	 * Initializes the lock resolver.
	 */
	private static init(): void {
		if (LockResolver.intervalId) { return }

		LockResolver.intervalId = setInterval(LockResolver.resolve, LockResolver.interval);
	}

	/**
	 * Resets the lock resolver.
	 */
	private static reset(): void {
		if (!LockResolver.intervalId) { return }

		clearInterval(LockResolver.intervalId);

		LockResolver.intervalId = undefined;
	}

	/**
	 * Resolves the pending resolver functions.
	 */
	private static resolve(): void {
		const now = Date.now();

		for (const [ fn, timestamp ] of LockResolver.resolvers) {
			// Continue waiting...
			if (timestamp > now) { continue }

			LockResolver.remove(fn);

			fn();
		}

		if (!LockResolver.resolvers.size) { LockResolver.reset() }
	}
};
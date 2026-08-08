import type { Resolver } from './@types';

type LockResolverOptions = {
	interval?: number,
	maxResolvers?: number
};

/**
 * Registering a single interval scales much better than registering N timeouts
 * Timeouts are respected within the interval margin
 */
export class LockResolver {
	private intervalId?: NodeJS.Timeout;
	private readonly interval: number;
	private readonly maxResolvers: number;
	/** Earliest known deadline, used to skip full scans on ticks where nothing can be due. */
	private nextDeadline: number = Infinity;
	private readonly resolvers: Map<Resolver, { timestamp: number, onEvict?: () => void }> = new Map();

	/**
	 * Creates a lock resolver.
	 * @param options - Optional timing and capacity overrides.
	 */
	constructor(options: LockResolverOptions = {}) {
		this.interval = options.interval ?? 50;
		this.maxResolvers = options.maxResolvers ?? 50000;
	}

	/**
	 * Adds a resolver function to be called after a timeout.
	 * @param fn - The resolver function to add.
	 * @param timeout - The timeout duration in milliseconds.
	 * @param onEvict - Optional callback invoked if the resolver is evicted before it resolves.
	 */
	add(fn: Resolver, timeout: number, onEvict?: () => void): void {
		const timestamp = performance.now() + timeout;

		if (!this.resolvers.has(fn) && this.resolvers.size >= this.maxResolvers) {
			// Keep memory bounded under heavy event pressure by evicting the oldest pending resolver.
			const oldestResolver = this.resolvers.keys().next().value;

			if (oldestResolver !== undefined) {
				const oldestEntry = this.resolvers.get(oldestResolver);
				this.resolvers.delete(oldestResolver);
				console.warn('🚨 Lock resolver capacity exceeded. Evicting oldest pending resolver.');

				oldestEntry?.onEvict?.();
			}
		}

		this.resolvers.set(fn, { timestamp, ...(onEvict === undefined ? {} : { onEvict }) });

		if (timestamp < this.nextDeadline) { this.nextDeadline = timestamp }

		this.init();
	}

	/**
	 * Removes a resolver function.
	 * @param fn - The resolver function to remove.
	 */
	remove(fn: Resolver): void {
		this.resolvers.delete(fn);
	}

	/**
	 * Initializes the lock resolver.
	 */
	private init() {
		if (this.intervalId) { return }

		this.intervalId = setInterval(() => this.resolve(), this.interval);
	}

	/**
	 * Resets the lock resolver.
	 */
	reset(): void {
		this.nextDeadline = Infinity;
		this.resolvers.clear();

		if (!this.intervalId) { return }

		clearInterval(this.intervalId);

		delete this.intervalId;
	}

	/**
	 * Resolves the pending resolver functions.
	 */
	private resolve() {
		const now = performance.now();

		// Nothing can be due yet, so skip the scan entirely.
		if (now < this.nextDeadline) { return }

		let nextDeadline = Infinity;

		for (const [ fn, { timestamp } ] of this.resolvers) {
			// Continue waiting...
			if (timestamp > now) {
				if (timestamp < nextDeadline) { nextDeadline = timestamp }

				continue;
			}

			this.remove(fn);

			fn();
		}

		if (!this.resolvers.size) {
			this.reset();

			return;
		}

		this.nextDeadline = nextDeadline;
	}
};
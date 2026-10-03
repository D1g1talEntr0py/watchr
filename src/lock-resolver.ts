import type { Resolver } from './@types/index';

type LockResolverOptions = {
	interval?: number,
	maxResolvers?: number,
	/** Receives exceptions thrown by resolvers during a tick. */
	onError: (error: unknown) => void
};

/**
 * Default resolver error sink: surfaces the failure without turning a timer tick into an uncaught exception.
 * @param error - The exception thrown by a resolver.
 */
const warnOnResolverError = (error: unknown): void => {
	const code = 'WATCHR_LOCK_RESOLVER_ERROR';
	const detail = 'A lock resolver threw during an interval tick.';
	const cause = error instanceof Error ? error : new Error(String(error));
	// Node ignores `options.code`/`detail` for Error instances, so mirror them onto the warning object itself.
	const warning = Object.assign(new Error(cause.message, { cause }), { name: 'WatchrWarning', code, detail });

	process.emitWarning(warning, { code, detail });
};

/**
 * Registering a single interval scales much better than registering N timeouts
 * Timeouts are respected within the interval margin
 * @internal
 */
export class LockResolver {
	#intervalId: NodeJS.Timeout | undefined;
	readonly #interval: number;
	readonly #maxResolvers: number;
	readonly #onError: (error: unknown) => void;
	/** Earliest known deadline, used to skip full scans on ticks where nothing can be due. */
	#nextDeadline: number = Infinity;
	readonly #resolvers: Map<Resolver, { timestamp: number, onEvict?: () => void }> = new Map();

	/**
	 * Creates a lock resolver.
	 * @param options - Error sink and optional timing and capacity overrides.
	 */
	constructor(options: LockResolverOptions) {
		this.#interval = options.interval ?? 50;
		this.#maxResolvers = options.maxResolvers ?? 50000;
		this.#onError = options.onError;
	}

	/**
	 * Adds a resolver function to be called after a timeout.
	 * @param fn - The resolver function to add.
	 * @param timeout - The timeout duration in milliseconds.
	 * @param onEvict - Optional callback that settles the operation if the resolver is evicted before it resolves.
	 */
	add(fn: Resolver, timeout: number, onEvict?: () => void): void {
		const timestamp = performance.now() + timeout;
		let evictionError: unknown;
		let evictionFailed = false;

		if (!this.#resolvers.has(fn) && this.#resolvers.size >= this.#maxResolvers) {
			// Keep memory bounded under heavy event pressure by evicting the oldest pending resolver.
			const oldestResolver = this.#resolvers.keys().next().value;

			if (oldestResolver !== undefined) {
				const oldestEntry = this.#resolvers.get(oldestResolver);
				this.#resolvers.delete(oldestResolver);

				try {
					oldestEntry?.onEvict?.();
				} catch (error) {
					evictionError = error;
					evictionFailed = true;
				}
			}
		}

		this.#resolvers.set(fn, { timestamp, ...(onEvict === undefined ? {} : { onEvict }) });

		if (timestamp < this.#nextDeadline) { this.#nextDeadline = timestamp }

		this.#init();

		if (evictionFailed) { throw evictionError }
	}

	/**
	 * Removes a resolver function.
	 * @param fn - The resolver function to remove.
	 */
	remove(fn: Resolver): void {
		this.#resolvers.delete(fn);
	}

	/**
	 * Initializes the lock resolver.
	 */
	#init() {
		if (this.#intervalId) { return }

		this.#intervalId = setInterval(() => this.#resolve(), this.#interval);
	}

	/**
	 * Resets the lock resolver.
	 */
	reset(): void {
		this.#nextDeadline = Infinity;
		this.#resolvers.clear();

		if (!this.#intervalId) { return }

		clearInterval(this.#intervalId);

		this.#intervalId = undefined;
	}

	/**
	 * Resolves the pending resolver functions.
	 */
	#resolve() {
		const now = performance.now();

		// Nothing can be due yet, so skip the scan entirely.
		if (now < this.#nextDeadline) { return }

		let nextDeadline = Infinity;

		for (const [ fn, { timestamp } ] of this.#resolvers) {
			// Continue waiting...
			if (timestamp > now) {
				if (timestamp < nextDeadline) { nextDeadline = timestamp }

				continue;
			}

			this.remove(fn);

			try {
				fn();
			} catch (error: unknown) {
				this.#reportResolverError(error);
			}
		}

		if (!this.#resolvers.size) {
			this.reset();

			return;
		}

		this.#nextDeadline = nextDeadline;
	}

	/**
	 * Routes a resolver exception to the configured sink; a throwing sink falls back to a process warning.
	 * @param error - The exception thrown by a resolver.
	 */
	#reportResolverError(error: unknown): void {
		try {
			this.#onError(error);
		} catch (sinkError: unknown) {
			warnOnResolverError(sinkError);
		}
	}
};

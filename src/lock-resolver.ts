import type { Closable, Resolver } from './@types/index';

type LockResolverOptions = {
	interval?: number,
	maxResolvers?: number,
	/** Receives exceptions thrown by resolvers during a tick. */
	onError: (error: unknown) => void
};

/** Node timers clamp delays above the signed 32-bit limit. */
const maxTimerDelayMs = 2_147_483_647;

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
 * Shares one deadline timer across pending resolvers, or an explicitly configured interval.
 * @internal
 */
export class LockResolver implements Closable {
	#resolving: boolean = false;
	#timerId: NodeJS.Timeout | undefined;
	/** Lower bound on pending deadlines; cancellation can leave one harmless early wake-up instead of re-scanning. */
	#nextDeadline: number = Infinity;
	readonly #interval: number | undefined;
	readonly #maxResolvers: number;
	readonly #onError: (error: unknown) => void;
	readonly #resolvers: Map<Resolver, { timestamp: number, onEvict?: () => void }> = new Map();

	/**
	 * Creates a lock resolver.
	 * @param options - Error sink and optional timing and capacity overrides.
	 */
	constructor(options: LockResolverOptions) {
		this.#interval = options.interval;
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

				try { oldestEntry?.onEvict?.() } catch (error) {
					evictionError = error;
					evictionFailed = true;
				}
			}
		}

		this.#resolvers.set(fn, { timestamp, ...(onEvict === undefined ? {} : { onEvict }) });

		const earlier = timestamp < this.#nextDeadline;

		if (earlier) { this.#nextDeadline = timestamp }

		this.#init(earlier);

		if (evictionFailed) { throw evictionError }
	}

	/**
	 * Removes a resolver function.
	 * @param fn - The resolver function to remove.
	 */
	remove(fn: Resolver): void {
		this.#resolvers.delete(fn);

		if (this.#interval === undefined && !this.#resolvers.size) { this.reset() }
	}

	/**
	 * Resets the lock resolver.
	 */
	reset(): void {
		this.#nextDeadline = Infinity;
		this.#resolvers.clear();

		if (!this.#timerId) { return }

		clearTimeout(this.#timerId);

		this.#timerId = undefined;
	}

	/** Cancels pending resolvers and releases the shared timer. */
	close(): void {
		this.reset();
	}

	/** Closes the resolver on scope exit. */
	[Symbol.dispose](): void {
		this.reset();
	}

	/**
	 * Initializes the lock resolver.
	 * @param earlier - Whether a newly added deadline precedes the scheduled wake-up.
	 */
	#init(earlier: boolean = false) {
		if (this.#resolving) { return }

		if (this.#interval !== undefined) {
			this.#timerId ??= setInterval(() => this.#resolve(), this.#interval);

			return;
		}

		if (this.#timerId) {
			if (!earlier) { return }

			clearTimeout(this.#timerId);
		}

		if (this.#nextDeadline === Infinity) { return }

		this.#timerId = setTimeout(() => {
			this.#timerId = undefined;
			this.#resolve();
		}, Math.min(maxTimerDelayMs, Math.max(1, Math.ceil(this.#nextDeadline - performance.now()))));
	}

	/**
	 * Resolves the pending resolver functions.
	 */
	#resolve() {
		const now = performance.now();

		// Nothing can be due yet, so skip the scan entirely.
		if (now < this.#nextDeadline) {
			this.#init();

			return;
		}

		this.#nextDeadline = Infinity;
		this.#resolving = true;

		for (const [ fn, { timestamp } ] of this.#resolvers) {
			// Continue waiting...
			if (timestamp > now) {
				if (timestamp < this.#nextDeadline) { this.#nextDeadline = timestamp }

				continue;
			}

			this.remove(fn);

			try { fn() } catch (error: unknown) { this.#reportResolverError(error) }
		}

		this.#resolving = false;

		if (!this.#resolvers.size) {
			this.reset();

			return;
		}

		this.#init();
	}

	/**
	 * Routes a resolver exception to the configured sink; a throwing sink falls back to a process warning.
	 * @param error - The exception thrown by a resolver.
	 */
	#reportResolverError(error: unknown): void {
		try { this.#onError(error) } catch (sinkError: unknown) { warnOnResolverError(sinkError) }
	}
};

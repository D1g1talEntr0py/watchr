import { noop } from '../utils';

/**
 * Decorator to set a timeout for an asynchronous method.
 * If the method accepts an `AbortSignal`, it must be the final parameter. The timeout signal is
 * combined with that existing signal so cancellation propagates correctly; otherwise the timeout
 * signal is appended as the final argument.
 * @param delay - The timeout duration in milliseconds. Defaults to 250ms.
 * @returns A decorator function that applies the timeout to the method.
 */
export function timeout(delay: number = 250) {
	if (delay < 0) { throw new Error('🚨 timeout value must be non-negative.') }

	return function<This extends object, Args extends unknown[], Return>(target: (this: This, ...args: Args) => Promise<Return>, _context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Promise<Return>>) {
		return async function(this: This, ...args: Args): Promise<Return | undefined> {
			const abortController = new AbortController();
			const { promise: timeoutPromise, resolve: resolveTimeout } = Promise.withResolvers<undefined>();
			const timeoutHandle = setTimeout(() => {
				abortController.abort();
				resolveTimeout(undefined);
			}, delay);

			using _timer = typeof timeoutHandle[Symbol.dispose] === 'function' ? timeoutHandle : { [Symbol.dispose]: () => clearTimeout(timeoutHandle) };

			const lastArgument = args.at(-1);
			const methodPromise = target.apply(this, (lastArgument instanceof AbortSignal ? [ ...args.slice(0, -1), AbortSignal.any([ lastArgument, abortController.signal ]) ] : [ ...args, abortController.signal ]) as Args);
			const result = await Promise.race([ methodPromise, timeoutPromise ]);

			methodPromise.catch(noop);

			return result!;
		};
	};
}

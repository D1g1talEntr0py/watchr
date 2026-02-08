import { noop } from '../utils';

/**
 * Decorator to set a timeout for an asynchronous method.
 * @param delay - The timeout duration in milliseconds. Defaults to 250ms.
 * @returns A decorator function that applies the timeout to the method.
 */
export function timeout(delay: number = 250) {
	if (delay < 0) { throw new Error('🚨 timeout value must be non-negative.') }

	return function<This extends object, Args extends unknown[], Return>(target: (this: This, ...args: Args) => Promise<Return>, _context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Promise<Return>>) {
		return async function(this: This, ...args: Args): Promise<Return | undefined> {
			let timeoutId: NodeJS.Timeout | undefined;

			try {
				const timeoutPromise = new Promise<undefined>((resolve) => {
					timeoutId = setTimeout(() => resolve(undefined), delay);
				});

				const methodPromise = target.apply(this, args);
				const result = await Promise.race([ methodPromise, timeoutPromise ]);

				// If timeout occurred, methodPromise is still running. We need to 'handle' its eventual
				// settlement to avoid unhandled rejection. The result is already undefined from timeoutPromise.
				methodPromise.catch(noop);

				return result;
			} finally {
				if (timeoutId) { clearTimeout(timeoutId) }
			}
		};
	};
}
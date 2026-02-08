import { debounce as _debounce } from '../utils';

/**
 * Debounces a method
 * @param wait The wait time in milliseconds
 * @returns A method decorator
 */
export function debounce(wait: number) {
	if (wait < 0) { throw new Error('🚨 wait must be non-negative.') }

	return function<This extends object, Args extends unknown[], Return>(target: (this: This, ...args: Args) => Return,	_context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>) {
		const instances = new WeakMap<This, (...args: Args) => Promise<Return | undefined | void>>();

		return function(this: This, ...args: Args): Promise<Return | undefined | void> {
			let debounced = instances.get(this);

			if (debounced === undefined) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				instances.set(this, debounced = _debounce(target.bind(this) as any, wait));
			}

			return debounced(...args);
		};
	};
}

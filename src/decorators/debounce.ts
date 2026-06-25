import { debounce as _debounce } from '../utils';

/**
 * Debounces a method
 * @param wait The wait time in milliseconds
 * @returns A method decorator
 */
export function debounce(wait: number) {
	if (wait < 0) { throw new Error('🚨 wait must be non-negative.') }

	return function<This extends object, Args extends unknown[], Return>(target: (this: This, ...args: Args) => Return,	_context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>) {
		type DebouncedFn = (...args: Args) => Promise<Return | undefined | void>;
		const instances = new WeakMap<This, DebouncedFn>();

		return function(this: This, ...args: Args): Return | Promise<Return | undefined | void> {
			let debounced = instances.get(this);

			if (debounced === undefined) {
				debounced = _debounce(target.bind(this) as (...args: Args) => Return, wait);
				instances.set(this, debounced);
			}

			return debounced(...args);
		};
	};
}

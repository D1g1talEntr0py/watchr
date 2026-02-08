import { describe, it, expect, vi } from 'vitest';
import { debounce } from '../../src/decorators/debounce';

vi.useFakeTimers();

describe('debounce decorator', () => {
	it('should throw an error if wait is negative', () => {
		expect(() => debounce(-1)).toThrow('wait must be non-negative');
	});

	it('should debounce the method', async () => {
		const spy = vi.fn();

		class Test {
			@debounce(100)
			method() {
				spy();
			}
		}

		const instance = new Test();

		instance.method();
		instance.method();
		instance.method();

		expect(spy).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(100);

		expect(spy).toHaveBeenCalledTimes(1);
	});

	it('should call the method again after the wait time', async () => {
		const spy = vi.fn();

		class Test {
			@debounce(100)
			method() {
				spy();
			}
		}

		const instance = new Test();

		instance.method();
		await vi.advanceTimersByTimeAsync(100);
		expect(spy).toHaveBeenCalledTimes(1);

		instance.method();
		await vi.advanceTimersByTimeAsync(100);
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it('should handle different instances separately', async () => {
		const spy1 = vi.fn();
		const spy2 = vi.fn();

		class Test {
			constructor(private spy: () => void) {}

			@debounce(100)
			method() {
				this.spy();
			}
		}

		const instance1 = new Test(spy1);
		const instance2 = new Test(spy2);

		instance1.method();
		instance2.method();

		await vi.advanceTimersByTimeAsync(100);

		expect(spy1).toHaveBeenCalledTimes(1);
		expect(spy2).toHaveBeenCalledTimes(1);
	});

	it('should pass arguments to the original method', async () => {
		const spy = vi.fn();

		class Test {
			@debounce(100)
			method(a: number, b: string) {
				spy(a, b);
			}
		}

		const instance = new Test();
		instance.method(1, 'test');

		await vi.advanceTimersByTimeAsync(100);

		expect(spy).toHaveBeenCalledWith(1, 'test');
	});

	it('should debounce multiple calls with arguments and use the last call arguments', async () => {
		const spy = vi.fn();

		class Test {
			@debounce(100)
			method(a: number, b: string) {
				spy(a, b);
			}
		}

		const instance = new Test();
		instance.method(1, 'a');
		instance.method(2, 'b');
		instance.method(3, 'c');

		await vi.advanceTimersByTimeAsync(100);

		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith(3, 'c');
	});
});

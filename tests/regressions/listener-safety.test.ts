import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Watchr } from '../../src/watchr';
import { cleanupTempRoots, createTempRoot } from '../helpers/fs-fixtures';

const watchers: Watchr[] = [];

/**
 * Extracts the message of an error or its `cause`, whichever mentions the marker.
 * @param error Error to inspect.
 * @returns Concatenated own and cause messages.
 */
function messages(error: unknown): string {
	if (!(error instanceof Error)) { return String(error) }

	const cause = error.cause instanceof Error ? error.cause.message : '';

	return `${error.message} ${cause}`;
}

describe('regression B4: throwing user listeners must not escape the process', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		for (const watcher of watchers.splice(0)) { watcher.close() }
		cleanupTempRoots();
	});

	it('routes a throwing all listener to error and still delivers add', async () => {
		const root = createTempRoot('watchr-listener-safety-');
		const errors: unknown[] = [];
		const delivered = vi.fn();
		const watcher = new Watchr(root, { handlers: {
			all: () => { throw new Error('boom') },
			add: delivered,
			error: (error) => { errors.push(error) }
		} });
		watchers.push(watcher);
		await watcher.start();

		writeFileSync(join(root, 'x.txt'), 'x');
		await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));
		expect(errors.some((error) => messages(error).includes('boom')), `error listener received: ${errors.map(messages).join(', ')}`).toBe(true);
	});

	it('warns when an add listener throws without an error listener', async () => {
		const root = createTempRoot('watchr-no-error-listener-');
		const warningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
		const watcher = new Watchr(root, { handlers: { add: () => { throw new Error('add listener failed') } } });
		watchers.push(watcher);
		await watcher.start();

		writeFileSync(join(root, 'file.txt'), 'content');
		await vi.waitFor(() => expect(warningSpy).toHaveBeenCalledWith(
			expect.objectContaining({ code: 'WATCHR_UNHANDLED_ERROR', message: 'add listener failed' }),
			expect.anything()
		));
	});

	it('warns when an error listener itself throws', async () => {
		const root = createTempRoot('watchr-throwing-error-listener-');
		const warningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
		const watcher = new Watchr(root, { handlers: {
			error: () => { throw new Error('error listener failed') },
			add: () => { throw new Error('add listener failed') }
		} });
		watchers.push(watcher);
		await watcher.start();

		writeFileSync(join(root, 'file.txt'), 'content');
		await vi.waitFor(() => expect(warningSpy).toHaveBeenCalledWith(
			expect.objectContaining({ code: 'WATCHR_UNHANDLED_ERROR', message: 'error listener failed', detail: 'The "error" handler threw synchronously.' }),
			expect.anything()
		));
	});

	it('identifies an error listener rejection', async () => {
		const root = createTempRoot('watchr-rejected-error-listener-');
		const warningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
		const watcher = new Watchr(root, { handlers: {
			error: () => Promise.reject(new Error('error listener rejected')),
			add: () => { throw new Error('add listener failed') }
		} });
		watchers.push(watcher);
		await watcher.start();

		writeFileSync(join(root, 'file.txt'), 'content');
		await vi.waitFor(() => expect(warningSpy).toHaveBeenCalledWith(
			expect.objectContaining({ code: 'WATCHR_UNHANDLED_ERROR', message: 'error listener rejected', detail: 'The "error" handler returned a rejected promise.' }),
			expect.anything()
		));
	});

	it('routes async rejection to error without awaiting handler completion', async () => {
		const root = createTempRoot('watchr-async-handler-');
		const errors: Error[] = [];
		const delivered = vi.fn();
		const { promise, reject } = Promise.withResolvers<void>();
		const watcher = new Watchr(root, { handlers: {
			add: () => promise,
			all: delivered,
			error: (error) => { errors.push(error) }
		} });
		watchers.push(watcher);
		await watcher.start();
		writeFileSync(join(root, 'file.txt'), 'content');
		await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));
		expect(errors).toEqual([]);
		const failure = new Error('async handler failed');
		reject(failure);
		await vi.waitFor(() => expect(errors).toEqual([ failure ]));
	});
});

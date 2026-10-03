import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileSystemEvent, WatcherEvent } from '../../src/watchr';
import { cleanupTempRoots, closeWatchers, createReadyWatcher, createTempRoot } from '../helpers/fs-fixtures';

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
		closeWatchers();
		cleanupTempRoots();
	});

	it('routes a throwing all listener to error and still delivers add', async () => {
		const root = createTempRoot('watchr-listener-safety-');
		const watcher = await createReadyWatcher(root, { ignoreInitial: true });
		const errors: unknown[] = [];
		const delivered = vi.fn();
		watcher.on(WatcherEvent.ALL, () => { throw new Error('boom') });
		watcher.on(FileSystemEvent.ADD, delivered);
		watcher.on(WatcherEvent.ERROR, (error: unknown) => errors.push(error));

		writeFileSync(join(root, 'x.txt'), 'x');
		await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));
		expect(errors.some((error) => messages(error).includes('boom')), `error listener received: ${errors.map(messages).join(', ')}`).toBe(true);
	});

	it('warns when an add listener throws without an error listener', async () => {
		const root = createTempRoot('watchr-no-error-listener-');
		const watcher = await createReadyWatcher(root, { ignoreInitial: true });
		const warningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
		watcher.on(FileSystemEvent.ADD, () => { throw new Error('add listener failed') });

		writeFileSync(join(root, 'file.txt'), 'content');
		await vi.waitFor(() => expect(warningSpy).toHaveBeenCalledWith(
			expect.objectContaining({ code: 'WATCHR_UNHANDLED_ERROR', message: 'Event listener threw.' }),
			expect.anything()
		));
	});

	it('warns when an error listener itself throws', async () => {
		const root = createTempRoot('watchr-throwing-error-listener-');
		const watcher = await createReadyWatcher(root, { ignoreInitial: true });
		const warningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
		watcher.on(WatcherEvent.ERROR, () => { throw new Error('error listener failed') });
		watcher.on(FileSystemEvent.ADD, () => { throw new Error('add listener failed') });

		writeFileSync(join(root, 'file.txt'), 'content');
		await vi.waitFor(() => expect(warningSpy).toHaveBeenCalledWith(
			expect.objectContaining({ code: 'WATCHR_UNHANDLED_ERROR', message: 'error listener failed' }),
			expect.anything()
		));
	});
});

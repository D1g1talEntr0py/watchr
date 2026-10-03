import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileRenameHandler } from '../src/file-rename-handler';
import { LockResolver } from '../src/lock-resolver';
import { FileSystemEvent } from '../src/constants';
import type { Path } from '../src/@types/index';
import { cleanupTempRoots, createTempRoot, delay } from './helpers/fs-fixtures';

type Emitted = [ event: FileSystemEvent, path: Path, next?: Path ];

describe('FileRenameHandler', () => {
	const handlers: FileRenameHandler[] = [];

	afterEach(() => {
		for (const handler of handlers.splice(0)) { handler.reset() }
		cleanupTempRoots();
	});

	/**
	 * Creates a handler that records emitted events.
	 * @param maxResolvers - Optional capacity limit for delayed event settlement.
	 * @returns The handler and its recorded events.
	 */
	function createHandler(maxResolvers?: number) {
		const emitted: Emitted[] = [];
		const errors: unknown[] = [];
		const handler = new FileRenameHandler(
			(event, path, _stats, next) => { emitted.push(next === undefined ? [ event, path ] : [ event, path, next ]) },
			(error) => { errors.push(error); return true },
			new LockResolver({ onError: () => undefined, ...(maxResolvers === undefined ? {} : { maxResolvers }) })
		);
		handlers.push(handler);

		return { handler, emitted, errors };
	}

	/**
	 * Polls a path and feeds every derived event to the handler, like one event-manager batch.
	 * @param handler - The handler under test.
	 * @param paths - Paths polled in the batch, all stat'd before any lock event is processed.
	 * @param timeout - The rename timeout.
	 */
	async function batch(handler: FileRenameHandler, paths: Path[], timeout: number) {
		const events = [];

		for (const path of paths) {
			for (const { type, stats } of await handler.fileStateManager.update(path)) { events.push({ type, path, stats }) }
		}

		for (const { type, path, stats } of events) { handler.getLockTargetEvent(type, path, stats, timeout, new Set()) }
	}

	it('emits add immediately for an inode no tracked path gave up', async () => {
		const { handler, emitted } = createHandler();
		const file = join(createTempRoot('watchr-rename-handler-'), 'new.txt');
		writeFileSync(file, 'x');

		await batch(handler, [ file ], 10_000);

		expect(emitted).toEqual([[ FileSystemEvent.ADD, file ]]);
	});

	it('holds an add whose inode was just vacated and pairs it with the unlink as a rename', async () => {
		const { handler, emitted } = createHandler();
		const root = createTempRoot('watchr-rename-handler-');
		const from = join(root, 'a.txt');
		const to = join(root, 'b.txt');
		writeFileSync(from, 'x');
		await batch(handler, [ from ], 10_000);
		emitted.length = 0;

		renameSync(from, to);
		// Destination first: the add is processed before the unlink that pairs with it.
		await batch(handler, [ to, from ], 10_000);

		expect(emitted).toEqual([[ FileSystemEvent.RENAME, from, to ]]);
	});

	it('does not let a rename target\'s own add swallow its later unlink', async () => {
		const { handler, emitted } = createHandler();
		const root = createTempRoot('watchr-rename-handler-');
		const from = join(root, 'a.txt');
		const to = join(root, 'b.txt');
		writeFileSync(from, 'x');
		await batch(handler, [ from ], 50);
		emitted.length = 0;

		renameSync(from, to);
		// Source first: the unlink resolves as a rename via the tracked sibling before the destination's add is seen.
		await batch(handler, [ from, to ], 50);
		rmSync(to);
		await batch(handler, [ to ], 50);
		await delay(150);

		expect(emitted).toEqual([[ FileSystemEvent.RENAME, from, to ], [ FileSystemEvent.UNLINK, to ]]);
	});

	it('emits addDir immediately for a new directory', async () => {
		const { handler, emitted } = createHandler();
		const dir = join(createTempRoot('watchr-rename-handler-'), 'dir');
		mkdirSync(dir);

		await batch(handler, [ dir ], 10_000);

		expect(emitted).toEqual([[ FileSystemEvent.ADD_DIR, dir ]]);
	});

	it('settles an evicted unlink and reports capacity pressure without dropping the removal', async () => {
		const { handler, emitted, errors } = createHandler(1);
		const root = createTempRoot('watchr-rename-capacity-');
		const first = join(root, 'first.txt');
		const second = join(root, 'second.txt');
		writeFileSync(first, 'first');
		writeFileSync(second, 'second');
		await batch(handler, [ first, second ], 10_000);
		emitted.length = 0;
		rmSync(first);
		rmSync(second);
		await batch(handler, [ first, second ], 10_000);

		expect(emitted).toEqual([[ FileSystemEvent.UNLINK, first ]]);
		expect(errors).toEqual([ expect.objectContaining({ message: 'Lock resolver capacity exceeded.' }) ]);
	});

	it('settles an evicted pending add and reports capacity pressure without dropping the addition', async () => {
		const { handler, emitted, errors } = createHandler(1);
		const root = createTempRoot('watchr-rename-capacity-');
		const first = join(root, 'first.txt');
		const second = join(root, 'second.txt');
		const firstTarget = join(root, 'first-target.txt');
		const secondTarget = join(root, 'second-target.txt');
		writeFileSync(first, 'first');
		writeFileSync(second, 'second');
		await batch(handler, [ first, second ], 10_000);
		emitted.length = 0;
		renameSync(first, firstTarget);
		renameSync(second, secondTarget);
		writeFileSync(first, 'replacement first');
		writeFileSync(second, 'replacement second');
		await batch(handler, [ first, second, firstTarget, secondTarget ], 10_000);

		expect(emitted).toEqual([[ FileSystemEvent.ADD, firstTarget ]]);
		expect(errors).toEqual([ expect.objectContaining({ message: 'Lock resolver capacity exceeded.' }) ]);
	});
});

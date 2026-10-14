import { afterEach, describe, expect, it, vi } from 'vitest';
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Watchr } from '../../src/watchr';
import { cleanupTempRoots, closeWatchers, collectEvents, createReadyWatcher, createTempRoot, createWatcher, observeEvent, waitForEvent } from './fs-fixtures';

afterEach(() => {
	closeWatchers();
	cleanupTempRoots();
});

describe('constructor-time test recording', () => {
	it('captures initial inventory before startup resolves without event methods', async () => {
		const root = createTempRoot();
		const file = join(root, 'initial.txt');
		writeFileSync(file, 'initial');
		const watcher = createWatcher(root, { emitInitial: true });
		const { events } = collectEvents(watcher);
		const added = waitForEvent(watcher, 'add', { path: file });
		expect('on' in watcher).toBe(false);
		expect(events).toEqual([]);
		expect(await watcher.start()).toBe(watcher);
		expect(await added).toBe(file);
		expect(events.find(({ path }) => path === file)).toMatchObject({ event: 'add', path: file, initial: true });
		expect(collectEvents(watcher).events).toEqual(events);
		await expect(waitForEvent(watcher, 'add', { path: file, timeoutMs: 5 })).rejects.toThrow('timed out');
	});

	it('adapts rename payloads to legacy assertion tuples without changing Watchr', async () => {
		const root = createTempRoot();
		const from = join(root, 'before.txt');
		const to = join(root, 'after.txt');
		writeFileSync(from, 'value');
		const watcher = await createReadyWatcher(root);
		const renamed = vi.fn();
		observeEvent(watcher, 'rename', renamed, true);
		const { events } = collectEvents(watcher);
		const next = waitForEvent(watcher, 'rename', { path: from });
		renameSync(from, to);
		await next;
		expect(renamed).toHaveBeenCalledExactlyOnceWith(expect.anything(), from, to);
		expect(events).toEqual([ expect.objectContaining({ event: 'rename', path: from, pathNext: to, initial: false }) ]);
		const final = join(root, 'final.txt');
		const nextRename = waitForEvent(watcher, 'rename', { path: to });
		renameSync(to, final);
		await nextRename;
		expect(renamed).toHaveBeenCalledTimes(1);
		expect(events).toHaveLength(2);
	});

	it('isolates handler option objects from caller mutation', async () => {
		const root = createTempRoot();
		const handler = vi.fn();
		const replacement = vi.fn();
		const entry = { handler, once: true };
		const watcher = createWatcher(root, { handlers: { all: entry } });
		entry.handler = replacement;
		entry.once = false;
		await watcher.start();

		const firstFile = join(root, 'first.txt');
		const firstEvent = waitForEvent(watcher, 'add', { path: firstFile });
		writeFileSync(firstFile, 'first');
		await firstEvent;

		const secondFile = join(root, 'second.txt');
		const secondEvent = waitForEvent(watcher, 'add', { path: secondFile });
		writeFileSync(secondFile, 'second');
		await secondEvent;

		expect(handler).toHaveBeenCalledTimes(1);
		expect(replacement).not.toHaveBeenCalled();
	});

	it('disposes only the selected collector while other observation queues remain active', async () => {
		const root = createTempRoot();
		const watcher = await createReadyWatcher(root);
		const first = collectEvents(watcher);
		const second = collectEvents(watcher);
		first.dispose();
		first.dispose();
		const file = join(root, 'live.txt');
		const next = waitForEvent(watcher, 'add', { path: file });
		writeFileSync(file, 'value');
		await next;
		expect(first.events).toEqual([]);
		expect(second.events).toHaveLength(1);
	});

	it('rejects timed-out waits and cancels pending waits on close', async () => {
		const root = createTempRoot();
		const watcher = await createReadyWatcher(root);
		await expect(waitForEvent(watcher, 'add', { timeoutMs: 5 })).rejects.toThrow('timed out');
		const pending = expect(waitForEvent(watcher, 'add')).rejects.toThrow('closed while waiting');
		watcher.close();
		await pending;
		await expect(waitForEvent(watcher, 'add')).rejects.toThrow('watcher is closed');
	});

	it('rejects attempts to attach recording after raw construction', () => {
		const watcher = new Watchr(createTempRoot());
		try {
			expect(() => collectEvents(watcher)).toThrow('Recording requires createWatcher');
		} finally {
			watcher.close();
		}
	});
});

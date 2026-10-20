import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchFile, unwatchFile, type Stats } from 'node:fs';
import { resolve } from 'node:path';
import { NodeTargetEvent } from '../src/constants';
import { MacOSWatcherFallback } from '../src/macos-watcher-fallback';
import { WindowsWatcherFallback } from '../src/windows-watcher-fallback';
import { createWatcherFallback, type WatcherFallback, type WatcherFallbackConfiguration } from '../src/watcher-fallback';

const { rootStatListeners } = vi.hoisted(() => ({
	rootStatListeners: new Map<string, (current: Stats, previous: Stats) => void>()
}));

vi.mock('node:fs', async (importOriginal) => ({
	...await importOriginal<typeof import('node:fs')>(),
	watchFile: vi.fn((target: string, _options: unknown, listener: (current: Stats, previous: Stats) => void) => {
		rootStatListeners.set(target, listener);
	}),
	unwatchFile: vi.fn()
}));

describe('Watcher fallback', () => {
	let controller: AbortController;
	let configuration: WatcherFallbackConfiguration;
	let fallback: WatcherFallback | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		controller = new AbortController();
		configuration = {
			folderPath: resolve('fallback-root'),
			filePath: undefined,
			persistent: undefined,
			signal: controller.signal,
			notifyPath: vi.fn(),
			requestSnapshot: vi.fn(),
			reconcileTracked: vi.fn(),
			closeNativeRoot: vi.fn()
		};
	});

	afterEach(() => {
		controller.abort();
		fallback?.close();
		fallback = undefined;
		rootStatListeners.clear();
		vi.restoreAllMocks();
		vi.clearAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	describe.runIf(process.platform === 'darwin')('MacOSWatcherFallback', () => {
		it('starts only on request and reconciles at cumulative 100/350/850/1850ms', () => {
			fallback = new MacOSWatcherFallback(configuration);
			expect(vi.getTimerCount()).toBe(0);
			fallback.start();
			for (const [ index, delay ] of [ 100, 250, 500, 1000 ].entries()) {
				vi.advanceTimersByTime(delay - 1);
				expect(configuration.reconcileTracked).toHaveBeenCalledTimes(index);
				vi.advanceTimersByTime(1);
				expect(configuration.reconcileTracked).toHaveBeenNthCalledWith(index + 1, NodeTargetEvent.RENAME);
			}
			vi.advanceTimersByTime(5000);
			expect(configuration.reconcileTracked).toHaveBeenCalledTimes(4);
			expect(configuration.requestSnapshot).not.toHaveBeenCalled();
			expect(configuration.notifyPath).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		});

		it('polls file changes every 100ms without directory reconciliation', () => {
			fallback = new MacOSWatcherFallback({ ...configuration, filePath: resolve('fallback-root/file.txt') });
			fallback.start();
			vi.advanceTimersByTime(99);
			expect(configuration.notifyPath).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(configuration.notifyPath).toHaveBeenCalledExactlyOnceWith(NodeTargetEvent.CHANGE);
			vi.advanceTimersByTime(200);
			expect(configuration.notifyPath).toHaveBeenCalledTimes(3);
			expect(configuration.reconcileTracked).not.toHaveBeenCalled();
			expect(configuration.requestSnapshot).not.toHaveBeenCalled();
		});

		it('requests snapshots only for named rename events', () => {
			const darwin = new MacOSWatcherFallback(configuration);
			fallback = darwin;
			darwin.onNamedEvent(NodeTargetEvent.CHANGE);
			expect(configuration.requestSnapshot).not.toHaveBeenCalled();
			darwin.onNamedEvent(NodeTargetEvent.RENAME);
			expect(configuration.requestSnapshot).toHaveBeenCalledExactlyOnceWith(NodeTargetEvent.RENAME);
			expect(configuration.reconcileTracked).not.toHaveBeenCalled();
		});

		it.each([ false, true ])('suppresses fallback if aborted before startup (file=%s)', (file) => {
			controller.abort();
			fallback = new MacOSWatcherFallback({ ...configuration, filePath: file ? resolve('file.txt') : undefined });
			fallback.start();
			expect(vi.getTimerCount()).toBe(0);
		});

		it.each([ false, true ])('suppresses queued work after abort (file=%s)', (file) => {
			fallback = new MacOSWatcherFallback({ ...configuration, filePath: file ? resolve('file.txt') : undefined });
			fallback.start();
			controller.abort();
			vi.advanceTimersByTime(5000);
			expect(configuration.notifyPath).not.toHaveBeenCalled();
			expect(configuration.reconcileTracked).not.toHaveBeenCalled();
			fallback.close();
			expect(vi.getTimerCount()).toBe(0);
		});

		it.each([ false, true ])('clears timers synchronously and idempotently (file=%s)', (file) => {
			fallback = new MacOSWatcherFallback({ ...configuration, filePath: file ? resolve('file.txt') : undefined });
			fallback.start();
			expect(vi.getTimerCount()).toBe(1);
			fallback.close();
			fallback.close();
			fallback.start();
			expect(vi.getTimerCount()).toBe(0);
			vi.advanceTimersByTime(5000);
			expect(configuration.notifyPath).not.toHaveBeenCalled();
			expect(configuration.reconcileTracked).not.toHaveBeenCalled();
		});

		it.each([ false, true, undefined ])('preserves timer ref behavior (persistent=%s)', (persistent) => {
			const timeout = vi.spyOn(globalThis, 'setTimeout');
			fallback = new MacOSWatcherFallback({ ...configuration, persistent });
			fallback.start();
			vi.advanceTimersByTime(1850);
			expect(timeout).toHaveBeenCalledTimes(4);
			for (const result of timeout.mock.results) {
				expect((result.value as NodeJS.Timeout).hasRef()).toBe(persistent !== false);
			}
			fallback.close();
			const interval = vi.spyOn(globalThis, 'setInterval');
			fallback = new MacOSWatcherFallback({ ...configuration, persistent, filePath: resolve('file.txt') });
			fallback.start();
			expect((interval.mock.results[0]!.value as NodeJS.Timeout).hasRef()).toBe(persistent !== false);
		});
	});

	describe.runIf(process.platform === 'win32')('WindowsWatcherFallback', () => {
		it.each([ false, true, undefined ])('registers root polling only after startup (persistent=%s)', (persistent) => {
			fallback = new WindowsWatcherFallback({ ...configuration, persistent });
			expect(watchFile).not.toHaveBeenCalled();
			fallback.start();
			expect(watchFile).toHaveBeenCalledExactlyOnceWith(configuration.folderPath, { interval: 100, persistent: persistent ?? true }, expect.any(Function));
		});

		it('closes the native root before notifying a missing root, but not for an existing root', () => {
			fallback = new WindowsWatcherFallback(configuration);
			fallback.start();
			const listener = rootStatListeners.get(configuration.folderPath)!;
			const present = { nlink: 1 } as Stats;
			const missing = { nlink: 0 } as Stats;
			listener(present, present);
			expect(configuration.closeNativeRoot).not.toHaveBeenCalled();
			expect(configuration.notifyPath).not.toHaveBeenCalled();
			listener(missing, present);
			expect(configuration.closeNativeRoot).toHaveBeenCalledOnce();
			expect(configuration.notifyPath).toHaveBeenCalledExactlyOnceWith(NodeTargetEvent.RENAME);
			expect(vi.mocked(configuration.closeNativeRoot).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(configuration.notifyPath).mock.invocationCallOrder[0]!);
		});

		it('ignores a pending root listener after cancellation', () => {
			fallback = new WindowsWatcherFallback(configuration);
			fallback.start();
			const listener = rootStatListeners.get(configuration.folderPath)!;
			controller.abort();
			listener({ nlink: 0 } as Stats, { nlink: 1 } as Stats);
			expect(configuration.closeNativeRoot).not.toHaveBeenCalled();
			expect(configuration.notifyPath).not.toHaveBeenCalled();
		});

		it('unregisters only its exact listener synchronously and idempotently', () => {
			fallback = new WindowsWatcherFallback(configuration);
			expect(unwatchFile).not.toHaveBeenCalled();
			fallback.start();
			const listener = rootStatListeners.get(configuration.folderPath)!;
			fallback.close();
			fallback.close();
			fallback.start();
			expect(unwatchFile).toHaveBeenCalledExactlyOnceWith(configuration.folderPath, listener);
			expect(watchFile).toHaveBeenCalledOnce();
			listener({ nlink: 0 } as Stats, { nlink: 1 } as Stats);
			expect(configuration.notifyPath).not.toHaveBeenCalled();
		});

		it.each([ 'file', 'aborted' ])('does not register root polling for %s targets', (target) => {
			if (target === 'aborted') { controller.abort() }
			fallback = new WindowsWatcherFallback({ ...configuration, filePath: target === 'file' ? resolve('file.txt') : undefined });
			fallback.start();
			expect(watchFile).not.toHaveBeenCalled();
		});

		it.each([ false, true ])('consumes only EPERM, including before startup (file=%s)', (file) => {
			const windows = new WindowsWatcherFallback({ ...configuration, filePath: file ? resolve('file.txt') : undefined });
			fallback = windows;
			expect(windows.handleError(Object.assign(new Error('locked'), { code: 'EPERM' }))).toBe(true);
			expect(configuration.notifyPath).toHaveBeenCalledExactlyOnceWith(NodeTargetEvent.RENAME);
			expect(windows.handleError(Object.assign(new Error('denied'), { code: 'EACCES' }))).toBe(false);
			expect(windows.handleError(new Error('unknown'))).toBe(false);
			expect(configuration.notifyPath).toHaveBeenCalledOnce();
			expect(configuration.closeNativeRoot).not.toHaveBeenCalled();
		});
	});

	const platformFallbacks = ([ [ 'darwin', MacOSWatcherFallback ], [ 'win32', WindowsWatcherFallback ] ] as const).filter(([ platform ]) => platform === process.platform);

	it.each(platformFallbacks)('supports using scope disposal on %s', (_platform, Fallback) => {
		fallback = new Fallback(configuration);
		const close = vi.spyOn(fallback, 'close');
		{
			using scopedFallback = fallback;
			scopedFallback.start();
		}
		expect(close).toHaveBeenCalledOnce();
		fallback.start();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(5000);
		expect(configuration.reconcileTracked).not.toHaveBeenCalled();
		expect(controller.signal.aborted).toBe(false);
	});

	it.each(platformFallbacks)('does not start after disposal before setup on %s', (_platform, Fallback) => {
		fallback = new Fallback(configuration);
		fallback.close();
		fallback.start();
		expect(watchFile).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	describe('createWatcherFallback', () => {
		it.runIf(process.platform !== 'darwin' && process.platform !== 'win32')('does not allocate fallback or schedule work without a platform fallback', () => {
			fallback = createWatcherFallback(configuration);
			expect(fallback).toBeUndefined();
			expect(watchFile).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		});

		it.each([ 'darwin', 'win32' ].filter((platform) => platform === process.platform))('selects %s once without starting fallback', (platform) => {
			fallback = createWatcherFallback(configuration);
			expect(fallback).toBeInstanceOf(platform === 'darwin' ? MacOSWatcherFallback : WindowsWatcherFallback);
			expect(watchFile).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
			fallback!.start();
			if (platform === 'darwin') {
				expect(vi.getTimerCount()).toBe(1);
			} else {
				expect(watchFile).toHaveBeenCalledOnce();
			}
		});
	});
});

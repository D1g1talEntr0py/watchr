/// <reference types="node" />

import { bench, group, run } from 'mitata';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync, watch } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { FileSystemStateManager } from '../dist/file-system-state-manager.js';
import { LockResolver } from '../dist/lock-resolver.js';
import { WatchrStats } from '../dist/watchr-stats.js';
import { Watchr } from '../dist/watchr.js';
import { FileSystemEvent, renameTimeout } from '../dist/constants.js';
import type { Stats, WatchrOptions } from '../src/@types/index.js';

type WatchrBenchEvent = 'add' | 'change' | 'unlink' | 'rename' | 'renameDir';

const timeoutMs = 5_000;
const settleBufferMs = 25;

const benchmarkRoot = mkdtempSync(join(tmpdir(), 'watchr-bench-'));
const testFilesDir = join(benchmarkRoot, 'test-files');
const unlinkDir = join(benchmarkRoot, 'unlink');
const renameFileDir = join(benchmarkRoot, 'rename-file');
const renameDirDir = join(benchmarkRoot, 'rename-dir');
const nativeCreateDir = join(benchmarkRoot, 'native-create');
const nativeChangeDir = join(benchmarkRoot, 'native-change');
const nativeUnlinkDir = join(benchmarkRoot, 'native-unlink');

const benchmarkWatchOptions: WatchrOptions = {
	ignoreInitial: true,
	renameTimeout: 0,
};

const renameBenchmarkWatchOptions: WatchrOptions = {
	ignoreInitial: true,
	renameTimeout,
};

let sequence = 0;

function uniqueName(prefix: string): string {
	sequence += 1;
	return `${prefix}-${Date.now()}-${sequence}.txt`;
}

class EventQueue {
	private pending = 0;
	private readonly waiters: Array<() => void> = [];

	notify(): void {
		const waiter = this.waiters.shift();

		if (waiter === undefined) {
			this.pending += 1;
			return;
		}

		waiter();
	}

	wait(message: string, timeout = timeoutMs): Promise<void> {
		if (this.pending > 0) {
			this.pending -= 1;
			return Promise.resolve();
		}

		return new Promise((resolve, reject) => {
			const onResolve = () => {
				clearTimeout(timer);
				resolve();
			};

			const timer = setTimeout(() => {
				const index = this.waiters.indexOf(onResolve);
				if (index >= 0) { this.waiters.splice(index, 1) }
				reject(new Error(message));
			}, timeout);

			this.waiters.push(onResolve);
		});
	}
}

class NativeEventStream {
	private readonly watcher;
	private readonly queue = new EventQueue();

	constructor(path: string) {
		this.watcher = watch(path, () => this.queue.notify());
	}

	wait(message: string): Promise<void> {
		return this.queue.wait(message);
	}

	close(): void {
		this.watcher.close();
	}
}

class WatchrEventStream {
	private readonly watcher: Watchr;
	private readonly queue = new EventQueue();

	private constructor(path: string, options: WatchrOptions, event: WatchrBenchEvent) {
		this.watcher = new Watchr(path, options);
		this.watcher.on(event, () => this.queue.notify());
	}

	static async create(path: string, options: WatchrOptions, event: WatchrBenchEvent): Promise<WatchrEventStream> {
		const stream = new WatchrEventStream(path, options, event);

		await stream.watcher.readyLock;
		await delay((options.renameTimeout ?? 0) + settleBufferMs);

		return stream;
	}

	wait(message: string): Promise<void> {
		return this.queue.wait(message);
	}

	close(): void {
		this.watcher.close();
	}
}

async function withWatchr(target: string, options: WatchrOptions, callback: (watcher: Watchr) => Promise<void>): Promise<void> {
	const watcher = new Watchr(target, options);
	await watcher.readyLock;
	await delay((options.renameTimeout ?? 0) + settleBufferMs);

	try {
		await callback(watcher);
	} finally {
		watcher.close();
	}
}

function waitForWatchrEventCount(watcher: Watchr, event: WatchrBenchEvent, count: number, timeout = timeoutMs): Promise<void> {
	return new Promise((resolve, reject) => {
		let seen = 0;
		const onEvent = () => {
			seen += 1;
			if (seen >= count) {
				clearTimeout(timer);
				watcher.off(event, onEvent);
				resolve();
			}
		};

		const timer = setTimeout(() => {
			watcher.off(event, onEvent);
			reject(new Error(`🚨 benchmark timeout waiting for ${count} '${event}' events`));
		}, timeout);

		watcher.on(event, onEvent);
	});
}

function syntheticStats(inodeNumber: number): WatchrStats {
	return new WatchrStats({
		isFile: () => true,
		isDirectory: () => false,
		isSymbolicLink: () => false,
		ino: BigInt(inodeNumber),
		size: 100n,
		mtimeNs: 0n,
		ctimeNs: 0n,
		mtimeMs: 0
	} as unknown as Stats);
}

await Promise.all([
	fs.mkdir(testFilesDir, { recursive: true }),
	fs.mkdir(unlinkDir, { recursive: true }),
	fs.mkdir(renameFileDir, { recursive: true }),
	fs.mkdir(renameDirDir, { recursive: true }),
	fs.mkdir(nativeCreateDir, { recursive: true }),
	fs.mkdir(nativeChangeDir, { recursive: true }),
	fs.mkdir(nativeUnlinkDir, { recursive: true }),
]);

for (let i = 0; i < 50; i++) {
	await fs.writeFile(join(testFilesDir, `file-${i}.txt`), `content-${i}`);
}

const steadyNativeCreate = new NativeEventStream(nativeCreateDir);
const steadyNativeChange = new NativeEventStream(nativeChangeDir);
const steadyNativeUnlink = new NativeEventStream(nativeUnlinkDir);

const steadyWatchrCreate = await WatchrEventStream.create(testFilesDir, benchmarkWatchOptions, 'add');
const steadyWatchrChange = await WatchrEventStream.create(testFilesDir, benchmarkWatchOptions, 'change');
const steadyWatchrUnlink = await WatchrEventStream.create(unlinkDir, benchmarkWatchOptions, 'unlink');
const steadyWatchrRenameFile = await WatchrEventStream.create(renameFileDir, renameBenchmarkWatchOptions, 'rename');
const steadyWatchrRenameDir = await WatchrEventStream.create(renameDirDir, renameBenchmarkWatchOptions, 'renameDir');

const nativeChangeTarget = join(nativeChangeDir, 'target.txt');
await fs.writeFile(nativeChangeTarget, 'seed-native-change');

const watchrChangeTarget = join(testFilesDir, 'watchr-change-target.txt');
await fs.writeFile(watchrChangeTarget, 'seed-watchr-change');

const watchrRenameFileTargetA = join(renameFileDir, 'file-a.txt');
const watchrRenameFileTargetB = join(renameFileDir, 'file-b.txt');
await fs.writeFile(watchrRenameFileTargetA, 'seed-watchr-rename-file');

const watchrRenameDirTargetA = join(renameDirDir, 'dir-a');
const watchrRenameDirTargetB = join(renameDirDir, 'dir-b');
await fs.mkdir(watchrRenameDirTargetA, { recursive: true });
await fs.writeFile(join(watchrRenameDirTargetA, 'seed.txt'), 'seed-watchr-rename-dir');

const trackedInodeCapacity = 5000;
const lockResolverCount = 5000;
type InodeUpdater = { updateInode: (p: string, e: FileSystemEvent, s: WatchrStats) => void };

let stateManager: InodeUpdater | undefined;
let inodeCounter = 0;
let lockResolverSeeded = false;
let lockResolver: LockResolver | undefined;

group('Native fs.watch Baseline', () => {
	bench('native init and close (50 files)', async () => {
		const watcher = watch(testFilesDir, () => undefined);
		await delay(0);
		watcher.close();
	});

	bench('native single create notification', async () => {
		const filePath = join(nativeCreateDir, uniqueName('native-add'));
		const eventPromise = steadyNativeCreate.wait('🚨 benchmark timeout waiting for native create notification');

		await fs.writeFile(filePath, 'payload');
		await eventPromise;
	});

	bench('native single change notification', async () => {
		const eventPromise = steadyNativeChange.wait('🚨 benchmark timeout waiting for native change notification');

		await fs.writeFile(nativeChangeTarget, uniqueName('native-change-payload'));
		await eventPromise;
	});

	bench('native single unlink notification', async () => {
		const filePath = join(nativeUnlinkDir, uniqueName('native-unlink'));
		await fs.writeFile(filePath, 'seed');

		const eventPromise = steadyNativeUnlink.wait('🚨 benchmark timeout waiting for native unlink notification');
		await fs.unlink(filePath);
		await eventPromise;
	});
});

group('Watchr Baseline Performance', () => {
	bench('watchr init and close (50 files)', async () => {
		await withWatchr(testFilesDir, benchmarkWatchOptions, async () => Promise.resolve());
	});

	bench('watchr single create notification', async () => {
		const filePath = join(testFilesDir, uniqueName('watchr-add'));
		const eventPromise = steadyWatchrCreate.wait('🚨 benchmark timeout waiting for watchr add notification');

		await fs.writeFile(filePath, 'payload');
		await eventPromise;
	});

	bench('watchr single change notification', async () => {
		const eventPromise = steadyWatchrChange.wait('🚨 benchmark timeout waiting for watchr change notification');

		await fs.writeFile(watchrChangeTarget, uniqueName('watchr-change-payload'));
		await eventPromise;
	});

	bench('watchr single unlink notification', async () => {
		const filePath = join(unlinkDir, uniqueName('watchr-unlink'));
		await fs.writeFile(filePath, 'seed');

		const eventPromise = steadyWatchrUnlink.wait('🚨 benchmark timeout waiting for watchr unlink notification');
		await fs.unlink(filePath);
		await eventPromise;
	});

	bench('watchr detect file rename', async () => {
		const source = await fs.access(watchrRenameFileTargetA).then(() => watchrRenameFileTargetA).catch(() => watchrRenameFileTargetB);
		const destination = source === watchrRenameFileTargetA ? watchrRenameFileTargetB : watchrRenameFileTargetA;

		const eventPromise = steadyWatchrRenameFile.wait('🚨 benchmark timeout waiting for watchr rename notification');
		await fs.rename(source, destination);
		await eventPromise;
	});

	bench('watchr detect directory rename', async () => {
		const source = await fs.access(watchrRenameDirTargetA).then(() => watchrRenameDirTargetA).catch(() => watchrRenameDirTargetB);
		const destination = source === watchrRenameDirTargetA ? watchrRenameDirTargetB : watchrRenameDirTargetA;

		const eventPromise = steadyWatchrRenameDir.wait('🚨 benchmark timeout waiting for watchr renameDir notification');
		await fs.rename(source, destination);
		await eventPromise;
	});

	bench('watchr handle 10 add events', async () => {
		const batch = Array.from({ length: 10 }, (_, i) => join(testFilesDir, uniqueName(`watchr-bulk-add-${i}`)));
		await withWatchr(testFilesDir, benchmarkWatchOptions, async (watcher) => {
			const eventPromise = waitForWatchrEventCount(watcher, 'add', 10);
			await Promise.all(batch.map((path, i) => fs.writeFile(path, `content-${i}`)));
			await eventPromise;
		});
	});

	bench('watchr rapid change notification (5 writes)', async () => {
		await withWatchr(testFilesDir, benchmarkWatchOptions, async (watcher) => {
			const eventPromise = new Promise<void>((resolve, reject) => {
				const onChange = () => {
					clearTimeout(timer);
					watcher.off('change', onChange);
					resolve();
				};

				const timer = setTimeout(() => {
					watcher.off('change', onChange);
					reject(new Error('🚨 benchmark timeout waiting for watchr rapid change notification'));
				}, timeoutMs);

				watcher.on('change', onChange);
			});

			for (let i = 0; i < 5; i++) {
				await fs.writeFile(watchrChangeTarget, uniqueName(`watchr-rapid-change-${i}`));
			}

			await eventPromise;
		});
	});
});

group('Hot Path Microbenchmarks', () => {
	bench('updateInode at capacity (triggers prune)', () => {
		if (stateManager === undefined) {
			(FileSystemStateManager as unknown as { maxTrackedEventInodes: number }).maxTrackedEventInodes = trackedInodeCapacity;
			stateManager = new FileSystemStateManager() as unknown as InodeUpdater;

			for (let i = 0; i < trackedInodeCapacity; i++) {
				stateManager.updateInode(`/seed-${i}.txt`, FileSystemEvent.ADD, syntheticStats(i));
			}
		}

		inodeCounter += 1;
		stateManager.updateInode(`/hot-${inodeCounter}.txt`, FileSystemEvent.ADD, syntheticStats(inodeCounter));
	});

	bench(`lock resolver idle tick with ${lockResolverCount} pending`, () => {
		lockResolver ??= new LockResolver();

		if (!lockResolverSeeded) {
			lockResolverSeeded = true;

			for (let i = 0; i < lockResolverCount; i++) {
				lockResolver.add(() => undefined, 60_000);
			}
		}

		(lockResolver as unknown as { resolve: () => void }).resolve();
	});
});

try {
	await run({ throw: true });
} finally {
	steadyNativeCreate.close();
	steadyNativeChange.close();
	steadyNativeUnlink.close();
	steadyWatchrCreate.close();
	steadyWatchrChange.close();
	steadyWatchrUnlink.close();
	steadyWatchrRenameFile.close();
	steadyWatchrRenameDir.close();
	rmSync(benchmarkRoot, { recursive: true, force: true });
}

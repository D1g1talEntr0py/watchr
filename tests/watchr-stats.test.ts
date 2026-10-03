import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WatchrStats } from '../src/watchr';

describe('WatchrStats', () => {
	let root: string;
	let filePath: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'watchr-stats-'));
		filePath = join(root, 'file.txt');
		writeFileSync(filePath, 'contents');
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it('captures native file metadata and timestamps without installing a Temporal global', () => {
		const nativeStats = statSync(filePath, { bigint: true });
		const hadTemporal = Object.hasOwn(globalThis, 'Temporal');
		const snapshot = WatchrStats.fromStats(nativeStats);

		expect(snapshot.inodeNumber).toBe(nativeStats.ino <= Number.MAX_SAFE_INTEGER ? Number(nativeStats.ino) : nativeStats.ino);
		expect(snapshot.size).toBe(Number(nativeStats.size));
		expect(snapshot.isFile()).toBe(true);
		expect(snapshot.isDirectory()).toBe(false);
		expect(snapshot.isSynthetic).toBe(false);
		expect(snapshot.modifiedTimeNs).toBe(nativeStats.mtimeNs);
		expect(snapshot.changeTimeNs).toBe(nativeStats.ctimeNs);
		expect(snapshot.modifiedTime.epochNanoseconds).toBe(nativeStats.mtimeNs);
		expect(snapshot.changeTime.epochNanoseconds).toBe(nativeStats.ctimeNs);
		expect(Object.hasOwn(globalThis, 'Temporal')).toBe(hadTemporal);
	});

	it('reports directory and symlink metadata from native stats', () => {
		const directory = join(root, 'nested');
		const link = join(root, 'link.txt');
		mkdirSync(directory);
		symlinkSync(filePath, link);

		expect(WatchrStats.fromStats(statSync(directory, { bigint: true })).isDirectory()).toBe(true);
		expect(WatchrStats.fromStats(lstatSync(link, { bigint: true })).isSymbolicLink()).toBe(true);
		const followed = WatchrStats.fromStats(statSync(link, { bigint: true }), true);
		expect(followed.isFile()).toBe(true);
		expect(followed.isSymbolicLink()).toBe(true);
	});

	it('keeps nanosecond timestamp precision when converting to milliseconds', () => {
		const nativeStats = statSync(filePath, { bigint: true });
		const snapshot = WatchrStats.fromStats(nativeStats);
		const expected = Number(nativeStats.mtimeNs / 1_000_000n) + Number(nativeStats.mtimeNs % 1_000_000n) / 1_000_000;

		expect(snapshot.modifiedTimeMs).toBe(expected);
		expect(snapshot.modifiedTime).not.toBe(snapshot.modifiedTime);
	});

	it('creates synthetic file and directory snapshots', () => {
		const file = WatchrStats.synthetic(false, 1_700_000_000_000);
		const directory = WatchrStats.synthetic(true, 1_700_000_000_000);

		expect(file.isSynthetic).toBe(true);
		expect(file.isFile()).toBe(true);
		expect(file.inodeNumber).toBe(0);
		expect(file.size).toBe(0);
		expect(file.modifiedTimeMs).toBe(1_700_000_000_000);
		expect(directory.isDirectory()).toBe(true);
		expect(file.equals(directory)).toBe(false);
	});

	it('defaults synthetic timestamps to the current time', () => {
		const before = Date.now();
		const snapshot = WatchrStats.synthetic(false);

		expect(snapshot.modifiedTimeMs).toBeGreaterThanOrEqual(before);
		expect(snapshot.modifiedTimeMs).toBeLessThanOrEqual(Date.now());
	});

	it('compares snapshots using native metadata changes', () => {
		const first = WatchrStats.fromStats(statSync(filePath, { bigint: true }));
		const unchanged = WatchrStats.fromStats(statSync(filePath, { bigint: true }));
		writeFileSync(filePath, 'changed contents with a different size');
		const changed = WatchrStats.fromStats(statSync(filePath, { bigint: true }));

		expect(first.equals(unchanged)).toBe(true);
		expect(first.equals(changed)).toBe(false);
		expect(WatchrStats.synthetic(false, 5).equals(WatchrStats.synthetic(false, 5))).toBe(true);
	});
});

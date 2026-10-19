import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileSystemStateManager } from '../src/file-system-state-manager';
import { FileSystemEvent } from '../src/constants';
import { FileSystem } from '../src/file-system';
import { cleanupTempRoots, createTempRoot } from './helpers/fs-fixtures';

describe('FileSystemStateManager.wasVacatedWithin', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		cleanupTempRoots();
	});

	/**
	 * Tracks a new file and returns its inode.
	 * @param manager - The state manager.
	 * @param path - The file to create and track.
	 * @returns The tracked inode number.
	 */
	async function track(manager: FileSystemStateManager, path: string) {
		writeFileSync(path, 'x');
		const [ event ] = await manager.update(path);

		expect(event?.type).toBe(FileSystemEvent.ADD);

		return event!.stats.inodeNumber;
	}

	it('is false for a tracked inode that never lost its path', async () => {
		const manager = new FileSystemStateManager();
		const inode = await track(manager, join(createTempRoot('watchr-vacated-'), 'a.txt'));

		expect(manager.wasVacatedWithin(inode, 25)).toBe(false);
	});

	it('is true within the window after the path disappears and false after it', async () => {
		const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
		const manager = new FileSystemStateManager();
		const path = join(createTempRoot('watchr-vacated-'), 'a.txt');
		const inode = await track(manager, path);

		rmSync(path);
		await manager.update(path);

		now.mockReturnValue(1_010);
		expect(manager.wasVacatedWithin(inode, 25)).toBe(true);
		now.mockReturnValue(1_026);
		expect(manager.wasVacatedWithin(inode, 25)).toBe(false);
	});

	it('prunes entries older than the retention window and clears on reset', async () => {
		const now = vi.spyOn(performance, 'now').mockReturnValue(0);
		const manager = new FileSystemStateManager();
		const root = createTempRoot('watchr-vacated-');
		const first = join(root, 'a.txt');
		const second = join(root, 'b.txt');
		const firstInode = await track(manager, first);
		const secondInode = await track(manager, second);

		rmSync(first);
		await manager.update(first);
		now.mockReturnValue(1_000);
		rmSync(second);
		await manager.update(second);

		expect(manager.wasVacatedWithin(firstInode, 25)).toBe(false);
		expect(manager.wasVacatedWithin(secondInode, 25)).toBe(true);

		manager.reset();
		expect(manager.wasVacatedWithin(secondInode, 25)).toBe(false);
	});

	it('configures positive retention before removals and never lowers it across shared roots', async () => {
		const now = vi.spyOn(performance, 'now').mockReturnValue(0);
		const manager = new FileSystemStateManager();
		manager.configureRenameTimeout(25);
		manager.configureRenameTimeout(10);
		manager.configureRenameTimeout(0);
		const root = createTempRoot();
		const first = join(root, 'first');
		const second = join(root, 'second');
		const inode = await track(manager, first);
		await track(manager, second);
		rmSync(first);
		await manager.update(first);
		now.mockReturnValue(20);
		rmSync(second);
		await manager.update(second);
		expect(manager.wasVacatedWithin(inode, 25)).toBe(true);
		now.mockReturnValue(26);
		expect(manager.wasVacatedWithin(inode, 25)).toBe(false);
	});

	it('keeps zero retention pruning semantics without disabling inode history', async () => {
		const now = vi.spyOn(performance, 'now').mockReturnValue(0);
		const manager = new FileSystemStateManager();
		manager.configureRenameTimeout(0);
		const root = createTempRoot();
		const first = join(root, 'first');
		const second = join(root, 'second');
		const inode = await track(manager, first);
		const secondInode = await track(manager, second);
		rmSync(first);
		await manager.update(first);
		expect(manager.wasVacatedWithin(inode, 0)).toBe(true);
		now.mockReturnValue(1);
		rmSync(second);
		await manager.update(second);
		expect(manager.wasVacatedWithin(inode, 25)).toBe(false);
		expect(manager.wasVacatedWithin(secondInode, 0)).toBe(true);
		expect(manager.getInodeNumber(first, FileSystemEvent.UNLINK)).toBe(inode);
	});
});

describe('FileSystemStateManager tracked event inodes', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		cleanupTempRoots();
	});

	it('evicts the least-recent event without refreshing lookups and refreshes event updates', async () => {
		const manager = new FileSystemStateManager();
		const fixture = join(createTempRoot('watchr-inode-cache-'), 'fixture.txt');

		writeFileSync(fixture, 'x');
		const stats = statSync(fixture, { bigint: true });
		const inodeNumber = Number(stats.ino);
		let revision = 0n;

		vi.spyOn(FileSystem, 'getStats').mockImplementation(() => {
			Object.defineProperty(stats, 'mtimeNs', { configurable: true, value: revision++ });

			return Promise.resolve(stats);
		});

		for (let index = 0; index < 50_000; index++) {
			await manager.update(`/virtual/${index}`);
		}
		for (let index = 0; index < 50_000; index++) {
			await manager.update(`/virtual/${index}`);
		}

		expect(manager.getInodeNumber('/virtual/0', FileSystemEvent.CHANGE)).toBe(inodeNumber);
		await manager.update('/virtual/1');
		await manager.update('/virtual/overflow');

		expect(manager.getInodeNumber('/virtual/0', FileSystemEvent.CHANGE)).toBeUndefined();
		expect(manager.getInodeNumber('/virtual/1', FileSystemEvent.CHANGE)).toBe(inodeNumber);

		manager.reset();
		expect(manager.getInodeNumber('/virtual/1', FileSystemEvent.CHANGE)).toBeUndefined();
	}, 30_000);
});

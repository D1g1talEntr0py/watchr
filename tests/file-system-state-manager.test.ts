import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileSystemStateManager } from '../src/file-system-state-manager';
import { FileSystemEvent } from '../src/constants';
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

		expect(manager.wasVacatedWithin(inode, 10_000)).toBe(false);
	});

	it('is true within the window after the path disappears and false after it', async () => {
		const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
		const manager = new FileSystemStateManager();
		const path = join(createTempRoot('watchr-vacated-'), 'a.txt');
		const inode = await track(manager, path);

		rmSync(path);
		await manager.update(path);

		now.mockReturnValue(1_100);
		expect(manager.wasVacatedWithin(inode, 150)).toBe(true);
		now.mockReturnValue(1_200);
		expect(manager.wasVacatedWithin(inode, 150)).toBe(false);
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

		expect(manager.wasVacatedWithin(firstInode, 60_000)).toBe(false);
		expect(manager.wasVacatedWithin(secondInode, 60_000)).toBe(true);

		manager.reset();
		expect(manager.wasVacatedWithin(secondInode, 60_000)).toBe(false);
	});
});

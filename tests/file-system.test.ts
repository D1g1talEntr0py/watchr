import { join, resolve, sep } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol, type memfs } from 'memfs';
import { FileSystem } from '../src/file-system';
import { FileSystemEntries } from '../src/file-system-entries';

// Mock the fs modules to use memfs
vi.mock('node:fs', async () => {
	const memfs = await vi.importActual<typeof memfs>('memfs');
	return {
		...memfs.fs,
		watch: vi.fn(() => ({
			on: vi.fn(),
			close: vi.fn(),
		})),
	};
});

vi.mock('node:fs/promises', async () => {
	const memfs = await vi.importActual<typeof memfs>('memfs');
	return memfs.fs.promises;
});

describe('FileSystem', () => {
	const mockDirectory = resolve(process.cwd(), 'tests/mocked-fs');
	const emptyDirectory = join(mockDirectory, 'empty');
	const notEmptyDirectory = join(mockDirectory, 'not-empty');
	const emptyFile = join(mockDirectory, 'empty.txt');
	const notEmptyFile = join(notEmptyDirectory, 'not-empty.txt');

	beforeEach(() => {
		// Reset memfs and create test structure
		vol.reset();
		vol.mkdirSync(mockDirectory, { recursive: true });
		vol.mkdirSync(emptyDirectory, { recursive: true });
		vol.mkdirSync(notEmptyDirectory, { recursive: true });
		vol.writeFileSync(emptyFile, '');
		vol.writeFileSync(notEmptyFile, 'Some content');
	});

	afterEach(() => {
		const retryQueue = FileSystem['retryQueue'];
		retryQueue['activeQueue'].clear();
		retryQueue['pendingQueue'].clear();
		retryQueue['reset']();
		vol.reset();
		vi.restoreAllMocks();
	});

	describe('creating an instance', () => {
		it('should throw an error', () => {
			// @ts-expect-error This is a test case
			expect(() => new FileSystem()).toThrowError('This class cannot be instantiated');
		});
	});

  describe('readDirectory', () => {
		it('should respect the recursive option', async () => {
			const nestedDirectory = join(notEmptyDirectory, 'nested');
			const nestedFile = join(nestedDirectory, 'nested.txt');
			vol.mkdirSync(nestedDirectory);
			vol.writeFileSync(nestedFile, 'nested');

			const directResult = await FileSystem.readDirectory(mockDirectory, { recursive: false });
			const recursiveResult = await FileSystem.readDirectory(mockDirectory, { recursive: true });

			expect(directResult.directories).toContain(notEmptyDirectory);
			expect(directResult.directories).not.toContain(nestedDirectory);
			expect(directResult.files).not.toContain(nestedFile);
			expect(recursiveResult.directories).toContain(nestedDirectory);
			expect(recursiveResult.files).toContain(nestedFile);
		});

    it('should read an empty directory', async () => {
      const result = await FileSystem.readDirectory(emptyDirectory);

      expect(result).toEqual(new FileSystemEntries());
    });

    it('should read a directory with files', async () => {
      const result = await FileSystem.readDirectory(notEmptyDirectory);
			const expected = new FileSystemEntries().addFile(notEmptyFile);

      expect(result).toEqual(expected);
    });

    it('should read a directory with subdirectories', async () => {
      const result = await FileSystem.readDirectory(mockDirectory);
			const expected = new FileSystemEntries()
				.addDirectory(emptyDirectory)
				.addDirectory(notEmptyDirectory)
				.addFile(emptyFile)
				.addFile(notEmptyFile);

      // Sort for deterministic comparison across platforms
      result.files.sort();
      result.directories.sort();
      expected.files.sort();
      expected.directories.sort();

      expect(result).toEqual(expected);
    });

    it('should respect ignore function', async () => {
      const result = await FileSystem.readDirectory(notEmptyDirectory, { ignore: (path) => path.includes('not-empty.txt') });
      expect(result).toEqual(new FileSystemEntries());
    });

		it('should prune ignored directories before reading descendants', async () => {
			const ignoredDirectory = join(mockDirectory, 'node_modules');
			const ignoredChild = join(ignoredDirectory, 'visible-looking-child');
			const ignoredFile = join(ignoredChild, 'child.txt');
			vol.mkdirSync(ignoredChild, { recursive: true });
			vol.writeFileSync(ignoredFile, 'ignored');

			const fsPromises = await import('node:fs/promises');
			const readdirSpy = vi.spyOn(fsPromises, 'readdir');
			const result = await FileSystem.readDirectory(mockDirectory, {
				ignore: (path) => path.endsWith(`${sep}node_modules`),
			});

			expect(result.directories).not.toContain(ignoredDirectory);
			expect(result.directories).not.toContain(ignoredChild);
			expect(result.files).not.toContain(ignoredFile);
			expect(readdirSpy.mock.calls.map(([path]) => path)).not.toContain(ignoredDirectory);
		});

		it('should respect signal', async () => {
			const abortController = new AbortController();
			abortController.abort();
			const signal = abortController.signal;
			const fsPromises = await import('node:fs/promises');
			const readdirSpy = vi.spyOn(fsPromises, 'readdir');
			const result = await FileSystem.readDirectory(mockDirectory, { signal });
			expect(result).toEqual(new FileSystemEntries());
			expect(readdirSpy).not.toHaveBeenCalled();
		});

		it('should bound manual traversal reads globally', async () => {
			const branchingRoot = join(mockDirectory, 'branching');
			for (let index = 0; index < 20; index++) {
				vol.mkdirSync(join(branchingRoot, `branch-${index}`), { recursive: true });
			}

			const fsPromises = await import('node:fs/promises');
			const originalReaddir = fsPromises.readdir.bind(fsPromises);
			let activeReads = 0;
			let maximumActiveReads = 0;
			const readdirSpy = vi.spyOn(fsPromises, 'readdir').mockImplementation(async (path, options) => {
				if (typeof options === 'object' && options !== null && 'recursive' in options) {
					throw Object.assign(new Error('recursive reads unsupported'), { code: 'ERR_INVALID_ARG_VALUE' });
				}

				activeReads++;
				maximumActiveReads = Math.max(maximumActiveReads, activeReads);
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
				const result = await originalReaddir(path as string, options as { withFileTypes?: boolean });
				activeReads--;

				return result;
			});

			await FileSystem.readDirectory(branchingRoot, { ignore: () => false });

			expect(readdirSpy).toHaveBeenCalled();
			expect(maximumActiveReads).toBeLessThanOrEqual(8);
		});

		it('should correctly read the root directory', async () => {
			vol.reset();
			vol.writeFileSync('/file.txt', 'content');
			const result = await FileSystem.readDirectory(sep);
			const expectedPath = sep + 'file.txt';
			const expected = new FileSystemEntries().addFile(expectedPath);
			expect(result).toEqual(expected);
		});

		it('should attempt native recursive directory reads', async () => {
			const fsPromises = await import('node:fs/promises');
			const readdirSpy = vi.spyOn(fsPromises, 'readdir');

			await FileSystem.readDirectory(mockDirectory);

			expect(readdirSpy).toHaveBeenCalledWith(mockDirectory, expect.objectContaining({
				recursive: true,
				withFileTypes: true,
			}));
		});

		it('should fall back to manual traversal when recursive reads are unsupported', async () => {
			const fsPromises = await import('node:fs/promises');
			const originalReaddir = fsPromises.readdir.bind(fsPromises);
			const readdirSpy = vi.spyOn(fsPromises, 'readdir').mockImplementation((path, options) => {
				if (typeof options === 'object' && options !== null && 'recursive' in options) {
					const unsupportedError = Object.assign(new Error('recursive reads unsupported'), {
						code: 'ERR_INVALID_ARG_VALUE',
					});

					return Promise.reject(unsupportedError);
				}

				return originalReaddir(path as string, options as { withFileTypes?: boolean });
			});

			const result = await FileSystem.readDirectory(mockDirectory);
			const expected = new FileSystemEntries()
				.addDirectory(emptyDirectory)
				.addDirectory(notEmptyDirectory)
				.addFile(emptyFile)
				.addFile(notEmptyFile);

			result.files.sort();
			result.directories.sort();
			expected.files.sort();
			expected.directories.sort();

			expect(result).toEqual(expected);
			expect(readdirSpy).toHaveBeenCalledWith(mockDirectory, expect.objectContaining({
				recursive: true,
				withFileTypes: true,
			}));
		});

		it('should not add Windows drive prefixes to recursive parent paths', async () => {
			const fsPromises = await import('node:fs/promises');
			const windowsRootPath = 'D:\\a\\watchr\\watchr\\tests\\mocked-fs';
			const windowsParentPath = '\\a\\watchr\\watchr\\tests\\mocked-fs\\not-empty';

			const readdirSpy = vi.spyOn(fsPromises, 'readdir').mockImplementation(async (_path, options) => {
				if (typeof options === 'object' && options !== null && 'recursive' in options) {
					return [ {
						name: 'not-empty.txt',
						parentPath: windowsParentPath,
						isDirectory: () => false,
						isFile: () => true,
					} ] as never;
				}

				return [] as never;
			});

			const result = await FileSystem.readDirectory(windowsRootPath);

			expect(result.files[0]).not.toContain('D:');
			expect(readdirSpy).toHaveBeenCalledWith(windowsRootPath, expect.objectContaining({
				recursive: true,
				withFileTypes: true,
			}));
		});
  });

	describe('getStats', () => {
		it('should successfully getStats from a file', async () => {
			const result = await FileSystem.getStats(emptyFile);
			expect(result).toBeDefined();
			expect(result?.isFile()).toBe(true);
		});

		it('should release the retry queue lease after a successful stat', async () => {
			await FileSystem.getStats(emptyFile);

			const retryQueue = FileSystem['retryQueue'];
			expect(retryQueue['activeQueue'].size).toBe(0);
			expect(retryQueue['pendingQueue'].size).toBe(0);
		});

		it('should release the lease when aborted immediately after admission', async () => {
			const abortController = new AbortController();
			const retryQueue = FileSystem['retryQueue'];
			const schedule = retryQueue.schedule.bind(retryQueue);
			vi.spyOn(retryQueue, 'schedule').mockImplementation((signal) => {
				const admission = schedule(signal);
				abortController.abort();
				return admission;
			});
			const statSpy = vi.spyOn(vol.promises, 'stat');

			await expect(FileSystem.getStats(emptyFile, abortController.signal)).rejects.toMatchObject({ name: 'AbortError' });
			expect(statSpy).not.toHaveBeenCalled();
			expect(retryQueue['activeQueue'].size).toBe(0);
		});

		it.each([ 'abort', 'timeout' ])('should release an in-flight stat lease after %s cancellation', async (cancellation) => {
			vi.useFakeTimers();
			const deferredStat = Promise.withResolvers<never>();

			try {
				const abortController = new AbortController();
				const retryQueue = FileSystem['retryQueue'];
				const statSpy = vi.spyOn(vol.promises, 'stat').mockReturnValue(deferredStat.promise);
				const result = expect(FileSystem.getStats(emptyFile, abortController.signal)).rejects.toThrow(
					cancellation === 'abort' ? 'operation was aborted' : 'Stat operation timed out'
				);
				await vi.advanceTimersByTimeAsync(0);
				expect(statSpy).toHaveBeenCalledTimes(1);
				expect(retryQueue['activeQueue'].size).toBe(1);

				if (cancellation === 'abort') { abortController.abort(); }
				await vi.advanceTimersByTimeAsync(251);
				await result;
				expect(retryQueue['activeQueue'].size).toBe(0);

				deferredStat.reject(Object.assign(new Error('busy'), { code: 'EBUSY' }));
				await vi.advanceTimersByTimeAsync(0);
				expect(retryQueue['activeQueue'].size).toBe(0);
				expect(statSpy).toHaveBeenCalledTimes(1);
			} finally {
				deferredStat.reject(new Error('test cleanup'));
				vi.useRealTimers();
			}
		});

		it('should release the stat lease before retry backoff', async () => {
			vi.useFakeTimers();
			try {
				const originalStat = vol.promises.stat.bind(vol.promises);
				const retryQueue = FileSystem['retryQueue'];
				vi.spyOn(Math, 'random').mockReturnValue(0.99);
				const statSpy = vi.spyOn(vol.promises, 'stat')
					.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))
					.mockImplementation(async (path, options) => {
						expect(retryQueue['activeQueue'].size).toBe(1);
						return originalStat(path as string, options);
					});
				const result = FileSystem.getStats(emptyFile);
				await vi.advanceTimersByTimeAsync(0);
				expect(statSpy).toHaveBeenCalledTimes(1);
				expect(retryQueue['activeQueue'].size).toBe(0);
				await vi.advanceTimersByTimeAsync(100);
				await expect(result).resolves.toBeDefined();
				expect(statSpy).toHaveBeenCalledTimes(2);
				expect(retryQueue['activeQueue'].size).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		});

		it('should retry on specific error codes', async () => {
			const originalStat = vol.promises.stat.bind(vol.promises);
			const statSpy = vi.spyOn(vol.promises, 'stat');
			const retryableError = Object.assign(new Error('busy'), { code: 'EBUSY' as const });

			statSpy
				.mockRejectedValueOnce(retryableError)
				.mockImplementation(async (path, options) => originalStat(path as string, options));

			const result = await FileSystem.getStats(emptyFile);

			expect(result).toBeDefined();
			expect(typeof result?.isFile).toBe('function');
			expect(result?.isFile()).toBe(true);
			expect(statSpy.mock.calls.length).toBeGreaterThan(1);
		});

		it('should stop retrying after max retry attempts for retryable errors', async () => {
			const retryableError = Object.assign(new Error('too many open files'), { code: 'EMFILE' as const });
			const statSpy = vi.spyOn(vol.promises, 'stat').mockRejectedValue(retryableError);
			vi.spyOn(Math, 'random').mockReturnValue(0);

			await expect(FileSystem.getStats('any-path')).rejects.toThrow('too many open files');

			expect(statSpy).toHaveBeenCalled();
			expect(statSpy.mock.calls.length).toBeLessThanOrEqual(11);
			expect(statSpy.mock.calls.length).toBeGreaterThan(1);
		});

		it('should return undefined for non-existent file', async () => {
			const result = await FileSystem.getStats('./tests/mocked/non-existent.txt');
			expect(result).toBeUndefined();
		});

		it('should reject non-retryable errors instead of reporting absence', async () => {
			const statSpy = vi.spyOn(vol.promises, 'stat').mockRejectedValueOnce(new Error('boom'));
			await expect(FileSystem.getStats('any-path')).rejects.toThrow('boom');
			expect(statSpy).toHaveBeenCalledTimes(1);
		});

		it('should release the retry queue lease after a non-retryable stat error', async () => {
			vi.spyOn(vol.promises, 'stat').mockRejectedValueOnce(new Error('boom'));

			await expect(FileSystem.getStats('any-path')).rejects.toThrow('boom');

			const retryQueue = FileSystem['retryQueue'];
			expect(retryQueue['activeQueue'].size).toBe(0);
			expect(retryQueue['pendingQueue'].size).toBe(0);
		});

		it('should treat ENOTDIR as confirmed absence', async () => {
			vi.spyOn(vol.promises, 'stat').mockRejectedValueOnce(Object.assign(new Error('not a directory'), { code: 'ENOTDIR' }));

			expect(await FileSystem.getStats('any-path')).toBeUndefined();
		});

		it('should reject when the stat operation times out', async () => {
			vi.useFakeTimers();
			vi.spyOn(vol.promises, 'stat').mockImplementation(() => new Promise(() => {}));

			const result = expect(FileSystem.getStats('any-path')).rejects.toThrow('Stat operation timed out');
			await vi.advanceTimersByTimeAsync(251);

			await result;
			vi.useRealTimers();
		});

		it('should release the lease when cancellation wins an in-flight stat', async () => {
			vi.useFakeTimers();
			try {
				const abortController = new AbortController();
				const retryQueue = FileSystem['retryQueue'];
				const statSpy = vi.spyOn(vol.promises, 'stat').mockImplementation(() => new Promise(() => {}));

				const result = expect(FileSystem.getStats(emptyFile, abortController.signal)).rejects.toMatchObject({ name: 'AbortError' });
				await vi.advanceTimersByTimeAsync(0);
				expect(statSpy).toHaveBeenCalledWith(emptyFile, { bigint: true });
				expect(retryQueue['activeQueue'].size).toBe(1);

				abortController.abort();
				await result;
				expect(retryQueue['activeQueue'].size).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		});

		it('should reject cancellation distinctly from timeout', async () => {
			const abortController = new AbortController();
			abortController.abort();

			await expect(FileSystem.getStats('any-path', abortController.signal)).rejects.toMatchObject({ name: 'AbortError' });
		});

		it('should not retry stats after cancellation during retry backoff', async () => {
			vi.useFakeTimers();

			try {
				const abortController = new AbortController();
				const retryableError = Object.assign(new Error('busy'), { code: 'EBUSY' as const });
				const statSpy = vi.spyOn(vol.promises, 'stat').mockRejectedValue(retryableError);
				vi.spyOn(Math, 'random').mockReturnValue(0.99);

				const result = FileSystem.getStats('any-path', abortController.signal);

				await vi.waitFor(() => expect(statSpy).toHaveBeenCalledTimes(1));
				abortController.abort();

				await expect(result).rejects.toMatchObject({ name: 'AbortError' });
				await vi.advanceTimersByTimeAsync(1_000);

				expect(statSpy).toHaveBeenCalledTimes(1);
			} finally {
				vi.useRealTimers();
			}
		});
	});

  describe('isSubPath', () => {
    it('should return true for valid subpath', () => {
      const result = FileSystem.isSubPath('/parent', '/parent/child');
      expect(result).toBe(true);
    });

    it('should return false for invalid subpath', () => {
      const result = FileSystem.isSubPath('/parent', '/other/child');
      expect(result).toBe(false);
    });

		it('should return true for direct sub-paths', () => {
			expect(FileSystem.isSubPath(join(sep, 'a'), join(sep, 'a', 'b'))).toBe(true);
		});

		it('should return false for the same path', () => {
			expect(FileSystem.isSubPath('/a/b', '/a/b')).toBe(false);
		});

    it('should handle paths with trailing separators', () => {
      const result1 = FileSystem.isSubPath('/parent/', '/parent/child');
      const result2 = FileSystem.isSubPath('/parent', '/parent/child/');
      expect(result1).toBe(true);
      expect(result2).toBe(true);
    });

    it('should handle paths that share a prefix but are not subpaths', () => {
      const result = FileSystem.isSubPath('/parent', '/parentother/child');
      expect(result).toBe(false);
    });

    it('should handle relative paths correctly', () => {
      const result1 = FileSystem.isSubPath('./parent', './parent/child');
      const result2 = FileSystem.isSubPath('../parent', '../parent/child');
      expect(result1).toBe(true);
      expect(result2).toBe(true);
    });

    it('should handle deep nested paths', () => {
      const result = FileSystem.isSubPath('/a/b/c', '/a/b/c/d/e/f');
      expect(result).toBe(true);
    });

    it('should return false for empty paths', () => {
      const result1 = FileSystem.isSubPath('', '/child');
      const result2 = FileSystem.isSubPath('/parent', '');
      expect(result1).toBe(false);
      expect(result2).toBe(false);
    });
  });
});

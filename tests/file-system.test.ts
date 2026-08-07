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

		it('should respect signal', async () => {
			const abortController = new AbortController();
			abortController.abort();
			const signal = abortController.signal;
			const result = await FileSystem.readDirectory(mockDirectory, { signal });
			expect(result).toEqual(new FileSystemEntries());
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

			const result = await FileSystem.getStats('any-path');

			expect(result).toBeUndefined();
			expect(statSpy).toHaveBeenCalled();
			expect(statSpy.mock.calls.length).toBeLessThanOrEqual(11);
			expect(statSpy.mock.calls.length).toBeGreaterThan(1);
		});

		it('should return undefined for non-existent file', async () => {
			const result = await FileSystem.getStats('./tests/mocked/non-existent.txt');
			expect(result).toBeUndefined();
		});

		it('should return undefined for non-retryable errors', async () => {
			const statSpy = vi.spyOn(vol.promises, 'stat').mockRejectedValueOnce(new Error('boom'));
			const result = await FileSystem.getStats('any-path');
			expect(result).toBeUndefined();
			expect(statSpy).toHaveBeenCalledTimes(1);
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
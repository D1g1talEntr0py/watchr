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
			const expected = new FileSystemEntries().addFile('/file.txt');
			expect(result).toEqual(expected);
		});
  });

	describe('getStats', () => {
		it('should successfully getStats from a file', async () => {
			const result = await FileSystem.getStats(emptyFile);
			expect(result).toBeDefined();
			expect(result?.isFile()).toBe(true);
		});

		it('should retry on specific error codes', async () => {
        // Rename the file temporarily using memfs
        const tempRenamedFilePath = join(mockDirectory, 'temp-renamed-file.txt');
        vol.renameSync(emptyFile, tempRenamedFilePath);

        // Poll the file, expecting retries to occur
        const pollPromise = FileSystem.getStats(emptyFile);

        // Restore the original file name after a short delay
        setTimeout(() => {
					vol.renameSync(tempRenamedFilePath, emptyFile);
        }, 100); // Adjust the delay as needed

        const result = await pollPromise;

        // Expect the result to be valid stats after retries
        expect(result).toBeDefined();
        expect(typeof result?.isFile).toBe('function');
        expect(result?.isFile()).toBe(true);
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
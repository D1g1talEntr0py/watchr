import { describe, it, expect, beforeEach } from 'vitest';
import { FileSystemEntries } from '../src/file-system-entries';

describe('FileSystemEntries', () => {
	let entries: FileSystemEntries;

	beforeEach(() => {
		entries = new FileSystemEntries();
	});

	describe('constructor', () => {
		it('should initialize with empty directories and files', () => {
			expect(entries.directories).toEqual([]);
			expect(entries.files).toEqual([]);
		});
	});

	describe('addDirectory', () => {
		it('should add a directory to the list', () => {
			entries.addDirectory('/path/to/dir');
			expect(entries.directories).toEqual(['/path/to/dir']);
		});

		it('should allow chaining', () => {
			entries.addDirectory('/dir1').addDirectory('/dir2');
			expect(entries.directories).toEqual(['/dir1', '/dir2']);
		});
	});

	describe('addFile', () => {
		it('should add a file to the list', () => {
			entries.addFile('/path/to/file.txt');
			expect(entries.files).toEqual(['/path/to/file.txt']);
		});

		it('should allow chaining', () => {
			entries.addFile('file1.txt').addFile('file2.txt');
			expect(entries.files).toEqual(['file1.txt', 'file2.txt']);
		});
	});

	describe('directories', () => {
		it('should return the list of added directories', () => {
			entries.addDirectory('/dir1');
			entries.addDirectory('/dir2');
			expect(entries.directories).toEqual(['/dir1', '/dir2']);
		});
	});

	describe('files', () => {
		it('should return the list of added files', () => {
			entries.addFile('file1.txt');
			entries.addFile('file2.txt');
			expect(entries.files).toEqual(['file1.txt', 'file2.txt']);
		});
	});

	describe('reset', () => {
		it('should clear both directories and files lists', () => {
			entries.addDirectory('/dir1');
			entries.addFile('file1.txt');

			entries.reset();

			expect(entries.directories).toEqual([]);
			expect(entries.files).toEqual([]);
		});

		it('should return the instance for chaining', () => {
			const result = entries.reset();
			expect(result).toBe(entries);
		});
	});
});
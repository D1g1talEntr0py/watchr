/**
 * Represents a collection of file system entries.
 */
export class FileSystemEntries {
	/** The directories in the file system. */
	private readonly _directories: string[];
	/** The files in the file system. */
	private readonly _files: string[];

	constructor() {
		this._directories = [];
		this._files = [];
	}

	/**
	 * Adds a directory to the file system.
	 * @param directory - The directory to add.
	 * @returns The file system entries.
	 */
	addDirectory(directory: string): FileSystemEntries {
		this._directories.push(directory);

		return this;
	}

	/**
	 * Adds a file to the file system.
	 * @param file - The file to add.
	 * @returns The file system entries.
	 */
	addFile(file: string): FileSystemEntries {
		this._files.push(file);

		return this;
	}

	/**
	 * Gets the directories in the file system.
	 * @returns The directories in the file system.
	 */
	get directories(): string[] {
		return this._directories;
	}

	/**
	 * Gets the files in the file system.
	 * @returns The files in the file system.
	 */
	get files(): string[] {
		return this._files;
	}

	/**
	 * Resets the file system entries.
	 * @returns The file system entries.
	 */
	reset(): FileSystemEntries {
		this._directories.length = 0;
		this._files.length = 0;

		return this;
	}
}
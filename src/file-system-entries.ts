/**
 * Represents a collection of file system entries.
 * @internal
 */
export class FileSystemEntries {
	/** The directories in the file system. */
	readonly #directories: string[];
	/** The files in the file system. */
	readonly #files: string[];
	/** Entries (already present in `directories` or `files`) that were discovered as symbolic links. */
	readonly #symlinks: Set<string>;

	constructor() {
		this.#directories = [];
		this.#files = [];
		this.#symlinks = new Set();
	}

	/**
	 * Adds a directory to the file system.
	 * @param directory - The directory to add.
	 * @returns The file system entries.
	 */
	addDirectory(directory: string): this {
		this.#directories.push(directory);

		return this;
	}

	/**
	 * Adds a file to the file system.
	 * @param file - The file to add.
	 * @returns The file system entries.
	 */
	addFile(file: string): this {
		this.#files.push(file);

		return this;
	}

	/**
	 * Marks an already-added directory or file as a symbolic link.
	 * @param symlink - The symlink path.
	 * @returns The file system entries.
	 */
	addSymlink(symlink: string): this {
		this.#symlinks.add(symlink);

		return this;
	}

	/**
	 * Gets the directories in the file system.
	 * @returns The directories in the file system.
	 */
	get directories(): string[] {
		return this.#directories;
	}

	/**
	 * Gets the files in the file system.
	 * @returns The files in the file system.
	 */
	get files(): string[] {
		return this.#files;
	}

	/**
	 * Gets the entries that were discovered as symbolic links.
	 * @returns The symlink paths.
	 */
	get symlinks(): Set<string> {
		return this.#symlinks;
	}

	/**
	 * Resets the file system entries.
	 * @returns The file system entries.
	 */
	reset(): this {
		this.#directories.length = 0;
		this.#files.length = 0;
		this.#symlinks.clear();

		return this;
	}
}

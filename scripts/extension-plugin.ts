import { readFile } from 'node:fs/promises';
import type { Plugin, OnLoadArgs, OnLoadResult } from 'esbuild';

// Regular expression to match import statements without .js extension
const jsExtension = /((?:from|import)\s+['"])((\.\.?\/)(?:(?!\.js).)+)(['"])/g;

/**
 * esbuild plugin that adds .js extensions to relative imports in TypeScript files.
 * Transforms import statements during the load phase to ensure ESM compatibility.
 */
export const addJsExtensionPlugin: Plugin = {
	name: 'add-js-ext',
	/**
	 * Intercepts the loading of TypeScript files and modifies their contents by adding .js extensions to relative imports.
	 * Uses a regular expression to find import statements and appends .js to the module paths.
	 * This ensures that the resulting JavaScript files have correct import paths for ESM.
	 * @param build - The esbuild build context, used to register the onLoad callback.
	 */
	setup(build) {
		build.onLoad({ filter: /\.tsx?$/ }, async ({ path }: OnLoadArgs): Promise<OnLoadResult> => {
			const contents = (await readFile(path, 'utf8')).replace(jsExtension, '$1$2.js$4');

			return { contents, loader: 'ts' };
		});
	}
};
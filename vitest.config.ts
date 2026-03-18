import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import babel from '@rolldown/plugin-babel';

function decoratorPreset(options: Record<string, unknown>) {
  return {
    preset: () => ({
      plugins: [[ '@babel/plugin-proposal-decorators', options ]],
    }),
    rolldown: {
      // Only run this transform if the file contains a decorator.
      filter: { code: '@' }
    }
  }
}

export default defineConfig({
	plugins: [ babel({ presets: [ decoratorPreset({ version: '2023-11' }) ] }) ],
	resolve: {
		alias: [ { find: '@/', replacement: fileURLToPath(new URL('./', import.meta.url)) } ]
	},
	test: {
		environment: 'node',
		globals: false,
		pool: 'vmForks',
		testTimeout: 10000,
		typecheck: { enabled: false },
    coverage: {
      reporter: [ 'text', 'json' ],
			reportsDirectory: 'tests/coverage',
      include: [ 'src/**/*.ts' ],
			exclude: [ 'src/index.ts', 'src/@types' ]
    }
	}
});
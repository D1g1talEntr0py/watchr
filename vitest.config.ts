import { defineConfig, type Plugin } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';
import { transform, type TransformResult } from 'esbuild';

// Custom esbuild plugin to handle TypeScript decorators in Vitest since the default transformer (OXC) does not support them.
function esbuildDecorators(): Plugin {
  return {
    name: 'esbuild-decorators',
    enforce: 'pre',
    async transform(code, id): Promise<TransformResult | undefined> {
      if (!id.endsWith('.ts') || !code.includes('@')) { return }

      ({ code } = await transform(code, { loader: 'ts', target: 'es2024', sourcefile: id }));

      return { code, map: '', warnings: [], mangleCache: {}, legalComments: 'none' };
    }
  };
}

export default defineConfig({
	plugins: [ esbuildDecorators() ],
	resolve: {
		alias: [ { find: '@/', replacement: fileURLToPath(new URL('./', import.meta.url)) } ]
	},
	test: {
		environment: 'node',
		globals: false,
		pool: 'threads',
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
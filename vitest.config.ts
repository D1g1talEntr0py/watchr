import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
	resolve: {
		alias: [ { find: '@/', replacement: fileURLToPath(new URL('./', import.meta.url)) } ]
	},
	test: {
		environment: 'node',
		globals: false,
		// `forks` (child processes) accept V8 flags; worker threads reject --expose-gc with ERR_WORKER_INVALID_EXEC_ARGV.
		pool: 'forks',
		execArgv: [ '--expose-gc' ],
		fsModuleCache: true,
		testTimeout: 10000,
		typecheck: { enabled: true, include: [ 'tests/**/*.test-d.ts' ], tsconfig: './tests/tsconfig.json' },
    coverage: {
      reporter: [ 'text', 'json' ],
			reportsDirectory: 'tests/coverage',
      include: [ 'src/**/*.ts' ],
			exclude: [ 'src/index.ts', 'src/@types', 'tests/**' ],
			thresholds: { lines: 85, branches: 70, functions: 80, statements: 85 }
		}
	}
});

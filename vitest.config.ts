import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		testTimeout: 10000,
		typecheck: { enabled: false },
		coverage: { reporter: [ 'lcov', 'text' ], reportsDirectory: 'tests/coverage', include: [ 'src' ], exclude: [ 'src/constants.ts', 'src/@types' ] },
		outputFile: 'coverage/sonar-report.xml'
	},
	resolve: {
		alias: [ { find: '@/', replacement: fileURLToPath(new URL('./', import.meta.url)) } ]
	}
});
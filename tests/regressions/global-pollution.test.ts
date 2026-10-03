import { describe, expect, it } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const distEntry = resolve(projectRoot, 'dist', 'watchr.js');

describe('regression B5: importing the library must not install a global Temporal', { timeout: 60_000 }, () => {
	it('should not modify globalThis.Temporal after import', () => {
		if (!existsSync(distEntry)) {
			execSync('pnpm build', { cwd: projectRoot, stdio: 'ignore' });
		}

		expect(existsSync(distEntry), `${distEntry} missing after build`).toBe(true);

		const script = `const temporalBeforeImport = globalThis.Temporal; import(${JSON.stringify(distEntry)}).then(() => process.exit(globalThis.Temporal === temporalBeforeImport ? 0 : 1))`;
		let exitCode = 0;

		try {
			execFileSync(process.execPath, [ '-e', script ], { stdio: 'ignore' });
		} catch (error) {
			exitCode = error !== null && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : -1;
		}

		expect(exitCode, 'globalThis.Temporal was defined after importing dist/watchr.js').toBe(0);
	});
});

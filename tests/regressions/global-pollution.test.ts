import { describe, expect, it } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const distEntry = resolve(projectRoot, 'dist', 'watchr.js');

describe('regression B5: importing the library must not install a global Temporal', { timeout: 60_000 }, () => {
	it('should not modify globalThis.Temporal after import', () => {
		if (!existsSync(distEntry)) {
			execSync('pnpm build', { cwd: projectRoot, stdio: 'ignore' });
		}

		expect(existsSync(distEntry), `${distEntry} missing after build`).toBe(true);

		const script = `const temporalBeforeImport = globalThis.Temporal; await import(${JSON.stringify(pathToFileURL(distEntry).href)}); if (globalThis.Temporal !== temporalBeforeImport) throw new Error('Import modified globalThis.Temporal');`;
		const result = spawnSync(process.execPath, [ '--input-type=module', '-e', script ], { encoding: 'utf8', timeout: 30_000 });

		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr || 'Import must preserve globalThis.Temporal').toBe(0);
	});
});

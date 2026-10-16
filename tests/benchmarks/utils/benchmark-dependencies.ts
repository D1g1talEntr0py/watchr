import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageSpecs = {
	'@parcel/watcher': '@parcel/watcher@2.6.0',
	chokidar: 'chokidar@5.0.0',
	mitata: 'mitata@1.0.34'
} as const;

export type BenchmarkDependencyName = keyof typeof packageSpecs;

export type InstalledBenchmarkDependency = {
	load: () => Promise<unknown>;
	version: string;
};

/**
 * Installs one benchmark-only dependency outside the project and returns a loader for it.
 * @param name - The benchmark dependency to install.
 * @returns The installed package loader and version.
 */
export const installBenchmarkDependency = async (
	name: BenchmarkDependencyName
): Promise<InstalledBenchmarkDependency> => {
	const installRoot = mkdtempSync(join(tmpdir(), 'watchr-benchmark-deps-'));
	const manifestPath = join(installRoot, 'package.json');
	writeFileSync(manifestPath, JSON.stringify({ name: 'watchr-benchmark-dependencies', private: true }));

	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [ 'add', '--ignore-scripts', '--save-exact', packageSpecs[name] ], {
				cwd: installRoot,
				env: { ...process.env, npm_config_verify_deps_before_run: 'false' },
				stdio: 'inherit',
				shell: process.platform === 'win32'
			});

			child.on('error', reject);
			child.on('exit', (exitCode, signal) => {
				if (exitCode === 0) {
					resolve();
					return;
				}

				reject(new Error(`Could not install ${name} (${signal ?? `exit ${exitCode}`})`));
			});
		});
	} catch (error) {
		rmSync(installRoot, { recursive: true, force: true });
		throw error;
	}

	const packageRequire = createRequire(manifestPath);
	const packageManifest = JSON.parse(readFileSync(join(installRoot, 'node_modules', name, 'package.json'), 'utf8')) as { version: string };
	let cleaned = false;
	const cleanup = () => {
		if (cleaned) { return }

		cleaned = true;
		rmSync(installRoot, { recursive: true, force: true });
	};

	process.once('exit', cleanup);

	return {
		load: () => import(pathToFileURL(packageRequire.resolve(name)).href),
		version: packageManifest.version
	};
};

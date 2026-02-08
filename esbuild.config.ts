import * as esbuild from 'esbuild';
import ts from 'typescript';
import { addJsExtensionPlugin } from './build/extension-plugin.ts';
import { access, constants, readdir, rm } from 'fs/promises';
import { join } from 'path';

const outdir = 'dist';

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch (error) {
		// File does not exist - check for any error with ENOENT code
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return false }
		// Other errors (e.g., permissions issues)
		throw error;
	}
}

// Clean output directory before build
if (await exists(outdir)) {
	await Promise.all((await readdir(outdir)).map((file) => rm(join(outdir, file), { recursive: true, force: true })));
}

// Generate declaration files using TypeScript API
const configPath: string = ts.findConfigFile('./', ts.sys.fileExists, 'tsconfig.json') ?? 'tsconfig.json';
const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
const { options, fileNames } = ts.parseJsonConfigFileContent(config, ts.sys, './');
const program: ts.Program = ts.createProgram(fileNames, { ...options, emitDeclarationOnly: true, incremental: false });

// Collect all diagnostics
const allDiagnostics = [
	...ts.getPreEmitDiagnostics(program),
	...program.emit().diagnostics,
];

// Display diagnostics if any exist
if (allDiagnostics.length > 0) {
	const formatHost: ts.FormatDiagnosticsHost = {
		getCanonicalFileName: (path) => path,
		getCurrentDirectory: ts.sys.getCurrentDirectory,
		getNewLine: () => ts.sys.newLine,
	};

	const formattedDiagnostics = ts.formatDiagnosticsWithColorAndContext(allDiagnostics, formatHost);
	console.error(formattedDiagnostics);

	const errorCount = allDiagnostics.filter(d => d.category === ts.DiagnosticCategory.Error).length;
	if (errorCount > 0) {
		process.exit(1);
	}
}

await esbuild.build({
	entryPoints: ['src/**/*.ts'],
	outdir: 'dist',
	format: 'esm',
	target: 'esnext',
	bundle: false,
	outbase: 'src',
	tsconfigRaw: {
		compilerOptions: {
			experimentalDecorators: true,
			emitDecoratorMetadata: false,
		}
	},
	plugins: [addJsExtensionPlugin],
});

console.log('⚡ Build complete.');

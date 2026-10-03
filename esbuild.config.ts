/// <reference types="node" />
// Usage: node esbuild.config.ts [--minify]
// Emits dist/watchr.js (+ .js.map) as the only runtime artifact and dist/**/*.d.ts via the TypeScript Program API.

import * as esbuild from 'esbuild';
import ts from 'typescript';
import { join } from 'node:path';
import { access, constants, readdir, readFile, rm } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values: { minify } } = parseArgs({ options: { minify: { type: 'boolean', default: false } } });
const { name, version, license, author } = JSON.parse(await readFile('package.json', 'utf8')) as Record<string, string>;
const outdir = 'dist';
const fileExtensionPattern = /\.[a-z\d]+$/i;

async function exists(filePath: string) {
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
const addDeclarationExtensions: ts.TransformerFactory<ts.Bundle | ts.SourceFile> = (context) => {
	const visit: ts.Visitor = (node) => {
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			const modulePath = node.moduleSpecifier.text;

			if (/^\.\.?\//.test(modulePath) && !fileExtensionPattern.test(modulePath)) {
				const moduleSpecifier = ts.factory.createStringLiteral(`${modulePath}.js`);

				if (ts.isImportDeclaration(node)) {
					return ts.factory.updateImportDeclaration(node, node.modifiers, node.importClause, moduleSpecifier, node.attributes);
				}

				return ts.factory.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, node.exportClause, moduleSpecifier, node.attributes);
			}
		}

		return ts.visitEachChild(node, visit, context);
	};
	const transformSourceFile = (sourceFile: ts.SourceFile): ts.SourceFile => ts.visitNode(sourceFile, visit) as ts.SourceFile;

	return (node) => ts.isBundle(node) ? ts.factory.updateBundle(node, node.sourceFiles.map(transformSourceFile)) : transformSourceFile(node);
};
const emitResult = program.emit(undefined, (fileName, text, writeByteOrderMark) => {
	const output = text.includes('Temporal.') ? `/// <reference lib="esnext.temporal" />${ts.sys.newLine}${text}` : text;

	ts.sys.writeFile(fileName, output, writeByteOrderMark);
}, undefined, true, { afterDeclarations: [addDeclarationExtensions] });

// Collect all diagnostics
const allDiagnostics = [ ...ts.getPreEmitDiagnostics(program), ...emitResult.diagnostics ];

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
	entryPoints: [ 'src/watchr.ts' ],
	outdir,
	outbase: 'src',
	format: 'esm',
	platform: 'node',
	target: 'esnext',
	bundle: true,
	minify,
	sourcemap: true,
	// `/*!` marks the banner as a legal comment so esbuild keeps it when minifying.
	banner: { js: `/*! ${name} v${version} | ${license} License | (c) ${author} */` },
	legalComments: 'inline',
	external: [ 'temporal-polyfill-lite' ],
	supported: { decorators: false }
});

console.log(`⚡ Build complete${minify ? ' (minified)' : ''}.`);

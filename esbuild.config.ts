/// <reference types="node" />

import * as esbuild from 'esbuild';
import ts from 'typescript';
import { join } from 'node:path';
import { access, constants, readdir, rm } from 'node:fs/promises';

const outdir = 'dist';

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

			if (/^\.\.?\//.test(modulePath) && !/\.[a-z\d]+$/i.test(modulePath)) {
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
	outdir: 'dist',
	format: 'esm',
	platform: 'node',
	target: 'esnext',
	bundle: true,
	outbase: 'src',
	external: [ 'temporal-polyfill-lite' ],
	supported: { decorators: false }
});

console.log('⚡ Build complete.');
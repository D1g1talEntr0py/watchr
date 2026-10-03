import eslint from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';
import tslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';

export default defineConfig({ ignores: [ 'node_modules/**', 'dist/**', '*.config.ts', 'scripts/**', 'src/@types', 'tests/coverage/**' ] }, {
	extends: [
		eslint.configs.recommended,
		jsdoc.configs['flat/recommended-typescript'],
		...tslint.configs.recommended,
		...tslint.configs.recommendedTypeChecked
	],
	plugins: { '@typescript-eslint': tslint.plugin, jsdoc },
	languageOptions: {
		parser: tslint.parser,
		parserOptions: {
			project: true,
			ecmaFeatures: {	impliedStrict: true	},
			tsconfigRootDir: import.meta.dirname,
			allowAutomaticSingleRunInference: true,
			warnOnUnsupportedTypeScriptVersion: false
		}
	},
	settings: {
		jsdoc: {
			mode: 'typescript',
			structuredTags: {
				template: { name: 'namepath-defining', type: true }
			}
		}
	},
	rules: {
		'jsdoc/require-returns': 0,
		'jsdoc/check-param-names': [ 'error', { checkDestructured: false	}	],
		'jsdoc/require-param': [ 'error',	{ checkDestructured: false } ],
		'jsdoc/tag-lines': 0,
		'jsdoc/no-defaults': 0,
		'jsdoc/require-jsdoc': [ 'error',	{
				exemptEmptyConstructors: true,
				checkConstructors: false,
				require: {
					ClassDeclaration: true,
					FunctionExpression: true,
					MethodDefinition: true
				}
			}
		],
		'comma-dangle': ['error', 'never'],
		indent:  ['error', 'tab', { SwitchCase: 1 } ],
		'linebreak-style': ['error', 'unix'],
		quotes: ['error', 'single'],
		semi: ['error', 'always', {
			omitLastInOneLineBlock: true,
			omitLastInOneLineClassBody: true
		}],
		'@typescript-eslint/unbound-method': 'off',
		'@typescript-eslint/restrict-template-expressions': 'off',
		'@typescript-eslint/no-unsafe-enum-comparison': 'off',
		'@typescript-eslint/no-unused-vars': ['error', {
			args: 'all',
			argsIgnorePattern: '^_',
			caughtErrors: 'all',
			caughtErrorsIgnorePattern: '^_',
			destructuredArrayIgnorePattern: '^_',
			varsIgnorePattern: '^_',
			ignoreRestSiblings: true
		}]
	}
}, {
	files: [ 'tests/**/*.ts' ],
	rules: {
		'jsdoc/require-jsdoc': 'off',
		'@typescript-eslint/no-explicit-any': 'off',
		'@typescript-eslint/no-unsafe-assignment': 'off',
		'@typescript-eslint/no-unsafe-call': 'off',
		'@typescript-eslint/no-unsafe-member-access': 'off',
		'@typescript-eslint/no-unsafe-argument': 'off',
		'@typescript-eslint/no-unsafe-return': 'off',
		'@typescript-eslint/no-floating-promises': 'off',
		'@typescript-eslint/require-await': 'off'
	}
});

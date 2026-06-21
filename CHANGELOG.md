## [1.0.7](https://github.com/D1g1talEntr0py/watchr/compare/v1.0.6...v1.0.7) (2026-06-21)

### Performance Improvements

* **core:** parallelize directory traversal for improved latency (8d0529f2cd43bb090641e27bcd10f3eb401c3517)
- Refactor readDirectory() to batch sibling directory processing with Promise.all()
  instead of sequential await, reducing latency by 2-3x for deep directory structures
- Add comprehensive benchmark suite (11 tests) using vitest bench framework
  measuring initialization, event emission, rename detection, and bulk operations
- Clarify watchPaths TODO: directory-level parallelization implemented,
  path-level approach is intentional design decision for correctness
- Add dev dependencies: chokidar, watcher, mitata for benchmarking

Files: src/file-system.ts, src/watchr.ts, benchmarks/watchr.bench.ts,
       package.json, vitest.config.ts, pnpm-lock.yaml
Tests: All 198 tests pass, no regressions


### Code Refactoring

* **ts:** enforce exact optional property semantics (c0682c71251e77aaad13fa6b924d8ce581524d87)
TypeScript strictness hardening, optional-property handling cleanup, and a regression test for the stricter contract.

* **ts:** tighten type safety and modernize promise helpers (3aa84873d20de8d08d73d874f67ef8a8c4d5e502)
- enable noUncheckedIndexedAccess for stricter indexed access checks
- update debounce to use Promise.withResolvers()
- update timeout decorator to use Promise.withResolvers()
- fix watchPaths bounds to satisfy stricter indexed access typing
- keep behavior unchanged while improving type safety and clarity

## [1.0.6](https://github.com/D1g1talEntr0py/watchr/compare/v1.0.5...v1.0.6) (2026-04-07)

### Bug Fixes

* **deps:** bump vite to patch CVE-2026-39363 (b256b5c88eee8294d1f58a28f0537ad2bf8d91f1)
Bumps vitest and corresponding packages to transitively update vite, addressing the security vulnerability described in CVE-2026-39363. Additionally, updates other local development dependencies to their latest versions.


### Code Refactoring

* enforce isolated declarations and explicit return types (0f1d722274762222299678fbdbc99f27e244cb91)
Enables typescript's isolatedDeclarations compiler option and adds explicit return types across the codebase. Modifies the primary entry points in package.json and removes the intermediary index.ts file.


### Miscellaneous Chores

* update project configuration (8b73b1440aa99e963c9844f1fa80d72e80615f55)
Adds a new editorconfig file to ensure consistent formatting across environments. Updates semantic release rules to properly trigger major version bumps on breaking changes.

## [1.0.5](https://github.com/D1g1talEntr0py/watchr/compare/v1.0.4...v1.0.5) (2026-03-27)

### Bug Fixes

* Resolves compilation issues and improves typings (cb479a28ca7f45410b48a3cf76592cc3f230c2c3)
Refines generic type bindings in the debounce decorator, eliminating the use of 'any' to enhance type safety.

Ignores TypeScript build info files to prevent them from cluttering the repository.


### Code Refactoring

* remove explicit return types and rely on inference (c7002953b5d2fbb8ae7bb6694c32c7e14d137315)
Simplifies the codebase by stripping out explicitly declared return types across source files, relying on TypeScript's type inference. This reduces visual noise and boilerplate without sacrificing type safety.


### Documentation

* update readme with ts version and package managers (a8c1459f66b08028260f52858e22b0f07a9dbcfb)
Updates the TypeScript version badge to reflect support for >= 5.0.4, and adds installation instructions using Yarn as an alternative package manager.


### Miscellaneous Chores

* update vscode workspace settings (dcb3e0bcb472a325f22acf1764f526b7b35a29f0)
Adds a new workspace setting to configure the TypeScript SDK path, ensuring the editor uses the local workspace version of TypeScript.


### Build System

* migrate to typescript 6 and update dependencies (feaae2ce56ce73dd2349b44c1e46df896d99e225)
Upgrades TypeScript to version 6 and updates associated tooling such as ESLint and Vitest. Adapts `tsconfig.json` by removing outdated flags and replacing the Babel plugin in Vitest with a custom esbuild decorator transformer to accommodate the upgraded ecosystem.


### Continuous Integration

* update github actions versions (650fea455a646a9003e6c24bb64bb2ff6756a6a5)
Updates the actions used in the publish workflow to their latest major versions (checkout to v6, pnpm/action-setup to v5, setup-node to v6) to ensure compatibility and maintain security.

## [1.0.4](https://github.com/D1g1talEntr0py/watchr/compare/v1.0.3...v1.0.4) (2026-03-18)

### Bug Fixes

* **security:** patch CVE-2026-32141 (a1b1595de1b65d7e4defb7f791a09deba0903bfb)
Addresses a race condition where initializing a watcher on a non-existent path can cause unhandled exceptions. Errors are now gracefully emitted through the watcher's event bus instead of throwing directly, preventing potential crash vulnerabilities and bringing the implementation into compliance with CVE-2026-32141.


### Miscellaneous Chores

* cleanup files (32217d28107210f915858e438066cbe3c2ffff8b)
* **deps:** update developer dependencies and tooling configurations (d9873a4e9608c3ed1ed5b091dff0004dab3ee9ae)
Bumps packageManager to a newer pnpm version, bumps core devDependencies including eslint, vitest, and typescript-eslint setups, and introduces the @rolldown/plugin-babel dependency. Also adds a specific tsconfig.json for tests and updates the configured vitest execution environment.


### Continuous Integration

* bump GitHub Actions workflow versions (69d5bcdab3636b85730cab2049fe01c11e0fb30e)
Updates Github Actions standard uses, including `actions/checkout` to v6, `pnpm/action-setup` to v5, and `actions/setup-node` to v6. Modifies standard publish procedures to manually enforce getting latest npm versions as necessary for semantic release.

## [1.0.3](https://github.com/D1g1talEntr0py/watchr/compare/v1.0.2...v1.0.3) (2026-03-07)

### Bug Fixes

* clear the restore timeout resources in the close() method (344870c0f55833412531db723a8759714d52173b)

### Miscellaneous Chores

* **ci:** add commit message git hook (b3f7b99b0a1398411f7dc8b8a61b8f46adadb1fd)

## [1.0.2](https://github.com/D1g1talEntr0py/watchr/compare/v1.0.1...v1.0.2) (2026-03-07)

### Bug Fixes

* **release:** added --no-git-checks to config (cf3c69acc7bd306c1492ac7fc63d36e30720708f)

## [1.0.1](https://github.com/D1g1talEntr0py/watchr/compare/v1.0.0...v1.0.1) (2026-03-07)

### Bug Fixes

* **build:** fixed broken import (01101f32ac74b9f7797c29645d4124b7077173ae)
* **deps:** bump @types/node, memfs and transitive packages (b9338f240b3d1be4d1f7b55140c864285c67f641)
Updates @types/node and memfs to their latest patch releases. Transitive
packages updated include the full @jsonjoy.com/fs-* family, ast-v8-to-istanbul,
brace-expansion, postcss, and vitest-related peer resolutions. Lock file
regenerated accordingly.

* **deps:** bump eslint and related packages (ab85911f797a1f6487dd0213a87c571585cf3929)
Updates eslint and its ecosystem packages to latest patch releases to
pick up bug fixes. Transitive packages updated include eslint internals
(@eslint/config-array, @eslint/core, @eslint/plugin-kit, eslint-scope,
espree, flatted) and typescript-eslint peer resolutions. Lock file
regenerated accordingly.

* **release:** updated config to use pnpm (a1383a0aaa98591fcb87a5adbb3613bc9f0202dc)

### Code Refactoring

* **build:** fix import path and simplify plugin logic (bbfeefd732b23bc042bc64bd7386f05d1aa38a62)
Removes the explicit .ts extension from the esbuild config import so
bundler-mode module resolution works correctly. Condenses the
file-read and regex-replace steps in the extension plugin into a
single expression and reorders imports to follow idiomatic built-in
before third-party ordering.

* **package:** reorganise metadata and release scripts (d9db0181ea9299dfff560f8afaa07ab9168611fe)
Moves metadata fields to a more logical order near the top of the
file, improving readability and conformance with common conventions.

Adds maintainers field with contact info, adds explicit npm registry
in publishConfig, removes manual release scripts in favour of
semantic-release, and adds a prepublishOnly guard to ensure the
package is linted and built before any publish.

* **release:** add lint and build to prepare step (8552ef39658f68b811493c8a7085dea9fa4b9b02)
Ensures the codebase is linted and compiled before a release package
is created, preventing a broken or un-built package from being
published. Also corrects the tarball glob to match the actual package
name used for GitHub release assets.

* **tsconfig:** update compile target to ESNext (098b82abd86d9aa7248819f6dd8c3a7661928340)
Switches target and lib from ES2024 to ESNext so the compiler always
targets the latest ECMAScript feature set supported by the installed
TypeScript version, removing the need to manually bump the year.
Also removes esModuleInterop, which is not needed for a pure ESM
package.


### Documentation

* remove outdated manual release workflow (0b2a1c17d908f86f8ec4c9e2f585625f2f88cdff)
Deletes the RELEASE.md file that documented a manual pnpm-based
version-bump workflow. The project now uses semantic-release, making
the document obsolete and potentially confusing for contributors.

* update release process and version references (4840b902e5d977de3ed95c71524f4a9b1e6f3110)
Clears the manually maintained changelog now that semantic-release will
own it. Adds docs/release-process.md as the canonical contributor guide
for Conventional Commits, version bump rules, and the automated
pipeline. Adds RELEASE.md at the repo root with a Mermaid diagram and
quick-reference table for day-to-day use.

Fixes inaccurate Node.js (20.16 → 22.x) and TypeScript (6.0 → 5.0)
version badges and requirement text in the README.


### Miscellaneous Chores

* bump dev dependencies and lockfile (462f66744503861873bba4cdcfbf7065f1377055)
Updates @typescript-eslint, eslint, eslint-plugin-jsdoc, @types/node,
and pnpm to their latest compatible versions. Consolidates duplicate
minimatch, brace-expansion, and balanced-match entries down to single
modern versions, removing the now-unused @isaacs scoped packages.

* removing old tooling cache (00ef475a6e1ca87eb63e87c9bc3362f7e5965499)
* update README.md to use new coverage provider (d000c44e36ee5f4d642f6a68eab9b5fe125fff9a)

### Continuous Integration

* add better test matrix (5e1fffb3b97c0a2654f7f938642fe09e13d9c175)
* add CI workflow and migrate to semantic-release (7450c93d6a6b1ad2200f6e679f39c80b6c86c2a3)
Adds a matrix CI workflow across Node.js 20, 22, and 24 running lint,
type-check, tests with coverage reporting to Codecov, and build.

Replaces the manual tag-triggered publish workflow with a fully
automated semantic-release pipeline driven by Conventional Commits.
Version bumping, changelog generation, npm publish with provenance,
and GitHub release creation are now hands-off on every merge to main.

* removed old test.yml GitHub action (87f9021f2158dfe8685852235e140cf319920566)

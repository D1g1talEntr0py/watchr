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

# Release Process

## Overview

This project uses [git-cliff](https://git-cliff.org/) with [Conventional Commits](https://www.conventionalcommits.org) to calculate versions and generate `CHANGELOG.md`. The release workflow publishes to npm and creates a GitHub release. There are no manual version bumps.

## Step-by-Step: Making a Release

### 1. Write Code on a Feature Branch

```sh
git checkout -b feat/my-feature
```

### 2. Commit Using Conventional Commit Messages

Every commit message must follow the format:

```
type(optional-scope): description
```

**Types that trigger a release:**

| Type | Bump | Example |
|---|---|---|
| `feat` | Minor (`1.x.0`) | `feat: add watch mode` |
| `fix` | Patch (`1.0.x`) | `fix: resolve path edge case` |
| `perf` | Patch (`1.0.x`) | `perf: cache module resolution` |
| `revert` | Patch (`1.0.x`) | `revert: undo feature X` |

**Types that do NOT trigger a release:**

| Type | Example |
|---|---|
| `refactor` | `refactor: simplify bundler` |
| `docs` | `docs: update README` |
| `style` | `style: fix formatting` |
| `chore` | `chore: update deps` |
| `test` | `test: add bundler tests` |
| `build` | `build: update esbuild config` |
| `ci` | `ci: fix workflow` |

**Breaking changes** (major bump `x.0.0`):

Add `!` after the type, or include a `BREAKING CHANGE:` footer:

```
feat!: drop Node 22 support

BREAKING CHANGE: Minimum Node.js version is now 24.6.0.
```

### 3. Push and Open a Pull Request

```sh
git push -u origin feat/my-feature
```

Open a PR targeting `main`. The CI workflow runs `pnpm audit --prod`, lint, type-check, tests with coverage thresholds, build, and the `dist/` typings smoke check across ubuntu and macOS × Node.js 24 and 26. A benchmark regression job (ubuntu, Node 26) and a Windows job (Tier 2) also run but are non-blocking. All blocking checks must pass.

### 4. Merge to `main`

Merge the PR (squash or merge commit — both work). The commit message(s) on `main` are what git-cliff reads, so:

- **Squash merge**: Edit the squash commit message to use the correct conventional commit format.
- **Merge commit**: Each individual commit on the branch is analyzed, so they should all follow the format.

### 5. Automated Release (Hands-Off)

After the merge, the `publish.yml` workflow triggers automatically. It installs git-cliff 2.14.0 from the workflow and does not add release tooling to `package.json`:

1. Verifies conditions, including `pnpm audit --prod`
2. Checks commits since the latest git tag and calculates the next version, or skips if there is no release-worthy change
3. Regenerates `CHANGELOG.md` with grouped release notes and updates `package.json`
4. Runs lint, type-check, tests, build, and `pnpm pack`; the workflow verifies the tarball contains exactly one `.js` file
5. Publishes to npm with provenance attestation via Trusted Publishers
6. Commits `CHANGELOG.md` and `package.json` back to `main` with `[skip ci]`, creates an annotated git tag (e.g., `v4.2.0`), and pushes both
7. Creates a GitHub Release with the generated release notes and `.tgz` as an asset

### 6. Verify

- Check the [Actions tab](../../actions) for the workflow run
- Check [npm](https://www.npmjs.com/package/@d1g1tal/watchr) for the published version
- Check [Releases](../../releases) for the GitHub release

## Dry Run (Local Testing)

To preview the unreleased changelog and calculated next version without publishing:

```sh
git-cliff --unreleased
git-cliff --bumped-version
```

Install [git-cliff](https://git-cliff.org/docs/installation/) locally before running these commands.

## Troubleshooting

**No release was created after merging:**
- The commits on `main` don't include any release-worthy types. `feat`, `fix`, `perf`, and `revert` trigger releases; any type with a breaking-change marker triggers a major release.

**Wrong version bump:**
- Check the commit messages. A `feat` bumps minor, a `fix`/`perf`/`revert` bumps patch, and a breaking change always bumps major. `refactor` is included in the changelog but does not trigger a release on its own.

**npm publish failed:**
- Verify the `npm` environment exists in the repo's GitHub Settings → Environments.
- Verify Trusted Publishing is configured on npmjs.com for this repo and the `publish.yml` workflow.

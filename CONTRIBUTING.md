# Contributing

## Prerequisites

- Node.js `>= 24.6` (CI runs 24 and 26; `.node-version` pins 26 for local tooling)
- pnpm `>= 12` (`corepack enable` picks up the version in `package.json#packageManager`)

## Setup

```sh
pnpm install
```

`pnpm install` runs the `prepare` script, which points `core.hooksPath` at `.githooks` so the Conventional Commits
`commit-msg` hook is active in your clone.

## Quality gates

Every change must keep these green (CI runs the same set on ubuntu/macos × Node 24/26):

```sh
pnpm lint            # eslint over src/ and tests/
pnpm type-check      # tsc over src/ and tests/
pnpm test:coverage   # vitest with coverage thresholds
pnpm build           # dist/watchr.js + declarations
pnpm type-check:dist # consumer-side check of the emitted typings
```

`pnpm test` runs the suite without coverage; `pnpm test:watch` for iteration.

## Commit messages

Commits must follow [Conventional Commits](https://www.conventionalcommits.org) — the `commit-msg` hook rejects
anything else. Release versions and `CHANGELOG.md` are generated from these messages by git-cliff, so never
bump `version` or edit `CHANGELOG.md` by hand. See [docs/release-process.md](docs/release-process.md).

## Performance changes

Before opening a PR that touches the scan, stat, or event pipeline, record a fresh baseline on your machine and run the
regression check:

```sh
pnpm bench:baseline   # writes tests/benchmarks/baseline.json (per-machine)
pnpm bench:ci         # fails on >20% readiness or bytes/path regression vs that baseline
```

Include the before/after numbers from `pnpm bench:compare` in the PR description.

## Conventions

Tabs, single quotes, semicolons, JSDoc on exported symbols; see [.github/copilot-instructions.md](.github/copilot-instructions.md)
for the architecture overview and change patterns.

# Watchr Development Guide

## Project Overview
Watchr is a TypeScript-first file watcher built on native `fs.watch` with inode-based rename detection and an EventEmitter API.

- Runtime: Node.js 24.6+
- Package manager: pnpm 12.x
- Fork of [`fabiospampinato/watcher`](https://github.com/fabiospampinato/watcher) for personal experimentation

## Architecture Snapshot

Core flow:
`fs.watch` -> `FileSystemEventManager` -> `FileSystemStateManager` -> `FileRenameHandler` -> `Watchr.emitEvent`

Key modules:
- [src/watchr.ts](../src/watchr.ts): public API, watcher lifecycle, abort/ready handling
- [src/file-system-event-manager.ts](../src/file-system-event-manager.ts): per-watcher event batching, deduplication, initial scan wiring
- [src/file-system-state-manager.ts](../src/file-system-state-manager.ts): stat diffing, event derivation, inode/path tracking
- [src/file-rename-handler.ts](../src/file-rename-handler.ts): rename correlation via inode locks
- [src/file-system.ts](../src/file-system.ts): recursive reads and stat retrieval with retries
- [src/lock-resolver.ts](../src/lock-resolver.ts): shared interval timeout resolver with bounded capacity

Supporting types/data:
- [src/watchr-stats.ts](../src/watchr-stats.ts): primitive-only stats (`ino`/`size`/`mtimeNs`/`ctimeNs`/`flags`), lazy `Temporal.Instant` getters
- [src/file-system-entries.ts](../src/file-system-entries.ts)
- [src/file-system-locker.ts](../src/file-system-locker.ts)
- [src/retry-queue.ts](../src/retry-queue.ts)
- [src/set-multi-map.ts](../src/set-multi-map.ts)
- [src/utils.ts](../src/utils.ts): `raceWithAbort`, `castError`, `noop`
- [src/@types/index.ts](../src/@types/index.ts); [src/@types/temporal-polyfill-lite.d.ts](../src/@types/temporal-polyfill-lite.d.ts) is a local typing shim for the polyfill root export, selected via `compilerOptions.paths`

Test support:
- [tests/helpers/fs-fixtures.ts](../tests/helpers/fs-fixtures.ts): `createTempRoot`, `createReadyWatcher`, `collectEvents`, `waitForEvent`, `settle`, `delay`
- [tests/helpers/internals.ts](../tests/helpers/internals.ts): the one typed seam for reaching `@internal` collaborators (`renameHandler`, `stateManager`, `watchers`)
- [tests/regressions/](../tests/regressions/): B1–B5 regression suites (large-tree, event-ordering, root-lifecycle, listener-safety, global-pollution)
- [tests/memory.test.ts](../tests/memory.test.ts): Linux-only heap budget tests (needs `--expose-gc`, wired via `vitest.config.ts`)
- [tests/dist-smoke/](../tests/dist-smoke/): consumer-side compile of `dist/watchr.d.ts` (`pnpm type-check:dist`)
- [tests/benchmarks/compare.ts](../tests/benchmarks/compare.ts), [tests/benchmarks/helpers.ts](../tests/benchmarks/helpers.ts), [tests/benchmarks/watchr.bench.ts](../tests/benchmarks/watchr.bench.ts)

## Behavioral Details That Matter

- Defaults ([src/constants.ts](../src/constants.ts) / `Watchr.normalizeWatchOptions()`): `recursive: true`, `renameTimeout: 150ms`, `statTimeout: 1000ms` (live polls only; the initial scan has no per-stat timeout), `fallbackScanInterval: 50ms`, `followSymlinks: true`, `ignoreInitial: false`.
- Rename detection correlates `unlink` + `add` by inode, with separate file/dir lock stores. An `add` is held only if its inode was vacated by a tracked path within `renameTimeout` (`FileSystemStateManager.wasVacatedWithin`); brand-new inodes emit immediately. A `change` arriving while an `add` for the same path is held is folded into that `add`.
- Initial scan stats paths with blocking `statSync` (`StatOptions.sync`), sequentially, yielding to the event loop every 8ms; retryable errors fall back to the async `RetryQueue` path.
- `FileSystemEventManager` batches through a microtask and deduplicates by event priority; the fallback scan is bounded to one in flight per manager and aborted on cleanup.
- Root lifecycle: a deleted watched root emits `unlinkDir`, then is retried with backoff `[100, 250, 500, 1000, 2000]ms` (unref'd timers) until it reappears (`addDir` + rescan) or `close()`.
- Safe emission: listener exceptions are routed to `error`; if that has no listener they surface as `process.emitWarning` with name `WatchrWarning` and code `WATCHR_UNHANDLED_ERROR` (`WATCHR_LOCK_RESOLVER_ERROR` for resolver ticks). Never `uncaughtException` from a timer.
- Watcher errors are sanitized before emission.
- Stats travel with the event tuple from `FileSystemStateManager.determineEvents()`; there is no last-known-stats cache. Synthetic stats (`WatchrStats.synthetic`) are used only for rename targets without stats.
- No global `Temporal` is installed: `temporal-polyfill-lite` is imported lazily as a module value only when a `Temporal.Instant` getter is read (`globalThis.Temporal` wins when present). `tests/regressions/global-pollution.test.ts` enforces this against `dist/`.
- Public API is typed via `EventEmitter<WatchrEventMap>`; implementation members use ECMAScript `#` privacy.

## Coding Conventions

- Tabs, single quotes, semicolons, required JSDoc, underscore-prefixed intentionally unused params.
- Keep runtime validation in sync with `Watchr.validateWatchArguments()` and defaults in `Watchr.normalizeWatchOptions()`.
- Use `as const`-driven enums/constants and existing type utilities in [src/@types/index.ts](../src/@types/index.ts).

## Build, Test, Benchmark

Build system:
- [esbuild.config.ts](../esbuild.config.ts): one bundled runtime artifact `dist/watchr.js` (+ `.js.map`, MIT banner) and `dist/**/*.d.ts` via the TypeScript Program API (rewrites declaration imports to `.js` inline). `--minify` is parsed with `node:util` `parseArgs`. There are no unbundled per-module `.js` files in `dist/`; `tests/benchmarks/watchr.bench.ts` bundles the internals from `src/` on the fly.
- `package.json`: `"files"` ships only `dist/**/*.js`, `dist/**/*.js.map`, `dist/**/*.d.ts` + README/CHANGELOG/LICENSE; `"sideEffects": false`.

TypeScript toolchain (two compilers, deliberately):
- `typescript` → `@typescript/typescript6` (TS 6, JS). Used by `esbuild.config.ts` declaration emit (`import ts from 'typescript'`), by typescript-eslint, and by vitest's `typecheck` of `tests/**/*.test-d.ts`.
- `@typescript/native` → TS 7 (Go). `node_modules/.bin/tsc` is the shim for this package, so `pnpm type-check`, `type-check:tests`, `type-check:dist`, `build:watch`, and `npx tsc` all run TS 7.
- [tsconfig.json](../tsconfig.json) enables `isolatedDeclarations` and uses compiler defaults for target, module and strictness; [tsconfig.tooling.json](../tsconfig.tooling.json) covers the config/bench scripts (`skipLibCheck` because vitest/vite d.ts fail under TS 6 lib check).

Commands:
- `pnpm build` / `pnpm build --minify`
- `pnpm build:watch`
- `pnpm type-check` (src + tests), `pnpm type-check:tests`, `pnpm type-check:dist` (compiles [tests/dist-smoke/consumer.ts](../tests/dist-smoke/consumer.ts) against `dist/` without `skipLibCheck`)
- `pnpm lint` (src + tests)
- `pnpm test`, `pnpm test:watch`, `pnpm test:coverage` (thresholds: statements 85 / branches 70 / functions 80 / lines 85)
- `pnpm bench` (mitata micro-benchmarks of internal hot paths bundled from `src/`, no build needed; [tests/benchmarks/watchr.bench.ts](../tests/benchmarks/watchr.bench.ts))
- `pnpm bench:compare` (watchr vs chokidar vs @parcel/watcher, raw `fs.watch` as unranked reference: startup, retained heap, latency p50/p95, rename detection, plus a per-category verdict; [tests/benchmarks/compare.ts](../tests/benchmarks/compare.ts))
- `pnpm bench:baseline` (writes per-machine [tests/benchmarks/baseline.json](../tests/benchmarks/baseline.json))
- `pnpm bench:ci [--tolerance 0.2]` (exits 1 if watchr readiness or B/path regress beyond the tolerance vs baseline; warns instead when the baseline is from another machine)
- Release: `publish.yml` pins git-cliff 2.14.0 and uses [cliff.toml](../cliff.toml); see [docs/release-process.md](../docs/release-process.md) for release and dry-run steps.

Benchmark notes:
- Shared fixture builders and gc/percentile helpers live in [tests/benchmarks/helpers.ts](../tests/benchmarks/helpers.ts).
- `chokidar` and `@parcel/watcher` are devDependencies used only by the comparison bench; the parcel build script is denied in `pnpm-workspace.yaml` because the prebuilt binary is used.

Testing notes:
- Vitest config is in [vitest.config.ts](../vitest.config.ts); worker forks run with `--expose-gc` so `tests/memory.test.ts` can measure retained heap.
- Use `await watcher.readyLock` before asserting watch events.
- Always close watchers in cleanup paths (`tests/helpers/fs-fixtures.ts` tracks and closes them for you).
- Coverage reports to `tests/coverage`.

## Common Change Patterns

Adding a new file-system event:
1. Add constant/type in [src/constants.ts](../src/constants.ts)
2. Extend event derivation in `FileSystemStateManager.determineEvents()`
3. Update rename lock behavior in `FileRenameHandler` if needed
4. Ensure `Watchr.emitEvent()` payloads remain consistent

Lock-based delayed resolution:
- Use `this.lockResolver.add(fn, timeout)` and `this.lockResolver.remove(fn)`
- Avoid per-event `setTimeout` fanout

Filesystem pressure handling:
- Keep high-volume stat calls behind `RetryQueue`
- Preserve retry behavior for transient descriptor/permission errors

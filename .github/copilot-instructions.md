# Watchr Development Guide

## Project Overview
Watchr is a TypeScript-first file watcher built on native `fs.watch` with inode-based rename detection and constructor-configured handlers.

- Runtime: Node.js 24.6+
- ESM ONLY. No CommonJS support. EVER
- Package manager: pnpm 12.x
- Fork of [`fabiospampinato/watcher`](https://github.com/fabiospampinato/watcher) now ready for production environments

## Architecture Snapshot

Core flow:
`fs.watch` -> `FileSystemEventManager` -> `FileSystemStateManager` -> `FileRenameHandler` -> Watchr handler dispatch

Key modules:
- [src/watchr.ts](../src/watchr.ts): public API, watcher lifecycle, startup barrier, handler ownership and cancellation
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
- [tests/helpers/fs-fixtures.ts](../tests/helpers/fs-fixtures.ts): `createTempRoot`, `createWatcher`, `createReadyWatcher`, `collectEvents`, `waitForEvent`, `observeEvent`, `unobserveEvent`, `settle`, `delay`. `createWatcher` installs recording handlers at construction; collectors and observers attach to test-owned data, not Watchr. `collectEvents` includes recorded initial inventory. These helpers are not public subscription APIs.
- [tests/regressions/](../tests/regressions/): B1–B5 regression suites (large-tree, event-ordering, root-lifecycle, listener-safety, global-pollution)
- [tests/memory.test.ts](../tests/memory.test.ts): Linux-only heap budget tests (needs `--expose-gc`, wired via `vitest.config.ts`)
- [tests/dist-smoke/](../tests/dist-smoke/): consumer-side compile of `dist/watchr.d.ts` (`pnpm type-check:dist`)
- [tests/benchmarks/compare.ts](../tests/benchmarks/compare.ts), [tests/benchmarks/helpers.ts](../tests/benchmarks/helpers.ts), [tests/benchmarks/watchr.bench.ts](../tests/benchmarks/watchr.bench.ts)

## Behavioral Details That Matter

- Defaults ([src/constants.ts](../src/constants.ts)): `recursive: true`, `persistent: true`, `emitInitial: false`, `renameTimeout: 150ms`, `statTimeout: 1000ms` (live polls only; the initial scan has no per-stat timeout), `fallbackScanInterval: 50ms`, `followSymlinks: true`. Paths are absolute UTF-8 strings; `encoding` and `throwIfNoEntry` are removed.
- Required target: a nonempty string or nonempty array of nonempty strings, validated synchronously. Construction is idle; `start(): Promise<this>` is the only startup operation. It resolves the instance after attachment, scan, and requested synchronous initial callbacks, never after asynchronous application work. State is `idle | starting | watching | closed`; no readiness event or EventEmitter inheritance/methods.
- `options.handlers` is the only subscription mechanism: optional `add`, `addDir`, `change`, `unlink`, `unlinkDir`, `rename`, `renameDir`, `all`, `error`, `close`. Each accepts a function or `{ handler, once?: boolean }`; consume `once` before invocation (initial events count when enabled).
- Path payloads are `{ type, path, stats, initial }`; rename payloads are `{ type, from, to, stats, initial: false }`; `all` receives their discriminated union, `error` an Error, and `close` no arguments. `WatchrEventHandler<Payload>` and `WatchrHandlerOptions<Payload>` accept only file-system payload types and default to `WatchrEvent`; never supply event-name strings, `Error`, or `undefined`. Errors use `WatchrErrorHandler` / `WatchrErrorHandlerOptions`; closure uses `WatchrCloseHandler` / `WatchrCloseHandlerOptions`. `WatchrHandlers` infers inline callback signatures. Use these exported types plus `WatchrOptions`, `WatchrEventMap`, `WatchrPathEvent`, `WatchrRenameEvent`, `WatchrState`, `WatchIgnore`, and `Path` directly; old `Handler` is not public.
- All public exports are named; use `import { Watchr } from '@d1g1tal/watchr'`, never a default import.
- `close()` is synchronous, idempotent and terminal: clear all handler references (inline callbacks included), native watchers, timers, queues and rename tracking; abort the read-only `abortSignal`. `[Symbol.dispose]()` does the same. Neither waits for application callback work. Inline handlers need no saved reference for cleanup; callers bind methods requiring their own `this`.
- `using watcher = await new Watchr(target, { handlers }).start()` must remain in an open application scope (for example, await a shutdown promise). Plain `const` plus application teardown or `finally` is equally valid.
- Fatal startup failures (missing targets, directory setup/scan failures) reject `start()` and automatically close, without duplicate `error` delivery. Per-stat failures report `error`, skip the path and continue. Native operational errors and handler throws/rejections report safely to `error`; callback promises are observed, not awaited.
- Ignore callbacks always receive the full absolute path, including array entries; do not invoke them again with basename. Callbacks are synchronous; strings/globs and regex match full path and basename.
- Rename detection correlates `unlink` + `add` by inode, with separate file/dir lock stores. An `add` is held only if its inode was vacated by a tracked path within `renameTimeout` (`FileSystemStateManager.wasVacatedWithin`); brand-new inodes emit immediately. A `change` arriving while an `add` for the same path is held is folded into that `add`.
- Initial scan stats paths with blocking `statSync` (`StatOptions.sync`), sequentially, yielding to the event loop every 8ms; retryable errors fall back to the async `RetryQueue` path.
- `FileSystemEventManager` batches through a microtask and deduplicates by event priority; the fallback scan is bounded to one in flight per manager and aborted on cleanup.
- Root lifecycle: a deleted watched root emits `unlinkDir`, then is retried with backoff `[100, 250, 500, 1000, 2000]ms` (unref'd timers) until it reappears (`addDir` + rescan) or `close()`.
- Safe dispatch: missing or throwing/rejecting error handlers produce `process.emitWarning`, not recursive error dispatch or an uncaught exception from a timer. Handler promise rejections must be observed.
- Watcher errors are sanitized before emission.
- Stats travel with the event tuple from `FileSystemStateManager.determineEvents()`; there is no last-known-stats cache. Synthetic stats (`WatchrStats.synthetic`) are used only for rename targets without stats.
- No global `Temporal` is installed: `temporal-polyfill-lite` is imported lazily as a module value only when a `Temporal.Instant` getter is read (`globalThis.Temporal` wins when present). `tests/regressions/global-pollution.test.ts` enforces this against `dist/`.
- `WatchrEventMap` maps handler names to payloads, not positional argument tuples; implementation members use ECMAScript `#` privacy.

## Coding Conventions

- ESM only: JavaScript uses `.js` with `"type": "module"` and `import`/`export` throughout code, tooling, and documentation. Use the same convention for temporary scripts.
- Tabs, single quotes, semicolons, required JSDoc, underscore-prefixed intentionally unused params.
- Keep runtime argument/handler validation in sync with public types and option defaults.
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
- Configure test handlers before `await watcher.start()`; initial synchronous callbacks finish before it resolves. Use `createWatcher` for test-owned recording and `createReadyWatcher` when no pre-start assertions are needed. Do not use EventEmitter subscriptions or wait for a readiness event.
- Always close watchers in cleanup paths (`tests/helpers/fs-fixtures.ts` tracks and closes them for you).
- Coverage reports to `tests/coverage`.

## Common Change Patterns

Adding a new file-system event:
1. Add constant/type in [src/constants.ts](../src/constants.ts)
2. Extend event derivation in `FileSystemStateManager.determineEvents()`
3. Update rename lock behavior in `FileRenameHandler` if needed
4. Extend the public event payload union and handler map, and keep Watchr dispatch payloads consistent

Lock-based delayed resolution:
- Use `this.lockResolver.add(fn, timeout)` and `this.lockResolver.remove(fn)`
- Avoid per-event `setTimeout` fanout

Filesystem pressure handling:
- Keep high-volume stat calls behind `RetryQueue`
- Preserve retry behavior for transient descriptor/permission errors

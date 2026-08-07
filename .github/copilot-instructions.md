# Watchr Development Guide

## Project Overview
Watchr is a TypeScript-first file watcher built on native `fs.watch` with inode-based rename detection and an EventEmitter API.

- Runtime: Node.js 24.6+
- Package manager: pnpm 11.x
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
- [src/watchr-stats.ts](../src/watchr-stats.ts)
- [src/file-system-entries.ts](../src/file-system-entries.ts)
- [src/@types/index.ts](../src/@types/index.ts)

## Behavioral Details That Matter

- Default `renameTimeout` is `150ms` ([src/constants.ts](../src/constants.ts)).
- Rename detection correlates `unlink` + `add` by inode, with separate file/dir lock stores.
- `FileSystemEventManager` batches through a microtask and deduplicates by event priority.
- Watcher errors are sanitized before emission.
- `Watchr` caches last-known stats and can emit fallback stats for hard-to-resolve edge events.

## Coding Conventions

- Tabs, single quotes, semicolons, required JSDoc, underscore-prefixed intentionally unused params.
- Keep runtime validation in sync with `Watchr.validateWatchArguments()` and defaults in `Watchr.normalizeWatchOptions()`.
- Use `as const`-driven enums/constants and existing type utilities in [src/@types/index.ts](../src/@types/index.ts).
- `@timeout()` is the only decorator currently in use ([src/decorators/timeout.ts](../src/decorators/timeout.ts)).

## Build, Test, Benchmark

Build system:
- [esbuild.config.ts](../esbuild.config.ts): esbuild output + declaration emit via TypeScript Program API
- [build/extension-plugin.ts](../build/extension-plugin.ts): rewrites emitted imports to `.js`

Commands:
- `pnpm build`
- `pnpm build:watch`
- `pnpm type-check`
- `pnpm test`
- `pnpm test:watch`
- `pnpm test:coverage`
- `pnpm bench`
- `pnpm bench:compare`
- `pnpm bench:compare:json`

Testing notes:
- Vitest config is in [vitest.config.ts](../vitest.config.ts) and includes a decorator pre-transform.
- Use `await watcher.readyLock` before asserting watch events.
- Always close watchers in cleanup paths.
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

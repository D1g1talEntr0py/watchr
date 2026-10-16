# Watchr

[![npm version](https://img.shields.io/npm/v/@d1g1tal/watchr?color=blue)](https://www.npmjs.com/package/@d1g1tal/watchr)
[![npm downloads](https://img.shields.io/npm/dm/@d1g1tal/watchr)](https://www.npmjs.com/package/@d1g1tal/watchr)
[![CI](https://github.com/D1g1talEntr0py/watchr/actions/workflows/ci.yml/badge.svg)](https://github.com/D1g1talEntr0py/watchr/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/D1g1talEntr0py/watchr/graph/badge.svg)](https://codecov.io/gh/D1g1talEntr0py/watchr)
[![License: MIT](https://img.shields.io/github/license/D1g1talEntr0py/watchr)](https://github.com/D1g1talEntr0py/watchr/blob/main/LICENSE)
[![Node.js](https://img.shields.io/node/v/@d1g1tal/watchr)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript->=6.0.0-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

A TypeScript-first file system watcher for Node.js, with file statistics and inode-based rename detection. Configure handlers in the options, then call `start()` to begin watching. No native binaries; one runtime dependency, `temporal-polyfill-lite`.

Requires Node.js 24.6+; TypeScript projects require TypeScript 6+.

- [Quick Start](#quick-start)
- [Lifecycle and Cleanup](#lifecycle-and-cleanup)
- [Events and Statistics](#events-and-statistics)
- [Options](#options)
- [API and Types](#api-and-types)
- [Error Handling](#error-handling)
- [Migration](#migration)
- [Performance](#performance)

## Installation

```bash
# pnpm
pnpm add @d1g1tal/watchr

# npm
npm install @d1g1tal/watchr

# yarn
yarn add @d1g1tal/watchr
```

## Quick Start

Watch an existing directory until Ctrl+C or SIGTERM. Use a `.js` file in a project with `"type": "module"` in its package.json, or TypeScript compiled as ESM. Replace `./src` with your directory.

```javascript
import { Watchr } from '@d1g1tal/watchr';

const { promise: applicationLifetime, resolve } = Promise.withResolvers();
const shutdown = () => resolve(undefined);
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

try {
  using watchr = await new Watchr('./src', {
    handlers: {
      add: ({ path, stats }) => console.log(`Created: ${path} (${stats.size} bytes)`),
      change: ({ path, stats }) => console.log(`Changed: ${path} (${stats.size} bytes)`),
      rename: ({ from, to }) => console.log(`Renamed: ${from} -> ${to}`),
      error: (error) => console.error('Watcher error:', error)
    }
  }).start();

  console.log(`Watching ./src (${watchr.state})`);
  await applicationLifetime;
} catch (error) {
  console.error('Could not start watching:', error);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', shutdown);
  process.removeListener('SIGTERM', shutdown);
}
```

The application-lifetime promise keeps the `using` scope open. On shutdown, leaving the scope calls `close()`. Construction does not start watching, and `using` alone does not keep a scope alive.

## Lifecycle and Cleanup

`new Watchr(target, options)` validates configuration synchronously and creates an `idle` watcher. The target is required: a nonempty string or nonempty array of nonempty strings. Use `'.'` for the current directory. Files and directories must exist at startup; file targets watch only that file, including atomic-save replacements, not its siblings.

`await watchr.start()` attaches native watchers, scans the configured targets, and resolves with the **same Watchr instance** in the `watching` state. Await it before making changes you need to observe. Repeated calls share one startup operation; there are no automatic constructors, factories, or readiness events. If any target fails startup, the whole instance closes and the promise rejects. Relative targets resolve from the working directory at startup; use absolute targets if your application changes directories.

Existing entries are scanned even with the default `emitInitial: false`. Set `emitInitial: true` to receive initial `add` and `addDir` payloads with `initial: true`. Requested synchronous initial callbacks are fully delivered before `start()` resolves. Async callback promises are observed for failures, but their application work is **not awaited** by startup.

`close()` is synchronous, idempotent, and terminal. It releases owned native watchers, timers, queues, and rename tracking, clears **all handler references, including inline functions**, and aborts `abortSignal`. The optional `close` handler runs once, without arguments. A closed watcher cannot restart; create a new instance. Closing during startup rejects its pending promise. Neither `close()` nor disposal waits for asynchronous application work already launched by handlers.

`watcher.closed` is a stable promise that resolves after synchronous cleanup completes, whether closure comes from `close()`, disposal, or a startup failure. It observes closure; it does not close the watcher or keep the process alive. With `using`, await the application's shutdown signal first and let leaving the scope close the watcher.

Use `using` for a scope-owned watcher, or plain `const` with `close()` in application teardown or `finally`. `using` is optional; cleanup is not. Both use the same `start()` operation. Use plain `using`, not `await using`, because disposal is synchronous. `persistent: false` lets Node exit but does not close the watcher.

Inline handlers are encouraged for local behavior. Saved function or method references are useful for reuse, **not required for cleanup**. Bind a method yourself if it needs its object's `this`. There is no runtime listener registration or removal API; `options.handlers` is the only subscription mechanism.

## Events and Statistics

Each file-system handler receives one object. All paths are absolute UTF-8 strings.

| Handler | Payload |
|---|---|
| `add`, `addDir`, `change`, `unlink`, `unlinkDir` | `{ type, path, stats, initial }` |
| `rename`, `renameDir` | `{ type, from, to, stats, initial: false }` |
| `all` | Discriminated union of the file-system payloads above |
| `error` | An `Error` |
| `close` | No arguments |

`all` includes file-system events only, not errors or closure. Narrow on `event.type` to distinguish rename payloads from path payloads. Every handler is optional and accepts either a function or `{ handler, once?: boolean }`. A `once` handler is consumed **before** invocation, even if it throws or rejects. With `emitInitial: true`, its first matching initial event counts.

`WatchrStats` includes `size`, `inodeNumber`, `isFile()`, `isDirectory()`, and `isSymbolicLink()`. Removal snapshots describe the previously tracked entry. `isSynthetic` identifies fallback snapshots when real stats are unavailable. Timestamps are available as bigint nanoseconds (`modifiedTimeNs`, `changeTimeNs`), numeric milliseconds (`modifiedTimeMs`, `changeTimeMs`), and `Temporal.Instant` (`modifiedTime`, `changeTime`). Reading Temporal getters does not install a global polyfill.

### Typed Handlers

Use the exported types when handlers or options are reused. `WatchrEventHandler` defaults to all file-system events; its optional type parameter is a file-system payload type, not an event-name string. Errors and closure have separate, non-generic callback types: `WatchrErrorHandler` and `WatchrCloseHandler`.

This TypeScript ES module watches multiple existing targets for the application's lifetime and uses `using` for cleanup. The one-shot handler receives the first observed file, including an initial one.

```typescript
import {
  Watchr,
  type WatchrAddEvent,
  type WatchrCloseHandler,
  type WatchrErrorHandler,
  type WatchrEventHandler,
  type WatchrHandlerOptions,
  type WatchrOptions
} from '@d1g1tal/watchr';

const logEvent: WatchrEventHandler = (event) => {
  if (event.type === 'rename' || event.type === 'renameDir') {
    console.log(event.type, event.from, event.to);
  } else {
    console.log(event.type, event.path, event.stats.size, event.initial);
  }
};
const firstFile: WatchrHandlerOptions<WatchrAddEvent> = {
  handler: ({ path }) => console.log('First observed file:', path),
  once: true
};
const reportError: WatchrErrorHandler = (error) => {
  console.error('Watcher error:', error);
};
const reportClose: WatchrCloseHandler = () => {
  console.log('Watcher closed');
};
const options: WatchrOptions = {
  emitInitial: true,
  ignore: ['node_modules', '.git', '**/*.log'],
  handlers: {
    all: logEvent,
    add: firstFile,
    error: reportError,
    close: reportClose
  }
};

const { promise: applicationLifetime, resolve } = Promise.withResolvers<void>();
const shutdown = () => resolve();
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

try {
  using watchr = await new Watchr(['./src', './package.json'], options).start();
  await applicationLifetime;
} catch (error) {
  console.error('Could not start watching:', error);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', shutdown);
  process.removeListener('SIGTERM', shutdown);
}
```

`WatchrHandlerOptions<Payload>` wraps only file-system callbacks. For error and close callbacks, use `WatchrErrorHandlerOptions` and `WatchrCloseHandlerOptions`; each provides `{ handler, once?: boolean }` with its corresponding callback type. Inline callbacks infer their argument types from the handler property and need no explicit annotation.

### When Manual Cleanup Fits

Use explicit `close()` when another object owns the watcher and its lifetime extends beyond the method that starts it. For example, a service can start watching during initialization, return to its caller, and keep watching until the application later invokes its shutdown hook:

```typescript
import { Watchr } from '@d1g1tal/watchr';

export class ProjectService {
  readonly #watchr: Watchr;

  constructor(directory: string) {
    this.#watchr = new Watchr(directory, {
      handlers: {
        change: ({ path }) => console.log(`Changed: ${path}`),
        error: (error) => console.error('Watcher error:', error)
      }
    });
  }

  async initialize(): Promise<void> {
    await this.#watchr.start();
  }

  shutdown(): void {
    this.#watchr.close();
  }
}
```

The application calls `initialize()` during startup and `shutdown()` during teardown. A `using` declaration inside `initialize()` would close the watcher when that method returned, which is too early. The service therefore stores the instance and explicitly closes it later. If one scope can contain the entire watching lifetime, prefer `using`, as in the examples above.

### Rename Expectations

An `unlink` and `add` with the same inode inside `renameTimeout` can become one `rename` or `renameDir`. Without correlation, expect separate removal and addition events; moves outside watched targets generally cannot be paired. Only additions whose inode was recently vacated are held for correlation; a brand-new inode emits immediately. A change during a held addition folds into that addition. `renameTimeout: 0` disables correlation.

Native notifications can coalesce: these are observed state changes, not a log of every write. A `change` can mean content or metadata changed. Read the current file when handling an event.

## Options

| Option | Default | Behavior |
|---|---|---|
| `handlers` | None | Optional handlers listed above; the only subscription mechanism |
| `emitInitial` | `false` | Deliver existing entries as initial `add` / `addDir` events |
| `recursive` | `true` | Watch and scan nested directories; `false` limits both to direct children |
| `persistent` | `true` | Keep Node running while native watchers are open |
| `ignore` | None | Synchronous callback, string, RegExp, or an array of these |
| `renameTimeout` | `150` | Rename correlation window in milliseconds |
| `statTimeout` | `1000` | Per-stat timeout in milliseconds for live polls; no initial-scan stat timeout |
| `fallbackScanInterval` | `50` | Minimum milliseconds between fallback root scans when notifications lack a usable filename |
| `followSymlinks` | `true` | Include symlink targets under the link's own path; `false` skips links |

### Ignore and Symlink Behavior

Ignore callbacks always receive the **full absolute path**, including callbacks inside arrays. They run synchronously, once per matcher evaluation, not again with a basename. Return `true` to ignore. Strings support exact names and glob patterns; strings and regular expressions match against both the full path and basename. An array ignores a path if any entry matches. Ignoring a directory prunes it from scans. A throwing callback reports an error and treats the path as ignored.

With `followSymlinks: true`, scanned symlink entries use the target's stats with `isSymbolicLink() === true`. Symlinked directories are scanned unless they lead to an ancestor or an already-scanned directory. Live changes inside a symlinked directory depend on native notifications.

## API and Types

| Member | Contract |
|---|---|
| `new Watchr(target, options?)` | Required `string \| string[]` target; optional `WatchrOptions` |
| `start(): Promise<this>` | Single startup operation; resolves the instance after attachment, scan, and requested synchronous initial callbacks |
| `close(): void` | Terminal, idempotent cleanup |
| `[Symbol.dispose](): void` | Same cleanup as `close()` |
| `state` | Read-only `idle \| starting \| watching \| closed` |
| `abortSignal` | Read-only `AbortSignal`; aborted on close, not an external control input |

Pass `abortSignal` to application operations that should cancel when the watcher closes. No external abort-signal option is provided.

All exports are named; import the watcher with `import { Watchr } from '@d1g1tal/watchr'`. There is no default export. Runtime exports are `Watchr`, `WatchrStats`, `FileSystemEvent`, `FileEvent`, and `DirectoryEvent`. Use these exported types directly:

- `WatchrOptions`, `WatchrHandlers`: configuration and optional subscriptions.
- `WatchrEventHandler`, `WatchrHandlerOptions`: a callback for all file-system events and its `{ handler, once? }` form. Both default to `WatchrEvent`. Supply a file-system payload type for narrower callbacks, such as `WatchrEventHandler<WatchrAddEvent>` or `WatchrHandlerOptions<WatchrRenameEvent>`. Neither accepts `Error` or `undefined` as a payload type.
- `WatchrErrorHandler`, `WatchrErrorHandlerOptions`: an error callback receiving an `Error` and its options.
- `WatchrCloseHandler`, `WatchrCloseHandlerOptions`: a no-argument close callback and its options.
- `WatchrEvent`, `WatchrPathEvent`, `WatchrRenameEvent`: the file-system union and its payload variants.
- `WatchrAddEvent`, `WatchrAddDirEvent`, `WatchrChangeEvent`, `WatchrUnlinkEvent`, `WatchrUnlinkDirEvent`, `WatchrRenameFileEvent`, `WatchrRenameDirectoryEvent`: individual event payloads.
- `WatchrEventMap`: payloads keyed by configured handler name, not EventEmitter argument tuples. It includes `all: WatchrEvent`, `error: Error`, and `close: undefined`; the close callback itself receives no arguments. The map does not make errors or closure file-system events.
- `WatchrState`, `WatchIgnore`, `Path`: lifecycle state, ignore matchers, and string paths.

Watchr does not inherit from EventEmitter. There are no `on`, `once`, `off`, `emit`, third constructor callback, static startup aliases, or `ready` event. The `once` option belongs to a configured handler, not a watcher method.

## Error Handling

Handle startup rejection with `try` / `catch` and later failures with `handlers.error`:

- **Fatal startup failure:** missing targets or directory setup/scan failures reject `start()` and automatically close the instance. The same failure is not also sent to `error`.
- **Nonfatal stat failure:** the path is skipped, `error` receives the failure, and scanning continues.
- **Operational failure:** native watcher errors go to `error`. A deleted root emits `unlinkDir` and is retried with backoff (100, 250, 500, 1000, then 2000 ms) until restored or closed; restoration produces `addDir` and a rescan.
- **Handler failure:** synchronous throws and asynchronous rejections are safely reported to `error`. Watchr observes callback promises but does not await application work.
- **Missing or failing error handler:** a warning is reported through `process.emitWarning`, rather than recursively calling the error handler or raising an uncaught exception from watcher dispatch.

`state: 'watching'` means startup completed, not that every configured root is currently healthy. Track application work separately when shutdown must wait for it.

## Migration

### Handler API Is a Breaking Change

| Previous API | Replacement |
|---|---|
| Default import | Named import: `import { Watchr } from '@d1g1tal/watchr'` |
| `watchr.on('change', (stats, path) => ...)` | `options.handlers.change: ({ path, stats }) => ...` |
| `watchr.once('add', callback)` | `handlers.add: { handler: callback, once: true }` |
| `.off()`, `.removeAllListeners()` for cleanup | `close()` releases all configured handler references |
| Third constructor callback / `all` tuple | `handlers.all: (event) => ...`; narrow `event.type` |
| Positional rename arguments | One `{ type, from, to, stats, initial: false }` object |
| Optional or empty target | Required nonempty string or nonempty string array |
| `ignoreInitial: true` / `false` | `emitInitial: false` / `true`; default is now `false` |
| `start(): Promise<void>` | `start(): Promise<this>`; supports `await new Watchr(...).start()` |
| `ready` / `readyLock` / automatic construction startup | Await `start()`; no readiness event, getter, or factory |
| `isReady()` / `isClosed()` | Read `state` |
| `watchPath()` / `watchersClose()` | Configure targets, call `start()`, then `close()` |
| `encoding` / `throwIfNoEntry` | Removed; UTF-8 absolute string paths; missing targets reject startup |
| Array ignore callback called with basename too | Callback receives only the full absolute path |
| Startup rejection also delivered to `error` | Catch the rejection; no duplicate error callback |
| Unobserved async listener rejection | Handler promises are observed and failures reported |
| `Handler` / tuple-based `WatchrEventMap` | `WatchrEventHandler` / payload-based `WatchrEventMap` |
| Event-name handler type parameters | Payload types: `WatchrEventHandler` for all events, `WatchrEventHandler<WatchrAddEvent>` for additions; the same applies to `WatchrHandlerOptions` |
| Error and close handler type parameters | Dedicated `WatchrErrorHandler` / `WatchrCloseHandler` and their corresponding options types |

Move subscriptions into the constructor options before calling `start()`. Initial synchronous callbacks now finish before startup resolves; asynchronous application work still does not. Update wrappers and test helpers too.

### Other Changes Since 3.x

- Importing Watchr no longer installs global `Temporal`; the timestamp getters still return native or module-local polyfill instants. Add `import 'temporal-polyfill-lite/shim'` only if your application needs the global.
- `recursive` defaults to `true`; `statTimeout`, `fallbackScanInterval`, and `followSymlinks` are available.
- The `WatchrStats` constructor is private; use `fromStats()` or `synthetic()`. Nanosecond getters are available. Internal classes and members are not public.
- A change can fold into an addition awaiting rename correlation; brand-new inodes are not held. Handler failures are reported safely rather than escaping watcher dispatch.

## Performance

Previous-version benchmark numbers are omitted: they do not validate the redesigned API. Compare builds on the same machine with matching fixtures and options, including `emitInitial`, `recursive`, and cleanup. Native subscribe-only readiness is not equivalent to Watchr's attachment plus initial scan.

```bash
pnpm bench           # internal hot-path microbenchmarks
pnpm bench:compare   # readiness, retained heap, latency, rename correlation
pnpm bench:baseline  # record the before-change baseline on this machine
pnpm bench:ci        # compare the candidate to that baseline
```

Record the baseline **before** making performance changes; do not overwrite it with candidate measurements. Results depend on runtime, platform, filesystem, and workload. See [Contributing](CONTRIBUTING.md) for development gates.

The [redesign validation report](docs/ux-refactor-validation.md) preserves original and follow-up measurements. Startup remained comparable. The initial roughly 8% throughput deficit did not reproduce consistently, but longer-burst write throughput remains an open concern. Closing was consistently slower; a proposed cleanup optimization did not show a repeatable benefit and was not retained. These results are not a regression-free performance claim.

## Platform Support

| Tier | Platforms | Guarantee |
|---|---|---|
| 1 | Linux, macOS | CI-blocking; regressions are release blockers |
| 2 | Windows | Best-effort; CI job is non-blocking; no SLA. WSL is recommended for Tier 1 behavior |

On Windows the first `Watchr` constructed in a process emits a one-time `WatchrWarning` with code `WATCHR_PLATFORM_TIER2`; the Windows CI job runs the integration and regression suites but never blocks a merge.

## Requirements

- Node.js 24.6.0 or higher
- TypeScript 6.0.0 or higher (for TypeScript projects)

## Additional Acknowledgments
- [`watcher`](https://github.com/fabiospampinato/watcher) by [Fabio Spampinato](https://github.com/fabiospampinato) - Upstream project this repository was forked from
- [`chokidar`](https://github.com/paulmillr/chokidar) - Popular file watcher that helped shape API design decisions
- [`node-watch`](https://github.com/yuanchuan/node-watch) - Minimalist watcher implementation for reference

## License

MIT © D1g1talEntr0py

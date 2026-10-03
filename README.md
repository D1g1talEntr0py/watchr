# Watchr

[![npm version](https://img.shields.io/npm/v/@d1g1tal/watchr?color=blue)](https://www.npmjs.com/package/@d1g1tal/watchr)
[![npm downloads](https://img.shields.io/npm/dm/@d1g1tal/watchr)](https://www.npmjs.com/package/@d1g1tal/watchr)
[![CI](https://github.com/D1g1talEntr0py/watchr/actions/workflows/ci.yml/badge.svg)](https://github.com/D1g1talEntr0py/watchr/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/D1g1talEntr0py/watchr/graph/badge.svg)](https://codecov.io/gh/D1g1talEntr0py/watchr)
[![License: MIT](https://img.shields.io/github/license/D1g1talEntr0py/watchr)](https://github.com/D1g1talEntr0py/watchr/blob/main/LICENSE)
[![Node.js](https://img.shields.io/node/v/@d1g1tal/watchr)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript->=6.0.0-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

A modern, TypeScript-first file system watcher built on Node.js native APIs.

## Features

- **TypeScript First**: Written entirely in TypeScript with comprehensive type definitions and a typed `EventEmitter<WatchrEventMap>`
- **Event-Driven Architecture**: Clean, EventEmitter-based API for handling file system events
- **Rename Detection**: Inode-based correlation of file and directory renames with a configurable window
- **Abort Signal Support**: Built-in AbortController integration for clean cancellation
- **File Statistics**: Includes a compact `WatchrStats` snapshot with every event
- **No Native Binaries**: Pure TypeScript implementation with one runtime dependency, `temporal-polyfill-lite`

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

```typescript
import { Watchr } from '@d1g1tal/watchr';

// Watch a single directory
const watcher = new Watchr('/path/to/watch');

// Listen for all events
watcher.on('all', (event, stats, targetPath, targetPathNext) => {
  console.log(`${event}: ${targetPath}`);
});

// Listen for specific events
watcher.on('add', (stats, filePath) => {
  console.log(`File added: ${filePath}`);
});

watcher.on('change', (stats, filePath) => {
  console.log(`File changed: ${filePath}`);
});

await watcher.readyLock;
```

Watchr also supports JavaScript explicit resource management in Node.js 24+:

```typescript
import { once } from 'node:events';
import { Watchr } from '@d1g1tal/watchr';

{
  using watcher = new Watchr('/path/to/watch');
  await watcher.readyLock;

  const [stats, filePath] = await once(watcher, 'change');
  console.log(`File changed: ${filePath}`);
}
```

## Configuration Options

Watchr accepts the following options to customize behavior:

- **`recursive`**: Watch nested directories
  - Default: `true`
  - The initial scan honours it too: `false` limits both the scan and live events to direct children of the root

- **`ignoreInitial`**: Skip the events produced by the initial scan
  - Default: `false`
  - When `true`, only changes after `ready` emit events

- **`ignore`**: Ignore matcher for paths
  - Type: native Node `fs.watch` ignore matcher
  - Callback form: `(targetPath: string) => boolean`; a top-level callback receives the full path
  - Return `true` to ignore matching names
  - Native form: string and regex patterns are matched against full path and basename
  - In an array, callback entries are called with both the full path and basename
  - String patterns also support glob-style matching (for example `**/*.log`)

- **`renameTimeout`**: Rename correlation window in milliseconds
  - Default: `150`
  - An `unlink` and an `add` with the same inode inside the window become one `rename`/`renameDir`
  - Consequence: only an `add` whose inode a tracked path gave up inside the window is delayed (a `change` during that hold folds into the `add`); `add` for a brand-new file or directory is emitted immediately, so short-lived files surface as `add` + `unlink`
  - `0` disables correlation; `add`/`unlink` are emitted immediately

- **`statTimeout`**: Timeout in milliseconds for each stat performed while polling live watcher events
  - Default: `1000`
  - The initial scan has no timeout (it is bounded only by the watcher's abort signal)

- **`fallbackScanInterval`**: Minimum interval in milliseconds between fallback snapshot scans of a watched root
  - Default: `50`
  - A fallback scan (a full directory read) runs when the native watcher reports an event without a usable file name

- **`followSymlinks`**: Whether symbolic links are followed
  - Default: `true`
  - `true`: a link whose target is a file or directory is reported under the link's own path with the target's stats; entries discovered as links during a scan report `stats.isSymbolicLink() === true`; symlinked directories are scanned unless they point at an ancestor or an already-scanned directory
  - `false`: symlinks are skipped by the initial scan and ignored when they appear live
  - Changes *inside* a symlinked directory are only seen if the native watcher reports them

- **`persistent`**: Whether to keep the Node.js process running while watching
  - Default: `true` (Node.js native watcher default)

- **`encoding`**: Character encoding for file paths
  - Default: `'utf8'`
  - Supports any Node.js BufferEncoding

- **`throwIfNoEntry`**: Throw immediately if a watched path does not exist
  - Default: Node.js default (`true`)

## Events

Watchr extends Node.js `EventEmitter<WatchrEventMap>`, so listener arguments are typed per event name:

```typescript
import { Watchr, type WatchrEventMap } from '@d1g1tal/watchr';

const watcher = new Watchr('/path/to/watch');

watcher.on('rename', (stats, from, to) => {
  // stats: WatchrStats, from: string, to: string
});

watcher.on('add', (stats, filePath) => {
  console.log(filePath, stats.size);
});

type RenameArgs = WatchrEventMap['rename']; // [stats: WatchrStats, targetPath: string, targetPathNext: string]
```

It emits the following events:

### Watcher Events
- **`ready`**: Emitted when the watcher has finished initialization
- **`close`**: Emitted when the watcher is closed and all operations stopped
- **`error`**: Emitted when an error occurs
- **`all`**: Emitted before every file system event with `(event, stats, targetPath, targetPathNext?)`

### File System Events
- **`add`**: New file added - `(stats, filePath)`
- **`addDir`**: New directory added - `(stats, directoryPath)`
- **`change`**: File content or metadata changed - `(stats, filePath)`
- **`rename`**: File renamed - `(stats, oldPath, newPath)`
- **`renameDir`**: Directory renamed - `(stats, oldPath, newPath)`
- **`unlink`**: File removed - `(stats, filePath)`
- **`unlinkDir`**: Directory removed - `(stats, directoryPath)`

All file system events include a `WatchrStats` snapshot with the entry's size, inode number, nanosecond timestamps, and `isFile()`, `isDirectory()`, and `isSymbolicLink()` checks. `modifiedTime` and `changeTime` return `Temporal.Instant` values.

## API Reference

### Constructor

```typescript
new Watchr(target?: string | string[], options?: WatchrOptions, handler?: Handler)
```

- **`target`**: Path(s) to watch (file or directory)
- **`options`**: Configuration options (see Configuration Options above)
- **`handler`**: Optional handler for the `all` event

### Public Methods

```typescript
// Check if the watcher is closed
isClosed(): boolean

// Check if the watcher is ready
isReady(): boolean

// Close the watcher and stop all watching
close(): void

// Dispose the watcher; equivalent to close()
[Symbol.dispose](): void

// Check if a path should be ignored
isIgnored(targetPath: string, ignore?: WatchIgnore): boolean

// Access the abort signal for cancellation
get abortSignal(): AbortSignal

// Get a promise that resolves when ready (rejects if initialization fails)
get readyLock(): Promise<void>
```

### Type Definitions

```typescript
type WatchrOptions = {
  persistent?: boolean;
  /** Watch (and initially scan) nested directories. Defaults to `true`. */
  recursive?: boolean;
  encoding?: BufferEncoding;
  ignore?: WatchIgnore; // ((filename: string) => boolean) | string | RegExp | Array<...>
  ignoreInitial?: boolean;
  throwIfNoEntry?: boolean;
  renameTimeout?: number;
  /** Per-stat timeout (ms) for live polls; the initial scan is not time-limited. Defaults to 1000. */
  statTimeout?: number;
  /** Minimum interval (ms) between fallback snapshot scans. Defaults to 50. */
  fallbackScanInterval?: number;
  /** Follow symbolic links. Defaults to `true`. */
  followSymlinks?: boolean;
};

type WatchrEventMap = {
  add: [stats: WatchrStats, targetPath: string];
  addDir: [stats: WatchrStats, targetPath: string];
  change: [stats: WatchrStats, targetPath: string];
  unlink: [stats: WatchrStats, targetPath: string];
  unlinkDir: [stats: WatchrStats, targetPath: string];
  rename: [stats: WatchrStats, targetPath: string, targetPathNext: string];
  renameDir: [stats: WatchrStats, targetPath: string, targetPathNext: string];
  all: [event: FileSystemEvent, stats: WatchrStats, targetPath: string, targetPathNext?: string];
  error: [error: Error];
  ready: [];
  close: [];
};

type Handler = (
  event: FileSystemEvent,
  stats: WatchrStats,
  targetPath: string,
  targetPathNext?: string
) => void;

type FileSystemEvent =
  | 'add' | 'addDir' | 'change'
  | 'rename' | 'renameDir'
  | 'unlink' | 'unlinkDir';
```

### Ignore Matching Semantics

- Callback ignore: a top-level `(targetPath) => boolean` receives the full path; a callback in an array is called with both the full path and basename.
- String ignore:
  - Exact path and basename checks are supported.
  - Glob patterns are supported via Node path glob semantics.
  - Matching is attempted against both absolute path and basename.
- RegExp ignore:
  - Evaluated against full path, then basename.
- Array ignore:
  - Any matching pattern in the array ignores the path.

Examples:

```typescript
// Ignore all .log files anywhere
new Watchr('/repo', { ignore: '**/*.log' });

// Ignore by basename
new Watchr('/repo', { ignore: 'node_modules' });

// Ignore with callback
new Watchr('/repo', { ignore: (filename) => filename.endsWith('.map') });

// Mixed native patterns
new Watchr('/repo', { ignore: [ '**/*.tmp', /\.cache\// ] });
```

## Usage Examples

### Basic File Watching

```typescript
import { Watchr } from '@d1g1tal/watchr';

// Watch a single directory
const watcher = new Watchr('/path/to/watch', { recursive: true });

watcher.on(Watchr.Event.READY, () => {
  console.log('Watcher is ready');
});

watcher.on(Watchr.FileEvent.ADD, (stats, filePath) => {
  console.log(`File added: ${filePath}`);
  console.log(`Size: ${stats.size} bytes`);
});

watcher.on(Watchr.FileEvent.CHANGE, (stats, filePath) => {
  console.log(`File changed: ${filePath}`);
});

watcher.on(Watchr.FileEvent.UNLINK, (stats, filePath) => {
  console.log(`File deleted: ${filePath}`);
});
```

### Watching Multiple Paths

```typescript
const fileItems = [ '/path/to/src', '/path/to/config', '/path/to/package.json' ];
const watcher = new Watchr(fileItems, { recursive: true, ignore: (path) => path.includes('node_modules') });
```

### Using the Universal Handler

```typescript
const watcher = new Watchr('/path/to/watch', {}, (event, stats, targetPath, targetPathNext) => {
  switch (event) {
    case Watchr.FileEvent.ADD: {
      console.log(`Added: ${targetPath}`);
      break;
    }
    case Watchr.FileEvent.RENAME: {
      console.log(`Renamed: ${targetPath} -> ${targetPathNext}`);
      break;
    }
    case Watchr.FileEvent.UNLINK: {
      console.log(`Removed: ${targetPath}`);
      break;
    }
  }
});
```

### Advanced Configuration

```typescript
const watcher = new Watchr('/project', {
  recursive: true,
  ignoreInitial: true,
  ignore: (path) => {
    // Ignore common development artifacts
    return path.includes('node_modules') ||
           path.includes('.git') ||
           path.endsWith('.tmp');
  }
});

// Listen for all events
watcher.on('all', (event, stats, targetPath, targetPathNext) => {
  console.log(`Event: ${event}, Path: ${targetPath}`);
  if (targetPathNext) {
    console.log(`New path: ${targetPathNext}`);
  }
});

// Handle errors
watcher.on('error', (error) => {
  console.error('Watcher error:', error);
});

// Clean shutdown
process.on('SIGINT', () => {
  watcher.close();
  process.exit(0);
});
```

### With AbortController Integration

```typescript
const watcher = new Watchr('/path/to/watch');

// Use the built-in abort signal
const { abortSignal } = watcher;

abortSignal.addEventListener('abort', () => {
  console.log('Watcher was aborted');
});

// Close the watcher (triggers abort)
setTimeout(() => watcher.close(), 10000);
```

### With Explicit Resource Management

```typescript
import { once } from 'node:events';
import { Watchr } from '@d1g1tal/watchr';

{
  using watcher = new Watchr('/path/to/watch');
  await watcher.readyLock;

  const [event, stats, targetPath] = await once(watcher, 'all');
  console.log(event, targetPath);
}
```

These examples watch until the first matching event after readiness. Leaving the `using` block calls `watcher[Symbol.dispose]()` automatically. Disposal is synchronous, idempotent, emits `close` once, aborts `abortSignal`, and has the same behavior as `watcher.close()`.

## Error Handling

- **Listener exceptions**: an exception thrown by any event listener (including the `handler` passed to the constructor) is caught and re-emitted as `error`; it never propagates out of the watcher.
- **No `error` listener**: if there is no `error` listener (or the `error` listener itself throws), the error is reported via `process.emitWarning` with `name: 'WatchrWarning'` and `code: 'WATCHR_UNHANDLED_ERROR'`. Watchr never raises `uncaughtException`.
- **Initialization failure** (for example a missing root path): `readyLock` rejects, `error` is emitted, then the watcher closes and emits `close`.
- **Per-path failures during the initial scan**: a path whose stat fails is reported as `error` with the message `Initial scan skipped path.` (the underlying error is in `cause`) and the scan continues.
- **Watched root deleted**: `unlinkDir` is emitted for the root, then Watchr retries re-attaching with backoff (100 → 250 → 500 → 1000 → 2000 ms, repeating the last delay) and emits `addDir` for the root once it reappears.

## Platform Support

| Tier | Platforms | Guarantee |
|---|---|---|
| 1 | Linux, macOS | CI-blocking; regressions are release blockers |
| 2 | Windows | Best-effort; CI job is non-blocking; no SLA. WSL is recommended for Tier 1 behavior |

On Windows the first `Watchr` constructed in a process emits a one-time `WatchrWarning` with code `WATCHR_PLATFORM_TIER2`; the Windows CI job runs the integration and regression suites but never blocks a merge.

## Migrating from 3.x

- **No global `Temporal`**: importing Watchr no longer installs a `Temporal` polyfill on `globalThis`. `stats.modifiedTime` / `stats.changeTime` still return a `Temporal.Instant` (the native one when the host provides it, otherwise from the `temporal-polyfill-lite` dependency). If your code relied on the global, add `import 'temporal-polyfill-lite/shim'`.
- **`recursive` defaults to `true`** (was `false`).
- **`WatchrStats` constructor is private**: build snapshots with `WatchrStats.fromStats(stats)` or `WatchrStats.synthetic(isDirectory)`. New getters: `modifiedTimeNs` / `changeTimeNs` (bigint nanoseconds).
- **Internal classes and members are gone from the typings** (`FileRenameHandler`, `FileSystemEventManager`, `Watchr#renameWatchr`, …). Only `Watchr`, `WatchrStats`, the event constants and the exported types are public.
- **New options**: `statTimeout`, `fallbackScanInterval`, `followSymlinks`.
- **`change` may fold into a pending `add`**: an `add` that may still pair with an `unlink` as a rename is held for up to `renameTimeout`; a `change` for the same path during that hold is absorbed into the `add`. Brand-new inodes are never held.
- **Throwing listeners no longer crash the process**: see [Error Handling](#error-handling).

## Requirements

- Node.js 24.6.0 or higher
- TypeScript 6.0.0 or higher (for TypeScript projects)

## Additional Acknowledgments
- [`watcher`](https://github.com/fabiospampinato/watcher) by [Fabio Spampinato](https://github.com/fabiospampinato) - Upstream project this repository was forked from
- [`chokidar`](https://github.com/paulmillr/chokidar) - Popular file watcher that helped shape API design decisions
- [`node-watch`](https://github.com/yuanchuan/node-watch) - Minimalist watcher implementation for reference

## License

MIT © D1g1talEntr0py

## Benchmarks

| | watchr | chokidar 5 | @parcel/watcher | `fs.watch` |
|---|---|---|---|---|
| readiness, 50k files | 280 ms | 3149 ms | 74 ms (no scan) | 38 ms (no scan) |
| retained heap / tracked path | ~475 B | ~2000 B | n/a | n/a |
| write → `change` p50 / p95 | 0.34 / 0.46 ms | 2.26 / 18.0 ms | 50.4 / 50.5 ms | 0.15 / 0.23 ms |
| create → `add` p50 | 0.39 ms | 25.1 ms | 50.4 ms | 0.16 ms |
| correlated `rename` events (50 renames) | 50 | 0 | 0 | 0 |

Node 26.10, Linux x64, 28 cores, NVMe; `pnpm bench:compare`, default options. Readiness for @parcel/watcher and `fs.watch` measures subscribe only; they perform no initial scan.

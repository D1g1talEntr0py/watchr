# Watchr

[![npm version](https://img.shields.io/npm/v/@d1g1tal/watchr?color=blue)](https://www.npmjs.com/package/@d1g1tal/watchr)
[![npm downloads](https://img.shields.io/npm/dm/@d1g1tal/watchr)](https://www.npmjs.com/package/@d1g1tal/watchr)
[![CI](https://github.com/D1g1talEntr0py/watchr/actions/workflows/ci.yml/badge.svg)](https://github.com/D1g1talEntr0py/watchr/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/D1g1talEntr0py/watchr/graph/badge.svg)](https://codecov.io/gh/D1g1talEntr0py/watchr)
[![License: MIT](https://img.shields.io/github/license/D1g1talEntr0py/watchr)](https://github.com/D1g1talEntr0py/watchr/blob/main/LICENSE)
[![Node.js](https://img.shields.io/node/v/@d1g1tal/watchr)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript->=5.0.4-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

> **⚠️ Important Notice**: This is a personal fork of [`Watcher`](https://github.com/fabiospampinato/watcher) by [Fabio Spampinato](https://github.com/fabiospampinato), modified to fit specific personal needs and experimentation. **Most users should use the original [Watcher](https://github.com/fabiospampinato/watcher) library instead**, which is actively maintained, battle-tested, and feature-complete.

A modern, TypeScript-first file system watcher built on Node.js native APIs.

## Features

- **Native Performance**: Built on Node.js native `fs.watch` with recursive watching support (Node.js 22.x+)
- **TypeScript First**: Written entirely in TypeScript with comprehensive type definitions
- **Event-Driven Architecture**: Clean, EventEmitter-based API for handling file system events
- **Rename Detection**: Optional detection of file and directory renames with configurable timeouts
- **Abort Signal Support**: Built-in AbortController integration for clean cancellation
- **File Statistics**: Includes file stats with all events for enhanced metadata access
- **Debouncing**: Configurable event debouncing to reduce noise from rapid file changes
- **Cross-Platform**: Works reliably on macOS?, Windows??, and Linux! (Honestly haven't tested much on Windows and I don't own a Mac. Please report any issues if you find platform-specific bugs)
- **Zero Native Dependencies**: Pure TypeScript implementation with no native binaries

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
import { Watchr } from 'watchr';

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

// Close when done
watcher.close();
```

## Configuration Options

Watchr accepts the following options to customize behavior:

- **`persistent`**: Whether to keep the Node.js process running while watching
  - Default: `false`
  - When `true`, prevents the process from exiting while the watcher is active

- **`recursive`**: Enable recursive watching of subdirectories
  - Default: `false`
  - Uses native recursive watching when available (Node.js 20.16+)

- **`encoding`**: Character encoding for file paths
  - Default: `'utf8'`
  - Supports any Node.js BufferEncoding

- **`ignore`**: Ignore matcher for paths
  - Type: native Node `fs.watch` ignore matcher
  - Callback form: `(filename: string) => boolean`
  - Return `true` to ignore matching names
  - Native form: string and regex patterns are matched against full path and basename
  - String patterns also support glob-style matching (for example `**/*.log`)

- **`ignoreInitial`**: Skip initial scan events when starting to watch
  - Default: `false`
  - When `true`, only new changes after watching starts will emit events

- **`throwIfNoEntry`**: Throw immediately if watched path does not exist
  - Default: Node.js default (`true`)

- **`renameTimeout`**: Timeout in milliseconds for rename detection
  - Default: `150ms`
  - How long to wait to detect if separate add/unlink events are actually a rename

## Events

Watchr extends Node.js EventEmitter and emits the following events:

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

All file system events include a `WatchrStats` object containing file metadata.

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

// Check if a path should be ignored
isIgnored(targetPath: string, ignore?: WatchIgnore): boolean

// Access the abort signal for cancellation
get abortSignal(): AbortSignal

// Get a promise that resolves when ready
get readyLock(): Promise<void>

// Access file rename handler
get renameWatchr(): FileRenameHandler
```

### Type Definitions

```typescript
type WatchrOptions = {
  persistent?: boolean;
  recursive?: boolean;
  encoding?: BufferEncoding;
  ignore?: ((filename: string) => boolean) | string | RegExp | Array<string | RegExp | ((filename: string) => boolean)>;
  ignoreInitial?: boolean;
  throwIfNoEntry?: boolean;
  renameTimeout?: number;
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

- Callback ignore (`(filename) => boolean`): native watcher-style matcher.
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
import { Watchr } from 'watchr';

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

## Requirements

- Node.js 22.x or higher
- TypeScript 6.0.0 or higher (for TypeScript projects)

## Why Use the Original Watcher Instead?

The original [`Watcher`](https://github.com/fabiospampinato/watcher) by Fabio Spampinato is:
- **Production-ready** with extensive real-world usage and testing
- **Actively maintained** with regular updates and bug fixes
- **Well-documented** with comprehensive examples and API documentation
- **Battle-tested** across many projects and platforms
- **Feature-complete** with robust edge case handling

This fork was created for personal experimentation with alternative architectural approaches (like inode-based rename detection patterns and event flow redesigns) and should be considered experimental. Unless you have specific needs that align with these experimental features, you'll be better served by the original library.

## Additional Acknowledgments
- [`chokidar`](https://github.com/paulmillr/chokidar) - Popular file watcher that helped shape API design decisions
- [`node-watch`](https://github.com/yuanchuan/node-watch) - Minimalist watcher implementation for reference

## License

MIT © D1g1talEntr0py
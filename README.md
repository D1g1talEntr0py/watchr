# Watchr

[![npm version](https://img.shields.io/npm/v/@d1g1tal/watchr.svg)](https://www.npmjs.com/package/@d1g1tal/watchr)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.x-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0%2B-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://github.com/D1g1talEntr0py/watchr/actions/workflows/test.yml/badge.svg)](https://github.com/D1g1talEntr0py/watchr/actions/workflows/test.yml)
[![Coverage Status](https://coveralls.io/repos/github/D1g1talEntr0py/watchr/badge.svg?branch=main)](https://coveralls.io/github/D1g1talEntr0py/watchr?branch=main)

> **⚠️ Important Notice**: This is a personal fork of [`Watcher`](https://github.com/fabiospampinato/watcher) by [Fabio Spampinato](https://github.com/fabiospampinato), modified to fit specific personal needs and experimentation. **Most users should use the original [Watcher](https://github.com/fabiospampinato/watcher) library instead**, which is actively maintained, battle-tested, and feature-complete.

A modern, TypeScript-first file system watcher built on Node.js native APIs.

## Features

- **Native Performance**: Built on Node.js native `fs.watch` with recursive watching support (Node.js 20.16+)
- **TypeScript First**: Written entirely in TypeScript with comprehensive type definitions
- **Event-Driven Architecture**: Clean, EventEmitter-based API for handling file system events
- **Rename Detection**: Optional detection of file and directory renames with configurable timeouts
- **Abort Signal Support**: Built-in AbortController integration for clean cancellation
- **File Statistics**: Includes file stats with all events for enhanced metadata access
- **Debouncing**: Configurable event debouncing to reduce noise from rapid file changes
- **Cross-Platform**: Works reliably on macOS?, Windows??, and Linux! (Honestly haven't tested much on Windows and I don't own a Mac. Please report any issues if you find platform-specific bugs)
- **Zero Native Dependencies**: Pure TypeScript implementation with no native binaries

## Installation

```sh
// pnpm 🎉
pnpm add @d1g1tal/watchr

// npm 🤷🏽‍♂️
npm install @d1g1tal/watchr
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

- **`debounce`**: Debounce delay in milliseconds for event emission
  - Default: `100ms`
  - Higher values reduce duplicate events but increase latency

- **`ignore`**: Function to filter out unwanted paths
  - Type: `(targetPath: string) => boolean`
  - Return `true` to ignore the path and its children

- **`ignoreInitial`**: Skip initial scan events when starting to watch
  - Default: `false`
  - When `true`, only new changes after watching starts will emit events

- **`renameTimeout`**: Timeout in milliseconds for rename detection
  - Default: `250ms`
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
isIgnored(targetPath: string, ignore?: Ignore): boolean

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
  debounce?: number;
  ignore?: (targetPath: string) => boolean;
  ignoreInitial?: boolean;
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
  debounce: 200,
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

- Node.js 20.16.0 or higher
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
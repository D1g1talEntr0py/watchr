# Watchr Development Guide

## Project Overview
Watchr is a TypeScript-first file system watcher built on Node.js native `fs.watch` API. It features intelligent rename detection via inode tracking, event debouncing, and an EventEmitter-based architecture. Built for Node.js 20.16+.

**Fork Notice**: Personal fork of [`fabiospampinato/watcher`](https://github.com/fabiospampinato/watcher) - modified for experimentation. See [README.md](../README.md) for upstream context.

## Architecture

### Core Component Flow
1. **Watchr** ([src/watchr.ts](../src/watchr.ts)): EventEmitter orchestrating watchers, manages lifecycle and abort signals
2. **FileSystemEventManager** ([src/file-system-event-manager.ts](../src/file-system-event-manager.ts)): Per-folder event handler, manages native `FSWatcher` instances and initial scans
3. **FileRenameHandler** ([src/file-rename-handler.ts](../src/file-rename-handler.ts)): Inode-based rename detection using lock/unlock pattern with configurable timeouts
4. **FileSystemStateManager** ([src/file-system-state-manager.ts](../src/file-system-state-manager.ts)): Tracks stats and inodes, determines event types via bitwise pattern matching (see `determineEvents()`)
5. **FileSystemLocker** ([src/file-system-locker.ts](../src/file-system-locker.ts)): Manages add/unlink locks for matching inode pairs to detect renames

### Supporting Utilities
- **LockResolver** ([src/lock-resolver.ts](../src/lock-resolver.ts)): Static class managing all timed callbacks via single 50ms interval (scalable alternative to N timeouts)
- **RetryQueue** ([src/retry-queue.ts](../src/retry-queue.ts)): File descriptor pressure management - queues operations when approaching `fileDescriptorLimit` (2048)
- **SetMultiMap** ([src/set-multi-map.ts](../src/set-multi-map.ts)): Extended `Map<K, Set<V>>` with custom iterator methods for multi-value tracking

### Rename Detection Pattern
- Uses inode numbers to correlate `unlink` + `add` events within `renameTimeout` (default 250ms)
- Separate locks for files vs directories (`fileLocks`, `directoryLocks`) in `FileSystemLocker`
- Lock resolution pattern: `LockResolver.add(callback, timeout)` for delayed execution, `LockResolver.remove(callback)` to cancel

### Event Flow
```
fs.watch → FileSystemEventManager.onWatcherChange() 
  → FileSystemStateManager.update() 
  → FileRenameHandler.getLockTargetEvent()
  → Watchr.emitEvent() → EventEmitter listeners
```

## Development Conventions

### TypeScript Patterns
- **Type system**: Heavy use of mapped types (`Prettify`, `MergeConstTypes`) and function inference in [src/@types/index.ts](../src/@types/index.ts)
- **Decorators**: `@debounce(ms)` decorator for instance-bound debouncing using WeakMap (see [src/decorators/debounce.ts](../src/decorators/debounce.ts))
- **Constants**: Use `as const` objects for enums (`FileSystemEvent`, `WatcherEvent`) with derived types in [src/constants.ts](../src/constants.ts)
- **Strict mode**: `isolatedDeclarations: true` requires explicit return types on all exported declarations
- **Function types**: Use `Function<P, R>` type utilities, not bare `Function` - see type system in [src/@types/index.ts](../src/@types/index.ts)

### Code Style (ESLint enforced via [eslint.config.js](../eslint.config.js))
- **Indentation**: Tabs only (not spaces) - enforced by ESLint `indent: ['error', 'tab']`
- **Quotes**: Single quotes required - `quotes: ['error', 'single']`
- **Semicolons**: Required except in one-line blocks/classes
- **Unused params**: Prefix with `_` (e.g., `_target: object`) - ESLint `argsIgnorePattern: '^_'`
- **JSDoc**: Required on all public methods/classes (`jsdoc/require-jsdoc`)
- **Method signatures**: Property style `method: () => void` not `method(): void` (enforced by `@typescript-eslint/method-signature-style`)
- **Error formatting**: Use emoji prefixes in error messages (e.g., `throw new Error('🚨 wait must be non-negative.')`)

### Build System
- **TypeScript Compiler (tsc)**: Standard TypeScript compiler for building
- Entry points: All files in `src/` directory
- Output: Individual JS files in `dist/` with declaration files
- Module system: `module: "Preserve"` with `verbatimModuleSyntax: true` for ESM output
- Commands: `pnpm build`, `pnpm build:watch`, `pnpm type-check`

### Testing (Vitest via [vitest.config.ts](../vitest.config.ts))
- **Structure**: Tests in `tests/*.test.ts` mirror `src/*.ts` structure
- **Mocking**: Mock `node:fs.watch` at module level, delegate to actual implementation for real behavior:
  ```typescript
  vi.mock('node:fs', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    return { ...actualFs, watch: vi.fn() };
  });
  watch.mockImplementation((path, options, callback) => {
    const actualFs = require('node:fs');
    return actualFs.watch(path, options, callback);
  });
  ```
- **Async patterns**: Use `await watcher.readyLock` for initialization waits
- **Cleanup**: Always call `watcher.close()` in `afterEach` or finally blocks to prevent handle leaks
- **Test directory**: Create/cleanup `.tmp` directories in `tests/` for file operations
- **Event testing**: Wrap event listeners in promises for async verification
- **Coverage**: Excludes `src/constants.ts` and `src/@types` (configured in vitest.config.ts)
- Run: `pnpm test` (once), `pnpm test:watch` (watch mode), `pnpm test:coverage`

## Key Files
- [src/watchr.ts](../src/watchr.ts): Main class, watcher lifecycle, root path management
- [src/file-system-event-manager.ts](../src/file-system-event-manager.ts): Bridge between fs.watch and internal events
- [src/file-rename-handler.ts](../src/file-rename-handler.ts): Inode lock orchestration for rename detection
- [src/file-system-state-manager.ts](../src/file-system-state-manager.ts): Stats caching, event type determination via bitwise switch
- [src/file-system-locker.ts](../src/file-system-locker.ts): Lock management for add/unlink inode correlation
- [src/lock-resolver.ts](../src/lock-resolver.ts): Scalable timeout management via single interval
- [src/retry-queue.ts](../src/retry-queue.ts): File descriptor pressure handling
- [src/constants.ts](../src/constants.ts): All event types and default values (debounceWait=100ms, renameTimeout=250ms, fileDescriptorLimit=2048)
- [src/@types/index.ts](../src/@types/index.ts): Central type definitions with advanced TypeScript patterns
- [src/decorators/](../src/decorators/): Instance-bound decorators (debounce, timeout)

## Common Patterns

### Adding New Event Handlers
1. Add event constant to `FileSystemEvent` in [src/constants.ts](../src/constants.ts) using `as const`
2. Update `FileSystemStateManager.determineEvents()` bitwise logic for event detection
3. Add handler in `FileRenameHandler.getLockTargetEvent()` if lock coordination needed
4. Emit via `Watchr.emitEvent()` with stats and path(s)

### Lock Coordination for Timed Events
```typescript
// Add to shared interval instead of creating individual timeouts
LockResolver.add(callback, timeout); 
LockResolver.remove(callback); // Cancel before execution
```

### Instance-Bound Decorators
```typescript
@debounce(100) // Uses WeakMap to bind per-instance, not class-wide
async method() { /* ... */ }

@timeout() // Throws if method takes too long
async operation() { /* ... */ }
```

### Testing File Events
```typescript
await watcher.readyLock; // Wait for initialization
const eventPromise = new Promise(resolve => {
  watcher.on('add', (stats, path) => {
    expect(path).toBe(expectedPath);
    resolve();
  });
});
createTestFile('newfile.txt');
await eventPromise;
```

### Custom Data Structures
- Use `SetMultiMap` when tracking multiple values per key (extends `Map<K, Set<V>>`)
- Use `RetryQueue` when operations might hit file descriptor limits

## Dependencies
- **Runtime**: Node.js 20.16+ (requires native recursive watch support)
- **Package Manager**: pnpm (monorepo structure with `pnpm-workspace.yaml`)
- **Dev**: Vitest 4.x for testing, memfs for filesystem mocking
- **Build**: tsbuild (local monorepo dependency - custom TypeScript builder)
- **Linting**: ESLint 9 with TypeScript and JSDoc plugins (flat config format)
- **TypeScript**: 6.0.0-dev.20251220 (nightly build for latest features)

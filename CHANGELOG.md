# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-12-20

### Added
- Initial release of Watchr file system watcher
- Native `fs.watch` based implementation with recursive watching support
- TypeScript-first architecture with comprehensive type definitions
- EventEmitter-based API for handling file system events
- Intelligent rename detection using inode tracking
- Configurable event debouncing (default 100ms)
- Configurable rename detection timeout (default 250ms)
- AbortController integration for clean cancellation
- File statistics included with all events
- Support for watching multiple paths simultaneously
- Ignore function for filtering unwanted paths
- `ignoreInitial` option to skip initial scan events
- Cross-platform support (Linux, macOS, Windows)
- Comprehensive test suite with 100% statement coverage
- Event types: `add`, `addDir`, `change`, `rename`, `renameDir`, `unlink`, `unlinkDir`
- Watcher lifecycle events: `ready`, `close`, `error`, `all`

### Technical Details
- Built on Node.js native `fs.watch` API (requires Node.js 20.16+)
- Inode-based rename detection with lock coordination
- Single-interval lock resolver for performance optimization
- Separate locks for files vs directories
- Bitwise pattern matching for event type determination
- Instance-bound debouncing using WeakMap
- Zero native dependencies

### Credits
- Forked from [Watcher](https://github.com/fabiospampinato/watcher) by Fabio Spampinato
- Modified with alternative architectural approaches for personal experimentation

[1.0.0]: https://github.com/D1g1talEntr0py/watchr/releases/tag/v1.0.0

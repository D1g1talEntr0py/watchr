# 🤖 AGENT Guidelines

This document outlines the core principles, coding standards, and workflow protocols for AI assistants contributing to this project.

---

## 💻 Core Principles

1.  **Clarity and Brevity:** All responses, comments, and documentation must be concise, clear, and easy to understand.
2.  **Performance First:** Code implementation must **always** prioritize performance over readability or other metrics. Use single intervals instead of multiple timeouts, minimize allocations, leverage bitwise operations where appropriate.
3.  **Language:** All code, comments, and documentation must be written in English.
4.  **ESM-Only:** This is an ESM-only project. No CommonJS support. Uses `module: "Preserve"` and `verbatimModuleSyntax: true`.

---

## 📜 Coding Standards

1.  **Code Formatting:** Do **not** change the formatting of any existing code. Adhere strictly to the established style enforced by ESLint.
2.  **Indentation:** Tabs only (not spaces). This is enforced by ESLint `indent: ['error', 'tab']`. Switch case blocks are indented.
3.  **Line Wrapping:** Avoid wrapping lines. Keep lines reasonably within established limits.
4.  **Type Safety:** Prioritize strict type safety. Avoid the `any` type except where explicitly allowed (see `src/@types/index.ts` for the one place it's used). Use specific types to ensure compile-time checks. The project uses `isolatedDeclarations: true` requiring explicit return types on all exported declarations.
5.  **Path Types:** Use simple `Path` string type alias. No branded types are used in this project.
6.  **Documentation:** Write clear JSDoc documentation for all exported APIs and public methods. JSDoc is required by ESLint on all classes, methods, and function expressions.
7.  **Decorators:** The project uses TypeScript stage 3 decorators:
    - `@debounce(ms)` - Instance-bound debouncing using WeakMap (see `src/decorators/debounce.ts`)
    - `@timeout()` - Method timeout enforcement (see `src/decorators/timeout.ts`)
8.  **Error Messages:** Use emoji prefixes in error messages for quick visual identification (e.g., `throw new Error('🚨 wait must be non-negative.')`).
9.  **Method Signatures:** Use property style `method: () => void` not `method(): void` (enforced by `@typescript-eslint/method-signature-style`).
10. **Unused Parameters:** Prefix with `_` (e.g., `_target: object`) - enforced by ESLint `argsIgnorePattern: '^_'`.

---

## 🧪 Testing Protocol

1.  **Test Creation:** Write unit tests for your code. Create test files in `tests/` mirroring the `src/` structure. Focus on public/exported methods and the public contract.
2.  **Test Strategy:** Tackle low-hanging fruit first. Do **not** mock internal (private) methods or implementation details of a class or module. Test the public contract only.
3.  **Test Framework:** Use Vitest 4.x with Node environment. Mock `node:fs` at module level but delegate to actual implementation for real behavior. See `tests/watchr.test.ts` for the pattern.
4.  **Async Testing:** Use `await watcher.readyLock` to wait for initialization. Wrap event listeners in promises for async verification.
5.  **Test Cleanup:** Always call `watcher.close()` in `afterEach` or finally blocks to prevent file handle leaks. Create/cleanup `.tmp` test directories in `tests/` for file operations.
6.  **Test Fixing:** When instructed to fix tests, do not remove or modify existing implementation code. If a bug in the implementation is discovered while fixing a test, report it clearly instead of modifying the source code.
7.  **Code Coverage:**
    * Run `pnpm test:coverage` to check code coverage.
    * Coverage excludes: `src/constants.ts`, `src/@types` (configured in `vitest.config.ts`).
    * If coverage is not 100%, fill in the gaps by adding new tests **to the existing test file** for that source file.
    * If a remaining gap requires complex mocking, make a note of it and move on. We do not add mocks unless they are 100% necessary.
    * Repeat this process until all files are 100% covered or the only remaining gaps absolutely require complex mocking.

---

## 🔧 Tooling & Workflow

1.  **Command Execution:** **NEVER** prefix terminal commands with `cd` to the repository root. Commands are executed from the workspace root by default. If you need to reference files, use relative paths or full paths.
2.  **Dependency Management:** Do not suggest or add new dependencies unless they are critical for the required functionality and no native or existing solution is feasible. This is a zero-dependency runtime project.
3.  **Build Commands:**
    - `pnpm build` - Build using TypeScript compiler (tsc)
    - `pnpm build:watch` - Watch mode for development
    - `pnpm type-check` - Type checking only (no transpilation)
    - `pnpm test` - Run tests once
    - `pnpm test:watch` - Run tests in watch mode
    - `pnpm test:coverage` - Run tests with coverage report
    - `pnpm lint` - Run ESLint on source files

---

## 🏗️ Architecture Notes

1.  **Event-Driven Architecture:** Watchr extends Node.js EventEmitter. Core event flow: `fs.watch` → `FileSystemEventManager.onWatcherChange()` → `FileSystemStateManager.update()` → `FileRenameHandler.getLockTargetEvent()` → `Watchr.emitEvent()`.
2.  **Rename Detection:** Uses inode tracking to correlate `unlink` + `add` events within `renameTimeout` (250ms). Separate locks for files vs directories in `FileSystemLocker`. See `src/file-rename-handler.ts` for the lock/unlock coordination pattern.
3.  **Performance Optimizations:**
    - `LockResolver` uses a single 50ms interval for all timed callbacks instead of creating N separate timeouts (scales better)
    - `FileSystemStateManager.determineEvents()` uses bitwise switch pattern for event type determination
    - `@debounce` decorator uses WeakMap for instance-bound debouncing (not class-wide)
    - `RetryQueue` manages file descriptor pressure by queuing operations when approaching limit (2048)
4.  **Custom Data Structures:** `SetMultiMap` extends `Map<K, Set<V>>` for tracking multiple values per key (used for inode → paths mapping).
5.  **Type System:** Heavy use of mapped types (`Prettify`, `MergeConstTypes`), function type utilities (`Function<P, R>`, `TypedFunction`, `AsyncCallable`), and `as const` for enums. See `src/@types/index.ts`.
6.  **Build System:** Uses standard TypeScript compiler (tsc). Output: individual module files in `dist/` with declaration files. Not bundled.

---

## 📚 Critical Context

- **Fork Origin:** This is a personal fork of [`fabiospampinato/watcher`](https://github.com/fabiospampinato/watcher) for experimentation with alternative architectural approaches.
- **Node.js Version:** Requires 20.16+ for native recursive `fs.watch` support on all platforms.
- **TypeScript Version:** Uses TypeScript 6.0.0-dev.20251220 (nightly) for latest features.
- **Package Manager:** pnpm only. This is part of a monorepo workspace (see `pnpm-workspace.yaml`).
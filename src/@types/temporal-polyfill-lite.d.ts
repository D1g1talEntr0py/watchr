/**
 * Local typing for the root export of `temporal-polyfill-lite`, selected via `compilerOptions.paths`.
 * The package's bundled declarations do not type-check against this project's TypeScript lib (their `Intl`
 * namespace shadows the global one), so only the `Temporal` namespace value is declared here.
 * Importing this entry point never installs anything on `globalThis`.
 */
export const Temporal: typeof globalThis.Temporal;

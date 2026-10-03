# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.5.1](https://github.com/D1g1talEntr0py/watchr/compare/v3.5.0...v3.5.1) - 2026-10-03




### Bug Fixes
* **core:** handle watcher failures across platforms ([76da694](https://github.com/D1g1talEntr0py/watchr/commit/76da694879c47ae0d4af4f27527b2da26cdd241d))

### Bug Fixes
* **core:** watch file parents recursively on macOS ([1965157](https://github.com/D1g1talEntr0py/watchr/commit/1965157167c2fe6f0f32ec7bb3ef7988d39df7e2))








### Tests
* **memory:** preserve probe inodes during churn ([111f100](https://github.com/D1g1talEntr0py/watchr/commit/111f100b41a8ba3bf60ed04a8ae2100613f9cc0c))





## [3.5.0](https://github.com/D1g1talEntr0py/watchr/compare/v3.4.0...v3.5.0) - 2026-10-03



### Features
* **core:** harden watcher behavior and add symlink control ([81988bb](https://github.com/D1g1talEntr0py/watchr/commit/81988bb1d406d3802a69541b849ddbcf56db0e3b))


### Bug Fixes
* **core:** suppress duplicate rename notifications ([0c08aa2](https://github.com/D1g1talEntr0py/watchr/commit/0c08aa2cb6c1d551b15ae6cf3da4846698c13546))




### Documentation
* update usage and development guidance ([b5c95a9](https://github.com/D1g1talEntr0py/watchr/commit/b5c95a9f1d20cf5a168993e87f4711e1c2a6e26f))



### Chores
* **release:** replace semantic-release with git-cliff ([d3f3505](https://github.com/D1g1talEntr0py/watchr/commit/d3f3505d36302c50957d7536d7fd71662289c871))

### Chores
* **deps:** update development dependencies ([d408d45](https://github.com/D1g1talEntr0py/watchr/commit/d408d45b09470992a8e66622db007442a3e07e47))

### Chores
* **build:** bundle runtime and narrow published files ([b75274a](https://github.com/D1g1talEntr0py/watchr/commit/b75274ae5c3fd315ca5482f356cb029826579ada))

### Chores
* **ci:** expand quality gates ([e495051](https://github.com/D1g1talEntr0py/watchr/commit/e49505138a10053429a28631ded150968a0f854a))

### Chores
* **repo:** add contribution and security guidance ([66a3f89](https://github.com/D1g1talEntr0py/watchr/commit/66a3f89a14c06f7d825e4c139cd61845da993c71))

### Chores
* **repo:** ignore generated artifacts ([ffe87c1](https://github.com/D1g1talEntr0py/watchr/commit/ffe87c153a01f9b78f3a3e8ab63ff91dae830f0d))

### Chores
* **ci:** skip dist smoke fixture during lint ([622ce39](https://github.com/D1g1talEntr0py/watchr/commit/622ce398c1513e4a017714219dc6900c366c6b58))

### Chores
* **release:** 3.5.0 [skip ci] ([ad39a13](https://github.com/D1g1talEntr0py/watchr/commit/ad39a13b8b8c49be18f8c03913cdb6a7a04dfc9f))



### Tests
* **bench:** add comparative performance baselines ([b5f98ff](https://github.com/D1g1talEntr0py/watchr/commit/b5f98ff2a768d0f97be41528396d5ef7416f5560))





## [3.4.0](https://github.com/D1g1talEntr0py/watchr/compare/v3.3.0...v3.4.0) - 2026-09-07



### Features
* add abortable operations and disposable resources ([9afc73e](https://github.com/D1g1talEntr0py/watchr/commit/9afc73ecd737f7c6786377d02c420f33db8d6c49))


### Bug Fixes
* preserve event state during delayed processing ([6e7674e](https://github.com/D1g1talEntr0py/watchr/commit/6e7674e5e4239a92f897b5d016044228ffc17ce8))




### Documentation
* document disposal and updated watcher usage ([169432d](https://github.com/D1g1talEntr0py/watchr/commit/169432dbf2d8a18978d05f394cdf862ef64f7d89))



### Chores
* **deps:** upgrade project dependencies ([7e355f9](https://github.com/D1g1talEntr0py/watchr/commit/7e355f93dbe71fd9ee55e9433dfbc55b2e260684))

### Chores
* **build:** reorganize benchmarks and runtime build output ([8415d30](https://github.com/D1g1talEntr0py/watchr/commit/8415d30d70cca47b34a208c57f966eec971e4769))

### Chores
* **release:** run tests during release preparation ([1e02cfc](https://github.com/D1g1talEntr0py/watchr/commit/1e02cfcc54a4b8f5a15b9e67f42be3bc078a9ab4))

### Chores
* **release:** 3.4.0 [skip ci] ([5afa891](https://github.com/D1g1talEntr0py/watchr/commit/5afa891b26295b78d524f161d57c8e39391063ca))







## [3.3.0](https://github.com/D1g1talEntr0py/watchr/compare/v3.2.3...v3.3.0) - 2026-08-27


### Breaking Changes
* **decorators:** enhance timeout decorator to chain AbortSignals ([e760abf](https://github.com/D1g1talEntr0py/watchr/commit/e760abf2a216984d76418fc5bc43c77362729c2d))


### Features
* **file-rename-handler:** cache canonical changed-paths per batch ([7172fd4](https://github.com/D1g1talEntr0py/watchr/commit/7172fd4807aa02eb82f7b62b99dea195357672f2))


### Bug Fixes
* **ci:** remove invalid -s from pnpm parameters and fix broken test ([e0bdc1d](https://github.com/D1g1talEntr0py/watchr/commit/e0bdc1db27993658113fbfbd8ecbf65f4c2dbc71))




### Documentation
* update architecture and feature documentation ([4f9c9c3](https://github.com/D1g1talEntr0py/watchr/commit/4f9c9c3082e16fcff29e8a17119be576e1e6c78d))



### Chores
* bump tooling to pnpm 12.x and Node.js 24.6.0, update dev dependencies ([cb8136b](https://github.com/D1g1talEntr0py/watchr/commit/cb8136b24bfbfbecc46ead3357010666a80d5af0))

### Chores
* **build:** remove unused extension-plugin.ts ([5d132e8](https://github.com/D1g1talEntr0py/watchr/commit/5d132e85df0054e2a5430e60af5700da34b6306d))

### Chores
* **release:** 3.3.0 [skip ci] ([cf2d006](https://github.com/D1g1talEntr0py/watchr/commit/cf2d006729adc3064c5030923d735eb3395e2cb7))


### Code Refactoring
* **file-system:** add bounded concurrency and AbortSignal support ([51e13c9](https://github.com/D1g1talEntr0py/watchr/commit/51e13c9499b014eadd81532a7db4f7f3c444919e))

### Code Refactoring
* **core:** optimize event handling and path detection ([8ca5857](https://github.com/D1g1talEntr0py/watchr/commit/8ca58577308f20cc4a138c8df26a2e049bf000c0))


### Tests
* add comprehensive test coverage for timeout, events, and file system ([d2f75fb](https://github.com/D1g1talEntr0py/watchr/commit/d2f75fb7663ca5c8f858f74ab75101681d5788b1))

### Tests
* improve race-condition and utils test reliability ([a0d2dd0](https://github.com/D1g1talEntr0py/watchr/commit/a0d2dd0165897ed3e8fd008ba223f792ce8230b3))

### Tests
* add fs.watch invocation and comprehensive integration tests ([c9b7181](https://github.com/D1g1talEntr0py/watchr/commit/c9b71812a3af96dfcca2770ea20ea02cc2900800))





## [3.2.3](https://github.com/D1g1talEntr0py/watchr/compare/v3.2.2...v3.2.3) - 2026-08-22




### Bug Fixes
* **ci:** remove windows from ci tests ([65ac36c](https://github.com/D1g1talEntr0py/watchr/commit/65ac36cc85ffb7655cb63900c0b3ab6c69f4caa1))






### Chores
* **release:** 3.2.3 [skip ci] ([1af2f46](https://github.com/D1g1talEntr0py/watchr/commit/1af2f46aceaa9ae2ed46108abeb6047aae264959))







## [3.2.2](https://github.com/D1g1talEntr0py/watchr/compare/v3.2.1...v3.2.2) - 2026-08-22




### Bug Fixes
* **release:** switch to angular preset and update CI ([cbf575d](https://github.com/D1g1talEntr0py/watchr/commit/cbf575d2f6bbc99f19a8f436f8d0069647fcdfa1))






### Chores
* **deps:** bump dev dependencies and pnpm ([c72df25](https://github.com/D1g1talEntr0py/watchr/commit/c72df25ef54d7e4691489052cda825835bb5a817))

### Chores
* **release:** 3.2.2 [skip ci] ([db49120](https://github.com/D1g1talEntr0py/watchr/commit/db49120425d569ac63a9bb81bb07afc05f6449f1))







## [3.2.1](https://github.com/D1g1talEntr0py/watchr/compare/v3.2.0...v3.2.1) - 2026-08-10




### Bug Fixes
* add resolver to determine how to create an instant ([55dee0a](https://github.com/D1g1talEntr0py/watchr/commit/55dee0a901ca3f0936c97bfc765f9efecf667c0d))






### Chores
* **release:** 3.2.1 [skip ci] ([16262a3](https://github.com/D1g1talEntr0py/watchr/commit/16262a3003c24a3a9d83b162506797671d0b87e6))







## [3.2.0](https://github.com/D1g1talEntr0py/watchr/compare/v3.1.0...v3.2.0) - 2026-08-10



### Features
* **stats:** replace bigint timestamps with Temporal.Instant ([5aab409](https://github.com/D1g1talEntr0py/watchr/commit/5aab409e095431d5d63ad48f3f04b2431715b310))



### Performance Improvements
* **core:** use performance.now() for fallback scan timing ([f81e7b5](https://github.com/D1g1talEntr0py/watchr/commit/f81e7b55ef90df2e93e327947dcdd6a8a14ebef5))



### Documentation
* **benchmarks:** add JSDoc comments and inline renameTimeout constant ([a94e31c](https://github.com/D1g1talEntr0py/watchr/commit/a94e31c005649d0bec10d9da81a44cacf9dada61))



### Chores
* **deps:** bump dev dependencies to latest minor versions ([9996941](https://github.com/D1g1talEntr0py/watchr/commit/99969415bc927558627bb080581177e5aabcb260))

### Chores
* **release:** 3.2.0 [skip ci] ([aadeb0e](https://github.com/D1g1talEntr0py/watchr/commit/aadeb0ed00e65ee6419f2b5b463d4a10349c4160))


### Code Refactoring
* **build:** inline declaration transformer and bundle single entrypoint ([660ee78](https://github.com/D1g1talEntr0py/watchr/commit/660ee78345a20ded783973d65e768f36a793ab4c))

### Code Refactoring
* **imports:** use explicit index path for @types imports ([040b4f9](https://github.com/D1g1talEntr0py/watchr/commit/040b4f9c7fa726f5dcea55965a89e80444562f0d))

### Code Refactoring
* **eslint:** simplify config and tighten jsdoc rules ([fadf44d](https://github.com/D1g1talEntr0py/watchr/commit/fadf44d79e2cadd9ce110d8bddbc7915965585eb))






## [3.1.0](https://github.com/D1g1talEntr0py/watchr/compare/v3.0.2...v3.1.0) - 2026-08-08



### Features
* **bench:** add diagnostics benchmark workflow ([eaa689b](https://github.com/D1g1talEntr0py/watchr/commit/eaa689b8627e8ec82673472e7011dde4a0c4a5d3))


### Bug Fixes
* **events:** avoid false rename emission on changed paths ([3411224](https://github.com/D1g1talEntr0py/watchr/commit/34112245bf7ae3d99fc3853cbb9b303db28ec5c8))

### Bug Fixes
* **cache:** keep stats state consistent across renames ([176faef](https://github.com/D1g1talEntr0py/watchr/commit/176faef0e1afff879a2cfd638b740f74bbc78d01))


### Performance Improvements
* **lock-resolver:** use monotonic timing and tunable caps ([88db2cd](https://github.com/D1g1talEntr0py/watchr/commit/88db2cd4ed59974f8937dd632a7f7ac1caa32d5e))

### Performance Improvements
* **watcher:** canonicalize roots and speed subpath checks ([8f04822](https://github.com/D1g1talEntr0py/watchr/commit/8f048220abf80d0e762f2ef5376696f8ae3f4023))





### Chores
* **release:** 3.1.0 [skip ci] ([89488a6](https://github.com/D1g1talEntr0py/watchr/commit/89488a6467165cbada899bcf6e0eb898f033aee6))


### Code Refactoring
* **style:** enforce no dangling commas ([dae82b6](https://github.com/D1g1talEntr0py/watchr/commit/dae82b691257eece59c01c7b3de67e5aebd9f8e0))

### Code Refactoring
* **tests:** align suites with public behavior ([05a4120](https://github.com/D1g1talEntr0py/watchr/commit/05a4120224ffa3147d8600a1a407ed220a11e085))






## [3.0.2](https://github.com/D1g1talEntr0py/watchr/compare/v3.0.1...v3.0.2) - 2026-08-07




### Bug Fixes
* **watcher:** fixes empty-name callback handling ([e406bc7](https://github.com/D1g1talEntr0py/watchr/commit/e406bc7963da99c8818a5c8a7ab0e29e86d3a3f4))

### Bug Fixes
* **poller:** avoids false change events ([11fc99b](https://github.com/D1g1talEntr0py/watchr/commit/11fc99b50d47fe115f15be15ce35873f82ad6500))






### Chores
* **release:** 3.0.2 [skip ci] ([3d7981a](https://github.com/D1g1talEntr0py/watchr/commit/3d7981a34d2bcef002c23544fe6395836ce89f0f))


### Code Refactoring
* **tests:** improves watcher test reliability ([8016b1a](https://github.com/D1g1talEntr0py/watchr/commit/8016b1a27e997e79f42ccabee1dfac4ca7e820a5))






## [3.0.1](https://github.com/D1g1talEntr0py/watchr/compare/v3.0.0...v3.0.1) - 2026-08-07




### Bug Fixes
* watch parent directory for file targets and handle atomic saves ([4dd21af](https://github.com/D1g1talEntr0py/watchr/commit/4dd21af343af9fbf35200dac35b0e2f43c623987))






### Chores
* **release:** 3.0.1 [skip ci] ([12cd129](https://github.com/D1g1talEntr0py/watchr/commit/12cd129e7f3ae15cc115636ee3d7e40823fb78a3))







## [3.0.0](https://github.com/D1g1talEntr0py/watchr/compare/v2.0.2...v3.0.0) - 2026-08-07


### Breaking Changes
* **watchr:** drop direct windows support. Sorry, use WSL if you are on Windows ([754a78d](https://github.com/D1g1talEntr0py/watchr/commit/754a78df3a73d1a6642e6cb5c3cbc93fc5a3aa27))

### Breaking Changes
* **platform:** align validation with unix-only support ([6fe30fa](https://github.com/D1g1talEntr0py/watchr/commit/6fe30faf106e8a89c3ece9a0cd999ac478da2fa6))








### Chores
* **release:** 3.0.0 [skip ci] ([48239f9](https://github.com/D1g1talEntr0py/watchr/commit/48239f94d29f22307074190af395b374f5e80c40))







## [2.0.2](https://github.com/D1g1talEntr0py/watchr/compare/v2.0.1...v2.0.2) - 2026-08-07




### Bug Fixes
* **watcher:** adjust file watching behavior for Windows platform ([9c2a0d6](https://github.com/D1g1talEntr0py/watchr/commit/9c2a0d6697156fba14a57e9167492714144641b1))






### Chores
* **release:** 2.0.2 [skip ci] ([3e7d7fe](https://github.com/D1g1talEntr0py/watchr/commit/3e7d7fe4d00611bea8eadd2c722d758c5f5ea736))







## [2.0.1](https://github.com/D1g1talEntr0py/watchr/compare/v2.0.0...v2.0.1) - 2026-08-07




### Bug Fixes
* **watcher:** close native handle during cleanup ([94db663](https://github.com/D1g1talEntr0py/watchr/commit/94db663b484ce291f5afca9691be9f62c0017524))






### Chores
* **tests:** disable recursive watching in FileSystemEventManager tests and ensure cleanup after each test ([f04a0d1](https://github.com/D1g1talEntr0py/watchr/commit/f04a0d1587c966dccbcb3bf67913579016904a5b))

### Chores
* **ci:** align matrix with active node versions ([c9eb55d](https://github.com/D1g1talEntr0py/watchr/commit/c9eb55d6b231b47f4b8828c79e9e235016ecd722))

### Chores
* **release:** 2.0.1 [skip ci] ([d17b268](https://github.com/D1g1talEntr0py/watchr/commit/d17b268f2455eaa2ab3f3e63eeb33d3dce204626))







## [2.0.0](https://github.com/D1g1talEntr0py/watchr/compare/v1.2.0...v2.0.0) - 2026-08-07


### Breaking Changes
* **api:** remove debounce and queue options ([631a728](https://github.com/D1g1talEntr0py/watchr/commit/631a7282107473d62f4b188d1353972cb2486b7b))



### Bug Fixes
* **events:** coalesce batch flush and simplify rename timing ([2b80621](https://github.com/D1g1talEntr0py/watchr/commit/2b8062190ed3fb537868e3df9bc85a52f6fdfa1e))

### Bug Fixes
* **readiness:** reject lock when closed before ready ([2d1df5e](https://github.com/D1g1talEntr0py/watchr/commit/2d1df5e699c317416f8a2264ea2f158d06d0e7cf))


### Performance Improvements
* **benchmarks:** align harness with built runtime ([7059745](https://github.com/D1g1talEntr0py/watchr/commit/7059745b80980e149c9f7786e24e3315b128e504))





### Chores
* **deps:** update dev dependencies to latest versions ([865da69](https://github.com/D1g1talEntr0py/watchr/commit/865da69ea6699d6e80d417bbddec64feacd11772))

### Chores
* update esbuild config to disable legacy decorator support and change Vitest pool to threads ([991cfa0](https://github.com/D1g1talEntr0py/watchr/commit/991cfa09ea9fe9cd17284ef56c7c7b7a596f78f2))

### Chores
* **docs:** update README and settings for clarity and consistency ([5797e58](https://github.com/D1g1talEntr0py/watchr/commit/5797e588d98fddc0ae66e8cfa00debffb9de2a98))

### Chores
* **release:** 2.0.0 [skip ci] ([92db6f3](https://github.com/D1g1talEntr0py/watchr/commit/92db6f3b10fe8a9be69dc026d274348560e0caa0))





### Continuous Integration
* fix windows platform tests ([850f565](https://github.com/D1g1talEntr0py/watchr/commit/850f565ad4632f4951a23771d3ae49b44b6a002e))



## [1.2.0](https://github.com/D1g1talEntr0py/watchr/compare/v1.1.1...v1.2.0) - 2026-08-02



### Features
* feat!(watchr): align ignore and options with native node watcher ([7089780](https://github.com/D1g1talEntr0py/watchr/commit/7089780b356deff8de5ad767f57adb2cbeaf9a82))

### Features
* **deps:** update dependencies and lockfile ([30f18c1](https://github.com/D1g1talEntr0py/watchr/commit/30f18c1e3cf92e5a553783536048ddfd993c1593))


### Bug Fixes
* **rename:** prioritize add locks for rename detection ([098a10c](https://github.com/D1g1talEntr0py/watchr/commit/098a10c7c3e0bcaeeada2c06be1692dfb98c7406))


### Performance Improvements
* add benchmark suites ([5a2fe0d](https://github.com/D1g1talEntr0py/watchr/commit/5a2fe0d47129dd05fb57dee69e504bc7224e5ca6))





### Chores
* **release:** 1.2.0 [skip ci] ([b43bbca](https://github.com/D1g1talEntr0py/watchr/commit/b43bbca1083a0331e2199be664059fbbc7a8fa49))


### Code Refactoring
* **event-manager:** optimize event batching and deduplication ([e9267f7](https://github.com/D1g1talEntr0py/watchr/commit/e9267f75fa37a43f58e32f868f4fecf2733c9251))

### Code Refactoring
* **file-system:** use native recursive reading where possible ([48f57bb](https://github.com/D1g1talEntr0py/watchr/commit/48f57bbe9600478613e1795c97b973d262ad0617))






## [1.1.1](https://github.com/D1g1talEntr0py/watchr/compare/v1.1.0...v1.1.1) - 2026-06-25




### Bug Fixes
* removed race condition during shutdown ([61b831b](https://github.com/D1g1talEntr0py/watchr/commit/61b831ba94843b5ebb24e8ed69a6d9d0e90fcd01))






### Chores
* **ci:** fix failing test in GitHub actions and remove old eslint.config.js ([731085d](https://github.com/D1g1talEntr0py/watchr/commit/731085d3158c541f0021ef93375fa2d68a1c8dac))

### Chores
* **release:** 1.1.1 [skip ci] ([3fe7f14](https://github.com/D1g1talEntr0py/watchr/commit/3fe7f1447d7e7fc1be02e8f7ebece5973888806d))







## [1.1.0](https://github.com/D1g1talEntr0py/watchr/compare/v1.0.7...v1.1.0) - 2026-06-25



### Features
* **stats:** add change timestamps and equality comparator to WatchrStats ([1e6308f](https://github.com/D1g1talEntr0py/watchr/commit/1e6308f5bd00a4009e655339e76ba99ec24f4610))


### Bug Fixes
* **watchr:** handle missing error codes and clean up decorator types ([8f26da3](https://github.com/D1g1talEntr0py/watchr/commit/8f26da3ea47bdd173b05f9a5da9cb68fd0121d35))


### Performance Improvements
* **bench:** rewrite benchmark suite to use native fs.watch and vitest ([06f9436](https://github.com/D1g1talEntr0py/watchr/commit/06f94365c0c21d0ebe9e5d7032715fac06b991e7))





### Chores
* **tooling:** set up tsconfig tooling and migrate eslint config to typescript ([f97e211](https://github.com/D1g1talEntr0py/watchr/commit/f97e2111be0c7be4e224367f1c6a505cba534cfa))

### Chores
* **deps:** upgrade dependencies and prune benchmark packages ([d8d3b43](https://github.com/D1g1talEntr0py/watchr/commit/d8d3b430f179cb00a632a858c4bd2b264841ec3f))

### Chores
* **release:** 1.1.0 [skip ci] ([ff152fd](https://github.com/D1g1talEntr0py/watchr/commit/ff152fd49e95ccaf6fb36e77b4be19a5bccc6130))





### Continuous Integration
* **compat:** added check for closed or aborted before throwing an error ([3261c0b](https://github.com/D1g1talEntr0py/watchr/commit/3261c0bdce8c7fecdc9dda123166d7bb776572e0))



## [1.0.7](https://github.com/D1g1talEntr0py/watchr/compare/v1.0.6...v1.0.7) - 2026-06-21





### Performance Improvements
* **core:** parallelize directory traversal for improved latency ([8d0529f](https://github.com/D1g1talEntr0py/watchr/commit/8d0529f2cd43bb090641e27bcd10f3eb401c3517))





### Chores
* **release:** 1.0.7 [skip ci] ([bd126d1](https://github.com/D1g1talEntr0py/watchr/commit/bd126d132caf36f97413f6dbc4373f4707504a20))


### Code Refactoring
* **ts:** tighten type safety and modernize promise helpers ([3aa8487](https://github.com/D1g1talEntr0py/watchr/commit/3aa84873d20de8d08d73d874f67ef8a8c4d5e502))

### Code Refactoring
* refactor(ts): enforce exact optional property semantics
TypeScript strictness hardening, optional-property handling cleanup, and a regression test for the stricter contract. ([c0682c7](https://github.com/D1g1talEntr0py/watchr/commit/c0682c71251e77aaad13fa6b924d8ce581524d87))





### Other Changes
* **core:** harden error surfaces, validate options, and bound resolver growth ([58ebf3d](https://github.com/D1g1talEntr0py/watchr/commit/58ebf3debc4d7dbfbbde744f0e1a62279826b02f))

### Other Changes
* **state:** bound inode event tracking and prevent duplicate all-event listeners ([d275d03](https://github.com/D1g1talEntr0py/watchr/commit/d275d03fee26b081c9be143f992dfeaa5fc0baf7))

### Other Changes
* **watchr:** harden ignore callback failure handling and sanitize unsupported-target errors ([856acd0](https://github.com/D1g1talEntr0py/watchr/commit/856acd0bc53ea58fb77879b15be5b0391fc5af37))

### Other Changes
* **fs:** bound getStats retries to prevent unbounded retry loops ([9dca4d0](https://github.com/D1g1talEntr0py/watchr/commit/9dca4d04ba4f28f45036e15b011a8716d80016f5))

### Other Changes
* **rename:** surface lock resolver overflow instead of silently dropping callbacks ([91f23fc](https://github.com/D1g1talEntr0py/watchr/commit/91f23fc5b466da413192ee1cfabb2906e24586bf))

### Other Changes
* **lock-resolver:** warn when pending resolver callbacks are evicted ([38cf0e8](https://github.com/D1g1talEntr0py/watchr/commit/38cf0e82867d6ffdca3607f92ca342ab2d86700c))

### Other Changes
* **event-manager:** remove watcher listeners on close ([f4c44cb](https://github.com/D1g1talEntr0py/watchr/commit/f4c44cb16d0b96ca7ba3cc0a596b65d80c9e7026))

### Other Changes
* **watchr:** wrap user event handlers and surface failures as errors ([a7c7994](https://github.com/D1g1talEntr0py/watchr/commit/a7c7994a6136d3c594634945990979243faa363b))


## [1.0.6](https://github.com/D1g1talEntr0py/watchr/compare/v1.0.5...v1.0.6) - 2026-04-07




### Bug Fixes
* **deps:** bump vite to patch CVE-2026-39363 ([b256b5c](https://github.com/D1g1talEntr0py/watchr/commit/b256b5c88eee8294d1f58a28f0537ad2bf8d91f1))






### Chores
* update project configuration ([8b73b14](https://github.com/D1g1talEntr0py/watchr/commit/8b73b1440aa99e963c9844f1fa80d72e80615f55))

### Chores
* **release:** 1.0.6 [skip ci] ([c2d92dd](https://github.com/D1g1talEntr0py/watchr/commit/c2d92dd63b01dd4de45f77d7968bcaa5499fbe5d))


### Code Refactoring
* enforce isolated declarations and explicit return types ([0f1d722](https://github.com/D1g1talEntr0py/watchr/commit/0f1d722274762222299678fbdbc99f27e244cb91))






## [1.0.5](https://github.com/D1g1talEntr0py/watchr/compare/v1.0.4...v1.0.5) - 2026-03-27




### Bug Fixes
* Resolves compilation issues and improves typings ([cb479a2](https://github.com/D1g1talEntr0py/watchr/commit/cb479a28ca7f45410b48a3cf76592cc3f230c2c3))




### Documentation
* update readme with ts version and package managers ([a8c1459](https://github.com/D1g1talEntr0py/watchr/commit/a8c1459f66b08028260f52858e22b0f07a9dbcfb))



### Chores
* update vscode workspace settings ([dcb3e0b](https://github.com/D1g1talEntr0py/watchr/commit/dcb3e0bcb472a325f22acf1764f526b7b35a29f0))

### Chores
* **release:** 1.0.5 [skip ci] ([adaefdc](https://github.com/D1g1talEntr0py/watchr/commit/adaefdc9bb0d2346f2af3e83b6658c3a39fdac43))


### Code Refactoring
* remove explicit return types and rely on inference ([c700295](https://github.com/D1g1talEntr0py/watchr/commit/c7002953b5d2fbb8ae7bb6694c32c7e14d137315))



### Build System
* migrate to typescript 6 and update dependencies ([feaae2c](https://github.com/D1g1talEntr0py/watchr/commit/feaae2ce56ce73dd2349b44c1e46df896d99e225))


### Continuous Integration
* update github actions versions ([650fea4](https://github.com/D1g1talEntr0py/watchr/commit/650fea455a646a9003e6c24bb64bb2ff6756a6a5))



## [1.0.4](https://github.com/D1g1talEntr0py/watchr/compare/v1.0.3...v1.0.4) - 2026-03-18




### Bug Fixes
* **security:** patch CVE-2026-32141 ([a1b1595](https://github.com/D1g1talEntr0py/watchr/commit/a1b1595de1b65d7e4defb7f791a09deba0903bfb))






### Chores
* cleanup files ([32217d2](https://github.com/D1g1talEntr0py/watchr/commit/32217d28107210f915858e438066cbe3c2ffff8b))

### Chores
* **deps:** update developer dependencies and tooling configurations ([d9873a4](https://github.com/D1g1talEntr0py/watchr/commit/d9873a4e9608c3ed1ed5b091dff0004dab3ee9ae))

### Chores
* **release:** 1.0.4 [skip ci] ([1e6a45e](https://github.com/D1g1talEntr0py/watchr/commit/1e6a45e7574032a6b6a2c5397776ced6d06fa288))





### Continuous Integration
* bump GitHub Actions workflow versions ([69d5bcd](https://github.com/D1g1talEntr0py/watchr/commit/69d5bcdab3636b85730cab2049fe01c11e0fb30e))



## [1.0.3](https://github.com/D1g1talEntr0py/watchr/compare/v1.0.2...v1.0.3) - 2026-03-07




### Bug Fixes
* clear the restore timeout resources in the close() method ([344870c](https://github.com/D1g1talEntr0py/watchr/commit/344870c0f55833412531db723a8759714d52173b))






### Chores
* **ci:** add commit message git hook ([b3f7b99](https://github.com/D1g1talEntr0py/watchr/commit/b3f7b99b0a1398411f7dc8b8a61b8f46adadb1fd))

### Chores
* **release:** 1.0.3 [skip ci] ([b1199ac](https://github.com/D1g1talEntr0py/watchr/commit/b1199ace8682de761b7f31a6fac802976746da49))







## [1.0.2](https://github.com/D1g1talEntr0py/watchr/compare/v1.0.1...v1.0.2) - 2026-03-07




### Bug Fixes
* **release:** added --no-git-checks to config ([cf3c69a](https://github.com/D1g1talEntr0py/watchr/commit/cf3c69acc7bd306c1492ac7fc63d36e30720708f))






### Chores
* **release:** 1.0.2 [skip ci] ([51c8506](https://github.com/D1g1talEntr0py/watchr/commit/51c850653b396d0967ddf83188a332365ef3bfef))







## [1.0.1](https://github.com/D1g1talEntr0py/watchr/compare/v1.0.0...v1.0.1) - 2026-03-07




### Bug Fixes
* **deps:** bump eslint and related packages ([ab85911](https://github.com/D1g1talEntr0py/watchr/commit/ab85911f797a1f6487dd0213a87c571585cf3929))

### Bug Fixes
* **deps:** bump @types/node, memfs and transitive packages ([b9338f2](https://github.com/D1g1talEntr0py/watchr/commit/b9338f240b3d1be4d1f7b55140c864285c67f641))

### Bug Fixes
* **build:** fixed broken import ([01101f3](https://github.com/D1g1talEntr0py/watchr/commit/01101f32ac74b9f7797c29645d4124b7077173ae))

### Bug Fixes
* **release:** updated config to use pnpm ([a1383a0](https://github.com/D1g1talEntr0py/watchr/commit/a1383a0aaa98591fcb87a5adbb3613bc9f0202dc))




### Documentation
* update release process and version references ([4840b90](https://github.com/D1g1talEntr0py/watchr/commit/4840b902e5d977de3ed95c71524f4a9b1e6f3110))

### Documentation
* remove outdated manual release workflow ([0b2a1c1](https://github.com/D1g1talEntr0py/watchr/commit/0b2a1c17d908f86f8ec4c9e2f585625f2f88cdff))



### Chores
* bump dev dependencies and lockfile ([462f667](https://github.com/D1g1talEntr0py/watchr/commit/462f66744503861873bba4cdcfbf7065f1377055))

### Chores
* removing old tooling cache ([00ef475](https://github.com/D1g1talEntr0py/watchr/commit/00ef475a6e1ca87eb63e87c9bc3362f7e5965499))

### Chores
* update README.md to use new coverage provider ([d000c44](https://github.com/D1g1talEntr0py/watchr/commit/d000c44e36ee5f4d642f6a68eab9b5fe125fff9a))

### Chores
* **release:** 1.0.1 [skip ci] ([95314ad](https://github.com/D1g1talEntr0py/watchr/commit/95314adb2c4ea550b2a8388f197c202cbd7b4e79))


### Code Refactoring
* **release:** add lint and build to prepare step ([8552ef3](https://github.com/D1g1talEntr0py/watchr/commit/8552ef39658f68b811493c8a7085dea9fa4b9b02))

### Code Refactoring
* **package:** reorganise metadata and release scripts ([d9db018](https://github.com/D1g1talEntr0py/watchr/commit/d9db0181ea9299dfff560f8afaa07ab9168611fe))

### Code Refactoring
* **build:** fix import path and simplify plugin logic ([bbfeefd](https://github.com/D1g1talEntr0py/watchr/commit/bbfeefd732b23bc042bc64bd7386f05d1aa38a62))

### Code Refactoring
* **tsconfig:** update compile target to ESNext ([098b82a](https://github.com/D1g1talEntr0py/watchr/commit/098b82abd86d9aa7248819f6dd8c3a7661928340))




### Continuous Integration
* add CI workflow and migrate to semantic-release ([7450c93](https://github.com/D1g1talEntr0py/watchr/commit/7450c93d6a6b1ad2200f6e679f39c80b6c86c2a3))

### Continuous Integration
* removed old test.yml GitHub action ([87f9021](https://github.com/D1g1talEntr0py/watchr/commit/87f9021f2158dfe8685852235e140cf319920566))

### Continuous Integration
* add better test matrix ([5e1fffb](https://github.com/D1g1talEntr0py/watchr/commit/5e1fffb3b97c0a2654f7f938642fe09e13d9c175))



## [1.0.0](https://github.com/D1g1talEntr0py/watchr/compare/...v1.0.0) - 2026-02-08









### Chores
* prepare for npm publishing ([81a89e5](https://github.com/D1g1talEntr0py/watchr/commit/81a89e526db14b6d22cc33bf7f357ff683c16c73))

### Chores
* update lockfile after removing tsbuild override ([cb5ed5d](https://github.com/D1g1talEntr0py/watchr/commit/cb5ed5df4b9e9c0b1929d9163b20abfe7a610b7a))

### Chores
* update NodeJS version in package.json ([0b1314d](https://github.com/D1g1talEntr0py/watchr/commit/0b1314dd09531a31e704e7f72f9bfd3671db5b1d))

### Chores
* require Node 22+ and enforce LF line endings ([2bce564](https://github.com/D1g1talEntr0py/watchr/commit/2bce564dec273e8aa3fc0697a1018e4c304126d7))

### Chores
* normalize all line endings to LF ([dfd8697](https://github.com/D1g1talEntr0py/watchr/commit/dfd8697217ef01986e78ef48346c8d1f31bacca6))

### Chores
* fix node version on badge ([f5a906d](https://github.com/D1g1talEntr0py/watchr/commit/f5a906ded3536db51ea37af6a790f5464ee4e726))



### Tests
* fix Windows path separator and ordering issues ([32e8ffc](https://github.com/D1g1talEntr0py/watchr/commit/32e8ffcef5441a8bb1d2b0394d336ec327188b57))



### Continuous Integration
* use Node 20.x instead of hardcoded 20.16.0 ([8b28088](https://github.com/D1g1talEntr0py/watchr/commit/8b280886727237b8333d12373400263e8c8ffa98))



# UX Refactor Benchmark Validation

## Follow-Up: Regression Investigation

2026-10-14. The tested cleanup optimization **did not reproduce** the earlier external-variant speedup in the one planned acceptance series, so it was reverted. Production retains the unoptimized implementation, runtime hash `d4cdbeb3fa32871afcbe2132b28fd722485834c2de0dfcde07b367912fd7ac0c`. No reruns or sample exclusions; no performance acceptance claim. Historical evidence and the rejected candidate are preserved below.

### Scope And Provenance

The rejected candidate changed only close behavior: mutable handler registry replaced with `{}` after capturing `closeEntry`; capture `wasStarting` before closing, create/reject the cancellation Error only during startup, and always reset the reject callback. All other source files matched the preserved unoptimized current. Only that tentative code change was reverted; pre-existing user changes were preserved. The investigation retains this report, the README summary, and external build/results; no production optimization remains.

Root `R=/tmp/watchr-ux-fWJhOlM2`; unoptimized `U=$R/candidate-investigation-20261014`; optimized `O=$R/candidate-cleanup-optimized-20261014`; isolated staging `$R/build-cleanup-optimized-20261014`.

| Artifact | SHA-256 |
| --- | --- |
| Preserved unoptimized runtime | `d4cdbeb3fa32871afcbe2132b28fd722485834c2de0dfcde07b367912fd7ac0c` |
| Actual optimized runtime | `1c5a3f3b1bc116d705362d0fbb3047ed2635b0f7ddb27fde8acc4a372658ede6` |
| Optimized source map | `f1f768bf6250b96eddf9d91b2dd19ae768565425ced5c32acd5f1c1fa42044a3` |

Isolated runtime/declaration build and every embedded source-map source hash passed. Package/lockfile hashes match U exactly; private dereferenced runtime dependencies match. Source comparison proves exactly the four requested edits. Parsed runtime tokens match the earlier external variant after exchanging the independent capture declarations; only trivia/generated comments otherwise differ. Workspace dist was not rebuilt or measured. Protected-file and earlier-artifact hash checks passed; older results, including anomalous samples, remain intact.

### Actual Production Results

Ten alternating pairs, fresh children, 5k flat files, 100 serial creates/writes each plus 500-event bursts each, concurrency 32, same workload/GC/warmup as the earlier variant series. Both APIs explicitly configured; timing is the synchronous `watcher.close()` call, with no timed await. Node v26.11.1, Linux/WSL2, warm tmpfs; no concurrent heavy tasks launched here. Optional 20k extension omitted; dispatch is unchanged and no additional throughput suite was needed.

| Close Summary | Unoptimized us | Optimized us | Optimized/Unoptimized |
| --- | ---: | ---: | ---: |
| Aggregate medians | 230.001 | 237.881 | 1.034261 (+3.426%) |
| Observed min-max | 222.626-259.186 | 219.945-282.007 | paired 0.888505-1.233168 |

Difference of aggregate medians: **+7.880 us**. Median paired delta: **+6.981 us**; median paired ratio 1.030431. Optimized faster in 4/10 pairs. These summaries are distinct; observed slowdown does not establish a universal regression or negate the removed work.

| Pair | Unoptimized us | Optimized us | Delta us | Ratio |
| --- | ---: | ---: | ---: | ---: |
| 1 | 247.545 | 219.945 | -27.600 | 0.888505 |
| 2 | 228.685 | 282.007 | +53.322 | 1.233168 |
| 3 | 259.186 | 237.056 | -22.130 | 0.914617 |
| 4 | 227.276 | 238.706 | +11.430 | 1.050291 |
| 5 | 230.116 | 238.816 | +8.700 | 1.037807 |
| 6 | 228.045 | 233.506 | +5.461 | 1.023947 |
| 7 | 229.886 | 228.946 | -0.940 | 0.995911 |
| 8 | 230.285 | 238.786 | +8.501 | 1.036915 |
| 9 | 241.176 | 237.026 | -4.150 | 0.982793 |
| 10 | 222.626 | 247.875 | +25.249 | 1.113414 |

Secondary memory only: retained-heap median 2,491,672 -> 2,497,520 bytes (+5,848, +0.235%); ranges 2,291,000-2,635,768 / 2,289,048-2,636,016. Cleanup residual median 376,860 -> 381,972 bytes (+5,112), including collector/runtime/JIT state, not a leak estimate. Neither retained-memory improvement nor absence of leaks is established.

Audits: 6,000 expected add and change deliveries per artifact, zero errors, missing/pending, duplicates, unexpected initial or post-close callbacks; all twenty close states terminal and signals aborted. HOWEVER, optimized run 6 recorded 601 changes versus 600 expected (one unexpected live change). Control totals were 6,000/6,000; optimized 6,000/6,001. Earlier external-variant comparison ALSO retains its extra change in unmodified current control run 7. The collector stores no unexpected-event path; cause/patch attribution is unavailable. This is not a clean zero-unexpected-live acceptance.

### Remaining Emitter Differences

Separate historical synchronous-close series: original emitter -> unoptimized current 206.95 -> 236.61 us (+28.65 us median paired delta); current -> external variant 239.64 -> 223.59 us (-10.77 us median paired delta). Do not compare these different series with the new 237.881 us as a causal optimized-versus-emitter estimate. Actual production did not confirm the earlier variant gain.

Historical emitter-versus-unoptimized-current throughput reruns from `$U/INVESTIGATION.md`:

| 20k Workload | Create events/s Before -> After | Change | Write events/s Before -> After | Change |
| --- | ---: | ---: | ---: | ---: |
| 10 pairs, burst 500 | 11,363 -> 11,203 | -1.4% | 13,324 -> 13,679 | +2.7% |
| 7 pairs, burst 2000 | 13,715 -> 13,398 | -2.3% | 15,409 -> 14,483 | -6.0% |

Paired ratio ranges create/write: burst500 0.948-1.114 / 0.886-1.234; burst2000 0.861-1.031 / 0.732-1.037. Exploratory paired-bootstrap 95% median-ratio intervals respectively 0.975-1.014 / 0.935-1.123 and 0.865-1.021 / 0.844-1.032. Small, noisy, not equivalence evidence. The original roughly 8% deficit is not stable in the original workload, but longer-burst adverse write throughput remains unresolved. Do not pool workloads or attribute these reruns to the close patch.

Historical isolated dispatch: emitter 15.20 -> current 36.96 ns/event; lazy reporting 36.89, lazy reporting plus direct/no-array calls 36.88. No measured invocation benefit supports dispatch changes. Preserve immutable frozen payloads, throw safety and async rejection observation. V8 may remove apparent source-level allocations; these loops are not allocation profiles or evidence about async/cold paths.

Historical instrumented close-stage medians: abort/native closure ~144 us, manager/native cleanup ~20, registry deletion ~10, cancellation Error ~8, rename/state reset ~5. Native abort work dominates; stage clocks perturb execution and cannot be subtracted from uninstrumented totals. Neither deferred native teardown nor kernel reclamation is timed. Registry replacement avoids enumeration/deletion but adds one empty object; conditional Error creation avoids unnecessary work outside startup (also present in the emitter baseline). No new cache or supported speed/memory gain.

### Commands And Checks

The preserved external run logs contain the exact build, synchronous-close comparison, analysis, and report-check commands. The comparison used both configured APIs, 5k files, ten alternating pairs, 100 serial operations, and 500-event bursts; results are in `paired-production-close-10.json` under O.

Raw JSON and matching `.samples.jsonl`, `acceptance-analysis.json`, `snapshot.json`, `build-verification.json`, and `report-checks.json` are under O; staging retains build logs. Build completed once; validation-tool fixes required the acceptance driver's `--verify-existing` option to check that existing build, not rebuild or repeat measurements. Main reports 33 focused lifecycle/listener/memory tests plus typecheck/scoped lint passing; this benchmark task did not rerun those gates. Local report checks verify figures, anomalies and byte-for-byte preservation of the historical body.

External scripts use fixed paths/output names; use new directories/output names for reproduction, never overwrite preserved evidence or run package managers inside archives. `/tmp` is ephemeral: retain the complete artifact tree elsewhere for durable reproduction. Single-machine warm-cache measurements, no affinity/load telemetry or cross-platform/full-coverage acceptance here. No further production optimization recommended from these results; close speed acceptance and unexplained extra live changes remain unresolved.

## Historical Final And Superseded Evidence

Date: 2026-10-14. This report compares the preserved original emitter build with the FINAL constructor-handler candidate, not historical advertised benchmark numbers. No source optimization was made. Final results supersede the initial candidate measurements, which remain archived separately.

## Migration And Scope

- Migrated [compare.ts](../tests/benchmarks/compare.ts), [readiness.bench.ts](../tests/benchmarks/readiness.bench.ts), and [watchr.bench.ts](../tests/benchmarks/watchr.bench.ts) to `emitInitial: false`, constructor handlers, and awaited `start()`.
- The comparison adapter maps ordinary event objects and rename `from`/`to` explicitly. Remaining emitter calls belong only to chokidar and native `fs.watch`.
- The internal microbenchmark uses a temporary file-backed bundle, removed immediately after import. Startup samples close in `finally`; no private Watchr methods or replacement public internals were introduced.
- Existing benchmark helpers and fixture shapes/counts remain unchanged. The final refresh edited only this report and the owned temporary artifacts; no source, benchmark, test, README, package or lockfile edits, dependency changes, commits, reverts, or tracked machine baseline updates were made.
- The core owner repaired three review issues after the initial snapshot: release raw and compiled ignore references on close, validate removed/unknown runtime options, and reject fatal startup if the root disappears during inventory. This final snapshot includes those repairs; the paired workload does not directly test those failure paths.

## Reproduction And Artifacts

Baseline artifact: `/tmp/watchr-ux-fWJhOlM2` (preserved package metadata, dist and private dependency copy).
Final candidate artifact: `/tmp/watchr-ux-fWJhOlM2/candidate-final-20261014`.
Isolated build staging: `/tmp/watchr-ux-fWJhOlM2/build-final-20261014`.
Raw paired report: candidate artifact `paired-results-5runs.json`; incremental samples: `paired-results-5runs.json.samples.jsonl`; console log: `paired-results-5runs.log`.
Derived distributions, paired ratios and provenance checks: candidate artifact `analysis.json`. Snapshot source hashes and source-map verification: `snapshot.json`.
Build/preservation checks: `build-verification.json`; final report/provenance/audit checks: `report-checks.json`. The previous report is retained verbatim as final artifact `superseded-report.md`. All original `candidate-20261014` files, including its raw results and analysis, remain unchanged and superseded, not pooled into this series.

Exact executed build, paired comparison, summary, and provenance-check commands are retained in the external run logs. The final series used the configured candidate API, 5k/20k file sizes, five alternating pairs per size, 100 serial operations, and 500-event bursts, with exposed GC. Use the repository's [benchmark entry points](../README.md#performance) for current ESM tooling.

Build staging, snapshot and result outputs must use new directory names on reproduction; the build helper intentionally refuses an existing staging directory. Original `baseline.json`, its JSONL, earlier probes and self-checks remain intact. The baseline runtime is unchanged, but baseline samples were freshly paired with the final candidate, not reused from the previous series. Adapter probe and workflow smoke results remain separate.

The unchanged paired harness uses emitter tuples and `ignoreInitial: true` for baseline alone; candidate uses `emitInitial: false` and object callbacks, with no emitter fallback. Candidate startup must return the same instance in `watching` state. The snapshot helper copies sources and checks every embedded source-map source against the build input. Final build staging copies current source/config/metadata and uses the workspace toolchain only for building; measured archives have private dereferenced runtime dependencies. No package manager was run in either archive. The summary helper accepts candidate/build paths; calculations are unchanged.

Provenance SHA-256:

| Item | Hash |
| --- | --- |
| Baseline runtime | `76cef8d1f782161765439d4056cd8b4ed85b3c1e7fecaf95fd81bb3f6ac7999d` |
| Final candidate runtime | `d4cdbeb3fa32871afcbe2132b28fd722485834c2de0dfcde07b367912fd7ac0c` |
| Superseded candidate runtime | `68830c0b20843bde18c1e11dbb416a1578debb03bdb278d21a48bb9297f25755` |
| Paired harness | `748f0744ec0a66add748cf6db3f650cafe6990e819a976f7dde94fc14845dc5b` |
| Matching package metadata | `fe8dbb66992c2bbb27d3754b070d806f006956ab6b4aca764c37e6afc3f25f42` |
| Matching lockfile | `4068d26214b42a91f8fc4607f63dbc574642e57ab760e45188ad67278e37ea87` |

Both artifacts retain their exact `type: module` package metadata; package and lockfile hashes match byte-for-byte, including current workspace metadata. Private dereferenced temporal-polyfill-lite 0.4.3 dependency inventories match exactly. Snapshot source hashes match current workspace sources; embedded source-map contents and isolated build/runtime hashes match. The workspace dist was neither rebuilt nor used for final measurements. The measured harness hash is identical to the superseded series. This avoids metadata-free artifact/module-format and shared-node_modules contamination.

## Workload And Method

Machine: Node v26.11.1, V8 14.6.202.34-node.37, Linux x64 WSL2 kernel 6.18.54.1-microsoft-standard-WSL2, host quasar, AMD Ryzen 9 9950X, 28 logical CPUs exposed, 33,653,084,160 bytes RAM. `/tmp` is tmpfs. `UV_THREADPOOL_SIZE` and `NODE_OPTIONS` were unset. JSON retains the executable, cwd, environment and timestamps.

Five fresh child processes per artifact per size, twenty measured samples total; alternate baseline/candidate order each pair. Each child imports once, opens/closes a separate 256-file warmup, then builds a flat 5k or 20k fixture with five-byte files. Recursive watching is enabled; initial events are disabled. Startup includes constructor plus awaited start, excluding module import and fixture creation.

Each sample performs 100 serial creates and 100 distinct-file writes, separated by 20 ms, followed by 500 distinct creates and 500 writes with writer concurrency 32. Timing starts before asynchronous filesystem mutation; throughput ends after both writers and unique expected events complete. Each size/artifact has 500 latency observations per kind and 2,500 burst deliveries per kind.

Normal exposed full GC: four collections separated by 25 ms and a final collection before each memory reading. Retained heap is ready heap minus warmed pre-open heap. Cleanup closes, drops the watcher reference, clears collector path sets, settles 200 ms and repeats GC while the fixture still exists. Cleanup residual includes harness arrays, runtime caches and JIT state; it is not a leak estimate. Peak RSS uses child `/proc/self/status` VmHWM, not inherited `process.resourceUsage().maxRSS`.

## Measurements

Startup, heap, throughput, close and cleanup are medians across all five runs. Latency cells are pooled nearest-rank p50/p95 over all 500 observations, matching the raw harness summary. Ratios are candidate/baseline; lower is better except throughput. Cleanup is compared in absolute bytes because residual ratios are unstable.

| Metric | 5k Baseline | 5k Candidate | Ratio | 20k Baseline | 20k Candidate | Ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Startup ms | 46.251 | 44.420 | 0.960 | 143.487 | 144.699 | 1.008 |
| Retained heap MiB | 2.502 | 2.513 | 1.005 | 9.793 | 9.577 | 0.978 |
| Heap bytes/path | 524.5 | 527.0 | 1.005 | 513.4 | 502.1 | 0.978 |
| Create p50 ms | 0.349 | 0.359 | 1.027 | 0.348 | 0.352 | 1.012 |
| Create p95 ms | 0.556 | 0.589 | 1.060 | 0.543 | 0.542 | 0.999 |
| Write p50 ms | 0.349 | 0.350 | 1.003 | 0.350 | 0.347 | 0.989 |
| Write p95 ms | 0.531 | 0.542 | 1.019 | 0.502 | 0.496 | 0.988 |
| Create events/s | 10,910 | 11,220 | 1.028 | 11,669 | 10,705 | 0.917 |
| Write events/s | 13,287 | 13,488 | 1.015 | 14,848 | 13,676 | 0.921 |
| Close ms | 0.201474 | 0.255375 | 1.268 | 0.219705 | 0.229795 | 1.046 |
| Cleanup residual KiB | 502.5 | 507.6 | +5.1 KiB | 515.4 | 531.6 | +16.2 KiB |

Variability, min-max over the five runs (baseline / candidate):

| Metric | 5k Range | 20k Range |
| --- | --- | --- |
| Startup ms | 45.67-48.05 / 43.42-45.96 | 142.51-144.99 / 143.42-150.28 |
| Retained heap bytes | 2,426,312-2,629,128 / 2,463,104-2,635,840 | 10,029,952-10,423,528 / 9,842,040-10,043,432 |
| Create p95 ms per run | 0.513-0.567 / 0.522-0.652 | 0.504-0.598 / 0.488-0.559 |
| Write p95 ms per run | 0.485-0.535 / 0.484-0.613 | 0.493-0.516 / 0.475-0.499 |
| Create events/s | 10,561-11,336 / 10,514-11,643 | 10,779-12,668 / 10,254-12,010 |
| Write events/s | 12,666-15,034 / 13,099-14,022 | 13,315-15,651 / 12,417-14,471 |
| Close ms | 0.195415-0.206795 / 0.222305-0.294658 | 0.204774-0.258306 / 0.226335-0.235825 |
| Cleanup residual bytes | 318,120-515,872 / 347,368-520,160 | 523,904-528,776 / 343,528-545,856 |

All per-run percentile distributions and matched-pair ratios are retained in `analysis.json`. They are not interchangeable with pooled percentiles or ratios of aggregate medians: 5k create p95 per-run medians are 0.546634/0.544522 ms (-0.4%), while pooled p95 rises 6.0%. The 20k write throughput matched-pair ratio median is 0.893 (-10.7%), versus 0.921 (-7.9%) for the ratio of aggregate medians. Neither representation should be silently substituted for the other.

## Findings And Tradeoffs

- Startup medians change -4.0% at 5k and +0.8% at 20k; individual paired startup ratios range 0.911-1.006 and 0.990-1.055. No 10% startup regression was observed in this series; this is not a guarantee against regression elsewhere.
- Close regression, exact median costs: 5k baseline 0.201474 ms versus final 0.255375 ms, +0.053901 ms (+53.901 microseconds), +26.753% (1.267533x). At 20k: 0.219705 ms versus 0.229795 ms, +0.010090 ms (+10.090 microseconds), +4.593% (1.045925x). All five 5k pairs are slower (ratios 1.103-1.470); 20k pairs are mixed (0.913-1.122). Largest final close is 0.294658 ms. Timing includes the harness's unchanged `await close()` continuation; it is not an isolated synchronous call profile. Handler/ignore reference release and lifecycle/abort work are plausible contributors, not established causes. No source fix attempted.
- Adverse signals: 20k create/write throughput -8.3%/-7.9%; matched-pair ratio medians 0.908/0.893, with wide ranges 0.845-1.114/0.831-1.054. At 5k, create pooled p50/p95 +2.7%/+6.0%, write pooled p95 +1.9%, retained heap +12,264 bytes (+0.5%). Cleanup residual increases 5,216 bytes at 5k and 16,608 bytes at 20k. Scheduler/GC variability and overlapping distributions limit causal attribution; these adverse signals must not be presented as performance equivalence or dismissed as proven noise.
- Favorable signals: 5k create/write throughput +2.8%/+1.5%; 20k retained heap -226,232 bytes (-2.2%), write pooled p50/p95 -1.1%/-1.2%, create pooled p95 -0.1%. Import medians are 5.277/5.433 ms at 5k and 5.415/5.448 ms at 20k (baseline/final). Median child VmHWM falls 87,528/84,496 KiB and 125,800/124,132 KiB; this is whole-child high water, not watcher-only memory or descendant memory. Small samples establish neither a general speedup nor absence of leaks.
- Correctness: every size/artifact delivered all 3,000 expected add and 3,000 change events across serial and burst phases. Across twenty samples: zero errors, missing/pending, duplicate, unexpected initial/live, or post-close callbacks. Every candidate closed with `state === 'closed'` and an aborted signal. Children exited normally and fixture cleanup completed.

## Superseded Evidence

The initial `candidate-20261014` series preceded the three review repairs. Its report, raw JSON/JSONL/logs, source snapshot and analysis remain available; its runtime hash is listed above. Original baseline and superseded candidate file hashes were captured before this refresh and rechecked afterward. Prior close costs were 0.210/0.244 ms at 5k, +16.2% (about +34 microseconds), and 0.221/0.247 ms at 20k, +11.9% (about +26 microseconds), slower in every pair. Those relative regressions are not erased by the final series.

Other superseded signals: startup -1.6%/+0.7%, 5k retained heap +5.7%, create p95 +8.2%/-3.2%, write p95 -1.1%/+4.3%, create throughput -2.7%/-1.4%, write throughput +5.4%/+0.6% (5k/20k). Final-vs-prior differences are not a controlled measurement of the three repairs: each series has fresh baseline samples and scheduling/GC variation. Use final measurements for the current candidate, not pooled or selectively chosen values from both series.

## Validation And Limits

Final refresh passed: isolated runtime/declaration build, source typecheck, tooling typecheck, unchanged five-pair suite, source/map/runtime/metadata/dependency/harness checks, preserved artifact checks, and report numeric/audit checks. No full test/coverage run was performed by this task; the core owner owns those gates.

```bash
node_modules/.bin/tsc --noEmit
node_modules/.bin/tsc --noEmit -p tsconfig.tooling.json
git diff --check -- docs/ux-refactor-validation.md
```

The external report checker also passed; its invocation is retained with the run logs.

Earlier migration checks, retained as historical validation rather than rerun against the final candidate:

```bash
node tests/benchmarks/watchr.bench.ts
node_modules/.bin/tsc --noEmit -p tsconfig.tooling.json
node_modules/.bin/eslint --flag unstable_native_nodejs_ts_config tests/benchmarks
node --expose-gc tests/benchmarks/readiness.bench.ts --runs 1 --json
node --expose-gc tests/benchmarks/compare.ts --runs 1 --ops 10
git diff --check -- tests/benchmarks docs/ux-refactor-validation.md
```

The external harness and snapshot-helper syntax checks and the earlier small paired adapter probe also passed. Readiness smoke covered 1k/5k/20k flat and 5k nested with no failures/errors. Comparison smoke preserved its default startup shapes, delivered all latency samples, and correlated all ten Watchr renames. Smoke numbers are not substitutes for the final controlled paired series; those smokes predate the review repairs. Logs remain under the baseline/superseded candidate artifacts.

Linux/WSL2 only, warm-cache tmpfs, not cold disk and not universal performance evidence. No isolated CPU dispatch-only throughput, saturation sweep, production application callbacks, or statistical significance claim. Paired workloads do not cover rename/delete/nested/error behavior; the comparison smoke only adds a small rename check. No cross-platform verification or full test/coverage run was performed by this benchmark task. Other concurrent work may affect scheduling; fresh child processes, alternating order, raw observations and variability reduce but do not eliminate that risk. `/tmp` artifacts are ephemeral and must be retained elsewhere for long-term reproducibility.

## Final Bounded Write Investigation

2026-10-14. **STOP: no safe justified optimization.** One emitter/current CPU-profile control found dominant native stat and writer work, not a narrowly evidenced removable library hotspot. No candidate was created, no acceptance series was warranted, and no production change is recommended. The historical sustained-write adverse signal remains unresolved; these diagnostics do not establish equivalence or prove scheduler noise. Close and dispatch optimizations were not retried. This is the final performance attempt.

### Provenance And Method

Artifacts: `/tmp/watchr-ux-fWJhOlM2/final-write-attempt-20261014-profile` (P). Current source hashes match the preserved investigation snapshot; workspace and measured current runtime both remain `d4cdbeb3fa32871afcbe2132b28fd722485834c2de0dfcde07b367912fd7ac0c`. Original emitter runtime remains `76cef8d1f782161765439d4056cd8b4ed85b3c1e7fecaf95fd81bb3f6ac7999d`. Exact package/lock metadata match across workspace and both archives. No builds, package-manager commands, commits or reverts. Only this append and new external diagnostics were made; source, tests, dist, README and metadata were not edited. Earlier report bytes and artifact hashes are checked separately.

One fresh child per API, emitter first then current, Node v26.11.1, Linux/WSL2, warm tmpfs; existing external collector/adapters and preserved artifacts. Each child warms a separate 256-file watcher, opens the flat 20k fixture, performs 100 serial creates/writes and a 2,000-create burst, then twenty 2,000-write bursts at concurrency 32 with 20ms quiet gaps. Only these write windows are profiled below. External harness changes add monotonic timestamps, process CPU counters and nineteen additional write bursts; no runtime instrumentation or private profiler APIs. `--cpu-prof --cpu-prof-interval=100` samples the main isolate, including native calls. Each sample is weighted by overlap of its preceding time-delta interval with the marked write windows; all categories, including idle/GC/unresolved program frames, remain in the denominator. Selected weights cover every marked microsecond: emitter 2,063,018 us / 10,751 samples; current 2,031,974 us / 10,649 samples.

### Results And Attribution

| Profile Diagnostic | Emitter | Current |
| --- | ---: | ---: |
| Native stat self, % of marked wall samples | 47.1591% | 44.5389% |
| Native append writer job self | 21.2346% | 22.2071% |
| Node recursive watcher inclusive | 8.3808% | 7.9807% |
| Watchr JavaScript self | 7.5097% | 7.7529% |
| GC self | 2.4821% | 2.4825% |
| Burst elapsed median ms (min-max) | 91.9800 (77.9745-158.6946) | 89.7799 (73.2303-146.2172) |
| Burst events/s median (min-max) | 21,747.37 (12,602.83-25,649.40) | 22,278.40 (13,678.28-27,311.10) |
| Total active write elapsed ms | 2,062.2640 | 2,031.2007 |
| Active-window process CPU user/system ms | 1,393.098 / 2,286.709 | 1,279.861 / 2,377.250 |

Native `stat` has two visible stacks: Watchr `attemptStat -> node:internal/fs/promises stat -> native stat`, and Node recursive watcher `#onFolderEvent -> #onEntryEvent -> statSync -> native stat`. Writer native `run` is beneath `appendFile -> writeFile -> writeFileInOneRoundTrip`. Recursive-inclusive percentages overlap the native-stat row; do not add them. Watchr self excludes its native callees: current 157,536 sampled us, with largest function `#updateInode` only 1.4413% of total. Its bounded inode/LRU tracking protects rename behavior; this profile does not justify removing that work. Async stat/retry/cancellation and fresh bigint stats are required; no cache, debounce, stat omission, timestamp/engine change, or safety weakening is proposed. The profile cannot isolate syscall time from native stats construction/timestamp work, nor measure threadpool CPU stacks.

Throughput statistics above are medians/min-max across twenty rounds **inside one profiled process per API**, not seven independent alternating pairs. Ratio of profiled throughput medians is 1.024418; same-ordinal round ratios have median 1.001988 and range 0.907657-1.151623. These are explicitly NOT acceptance paired ratios: emitter and current ran sequentially, rounds share JIT/cache state, and profiling overhead is uncalibrated. Strong within-child warmup (current first/last burst 146.2172/73.2303 ms) prevents any speedup inference. Historical unprofiled seven-pair burst2000 results remain unchanged: write medians 15,409 -> 14,483 events/s (-6.0% aggregate), paired median ratio 0.980, range 0.732-1.037. No rerun or pooling of that evidence.

Both profiles delivered exactly 2,100 expected adds and 40,100 expected changes; zero missing/pending, duplicates, unexpected initial/live events, errors or post-close callbacks. Current ended closed with its signal aborted. Every raw count and per-round result is retained, with no sample exclusions. This write-only audit does not cover rename, nested, failure or cross-platform behavior. No new functional test, full suite or memory study was needed because no candidate or production edit exists; no speed or memory improvement is claimed.

### Artifacts And Stop Decision

P contains both `.cpuprofile` files, raw `.stdout`/`.stderr`, complete per-child JSON, `analysis.json` (weighted frames and caller stacks), `provenance.json`, the external harness, analyzer, and the byte-identical earlier report. Preparation initially failed while inventorying a directory symlink before any measurement; the partial `final-write-attempt-20261014` directory remains preserved. The corrected driver hashes symlink targets as link metadata without traversing them. Neither profiling nor acceptance was rerun to hunt a win.

The external run logs retain the exact preparation, harness syntax check, profiling, analysis, and verification commands. Preparation and profiling refuse existing output; use a new external directory for reproduction. Validation checks exact source/runtime/metadata hashes before measurement, full write-window profile coverage and delivery counts, then protected workspace/earlier-artifact hashes and the historical report prefix. `/tmp` is ephemeral; retain P with the earlier artifact tree for durability. Single-machine, warm-cache, profiled controls and uncontrolled host scheduling limit attribution. **No external candidate, no production recommendation, no further performance round. Move on.**

---
type: research
status: draft
review_by: 2026-12-31
related: ["docs/research/forceteki-simulation.md", "docs/research/sim-bot-policy-ladder.md", "docs/specs/learned-play-policies.spec.md"]
---

# Simulation batch runner: measured optimisation (2026-10-31)

What this answers: where the time and memory go in the forceteki batch runner, and which changes raise games per second without changing any per-seed decision trace. Written by the Apple-silicon compute optimiser agent against `scripts/sims/` at main `33f4f80`; every number is a measurement on this M4 Max under a busy load (load average 31 to 42), with interleaved A/B rounds and the first round discarded. The three patches it names are landed on main in the same commit as this doc. This is the input for #131 (compute plan). Tables below are the agent's; the project's prose rule tolerates them in a research measurement doc.

# forceteki batch runner: throughput and memory review (2026-10-31)

Machine: M4 Max, 12 Performance + 4 Efficiency (sysctl hw.perflevel0.name=Performance, logicalcpu=12; hw.perflevel1.name=Efficiency, logicalcpu=4), 64 GB, Node 26.4.0.
Engine: /Volumes/Local Files/Projects/forceteki build, unmodified. Scripts under test: swu-mcp main scripts/sims at ad48f26 (identical to base/).
Decks: best-placed premier lists from data/originals/decks/2026-10-17 for Krennic (melee-0b373cb2), Cad Bane (melee-6563300e), Luke (melee-1a7b3451); copies in decks/.
Caveat on every timing: the box was not idle (load average 31 to 42 during the runs: OBS, WindowServer, a VM). Comparisons are interleaved A/B rounds (round 0 discarded), n and sd given. RSS is far less noisy than wall time.

## Correctness gate (run after every change)
baseline/ = unmodified run-batch.mjs, 16 workers, 100 seeds (1..100) x 3 matchups x {random, greedy}. Gate = compare.mjs: every record field except `ms` (traceSha256, winner, endCondition, rounds, prompts, baseDamage, endBoard) equal to the baseline record, baseline is the reference. Exact equality, no tolerance.
Result: PASS on every measured run (every ab.mjs / pool-bench.mjs run is gated; results.jsonl). Held-out check: seeds 1000..1099, same 6 cases, baseline code vs final code: 600/600 identical. Baseline reproduces itself (second run, 8 workers vs 16: 100/100 identical). Zero engine errors in any run.
Extra evidence for the memo patch: verify-memo.mjs recomputes the sweep fresh at every second call and compares card uuids, mustTakeCardAction and title: 12,210 second sweeps in 60 games, 0 mismatches.

## Where the time goes (cpu profile, 1 thread, 30 games, Cad Bane vs Krennic, random)
- 97% of a game is the play loop; building the game is 6.8 ms (p50) of about 220 ms. The first game in a process is about 330 ms (JIT warm-up), then 160 to 240 ms.
- 85% of samples sit under game.continue(). The driver (legalAnswers, policy, trace hash) is 0.5%.
- ActionWindow.getSelectableCards sweeps every card for legal actions. ActionWindow.continue() runs that sweep TWICE per prompt on unchanged state: once in activePromptInternal (24.1% inclusive via setPrompt) and once in highlightSelectableCards (19.8%). That is the largest single removable cost.
- The game loop has no sleep or tick: the only await in the engine's game path is initialiseAsync once per game (Game.ts:1283); no setTimeout/setImmediate in Game.ts; user+sys CPU exceeds wall time in a single thread (5.73 s CPU vs 4.86 s wall for 20 games).
- GC is 1.6% self. SnapshotManager.moveToNextTimepoint with UndoMode.Disabled still runs removeUnusedGameObjects (about 2.7% inclusive); it is the engine's deliberate memory cleanup, left alone.
- Card data: UnitTestCardDataGetter already caches parsed card JSON per getter (UnitTestCardDataGetter.ts:60-66), its constructor is 3 ms, and engine module load is 213 to 231 ms of the 233 ms process load. There is nothing to share across workers that costs more than it saves.
- Parallel scaling is limited by the machine, not the code: per-game p50 rises with worker count (1 worker 257 ms, 8: 309, 12: 391, 16: 494), so aggregate throughput plateaus at about 26 games/s from 12 workers up (scale.mjs, pre-patch, 8 games per worker after a barrier).
- Memory: engine load leaves 32 MB live heap and 126 MB RSS per isolate; steady live heap after a full GC is about 46 MB, with no growth across 40 games (no leak). Peak heap per game before GC is 115 to 120 MB, which is garbage; with default V8 limits each worker's RSS drifts to 200 to 300 MB.

## Baseline (unmodified, 16 workers, fresh process, Cad Bane vs Krennic, 100 games, random)
wall p50 5009 to 5109 ms (n=5, sd 155 to 199), 19.6 to 20.3 games/s, game p50 626 ms / p99 1204 ms, peak RSS 2.69 to 2.77 GB.
Greedy, same matchup: wall p50 3343 ms, 29.9 games/s, game p50 373 ms (293 prompts vs 429 for random).
Other matchups (baseline 16 workers): Krennic/Luke random 4193 ms, greedy 2751 ms; Luke/Cad Bane random 3142 ms, greedy 2626 ms.

## Changes tested, with measured effect (all gated)
Fresh-process numbers are p50 wall of 100 games including engine load (about 0.3 to 0.5 s). Cumulative attribution, Cad Bane vs Krennic random, 5 interleaved rounds (B1-attribution):
- base, 16 workers, static partition: 5109 ms (sd 199), 19.6 g/s, RSS 2762 MB
- + patch 01 (memo of duplicate legal-action sweep), still 16 static: 3779 ms (sd 198), 26.5 g/s, RSS 2764 MB. 1.35x. Traces identical.
- + patch 02 (dynamic seed claiming, workers = perflevel0 = 12): 3433 ms (sd 150), 29.1 g/s, RSS 2206 MB. 1.49x total. Traces identical.
- + patch 03 (worker heap caps 128 MB old / 24 MB young): 3466 ms (sd 182), 28.9 g/s, RSS 1514 MB. 1.47x total, same wall within noise, RSS -45% vs base. Traces identical.
- same with --workers 8: 3507 ms (one outlier 5698, sd 880), 28.5 g/s, RSS 918 MB.

Single thread, 30 games, interleaved x3 (memo off vs on): sum of game time 6767/6656/8511 ms vs 5081/5046/4991 ms, i.e. about 168 ms vs 222 ms per game (-25%), 4.4 to 4.5 g/s to 5.9 g/s. Traces identical (3 of 3 rounds).

Worker count (all 100-game random batches, Cad Bane vs Krennic):
- Unmodified code, static, fresh process, n=5 interleaved: 8 workers 4853 ms (sd 61) / 12: 5001 (sd 931) / 16: 4909 (sd 115). RSS 1.65 / 2.17 / 2.77 GB. 20 workers (dynamic) 4858 ms, 3.5 GB. Eight workers is as fast as sixteen and uses 40% less memory.
- Dynamic claiming without memo: 8: 4603, 12: 4387 (sd 255), 16: 4997, 20: 4858 ms.
- With memo + dynamic: 8: 3349 (sd 66), 12: 3469 (sd 66), 16: 3734 (sd 100) ms.
- Warm persistent pool (patched, batches 2..9, 100 games each, random / greedy): 8 workers 2687 ms (37.2 g/s) / 1811 ms (55.2 g/s); 12 workers 2758 / 1672 ms (36.3 / 59.8 g/s); 16 workers 2897 / 1731 ms; 20 workers 2665 / 2041 ms. The plateau is 8 to 12 workers; 12 is best for greedy, 8 is within 5% to 8% on greedy and about equal on random at 36% less memory (886 to 903 MB vs 1.39 to 1.42 GB). Beyond 12 (Efficiency cores) throughput does not rise and RSS does.

Dispatch (static i mod W vs shared-counter claiming), no memo: 8 workers 4853 to 4603 ms (-5%), 12 workers 5001 to 4387 ms (-12%), 16 workers 4909 to 4997 (no gain), noise sd 61 to 931. Gain is the idle tail: with 100 games on 12 workers a static worker gets 8 or 9 games, and game length varies p50 626 to p99 1204 ms.

Warm pool (patch 03 pool.mjs, 12 workers): the first batch is cold, batches 2+ warm. Random: cold 3117 ms, warm p50 2758 ms (n=8, sd 781, min 2484), game p50 317 / p99 1009 ms. Greedy: cold 2107, warm p50 1672 ms (sd 204, min 1522), 59.8 g/s, game p50 184 / p99 491 ms. Pool start 310 to 660 ms once. Warm vs fresh process final: random 3470 to 2758 ms, greedy 2629 to 1672 ms.

Heap caps in a warm pool, 12 workers, greedy, batch p50 / RSS (2 rounds):
- default limits: 1653, 1654 ms / 3425, 3562 MB
- old 128 only: 1909, 1729 / 2241, 2174
- old 256 only: 1519, 1589 / 2268, 2232
- young 12 only: 1570, 1530 / 3213, 3183;  young 24 only: 1492, 1513 / 3115, 3006
- old 128 + young 24 (chosen): 1610, 1627 ms / 1506, 1452 MB (-58% RSS, wall within noise)
- old 192 + young 24: 1752 ms / 1389 MB
- old 128 + young 12: 1690, 1966 ms / 1226, 1216 MB (RSS lower, but 3% to 19% slower)
Both caps are needed; either alone leaves RSS above 2 GB. Live heap peak is below the cap in every run (no worker out-of-memory in any run, old 64 MB cap also completed 100-game batches at 682 MB but is not recommended: headroom is thin).
V8 flags in a fresh-process batch, 8 workers, memo + dynamic, n=4: default 3655 ms / 1727 MB; semi-space 4 MB 3785 / 1319; semi-space 1 MB 3790 / 1374; semi-space 64 MB 3485 / 2262; old 128 MB 3500 / 1557 (one 5855 outlier); --single-threaded-gc 3554 / 2027 (outlier 6114); --optimize-for-size 4366 / 749 MB (sd 1361: 19% slower; a memory-first option, not a default).

## Rejected, with the measurement
- node:module compile cache (enableCompileCache in each worker): engine load 233 to 256 ms on one worker, and 480 to 730 ms with 16 workers (worse); the load is class construction, not parsing.
- JIT flags --always-sparkplug, --no-lazy-feedback-allocation, --no-maglev, --max-lazy, --no-sparkplug (single thread, 12 games x3): first game 325 to 370 ms in every case, steady p50 239 to 294 ms, no effect.
- GC flags for speed (--single-threaded-gc, semi-space 1/4/64 MB at 12 workers): no speed effect (25 to 27 g/s in all, noise larger than differences). Used only for the memory result above.
- Per-worker Game or card-index reuse: startGame is 3% of a game and the getter already caches card JSON; SharedArrayBuffer sharing is impossible for parsed objects and cloning costs what parsing does.
- Fewer prompt-state calls in the driver: legalAnswers + currentPrompt are 0.5% inclusive.
- Not tested: V8 startup snapshot (user-land snapshot cannot be used by worker_threads; would need child processes plus a bundled entry), CPU affinity or QoS for Efficiency cores (Node exposes neither), cross-machine and cross-Node-version determinism, a patch to skip removeUnusedGameObjects (engine behaviour, at most 2.7%).

## Ranked changes worth landing (patches are cumulative: apply 01, 02, 03 in numeric order from the repo root; the ranking below is by value, not by apply order)
git apply tmp/sims-opt/01-memo-duplicate-sweep.patch   (checked: applies cleanly to main scripts/sims and the three together reproduce patchwork/3 byte for byte)
1. 01-memo-duplicate-sweep.patch: reuse the ActionWindow sweep inside one continue(). -25% CPU per game, batch 5109 to 3779 ms. Risk: runtime prototype patch of a private method (`getSelectableCards`); it throws at install if the shape changes and verify-memo.mjs checks it against a fresh sweep. The clean fix is upstream in forceteki (compute once in continue()). `--no-memo` turns it off. branch-probe.mjs does not install it.
2. 03-heap-limits-and-warm-pool.patch: `WORKER_RESOURCE_LIMITS` (old 128 MB, young 24 MB) on every worker, and pool.mjs (persistent pool, shared-counter claiming, sorted results). RSS 3.4 to 3.6 GB down to 1.45 to 1.5 GB at 12 workers with no wall cost; warm pool removes 0.3 to 0.5 s load and the cold-JIT first game per call (random 3470 to 2758 ms, greedy 2629 to 1672 ms). Needed by simulate_matchup because a persistent pool is where unbounded heap growth shows up. Depends on patch 02 only for `topCoreClassSize`; apply 02 first.
3. 02-dynamic-dispatch-auto-workers.patch: workers claim the next seed from an Int32 shared counter (Atomics.add), and `--workers auto` = sysctl hw.perflevel0.logicalcpu (12 here), falling back to os.availableParallelism(). Batch 3779 to 3433 ms (-9%) and RSS 2764 to 2206 MB. Record per seed is independent of worker, which the gate confirms. Use `--workers 8` when memory matters: same throughput within noise, 918 MB.

Recommended defaults for simulate_matchup: persistent pool, workers = perflevel0 count (12 on this part; 8 if the 1.4 GB matters), greedy-class policy, heap caps as in patch 03.

## Headline (Cad Bane vs Krennic, 100 games)
random, fresh process: 5109 ms, 19.6 g/s, game p50 626 ms, RSS 2.76 GB  ->  3466 ms, 28.9 g/s, RSS 1.51 GB (1.47x).
random, warm pool, 12 workers: 2758 ms p50 (n=8, sd 781, min 2484), 36.3 g/s, game p50 317 ms, RSS 1.39 GB (1.85x vs base).
greedy, fresh process: 3343 ms, 29.9 g/s  ->  2629 ms, 38.0 g/s (1.27x); warm pool 1672 ms, 59.8 g/s, game p50 184 ms (2.0x), RSS 1.42 GB.
Greedy is 1.3 to 1.65x faster than random in every configuration because games end in about 293 prompts instead of 429.

## Files
base/ (unmodified copies), opt/ (experimental variants), patchwork/{0..3}/scripts/sims (cumulative states), 01-*.patch 02-*.patch 03-*.patch,
baseline/ (reference records), baseline-s1000/ (held-out reference), compare.mjs (gate), ab.mjs and pool-bench.mjs (interleaved harness), scale.mjs, phases.mjs, heap.mjs, verify-memo.mjs, results.jsonl (every row).

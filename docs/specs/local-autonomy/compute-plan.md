---
type: proposal
status: draft
review_by: 2026-11-16
related: [tmp/local-autonomy/facts.md, tmp/local-autonomy/pipeline-design.md, docs/research/sim-compute-measurements.md, docs/runbooks/simulation-pipeline.md]
---

# Local autonomy: compute plan (issue #202, round 1)

Author: agent-apple-silicon-heterogeneous-compute-optimizer, 2026-11-02. Scratch, git-ignored. Every number below is a
measurement on this box today, with the command that produced it, unless it is marked "not measured" or "estimate".
Scratch scripts: `/private/tmp/claude-501/-Volumes-Local-Files-Projects-swu-mcp/4f6d3249-088e-48ac-aafe-253e8a10d6e0/scratchpad/qcall.mjs`
(streaming Ollama client: TTFT, Ollama's own durations, `size_vram`, sha256 of the output) and `qbench.mjs`.

Scope after the owner's correction: the loop's inputs are decks that already exist. Qwen writes no ideas. Its only job is
the optional judge passes, which run on triggers. The idea-branch measurements stay below as recorded facts, but they no
longer drive the plan.

## TL;DR

- The machine is an **Apple M4 Max** (`Mac16,9`), not an M5. It has 12 Performance cores and 4 Efficiency cores, a
  40-core GPU and 64 GB of memory.
- The CPU sets the nightly budget. The binding cost is the fair-rung confirm: about 14 minutes per confirmed deck.
  A rung1 screen costs about 30 seconds per deck.
- **Decks per night (estimate from measured rates):** a run of 64 decks with an 8-deck confirm takes about 2.4 h
  without escalation and about 3.4 h with one. In an 8 h window that is about 3 runs, so about 190 decks screened and
  24 confirmed, or 2 runs (128 and 16) when every run escalates. Judges do not change this number, because they run
  on the GPU next to the CPU pool.
- **Co-residency is safe, measured.** The 27B Qwen and the 12-worker pool ran together. Qwen's decode speed did not
  move: 21.6 to 24.4 tokens/s, against 22.2 to 25.8 alone. The pool lost about 5% (40.5 against 42.5 games/s). Free
  memory stayed at 47%. Swap did not grow, and no thermal warning appeared.
- **Schedule:** the pool runs in an overnight window, and judge calls run on the GPU at the same time. The loop never
  sends `keep_alive: 0`, because another client was using this same model during the measurement.
- **launchd:** the program is `/opt/homebrew/bin/node` and `ProcessType` is `Standard`. **Never use `Background`:**
  measured with `taskpolicy -b`, the pool dropped to 1.3 cores and became at least 14 times slower.
- **Ollama determinism holds.** The same request with the same seed gave byte-identical output on repeats and across a
  full unload and reload.
- **Ollama rejects a boolean subschema.** `"items": false` (how draft 2020-12 closes a tuple) gets HTTP 400 "JSON schema
  conversion failed: Unrecognized schema: false". Check what `z.toJSONSchema` emits for the judge schema before relying
  on it.

## 1. Machine

- Chip and cores: `sysctl -n machdep.cpu.brand_string hw.model hw.ncpu hw.memsize hw.nperflevels` and
  `sysctl -n hw.perflevel{0,1}.{name,logicalcpu,physicalcpu,l2cachesize}`.
  - Apple M4 Max, `Mac16,9`, 16 CPUs, 68,719,476,736 bytes (64 GB), 2 perf levels.
  - perflevel0 `Performance`: 12 logical, 12 physical, 16 MB L2. perflevel1 `Efficiency`: 4 logical, 4 physical, 4 MB L2.
  - `topCoreClassSize()` (`src/sims/engine.ts:205-213`) reads `hw.perflevel0.logicalcpu`, so the pool's default of
    12 is detected at runtime, not hardcoded.
- GPU: `system_profiler SPHardwareDataType SPDisplaysDataType` reports Apple M4 Max, 40 GPU cores, Metal 4.
- Memory bandwidth: **not measured.** Apple's published figure for the 40-core M4 Max is 546 GB/s. That is a vendor
  claim, not verified here, and nothing below depends on it.
- Load and memory at the start (07:43), before any of my load:
  - `uptime`: load average 10.10 / 6.89 / 6.08.
  - `memory_pressure | tail`: system-wide free 85%. `kern.memorystatus_level`: 85.
  - `vm_stat`: 444,973 wired pages × 16 KB = 7.3 GB wired. 149,544 pages occupied by the compressor = 2.4 GB.
  - `sysctl vm.swapusage`: 9,856.56 MB used of 10,240 MB. **This swap use was already there before I loaded anything,
    and my runs did not grow it** (9,840.56 MB afterwards).
- Thermal: `pmset -g therm` reported "No thermal warning level has been recorded" and "No performance warning level has
  been recorded" at every check, including right after the heaviest concurrent run (load 28.8).
  `osascript -l JavaScript -e 'ObjC.import("Foundation"); $.NSProcessInfo.processInfo.thermalState'` returned 0
  (nominal) every time. It needs no root.
- Power and sleep: `pmset -g` shows `sleep 0`, `standby 0`, `powernap 1` and `disksleep 10`. Sleep is also prevented
  by OBS, corespeechd, caffeinate and others. `pmset -g batt` shows "AC Power"; the Studio has no battery.
- Owner activity: `ioreg -c IOHIDSystem -d 4 | awk '/HIDIdleTime/'` returned 37,107 s without root. The load average
  was 24 at the same moment, so the owner's work here runs through remote sessions and agents, not the keyboard. HID
  idle time alone does not show that the box is free.
- Disk: `df -h "/Volumes/Local Files" / /Volumes/Models`.
  - `/Volumes/Local Files`: 452 GiB free of 3.6 TiB (88% used).
  - Internal `/`: 47 GiB free of 460 GiB. The project CLAUDE.md says the system disk is full; today it is not.
  - `/Volumes/Models`: 3.0 TiB free.

## 2. Ollama and the models

- Ollama 0.32.14 (`ollama --version`). The daemon is the LaunchAgent `com.ollama.serve`
  (`~/Library/LaunchAgents/com.ollama.serve.plist`), and the plist sets these values:
  - `OLLAMA_MODELS=/Volumes/Models/ollama-store`, `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0`;
  - `OLLAMA_CONTEXT_LENGTH=131072`, `OLLAMA_NUM_PARALLEL=1` and `OLLAMA_MAX_LOADED_MODELS=4`;
  - `OLLAMA_GPU_OVERHEAD=12884901888` (12 GiB reserved), `OLLAMA_KEEP_ALIVE=30m` and `ProcessType Interactive`.
- `qwen3.8:27b-mtp-q4_K_M`: id `e24d04e4a41f`, digest
  `e24d04e4a41fc8fb26e629f03c56323c9828c8745c5f3f3ce8f14aaee67639ed` (`/api/tags`), 17,741,872,154 bytes, Q4_K_M,
  27.3B parameters, architecture `qwen35`.
  - The weights blob is `sha256-f5f1dd8920d417aac2718b0bda3403da274301efdd6760b4f0f4b864ff2ad57d`, and the projector
    blob is `sha256-ac3714bfdddeca31351f2752bf1a63f266f4df87c0b68c895e44945ca704448e` (`ollama show --modelfile`).
- `qwen3.8:27b-mtp-q4_K_M-n1`: digest `4a0a7f30bd27b45f98def4e2968d73d88a9feb56d5586c6558141eae20985f38`. This is the
  same model under another tag.
  - Its template, sorted parameter block, `FROM` blobs and `model_info` hash identically to the base tag (sha256 over
    the `/api/show` fields). Both carry `draft_num_predict 1`.
  - An A/B between the two would compare the model with itself, so it was not run.
- `qwen3.5-9b-heretic-highiq:latest`: digest `43b76399adcaeb9c34265a1c5189cc9f4c3b8cff13d4f1058c0222a707209bce`,
  9,527,504,608 bytes, Q8_0, weights blob `sha256-8a6ec14b63d3c1b7447d86caa42ef4c452e67bbbd4bfa4ad0d88d5e8070d5e33`.
  - Its modelfile carries its own `SYSTEM` prompt and defaults (`num_ctx 32768`, `num_predict 4096`). A capture must
    record them.

### 2.1 Qwen 27B measurements

Every call used `seed` fixed, `stream` true for TTFT (the earlier `qbench.mjs` calls used `stream` false), `top_k 40`,
`top_p 0.95`, `min_p 0.05` and `temperature 0.8`. The prompt filler is real repo prose (decisions, runbook, skill,
README).

- Cold load (`load_duration`). There were 8 loads and none stalled; the model store read instantly
  (`ls /Volumes/Models/ollama-store/blobs`, 0.00 s).
  - The first load of the day, from a cold page cache, took 9.07 s. Later reloads (after a `num_ctx` change or an
    unload) took 4.51 to 6.31 s, and 2.37 to 2.51 s with the weights still in the page cache.
- Prefill, uncached:
  - 229.8 tokens/s at 1.7k tokens, 220.0 at 11.8k and 213.2 at 15.8k;
  - 177 tokens/s for tokens 12k to 24k (11,960 tokens in 67.7 s, call C2 on top of a cached 12k prefix);
  - so a cold 24k prompt costs about 121 s of prefill.
- Prefix cache: an exact repeat prefills at 10,000 to 235,000 tokens/s, which is effectively free. A shared prefix
  with a different suffix runs at an effective 694 to 728 tokens/s, 3.2 times the uncached rate.
  - **Design lever:** put the fixed context first and the per-pass material last.
- Decode:
  - 22.2 to 25.8 tokens/s at up to 12k depth;
  - 21.4 at 15.8k depth;
  - 19.6 to 20.5 at 23.7k depth.
- Structured output (`format` = JSON Schema):
  - setup is negligible: an 8-token call took 0.68 to 0.92 s in total with a 108 KB schema;
  - decode ran at 25.3 to 25.8 tokens/s with a schema against 26.2 without one (single samples each);
  - an 8-position inline enum ran slower at 21.7, but the card-key enum is no longer in scope.
- Thinking: with `think: true` and `num_predict 768`, all 768 tokens went to `thinking` (2,932 characters) and the
  answer was empty, at the same 20.5 tokens/s. Thinking spends the `num_predict` budget. For a judge, set `think: false`,
  or budget the thinking tokens on top of the answer.
- **Judge pass, measured (the workload that remains):** 16 deck summaries with gate facts plus about 22k characters of
  compact context. That is 8,533 prompt tokens, a strict JSON schema of 16 `{id enum, score 0-3, reason ≤140}`, and
  826 output tokens. It parsed.
  - Warm model: 70.6 s in total (38.1 s prefill, 32.2 s decode at 25.6 tokens/s).
  - After a full unload and cold reload: 72.3 s, with time to first token 40.3 s and load 2.51 s.
  - Scaled to the architect's size (about 1.5k output) as an estimate: 38 s prefill plus 1,500 / 25 tokens/s, about
    100 s per pass. At 12k prompt tokens it is about 115 s.
- Memory per `num_ctx` (`/api/ps` `size_vram`): 17.68 GB at 16k, 17.60 GB at 24k and 17.64 GB at 32k.
  - The hybrid `qwen35` architecture with a q8 KV cache adds almost nothing per context step in Ollama's estimate.
  - System wired memory (`vm_stat` wired × 16 KB) gives an approximation, because wired pages release with a lag:
    about 19 GB at 32k and about 23 GB at the default 131,072.
  - `footprint -p <llama-server pid>` read 24 GB at 131,072 but 3.3 GB at 32k, where the weights count as clean mapped
    pages. That makes `footprint` an inconsistent instrument for this, so it is not used.
- Omitting `num_ctx` gives the 131,072-token context: the first call, sent without `num_ctx`, showed
  `CONTEXT 131072` in `ollama ps`.

### 2.2 Qwen 9B measurements

- Command: `SUFFIX=300 node qbench.mjs qwen3.5-9b-heretic-highiq:latest 4 2m 32768`.
- Cold load 4.51 s.
- Prefill 658.5 tokens/s uncached (2,138 tokens, which include its baked-in system prompt). With the prefix cache it ran
  at 1,742 to 1,755 tokens/s.
- Decode 42.2 to 46.9 tokens/s. `size_vram` 10.41 GB at 32k.
- Against the 27B: about 1.9 times faster decode, about 3 times faster prefill, and 7.2 GB less memory.

## 3. Sims pool cost

The decks are the Cad Bane and Krennic lists from the 2026-10-31 optimisation run (`tmp/sims-opt/decks/`). Each run is a
fresh process that includes a 1.4 s engine load. Peak RSS and CPU come from `/usr/bin/time -l`. Before every load I
checked `node node_modules/tsx/dist/cli.mjs scripts/sims/summary.ts --text`, which showed no other sims job.

- rung1, 12 workers, 1,000 games: 42.2 and 42.9 games/s (wall 23.7 and 23.3 s). This used 11.29 to 11.3 cores
  ((user + sys) / real), with peak RSS of 2.38 and 2.22 GB. Results: 997 decided and 0 errors in each run.
  - Command:
    `node --import tsx --import ./scripts/sims/ladder-preload.ts scripts/sims/run-batch.ts --deck1 tmp/sims-opt/decks/cadbane.json --deck2 tmp/sims-opt/decks/krennic.json --games 1000 --seed 5000 --workers 12 --policy1 rung1 --policy2 rung1 --record none --quiet`.
- rung1, 8 workers: 37.5 and 37.1 games/s (0.88 times the 12-worker rate), 8.82 cores and 1.81 to 1.82 GB.
- Fair rung (`rung3:k=8,det=4,belief=known`, with `--undo`), 12 workers, 12 games:
  - 0.22 games/s and 54.5 s wall, at a mean of 150.5 decisions per game;
  - 425.5 CPU-seconds, so **35.5 CPU-seconds per game**, and 7.8 cores busy on average (the tail idles as games
    finish);
  - 2.39 GB peak RSS.
- Memory per worker: about 0.15 to 0.16 GB for both rungs. That is the 12-worker peak of 2.2 to 2.4 GB, minus about
  0.43 GB for the parent (426 MB peak in a run that loaded the context and failed before it started workers),
  divided by 12.
  - The heap caps (`WORKER_RESOURCE_LIMITS`, 128 MB old plus 24 MB young, `src/sims/engine.ts:216`) bind the fair rung
    too. Undo snapshots did not raise the peak.
- Background QoS: `taskpolicy -b` on the same rung1 command with 400 games.
  - It was at 132% CPU after 2 min 15 s and still not done. At default QoS that batch takes about 10 s, so Background
    QoS is at least 14 times slower. I stopped it.
- TMPDIR use: a fresh `TMPDIR` for the stopped rung1 batch held 748 KB in 82 files. The whole pinned D110 gauntlet
  output is 440 KB (`du -sk data/pinned/sim-gauntlet`), and `reports/.progress` is 1.7 MB.
- Gauntlet sizes come from the pinned D110 run (`data/pinned/sim-gauntlet/jerjerrod-dume-2026-11-01/screen.json` and
  `confirm.json`) and from D110 (`docs/decisions.md:246`).
  - Screen: 50 ideas, 4 controls and 4 references, 62,600 rung1 games in 1,383 s (45.3 games/s). That is about 1,252
    games per screened deck, about 28 to 30 s per deck.
  - Confirm: 8 decks, 20 pairs and 10 field games, 1,560 fair-rung games. That is 195 games per confirmed deck,
    about 14 to 15 minutes per deck at 0.22 to 0.23 games/s.

## 4. Co-scheduling

- Measured concurrent run: the 27B (default 131,072 context, warm) generated three times while a 2,000-game rung1 pool
  on 12 workers ran.
  - Qwen: prefill 229.0 tokens/s against 230 alone, and decode 21.6, 24.4 and 22.4 tokens/s against 22.2 to 25.8
    alone. There was no measurable loss.
  - Pool: 40.5 games/s against 42.2 to 42.9 alone. Qwen overlapped about 33 s of the 49 s run, so the pool lost about
    5 to 8% during the overlap.
  - System: load average 28.8 in the middle of the run; free memory 47%; swap unchanged; `pmset -g therm` clean.
- Why it works: Ollama runs the model 100% on the GPU (`ollama ps` PROCESSOR `100% GPU`), and the runner process used
  about 59% of one CPU core. The pool is pure CPU. The two meet only in memory: about 19 to 23 GB plus about 2.4 GB on
  64 GB.
- **Recommended schedule: a time window for the CPU, concurrent use for the GPU.**
  - The pool (screen, escalation, confirm) runs only in a night window, 23:00 to 07:00 by default. It uses 11.3 of the
    16 cores for hours, and the owner works on this box all day through agents.
  - Judge passes run whenever their trigger fires, on the GPU, while the pool keeps going. They do not need the window.
    They do need a free Ollama slot: `OLLAMA_NUM_PARALLEL=1` makes the loop's call queue behind the owner's chats,
    and the owner's chats queue behind the loop's call.
  - Interleaving (unload Qwen, then simulate) buys nothing. The two do not contend, and unloading costs a reload of
    2.4 to 9.1 s.
  - "Concurrent with fewer workers" is the daytime fallback only. Eight workers keep 0.88 of the throughput and free
    about 3 cores.
- Keep Qwen warm between the screen and the confirm? **No pinning, and no forced unload.**
  - A reload costs 2.4 to 9.1 s, and a confirm lasts about 2 h, so holding 17.6 GB idle for that long is waste.
  - Send `keep_alive: "5m"` on each judge call and let the daemon expire the model.
  - **Never send `keep_alive: 0`.** At 08:10 and 08:11 another client's `/api/chat` requests were using this same model
    (`~/Library/Logs/ollama-serve.log`). A forced unload would drop the owner's live session and its prompt cache.
  - Use one fixed `num_ctx` for every judge call. A change to `num_ctx` forces a reload, which was measured several
    times today.
    - **Recommendation: `num_ctx: 131072`, set explicitly.** It equals the daemon default the owner's clients load, so
      neither side's call evicts the other. It costs about 4 GB more wired memory than 32k, which fits, and it is still
      recorded in every capture.
    - This differs from the architect's "never inherit 131,072". Inheriting is the wrong source for the value, but the
      value itself is the right one.
- Thermal headroom: no warning at any point, and `thermalState` stayed 0. **Not measured:** hours of sustained load.
  The longest load I ran was 52 s. See question 7 for the guard.

## 5. Decks per night

These are estimates built from the measured rates above. The fair-rung rate under other agents' load is the recorded
0.23 games/s.

- Per screened deck (rung1, D110 sizes): about 1,252 games, about 29.5 s at 42.5 games/s.
- Per confirmed deck (fair rung, D110 sizes): 195 games, about 14.1 min at 0.23 games/s.
  - One confirmed deck costs as much CPU as screening about 29 decks.
- One run of 64 input decks, with an 8-deck confirm:
  - screen 31.5 min;
  - one escalation at twice the field games, at most about another 31.5 to 63 min;
  - confirm 1.9 h;
  - build and panel steps not measured, allow 5 min;
  - total: **about 2.4 h without escalation and about 3.4 h with it.**
- Judges add no wall time when they run concurrently.
  - One triggered set (2 passes): about 3.5 min.
  - Worst case, 12 to 18 calls when a whole screen is too small to rank: about 20 to 35 min, serial on the GPU.
  - They add that time only when confirm seats wait on the judge verdict. Whether they do is the architect's call:
    2 passes cost about 3.5 min, and the worst case about 35 min.
- **8 h window (23:00 to 07:00): about 3 runs, so about 190 decks screened and 24 confirmed. If every run escalates: 2
  runs, so 128 screened and 16 confirmed.**
- 10 h window: 4 runs (256 screened, 32 confirmed), or 2 to 3 with escalation.
- Screen-only capacity (no confirm): about 975 decks in 8 h. Confirm-only capacity: about 34 deck-confirms in 8 h.
- Bigger confirms (D110 was too small to rank) scale linearly in fair-rung games. Five times the pairs means about 70
  min per deck, and about 7 decks per night.

## 6. launchd layout (`com.graham.swu-autonomy`)

- `ProgramArguments`: `/opt/homebrew/bin/node`, `--import`, `tsx`, `--import`, `./scripts/sims/ladder-preload.ts`,
  `scripts/autonomy/runner.ts`.
  - The program binary sits on the internal disk. Homebrew node can read the volume, while `/bin/bash` and
    `/usr/bin/python3` could not (facts.md; `com.graham.swu-sims-summary` already works this way).
  - The runner spawns the gauntlet as a child with the same node binary, never through a `node_modules/.bin` shim.
- `WorkingDirectory`: the autonomy worktree.
- `EnvironmentVariables`: `TMPDIR=<worktree>/tmp` and `PATH=/opt/homebrew/bin:/usr/bin:/bin`.
- `ProcessType`: **`Standard`**.
  - `Background` is ruled out by measurement (1.3 cores, at least 14 times slower).
  - `Interactive` would rank the batch above the owner's own work, which is the wrong priority.
  - Plain default QoS (my shell runs) used 11.3 cores. Standard vs Interactive core placement is **not measured**,
    because `powermetrics` needs root.
- `Nice 5`: optional and **not measured**. It lowers priority without the QoS clamp. Measure rung1 games/s with and
  without it before adopting.
- `LowPriorityIO`: false. The TCC note measured throttled I/O at 28.6 s against 0.9 s.
- Triggers:
  - `StartCalendarInterval` at 23:00, plus `WatchPaths` on `~/.local/state/swu-autonomy/wake` for `ctl start`;
  - `RunAtLoad` false and `KeepAlive` false;
  - `AbandonProcessGroup` false, so a runner crash takes the pool with it;
  - `ExitTimeOut` 30;
  - logs to `~/Library/Logs/swu-autonomy.log` (internal disk).
- Sleep: the runner holds `/usr/bin/caffeinate -i -w <runner pid>` as a child during a run. Sleep is disabled today
  (`sleep 0`), but OBS's assertion and that setting can change. The child costs nothing.
- Window end:
  - A stage starts only if its estimate × 1.2 ends before 07:00. A stage already running may finish up to a hard stop
    at 08:00.
  - At the hard stop the runner pauses with `--now` and names the work lost. Results do not depend on worker count,
    so a stage can restart from scratch.
- Owner active:
  - At each stage start, use 12 workers when the 5-minute load average is under 12, and 8 workers when it is 12 to 24.
  - Above 24, block and recheck every 5 minutes.
  - HID idle time does not show the remote work, so it is logged and not gated on.
- Battery: the Studio has none. The MacBook runs only the SwiftBar plugin (ssh status calls), so no compute there
  needs a battery rule. If any MacBook piece ever does work, it skips when `pmset -g batt` says "Battery Power".
- Ollama stays its own agent. The runner never reads `/Volumes/Models` itself.

## 7. Questions from the architect

Questions 1 and 2 were about idea generation, which the owner's correction removed. Their measurements stay in section
2.1 as facts.

1. Prefill and decode on the 27B against `-n1`, at 12k, 16k and 24k prompt tokens with about 3k output, thinking on
   and off.
   - **Dropped from scope.** The rates are measured in section 2.1. They are the same calls and commands.
   - `-n1` is byte-identical in configuration, so there is nothing to compare.
   - Thinking on spends the `num_predict` budget at the same decode rate.
2. Enum cost in `format`. **Dropped from scope.** Measured anyway:
   - grammar setup under 1 s;
   - inline enum × 8 decode 21.7 tokens/s, `$defs` 25.3 to 25.5, no format 26.2 (one or two samples each);
   - an 8-idea `$defs` output was 1,196 tokens and parsed;
   - **`"items": false` is rejected with HTTP 400.**
3. Memory per `num_ctx`: `size_vram` 17.68, 17.60 and 17.64 GB at 16k, 24k and 32k (`/api/ps`). Wired memory is
   about 19 GB at 32k and about 23 GB at 131k. Omitting `num_ctx` gives 131,072 (confirmed in `ollama ps`).
   Recommendation: set 131,072 explicitly (section 4).
4. Co-residency: **yes, measured.** Qwen at 131k plus the 12-worker pool left 47% free with no swap growth. Memory per
   worker is about 0.15 to 0.16 GB for both rung1 and the fair rung (section 3).
   - The swap file was already 96% used before my load, from the owner's other apps. That is a pre-existing condition
     to watch, not one the loop causes.
5. Unload or pipeline: neither unload nor pin. Use `keep_alive: "5m"` per call, and never `0`, because another client
   shares the model.
   - Cold load: 9.07 s from a cold page cache, 4.5 to 6.3 s typical, 2.4 to 2.5 s when the page cache is warm.
   - Eight loads ran today from a foreground shell through the Ollama agent with no stall.
   - **Not measured:** a load while the Ollama agent itself hits a TCC stall. The daemon is already a launchd agent
     that reads `/Volumes/Models`, so the risk sits with it, and the load timeout in question 15 guards it.
6. Workers and QoS:
   - Keep 12: rung1 runs at 42.2 to 42.9 games/s, against 37.1 to 37.5 at 8. The 2026-10-31 doc found no gain above
     12 (`docs/research/sim-compute-measurements.md`). Fair-rung worker counts were not swept.
   - Use `ProcessType Standard`, never `Background` (measured at least 14 times slower).
   - `taskpolicy` clamps make it worse. `nice`/`Nice` is not measured.
7. Thermal: `NSProcessInfo.thermalState`, read through JXA, needs no root (0 nominal through every run). So does
   `pmset -g therm` (no warnings).
   - **Not measured:** sustained clocks over hours. The longest run was 52 s.
   - Guard: log `thermalState` and the stage's games/s in each heartbeat.
     - Do not start a stage at `thermalState` 2 (serious) or above.
     - Pause with `--now` at 3 (critical).
     - Flag a stage whose games/s falls under 70% of its rolling median.
   - No fixed cool-down: there is no evidence it is needed on this actively cooled box. Revisit after the first night's
     log.
8. Wall clock and runs per night: section 5, about 2.4 to 3.4 h per run and 2 to 3 runs in 8 h.
   - Why 0.23 and not 0.5: the fair rung costs 35.5 CPU-seconds per game, measured with both seats on the pilot. With
     12 workers that sets a ceiling of 12 / 35.5 = 0.34 games/s even with perfect packing.
   - 0.5 is above that ceiling, so outside load explains only the gap from about 0.34 down to 0.23. The pilot's own
     cost explains the rest.
   - Where the planned 0.5 came from was not found in the research budget.
   - Making the fair rung faster needs a profile of `rung3` first. That is outside this plan.
9. Determinism: **yes, on this box and Ollama version.**
   - Three identical 24k-prompt requests gave the same sha256, `c8c252b2bc63de0f`, over a partial-cache and a
     full-cache prefill path.
   - The judge pass gave byte-identical output (`cmp`) across a full unload and cold reload (`01d1dcc213843dfa`).
   - **Not measured:** across Ollama versions or across `num_ctx` values. Record both in the capture. A "regeneration
     check" field is worth recording.
10. Load and memory thresholds (at stage start, because a running pool cannot change its worker count):
    - 5-minute load under 12: 12 workers. 12 to 24: 8 workers. Above 24: `blocked`, recheck every 5 minutes.
    - `kern.memorystatus_level` under 25: block. Under 15 during a stage: pause with `--now`.
    - Load alone never kills a running stage: the results are deterministic, and load only makes them slower.
    - Judge calls do not gate on load, because the GPU is not the contended resource. They gate on memory only.
11. Disk: 452 GiB free on `/Volumes/Local Files` and 47 GiB on the internal disk.
    - One stage uses under 1 MB of temp space (748 KB measured) and about 0.5 MB of output.
    - Thresholds: `disk-low` under 20 GiB on the volume, and under 5 GiB on the internal disk for the state directory.
      Both are far above the use, and leave room for the owner's work.
12. `OLLAMA_NUM_PARALLEL=2`: **not measured**, because it means changing the shared daemon's config, which this
    read-only round may not do.
    - The plist records a live test on 0.32.14: architecture `qwen35` logs "does not currently support parallel
      requests", and the runner still launches `-np 1`. So it gives no gain until a later Ollama release.
    - It would not move decks per night anyway, because judges are rare.
13. The 9B: about 1.9 times faster decode, about 3 times faster prefill and 7.2 GB less memory. A judge pass would take
    about 40 s instead of about 100 s.
    - Judges do not limit decks per night, so speed is no reason to switch. Only a quality A/B could justify it.
    - Mind its baked-in `SYSTEM` prompt.
14. Sleep: it does not sleep today (`sleep 0`, `standby 0`, with OBS and corespeechd assertions). Hold
    `caffeinate -i -w <runner pid>` anyway; it costs nothing.
15. Timeouts (measured inputs, with margin):
    - Separate the load from the generation: a preload request (model and `keep_alive`, no prompt) with a **load
      timeout of 120 s**, 13 times the worst cold load measured.
    - Then a streamed call with a **first-token timeout of 180 s plus prompt tokens / 150**:
      - 150 tokens/s sits below the slowest measured prefill of 177;
      - the 180 s covers queuing behind the owner's chat under `NUM_PARALLEL=1` (the plist measured 39 to 45 s, and
        it advises client timeouts of at least 180 s).
    - **An inter-chunk stall timeout of 30 s.**
    - **A total of first-token + `num_predict` / 12 tokens/s**, half the slowest decode. For a 12k/1.5k judge that is
      about 7 min.
    - A load that exceeds 120 s, or no first token in its window, is `ollama-load-hang` and is not retried.

## 8. Judge passes (owner addition)

- Cost per pass, measured: 8.5k prompt and 826 output tokens took 70.6 s warm and 72.3 s after a cold reload.
  At the specified size of 12 to 16 decks and about 1.5k output, the estimate is about 100 to 115 s per pass.
- Memory: the same 17.6 GB `size_vram` and about 23 GB wired at a 131k context. Nothing extra per call.
- Cost per triggered set (2 blind passes): about 3.5 to 4 min.
  - Worst case, 12 to 18 calls: about 20 to 35 min, serial, because `NUM_PARALLEL=1`.
- Keep warm or run after the sims: run them when triggered, alongside the pool. Co-residency is measured safe, and
  Qwen's speed does not drop.
  - Put the shared compact context first and the deck block last. Blind passes with a different deck order then share
    the prefix (about 3 times faster prefill).
- Effect on runs per night: none when the judges run alongside the pool. If confirm seats wait on judge verdicts, each
  run gets about 4 min longer (35 min in the worst case). An 8 h night keeps 3 runs in the first case and drops to
  about 2.5 runs in the worst case.

## 9. Gaps, stated

- Not measured: sustained thermal behaviour over hours; Standard against Interactive core placement (needs root);
  `Nice`; a fair-rung worker-count sweep; Ollama determinism across versions and `num_ctx` values;
  `OLLAMA_NUM_PARALLEL=2`; build and panel step durations; temp-space use of a full gauntlet stage (only a partial
  batch).
- The memory bandwidth figure is a vendor claim, not measured.
- During my measurements the owner's agents held the load average at 6 to 24, so every rate here is "under ordinary
  daytime load", not idle.

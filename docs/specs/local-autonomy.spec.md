---
type: spec
status: active
title: Local autonomy - unattended gauntlet, ranking and report for already-ideated decks on the Mac Studio
goal: Already-ideated decks queued by the owner are built or validated, gated, run through the tournament-panel gauntlet with planted controls overnight, ranked by deterministic measurement (local Qwen judges only on named triggers, as captured hashed inputs), and reported, with no Claude in the loop, managed from SwiftBar on macstudio and grahams-macbook-neo.
tracker: github
review_by: 2026-12-02
related: ["docs/specs/local-autonomy/pipeline-design.md", "docs/specs/local-autonomy/compute-plan.md", "docs/specs/local-autonomy/facts.md", ".claude/skills/swu-deck-ideas/SKILL.md", "docs/decisions.md", "docs/runbooks/simulation-pipeline.md"]
items:
  - id: autonomy-d-entry
    title: Decision-log entry D112 for the local loop, quoting both owner rulings
    tier: architecture
    needs: []
  - id: sims-pool-lock
    title: Machine-wide sims pool lock inside createPool
    tier: architecture
    needs: []
  - id: deck-intake
    title: Deck-set queue entries, intake, parse, gates and build or validate
    tier: architecture
    needs: []
  - id: judge-capture
    title: Ollama judge client, capture contract and strict judge schema
    tier: architecture
    needs: []
  - id: runner-controller
    title: Runner, controller state machine, ctl command grammar and run guards
    tier: architecture
    needs: [sims-pool-lock, deck-intake]
  - id: gauntlet-stages
    title: Facts sheet, panel, screen with card checks and escalation, confirm seats
    tier: feature
    needs: [runner-controller]
  - id: judge-triggers
    title: Judge triggers J1 to J4, blind passes and medians in code
    tier: feature
    needs: [judge-capture, gauntlet-stages]
  - id: judge-calibration
    title: Offline judge calibration against the pinned opus judges (JQ4)
    tier: feature
    needs: [judge-triggers]
  - id: ranking
    title: Deterministic ranking with judge fallback at named triggers only
    tier: feature
    needs: [gauntlet-stages, judge-triggers]
  - id: run-reports
    title: Run report with measured and judged figures side by side
    tier: feature
    needs: [ranking]
  - id: launchd-install
    title: launchd agent, installer, doctor and runbook
    tier: feature
    needs: [runner-controller]
  - id: swiftbar-plugin
    title: SwiftBar plugin on macstudio and grahams-macbook-neo over a forced-command SSH key
    tier: feature
    needs: [launchd-install, run-reports]
  - id: first-week-observations
    title: First-week observation log for the measurements the compute plan could not make
    tier: polish
    needs: [launchd-install, ranking, swiftbar-plugin]
constraints:
  - '"Model calls are captured once as pinned, hashed inputs, never run inline." (CLAUDE.md:72) Every judge call writes a capture once; ranking code reads only captures; a rerun from captures is byte-identical.'
  - '"Card scoring is fully deterministic. No LLM call, embedding lookup or other model output decides a score at runtime." (CLAUDE.md:80) Judge captures order whole decks under named triggers only and never reach score_card; no live model call ranks, gates, builds, edits or removes a deck.'
  - 'Qwen writes no deck ideas in this loop (owner, 2026-11-02, "qwen wont write ideas for decks in this process! inputs are decks already ideated").'
  - '"Every data manipulation is reproducible" and "Banned inside a manipulation: Date.now(), Math.random(), locale-sensitive sort keys (use compareCodePoints)." (CLAUDE.md:70, :73) The clock enters only through the controller (asOf, window checks), never inside a step.'
  - '"Hand-edited data is illegal." (CLAUDE.md:71) A deck or record that needs fixing is fixed by a committed transform step.'
  - 'One sims pool job at a time, machine-wide; bound every wait; long steps emit progress with scripts/lib/progress.mjs (CLAUDE.md:50, :76).'
  - 'The unattended loop runs no git command; it writes only git-ignored storage. Push only when the owner asks (CLAUDE.md:84, D24).'
  - 'Untrusted input is parsed at the boundary with Zod v4 strict shapes; every card resolves through the deterministic tools; an unknown card rejects its deck, never a guess.'
  - 'Never pool play-data tiers; every sim figure carries the D108 label and the calibration caveat; no Karabast data is read and no player name, player id or game id appears in any prompt, capture, record or report (D21, D22, D102).'
  - 'The shared Ollama daemon is never reconfigured and never told keep_alive 0; num_ctx is 131072 on every call, equal to the daemon default, so the loop never forces a reload on the owner''s other clients.'
  - 'launchd ProcessType is Standard, never Background (measured at least 14 times slower); the program is /opt/homebrew/bin/node; logs and state live on the internal disk.'
---

# Local autonomy - unattended gauntlet, ranking and report for already-ideated decks

Issue #202. Method design: `tmp/local-autonomy/pipeline-design.md` (round 3, agent-llm-last-pipeline-architect).
Compute plan, measured on this box on 2026-11-02: `tmp/local-autonomy/compute-plan.md`
(agent-apple-silicon-heterogeneous-compute-optimizer). Both are git-ignored scratch. Every figure this spec relies on
is repeated here with its source, so the spec stands alone.

**What the loop does.** It is today's `/swu-deck-ideas` step 6b and everything after it, with no Claude in the loop.
- Input: a deck set. Either a `/swu-deck-ideas` run (pool files, `gates.txt`, optional built SWUDB files, optional
  session judge files) or decks the owner drops in (SWUDB JSON or `{card, count}` lines).
- Steps: intake, parse, gates, build or validate, facts sheet, panel, rung-1 screen with card checks and at most one
  escalation, judge triggers, fair-rung confirm, judge triggers, ranking, report.
- The only model is local Qwen (`qwen3.8:27b-mtp-q4_K_M`, digest `e24d04e4a41f...`, weights blob
  `f5f1dd8920d4...`). It judges decks only when a trigger fires, and every call is a captured, hashed input.

**Measured facts the items rely on** (compute plan, 2026-11-02, under ordinary daytime load):
- Machine: Apple M4 Max (`Mac16,9`), 12 performance and 4 efficiency cores, 40-core GPU, 64 GB.
- Rung 1, 12 workers: 42.2 to 42.9 games/s, about 30 s per screened deck at D110 sizes (about 1,252 games each).
- Fair rung `rung3:k=8,det=4,belief=known`: 0.22 to 0.23 games/s, 35.5 CPU-seconds per game.
  - That sets a ceiling of about 0.34 games/s on 12 workers. The 0.5 constant at `scripts/sims/gauntlet.ts:66` cannot
    be reached.
  - About 14 min per confirmed deck at D110 sizes (195 games each).
- A 64-deck run with an 8-deck confirm takes about 2.4 h, or about 3.4 h with one screen escalation. An 8 h night fits
  about 3 runs (about 190 decks screened, 24 confirmed), or 2 runs when every run escalates.
- Co-scheduling: Qwen runs 100% on the GPU and the pool runs on the CPU.
  - Qwen decode stayed at 21.6 to 24.4 tokens/s, against 22.2 to 25.8 alone. The pool lost about 5% (40.5 against
    42.5 games/s).
  - Free memory stayed at 47%, swap did not grow, and `pmset -g therm` stayed clean.
- Qwen 27B: `size_vram` 17.6 GB; about 23 GB wired at a 131,072 context.
  - Prefill 177 to 230 tokens/s uncached, about 3 times faster on a shared prefix. Decode 19.6 to 25.8 tokens/s.
  - Cold load 2.4 to 9.1 s.
  - A judge pass of 16 decks (8.5k prompt tokens, about 1.5k output) takes about 100 to 115 s.
- Ollama 0.32.14:
  - The same request and seed gave byte-identical output, also across an unload and reload.
  - A `format` schema containing `"items": false` is rejected with HTTP 400.
  - `think: true` spends the `num_predict` budget on thinking.
  - `OLLAMA_NUM_PARALLEL=1`, so loop calls and the owner's chats queue behind each other.
  - Another client uses the same model.
- launchd: `Background` QoS throttled the pool to 1.3 cores, at least 14 times slower. `Standard` is required.
- Not measured, carried to `first-week-observations`:
  - thermals over hours;
  - core placement under `Standard`;
  - `Nice`;
  - a fair-rung worker sweep;
  - `OLLAMA_NUM_PARALLEL=2`;
  - build and panel durations;
  - temp space for a full stage;
  - Ollama determinism across versions and `num_ctx` values.

**Decisions (proposed D-entry D112; written by item `autonomy-d-entry`)**

Owner rulings, verbatim, both 2026-11-02:
- "i want qwen judges running locally as needed but deterministic measurement preferred"
- "qwen wont write ideas for decks in this process! inputs are decks already ideated"

Proposed entry text:
- The unattended local loop (#202) takes decks that are already ideated: a `/swu-deck-ideas` run's pool and gates, or
  deck lists the owner drops in.
- No model writes, edits, builds or removes a deck. Code-built decks appear only as references (each leader's best
  tournament list, else `build_deck`'s list), dead-card controls and unranked card checks.
- Deterministic measurement is the default ranking input: the gauntlet field difference, controls detected, extra
  cost, anchors present, rotation share and the gate facts.
- Local Qwen judges run only on triggers J1 to J4, each with a named input set and output fields.
- Every judge call is a captured, hashed input, parsed with a strict Zod schema (four 0 to 10 scores, trap flags, a
  risk line).
- At least 2 blind passes, with the median taken in code. A judge set that fails the agreement gate is shown and
  orders nothing.
- Judge scores order nothing until the offline calibration (JQ4) passes.
- Deterministic ranking code reads only captures. No live model call ranks anything.
- Reports show measured figures and judge scores side by side, each labelled with its source. The owner seat stays.
- This amends D110 ("the sims never change the step 8 ranking") for this loop only: with controls detected, the sims
  order the shortlist, and judges reorder only inside a tie block at a cut.
- It is consistent with CLAUDE.md "No model in the scoring path" (CLAUDE.md:80), because judge captures never reach
  `score_card` and only deterministic code reads them.

**Open owner questions (each with the default the items build to unless the owner says otherwise)**
1. Where do run outputs and judge captures live? Default:
   - in git-ignored `data/autonomy/`, hash-verified, never overwritten;
   - the owner promotes chosen runs into `data/pinned/local-autonomy/` through a committed transform step;
   - the loop never commits.
2. May the ideas session's own Claude judge scores (source a) stand in for a Qwen pass? Default: no. They are shown
   side by side as "ideas-session judges (Claude)" and never satisfy a trigger, so one judging instrument covers both
   sources.
3. What is the night window? Default:
   - pool stages 23:00 to 07:00;
   - a stage starts only if its estimate times 1.2 ends by 07:00;
   - a running stage may finish until a hard stop at 08:00;
   - judge passes run whenever triggered, on the GPU.
4. Do the starting judge thresholds stand until calibration? Default: yes. Link coverage 0.5, JQ2 0.5, JQ3 0.3, JQ4 0.4
   and a third-pass spread of 3. Judge scores order nothing until a JQ4 record passes; before that they are shown only.
5. What confirm size in week one? Default: D110 sizes (top 8, `--pairs 20 --field-games 10`, about 14 min per deck).
   Revisit with the week-one control-detection rate. A larger confirm scales linearly: 5 times the pairs is about 70 min
   per deck and about 7 decks per night.
6. What happens when the queue is empty? Default: stay idle. The loop never auto-queues a new `/swu-deck-ideas` run;
   the owner queues explicitly.

## autonomy-d-entry — Decision-log entry D112 for the local loop, quoting both owner rulings

**Goal**: Record the owner's two 2026-11-02 rulings and the loop's ranking rule in `docs/decisions.md`. Reviews of every
later item need that yardstick. The entry amends D110 for this loop only.

**Acceptance**:
- `docs/decisions.md` holds `**D112. ...**` and quotes both rulings verbatim: "i want qwen judges running locally as
  needed but deterministic measurement preferred" and "qwen wont write ideas for decks in this process! inputs are
  decks already ideated".
- The entry carries every point of this spec's "Decisions" block: inputs, the deterministic default, triggers J1 to J4,
  captures, at least 2 blind passes with the median in code, the JQ2 fallback, the JQ4 gate, side-by-side reports, the
  owner seat, the D110 amendment scoped to this loop, and the CLAUDE.md:80 consistency line.
- It records the owner's answers to the six open questions, or states that the defaults apply.
- Its "Enforced in" line names this spec now. The `ranking` item replaces that with the real file list when it lands.

**Touches**: `docs/decisions.md`

**Open gaps**: the answers to the six open owner questions.

## sims-pool-lock — Machine-wide sims pool lock inside createPool

**Goal**: Make "one sims pool job at a time" a property of the code, not of discipline. Today only `simulate_matchup`
locks, at `tmp/sims-jobs/.lock` per checkout (`src/tools/sims.ts:241`). `scripts/sims/gauntlet.ts` takes no lock, and
an unattended loop in its own worktree would collide with an agent's job in the main checkout.

**Acceptance**:
- `createPool` (`src/sims/pool.ts`) acquires `~/.local/state/swu-sims/pool.lock` before it spawns a worker.
  - The lock records pid, job label, checkout path and start time, in a Zod strict schema.
  - It is released on `close()` and on process exit.
- Every caller found by `grep -l createPool` gets the lock without its own code change: `scripts/sims/ladder.ts`,
  `matchup-job.ts`, `replay-gate.ts`, `calibration-gate.ts`, `gauntlet.ts`, `bench-evaluator.ts` and `run-batch.ts`.
- A second `createPool` from any checkout fails at once with one sentence naming the holder's label, checkout, pid and
  age. An optional `{ waitMs }` waits with a bound and then fails the same way.
- A lock whose pid is dead is cleared with a log line naming it.
- `simulate_matchup` answers with its existing busy notice when another checkout holds the lock.
- `sims:summary --json` gains an optional `poolLock` field (holder label, checkout, age). `docs/schemas/sims-summary.v1.schema.json`
  is regenerated, and `schemaVersion` stays 1 because the field is optional.
- Tests in `tests/sims/pool-lock.test.ts`, with the lock directory set by an environment variable so tests never touch
  the real one:
  - a second process is refused;
  - a stale pid is cleared;
  - a crash releases the lock;
  - `waitMs` times out.

**Touches**: `src/sims/pool.ts`, `src/tools/sims.ts`, `src/sims/summary.ts`, `scripts/sims/summary.ts`,
`docs/schemas/sims-summary.v1.schema.json`, `tests/sims/pool-lock.test.ts`

**Open gaps**: none

## deck-intake — Deck-set queue entries, intake, parse, gates and build or validate

**Goal**: Turn an owner-queued deck set into gated, buildable decks, deterministically. Source (a) is a
`/swu-deck-ideas` run and source (b) is dropped-in lists. Deck files and session files are untrusted input, parsed at
the boundary, with every card resolved through the deterministic tools.

**Acceptance**:
- `src/autonomy/queue.ts` defines the queue entry (Zod strict): `{ id, kind: "ideas" | "decks", asOf, count, options }`.
  - `ideas` carries a run directory, `anchors` (cardKeys), `exclude` (`<ideaId>=<cardKey>`) and `fallbackLeaders`.
  - `decks` carries an inbox set name.
- Source (a) parse:
  - `parseIdeaPool` (`src/sims/idea-pool.ts:36`) also reads the `wins:` and `how it wins:` lines;
  - pool files are found at `<dir>/pool/*.md` or `<dir>/<slug>/pool/*.md`;
  - on the pinned jerjerrod-dume pool (`tmp/deck-ideas/pool/`, promoted into a test fixture) it reads 48 ideas, each
    with its line;
  - `gates.txt` is parsed by a strict `id|extra cost|rotation` grammar, and one unreadable line fails the intake with
    that line quoted.
- Source (b) parse:
  - SWUDB goes through `swudbDeckSchema` and `deckFromSwudb`;
  - `{card, count}` lines go through `resolve_card_name` with the skill's rule (a single `exact` row, or a top row with
    `distance` 3 or less and a strictly higher score than the next);
  - an ambiguous or unknown name rejects that deck, with the tool rows recorded;
  - files over 256 KB and sets over 64 decks are refused.
- Gates are code, batched as `.claude/skills/swu-deck-ideas/SKILL.md` step 5 writes them:
  - one `deck_legality_check`;
  - `format_legality` per leader and base;
  - one `deck_audit` per aspect group;
  - base location only from `baseEnabled` / `baseLocked` / `why`;
  - anchors present when anchors are given;
  - size and copies;
  - returning cards;
  - rotation tags;
  - status labels computed from the entry's `asOf`, never the clock.
- On the jerjerrod-dume fixture, the code gates reproduce `gates.txt`'s extra-cost and rotation fields for all 48
  ideas. Every disagreement is written to the step output with both values, and the code value decides.
- Build or validate:
  - an idea builds through `gauntlet-ideas.ts` with key cards and anchors at 2 copies and the entry's excludes;
  - a full list (50 to 60 cards) passes `validateDeck` unchanged;
  - a partial list is filled by `build_deck` with every given card in `mustInclude` at its count, labelled "filled by
    build_deck";
  - a reused built file that differs from its rebuild is reported, and the rebuild wins.
- Every step writes `step.json` `{inputHash, codeCommit, outputHash, effect}`. A second run on the same inputs gives
  byte-identical outputs (test).
- A grep test proves `src/autonomy/` and `scripts/autonomy/` contain no `Date.now()` or `Math.random()` inside a step
  and no locale sort.
- `tests/meta/no-karabast.test.ts` covers the new directories.

**Touches**: `src/autonomy/queue.ts`, `src/autonomy/intake.ts`, `src/autonomy/gates.ts`, `src/autonomy/build.ts`,
`src/sims/idea-pool.ts`, `scripts/sims/gauntlet-ideas.ts`, `tests/autonomy/`, `tests/fixtures/autonomy/`,
`tests/meta/no-karabast.test.ts`

**Open gaps**: `gauntlet-ideas.ts` reads markdown pools only. Whether source (b) partial lists go through it or
through a direct `build_deck` call is an implementation choice.

## judge-capture — Ollama judge client, capture contract and strict judge schema

**Goal**: Provide the one model boundary of the loop. It is a streaming Ollama client with measured timeouts, a capture
written once per call and verified on load, and a strict Zod judge schema whose Ollama `format` form Ollama actually
accepts.

**Acceptance**:
- Client (`src/autonomy/ollama.ts`), requests only to `127.0.0.1:11434`:
  - a preload request with a load timeout of 120 s;
  - then a streamed `/api/chat` with a first-token timeout of 180 s plus prompt tokens / 150, an inter-chunk stall
    timeout of 30 s, and a total of the first-token allowance plus `num_predict` / 12;
  - a breach of any of these is `ollama-load-hang` and is never retried.
- Every request carries `num_ctx: 131072`, `keep_alive: "5m"` and `think: false`. A test scans every request builder
  and fails on `keep_alive: 0`, `"0"` or `0s`, and on any other `num_ctx`.
- Capture at `data/autonomy/runs/<runId>/captures/judges/<setId>/<batch>.p<pass>.json`, Zod strict, `version: 1`:
  - `purpose: "deck-judge"`;
  - the exact request and its `requestSha256`;
  - model name, `ollamaDigest`, `weightsBlobSha256`, template and params hashes, and `ollamaVersion`;
  - `inputs` hashes (set, anon map, facts sheets, gates, triggering stage record, data package date, `asOf`, code
    commit);
  - `response.raw` (the exact streamed bytes) with `rawSha256`;
  - the assembled `content`, token counts and durations, for audit only.
- Writing and loading:
  - written to a temp name and renamed;
  - never overwritten: if the file exists with different bytes the step fails, and if it exists the call is not made
    again;
  - the loader re-hashes `raw` and the request, rebuilds the request from pinned inputs, refuses on mismatch, and
    derives `content` from `raw` deterministically.
- Judge schema (`src/autonomy/judge-schema.ts`), declared once in Zod per batch:
  - an array of verdicts with `minItems` = `maxItems` = the batch size;
  - `id` an enum of the batch's anonymised ids;
  - `surprise`, `win`, `fits`, `covers` as the digit enum `"0"` to `"10"`;
  - `trapFlags` (at most 4; `kind` one of `cannot-work`, `off-anchors`, `duplicate`, `one-card-plan`, `trap-card`;
    `cardKey`, `duplicateOf`, `clause` up to 200 characters);
  - `risk` from 5 to 160 characters;
  - no field for a swap or an added card.
- The `format` sent to Ollama comes from `z.toJSONSchema` through a post-processor that removes every boolean subschema
  (`"items": false` and friends).
  - A unit test asserts that no `true` or `false` appears as a subschema anywhere.
  - An integration test posts the real schema to a live Ollama and expects HTTP 200 and a parse. When Ollama is absent
    it reports "skipped: Ollama not reachable", never a pass.
- Checks after parse:
  - the ids are a permutation of the batch;
  - each `cardKey` belongs to that deck;
  - a `trap-card` clause is a verbatim substring of that card's prompt text, else the flag is dropped and recorded;
  - `duplicate` names `duplicateOf`;
  - a failed parse fails the step loudly (JQ1) and is never patched.
- `ctl verify-capture <path>` is owner-run only. It re-sends the stored request and writes `regen.json` (match or
  mismatch, new sha256) beside the capture without changing it. Replay never calls Ollama.

**Touches**: `src/autonomy/ollama.ts`, `src/autonomy/capture.ts`, `src/autonomy/judge-schema.ts`,
`tests/autonomy/capture.test.ts`, `tests/autonomy/judge-schema.test.ts`, `tests/autonomy/ollama-format.int.test.ts`

**Open gaps**: Ollama determinism across versions and across `num_ctx` values is unmeasured. Captures store
`ollamaVersion` and `num_ctx`, and replay never depends on regeneration.

## runner-controller — Runner, controller state machine, ctl command grammar and run guards

**Goal**: Drive runs unattended and safely. A launchd-run `runner` advances idempotent steps. A small `ctl` on the
internal disk takes commands locally or over SSH. Guards keep the pool to the night window and to safe load, memory,
thermal and disk levels.

**Acceptance**:
- `ctl`:
  - bundled with esbuild from `src/autonomy/ctl.ts` to `~/.local/libexec/swu-autonomy/ctl.mjs`, with Zod inlined;
  - reads and writes only `~/.local/state/swu-autonomy/` and never opens a path under `/Volumes` (a test runs it with
    that directory as the only writable path);
  - the space-free wrapper `~/bin/swu-autonomy` calls it.
- Commands, each parsed by one Zod grammar shared with `--ssh` mode:
  - `status [--json|--text|--swiftbar]`;
  - `start`, `pause [--now]`, `resume [--no-model]`, `stop`;
  - `queue add-ideas <runDir> [anchors:..] [exclude:<id>=<key>]... [fallback:..] [count:<n>]`;
  - `queue add-deck <set> [<name>]` (stdin, at most 256 KB), `queue seal <set>`, `queue list`, `queue rm <id>`,
    `queue move <id> <pos>`;
  - `seat <runId> <deckId>`;
  - `last-report [--text|--path|--headline]`;
  - `doctor`;
  - `replay <runId> [--to <step>]`, local only.
- State files: `controller.json`, `queue.json`, `inbox/`, `commands/`, `status.json` (schema v1, exported to
  `docs/schemas/autonomy-status.v1.schema.json`), `events.jsonl`, `runner.lock`, `reports/` and `wake`. All writes go
  to a temp file and then rename.
- Controller states and transitions, each covered by a table-driven test:
  - `idle`, `running`, `pausing`, `paused`, `error`;
  - `blocked(sims-pool-busy | outside-window | load-high | memory-low | thermal | disk-low | ollama-unreachable |
    ollama-load-hang | code-dirty)`;
  - run steps `queued`, `intake`, `parse`, `gates`, `build`, `facts`, `panel`, `screen`, `screen-escalation`,
    `judge-after-screen`, `confirm`, `judge-after-confirm`, `rank`, `report`, `done`, plus `needs-owner`, `failed` and
    `cancelled`.
- Steps run as child processes (`/opt/homebrew/bin/node --import tsx scripts/autonomy/step.ts`, never a `.bin` shim) in
  their own process group.
  - `pause --now` and `stop` kill the group, and the status names the work lost.
  - A finished step is re-verified by hash on resume and skipped when it matches.
- Guards (thresholds from the compute plan, each a unit-tested pure function over sampled inputs):
  - Window: pool stages start only if their estimate times 1.2 ends by 07:00, and a running stage is paused `--now` at
    08:00. The estimates are 42.5 games/s for rung 1 and 0.23 games/s for the fair rung.
  - Load, at stage start: a 5-minute load under 12 means 12 workers, 12 to 24 means 8 workers, and above 24 means
    `blocked(load-high)`, rechecked every 5 minutes.
  - Memory: `kern.memorystatus_level` under 25 blocks a new stage or judge call. Under 15 during a stage means pause
    `--now`.
  - Thermal: `NSProcessInfo.thermalState` (via `osascript -l JavaScript`) of 2 or more blocks a new stage, 3 means
    pause `--now`, and a stage whose games/s falls under 70% of its rolling median is flagged in `events.jsonl`.
  - Disk: under 20 GiB free on `/Volumes/Local Files` or under 5 GiB on the internal disk means `blocked(disk-low)`.
  - Stall: no `moved_ts` change for 5 minutes kills the step as `stalled`. Each step's deadline is its estimate times 2,
    with a floor of 10 minutes.
  - Code: a dirty autonomy worktree means `blocked(code-dirty)`.
  - Ollama: unreachable is rechecked 3 times, 5 minutes apart. A load hang is never retried, and
    `resume --no-model` finishes without judges.
- During a run the runner holds `/usr/bin/caffeinate -i -w <runner pid>` as a child.
- Worker count changes only the speed, never the result: a 120-game gauntlet smoke run on 8 and on 12 workers writes
  byte-identical stage records (test).
- Every step that can pass 30 s emits `scripts/lib/progress.mjs` heartbeats labelled `Autonomy <step>`, and
  `sims:summary --text` shows them.
- The runner publishes `ideasRuns` in `status.json` (the run directories under `tmp/deck-ideas/`, with pool and gate
  file counts), so the MacBook can queue source (a).

**Touches**: `src/autonomy/ctl.ts`, `src/autonomy/state.ts`, `src/autonomy/guards.ts`, `scripts/autonomy/runner.ts`,
`scripts/autonomy/step.ts`, `scripts/autonomy/build-ctl.ts`, `docs/schemas/autonomy-status.v1.schema.json`,
`tests/autonomy/`

**Open gaps**: the guard thresholds are the compute plan's starting values. Sustained-load behaviour is unmeasured, and
`first-week-observations` revisits them.

## gauntlet-stages — Facts sheet, panel, screen with card checks and escalation, confirm seats

**Goal**: Run the existing D110 gauntlet on the gated decks under the runner, with three additions:
- a deterministic facts sheet per deck;
- unranked card checks that measure a suspect card before any judge reads it;
- one calibrated screen escalation that reads only the controls.
Confirm seats follow fixed rules.

**Acceptance**:
- Facts sheet per deck (`src/autonomy/facts.ts`), all from tool rows:
  - extra cost;
  - anchors carried;
  - rotation share (unique cards tagged "rotates (unconfirmed)");
  - internal link coverage (the share of unique non-basic cards with a `find_pairings` candidate link to another card
    in the deck);
  - the top-5 popular decks with population and window, plus the deck's cards in their `meta_answers` ok or
    significant rows;
  - a deterministic novelty measure, or "not enough play data" when more than half the unique cards lack
    `leaderInclusion`;
  - trap candidates (a parsed effect on our own side, plus the entry's excludes).
- Panel: the newest `data/pinned/sim-panels/tournament-winners-*.json` whose `references` name every leader, else a
  panel built into the run directory. A leader with no tournament list gets `build_deck`'s list on its most-used base
  as the named fallback reference.
- Controls: `deadCardControl` (`src/sims/gauntlet.ts:215`) per reference, in every stage. `tooSmallToRank` is computed
  as today (`scripts/sims/gauntlet.ts:302`).
- Screen:
  - rung 1, seed `auto-<runId>`, worker count from the runner's guard, output under
    `data/autonomy/runs/<runId>/sim-gauntlet`;
  - it never writes into `data/pinned/`.
- Card checks: at most one per deck with a trap candidate. The deck minus that card, refilled by `build_deck` with the
  rest as `mustInclude`, plays the deck on identical shuffles. The figure is reported per deck and never enters the
  ranking (test: a card check id never appears in `ranking`).
- Escalation:
  - exactly one rerun at twice the field games, written as a new stage record that keeps the first;
  - only when every control's field difference is below 0 and some control's interval crosses 0;
  - no rerun when any control's point estimate is 0 or above, and the record says "the computer player cannot see
    this control";
  - fixtures for the three cases.
- Confirm: the fair rung at D110 sizes (`--pairs 20 --field-games 10`) on 8 seats:
  - controls detected: the top 8 by the ranking key;
  - J1 fired and the judge set passed JQ2 and JQ4: the top 8 by judge median S, labelled "seated by local judges";
  - otherwise the screen order, labelled noise;
  - wild seat for source (a) only, from branch ids T08 and T10;
  - owner seat from `ctl seat` before the confirm starts, replacing the lowest procedural seat and naming the deck it
    displaced.
- `GAMES_PER_SECOND.fair` at `scripts/sims/gauntlet.ts:66` changes from 0.5 to 0.23, with the measured 0.34 ceiling in
  the comment. The measurement is added to `docs/research/sim-compute-measurements.md` with its command.

**Touches**: `src/autonomy/facts.ts`, `src/autonomy/seats.ts`, `src/sims/gauntlet.ts`, `scripts/sims/gauntlet.ts`,
`scripts/autonomy/step.ts`, `docs/research/sim-compute-measurements.md`, `tests/autonomy/`

**Open gaps**: build and panel step durations are unmeasured (allow 5 min). The link-coverage measure rests on parsed
features that are wrong on about 1 card in 5.

## judge-triggers — Judge triggers J1 to J4, blind passes and medians in code

**Goal**: Call local Qwen judges only where the measurements give no answer. Run them blind, in at least 2 passes, and
reduce them in code, so judge scores enter the ranking only as captured inputs.

**Acceptance**:
- `triggers.json` is written after the screen and after the confirm, even when nothing fires. It lists each trigger
  with its input deck ids and the output fields the ranking will read.
- The triggers:
  - J1, too small to rank: the stage record has `tooSmallToRank: true`. Input: every gate-passing deck, never card
    checks, references or controls. Read: median S, for seats and order.
  - J2, tie at a cut: the controls are detected, and a tie block (each deck's interval contains the next deck's point
    estimate) straddles rank 1, `count` or the 8th seat. Input: the block. Read: median S inside the block only.
  - J3, plan coherence: a seated or shortlisted deck has link coverage under 0.5. Read: `fits`, plus `cannot-work`
    and `one-card-plan` flags.
  - J4, card that works against the plan: a trap candidate whose card check interval crosses 0, or a stage too small to
    rank. Read: `trap-card` flags.
  - Table-driven boundary tests: coverage exactly 0.5, a block ending one rank before a cut, and a check interval
    touching 0.
- Passes:
  - pass A, seed A, decks in anonymised order;
  - pass B, seed B, decks and criteria reversed;
  - pass C, a seeded code-point shuffle, only when any score's A/B spread exceeds 3;
  - seeds are `uint31(sha256("<runId>|<setId>|<batch>|<pass>"))`.
- Prompt: a shared prefix first (instructions, owner rulings, the top-5 popular decks), the deck block last, so passes
  reuse the prefix cache. Batches are cut deterministically to at most 24k prompt tokens.
- Blindness test: the rendered prompt contains no source kind, file name, branch id, temperature, lens, owner-seat
  marker, sim figure or ideas-session score.
- Reduction in code:
  - per deck and criterion, the median over passes (the 2-pass mean rounded half-up to one decimal);
  - a flag counts in a majority of passes;
  - JQ2 is the Spearman of S between pass A and pass B, at least 0.5;
  - JQ3 is |Spearman| between position and S, under 0.3 in each pass;
  - both are stored in the set's result.
- Judge calls run whenever triggered, alongside the pool, gated only by the memory guard. The confirm waits for a J1
  verdict after the screen; the measured worst case is about 35 min.
- A replay from the captures reproduces `triggers.json`, the medians, JQ2 and JQ3 byte for byte.

**Touches**: `src/autonomy/triggers.ts`, `src/autonomy/judge-prompt.ts`, `src/autonomy/judge-reduce.ts`,
`scripts/autonomy/step.ts`, `tests/autonomy/`

**Open gaps**: the starting thresholds (link coverage 0.5, JQ2 0.5, JQ3 0.3, spread 3) await calibration (open owner
question 4).

## judge-calibration — Offline judge calibration against the pinned opus judges (JQ4)

**Goal**: Before any judge score orders anything, show that the local judge reads decks the way the pinned opus judges
did. Without a passing record, judge scores are shown only. This checks agreement, not correctness, because opus is not
ground truth either.

**Acceptance**:
- `scripts/autonomy/judge-calibration.ts` judges the pinned jerjerrod-dume judge input (`judge-ideas.md`,
  `anon-map.tsv`, and the opus returns: `judge2.txt` and the returns in the session record) with the real J-prompt and
  2 passes, capturing every call.
- It writes `judge-calibration-v1.json` with the Spearman of the local median S against the opus median S, the opus
  trap flags recovered, JQ2 and JQ3, the model digest, and an input and output replay record.
- Pass requires a Spearman of at least 0.4 and recovery of the opus trap flag on Clone of the Zillo Beast (I05; T08-5
  as I47).
- One A/B with `think: true` (thinking tokens budgeted on top of the answer) against `think: false`. It keeps
  `think: false` unless thinking raises the Spearman by 0.1 or more.
- The 9B (`qwen3.5-9b-heretic-highiq`, with its baked-in `SYSTEM` prompt and defaults recorded) is calibrated only if
  the 27B fails. The 27B stays the judge unless the 9B passes and the 27B does not.
- The record is written to `data/autonomy/`. Promotion to `data/pinned/local-autonomy/` is an owner or
  agent-git-guardian commit, never the loop's.
- `ranking` reads the newest passing record and refuses judge ordering without one (test).

**Touches**: `scripts/autonomy/judge-calibration.ts`, `src/autonomy/judge-prompt.ts`, `tests/autonomy/`

**Open gaps**: whether all three opus judge returns are machine-readable. Only `judge2.txt` is a plain line file today.
If fewer than 3 opus returns parse, the record says how many it used.

## ranking — Deterministic ranking with judge fallback at named triggers only

**Goal**: Order the shortlist from measurements by default. Judge medians are used only where a trigger fired and the
judge set passed its gates. The ranking is reproducible from the stage records and captures alone.

**Acceptance**:
- Deterministic key:
  - the low end of the confirm field interval, then the screen's for decks not confirmed;
  - then the field difference, lower extra cost, more anchors carried, lower rotation share, and the deck id in
    code-point order.
- Judge use is limited to these cases, each with a fixture:
  - J2 tie blocks at a cut: ordered by median S, then the key;
  - J1, too small to rank: ordered by median S, then the key, labelled "ordered by local judges (Qwen), because the
    computer-player results were too small to rank", with the gauntlet order printed beside it as noise;
  - J3 and J4 majority flags: sort below unflagged decks inside a tie block only.
- S is the sum of the four medians plus R. R is 1 for 2 or more gate-passing returning cards, 0.5 for one and 0
  otherwise, for source (a) only; source (b) decks get 0, and the report says so.
- Fallbacks:
  - a set that fails JQ2, or no passing JQ4 record: the key decides, and the report says why;
  - model unavailable: the key decides, every gap reads "not judged (model unavailable)", and id order is never called
    a ranking.
- Owner seats and the wild seat carry their labels. An owner seat never becomes "build first" by its seat alone.
- A replay from `data/autonomy/runs/<runId>/` gives a byte-identical `08-rank` output (golden fixture).
- D112's "Enforced in" line lists the files that implement it.

**Touches**: `src/autonomy/rank.ts`, `scripts/autonomy/step.ts`, `docs/decisions.md`, `tests/autonomy/rank.test.ts`

**Open gaps**: none

## run-reports — Run report with measured and judged figures side by side

**Goal**: Give the owner one plain-language report per run, readable on either Mac. It leads with "too small to rank"
when that applies and labels every figure with where it came from.

**Acceptance**:
- `report.md` is rendered with no clock, written to the run directory and copied to
  `~/.local/state/swu-autonomy/reports/<runId>.md`.
- When any stage missed a control, the first line after the title says "too small to rank", with the control verdicts.
- Each shortlisted deck shows labelled blocks:
  - "measured": figures with ranges, card checks, extra cost, anchors, rotation share, link coverage, novelty, gate
    facts and the D108 label with the calibration caveat;
  - "local judges (Qwen, <n> passes, median)", or "not judged: the measurements answered";
  - "ideas-session judges (Claude)" when present;
  - "the ideas session's words", quoted.
- Each ranking line names what ordered the deck.
- "Cards to replace when building" lists majority-confirmed `trap-card` flags with the clause quoted, and card checks
  whose interval sits wholly above 0.
- Code-written sentences pass a banned-word lint (the skill's plain-language list). Model text is quoted and marked,
  never rewritten.
- No player name, player id or Karabast source appears (test).
- `status.json` `lastResult` carries the headline, `tooSmallToRank`, and the top 3 with figures and their ordering
  source. `events.jsonl` gets one event per run end, needs-owner, blocked and failed.

**Touches**: `src/autonomy/report.ts`, `scripts/autonomy/step.ts`, `tests/autonomy/report.test.ts`

**Open gaps**: none

## launchd-install — launchd agent, installer, doctor and runbook

**Goal**: Run the runner under launchd without the TCC, QoS and pended-spawn failures already measured on this box.
Make the agent's real state checkable, so a loaded agent is never reported as working.

**Acceptance**:
- `scripts/autonomy/com.graham.swu-autonomy.plist`:
  - program `/opt/homebrew/bin/node` with `--import tsx scripts/autonomy/runner.ts`;
  - `WorkingDirectory` the autonomy worktree `/Volumes/Local Files/Projects/swu-mcp-autonomy`;
  - `ProcessType Standard`, `LowPriorityIO` false;
  - `StartCalendarInterval` 23:00 plus `WatchPaths` on `~/.local/state/swu-autonomy/wake`;
  - `RunAtLoad` false, `KeepAlive` false, `AbandonProcessGroup` false, `ExitTimeOut` 30;
  - `EnvironmentVariables` `PATH=/opt/homebrew/bin:/usr/bin:/bin` and `TMPDIR=<worktree>/tmp`;
  - `StandardOutPath` and `StandardErrorPath` under `~/Library/Logs/swu-autonomy/`.
- `scripts/autonomy/install.mjs`:
  - creates the log and state directories;
  - copies the plist as a real file, never a symlink;
  - installs the bundled `ctl` and the `~/bin/swu-autonomy` wrapper;
  - records the sha256 of each;
  - bootstraps the agent;
  - runs no git command.
- `ctl doctor` exits non-zero when:
  - `launchctl print` shows a non-zero `last exit code`;
  - `runs = 0` after a scheduled fire;
  - an installed sha256 differs from a fresh build;
  - the worktree is dirty or missing;
  - the log directory is absent.
- After install, `ctl start` touches `wake`, `launchctl print gui/$(id -u)/com.graham.swu-autonomy` shows `runs`
  incremented within 10 s, `ps -o command=` shows `/opt/homebrew/bin/node`, and the log file exists on the internal
  disk.
- `docs/runbooks/local-autonomy.md`:
  - worktree creation with `scripts/dev/worktree-add.sh`, run by the owner or agent-git-guardian;
  - install;
  - doctor;
  - the window and guards;
  - promotion of a run into `data/pinned/local-autonomy/`;
  - recovery from each `blocked` reason.

**Touches**: `scripts/autonomy/com.graham.swu-autonomy.plist`, `scripts/autonomy/install.mjs`, `src/autonomy/ctl.ts`,
`docs/runbooks/local-autonomy.md`

**Open gaps**: whether `StartCalendarInterval`, a nondemand spawn, is ever pended on this box is unmeasured.
`first-week-observations` checks `runs` after each scheduled fire, and `ctl doctor` flags a never-fired schedule.

## swiftbar-plugin — SwiftBar plugin on macstudio and grahams-macbook-neo over a forced-command SSH key

**Goal**: Let the owner monitor and manage the loop from the menu bar on both Macs. The MacBook reaches the Studio over
the tailnet through one forced-command SSH key, with no new HTTP listener.

**Acceptance**:
- Plugins are thin wrappers, in the house style of `mault.stream.sh`:
  - Studio: `swu-autonomy.15s.sh` runs `exec /opt/homebrew/bin/node ~/.local/libexec/swu-autonomy/ctl.mjs status
    --swiftbar`;
  - MacBook: `swu-autonomy.30s.sh` runs `exec ssh swu-studio "status --swiftbar"`. On failure it prints "SWU: studio
    unreachable" with the cached status age from `~/.cache/swu-autonomy/`.
- `ctl status --swiftbar` prints:
  - the title (state plus step or result, for example "SWU: screen 41% (2h left)");
  - Now (run, deck set, step, progress, ETA, heartbeat age, triggers fired);
  - Queue (with `rm`, `move up`, `Seal`);
  - Add ("Queue ideas run" from `ideasRuns`; "Queue decks" through an `osascript` file chooser piped to
    `queue add-deck`);
  - Last result (headline, too small to rank, top 3 with sources, open report);
  - Seat (before a confirm);
  - Health (Ollama, pool lock, launchd runs and last exit, disk, worktree);
  - Actions (Start, Pause, Pause now and Stop with a confirm, Resume, Resume without model).
- SSH:
  - The runbook gives the owner paste-ready commands for a MacBook key `~/.ssh/swu_autonomy_ed25519`, a Host
    `swu-studio` (HostName <studio-tailnet-ip>, BatchMode yes, ConnectTimeout 5, ControlMaster auto, ControlPersist 120s), and
    one Studio `authorized_keys` line:
    `from="<macbook-tailnet-ip>",restrict,command="/opt/homebrew/bin/node /Users/graham/.local/libexec/swu-autonomy/ctl.mjs --ssh"`.
    The real tailnet addresses never enter this public repo: the installer reads them from `tailscale status` at install time and writes them only into `~/.ssh/config` and `~/.ssh/authorized_keys` on each machine.
  - `ctl --ssh` parses `SSH_ORIGINAL_COMMAND` with the shared grammar, and stdin only for `queue add-deck`. Tests
    refuse `status; rm -rf ~`, `$(...)`, unknown verbs, over-size stdin and `replay`.
- Verified from grahams-macbook-neo:
  - `ssh swu-studio "status --json"` returns JSON valid against `docs/schemas/autonomy-status.v1.schema.json`;
  - `ssh swu-studio "ls"` is refused;
  - the plugin renders within 5 s with ControlMaster warm.
- Notifications fire once per new `events.jsonl` event (run finished, needs-owner, blocked, failed).

**Touches**: `scripts/autonomy/swiftbar/swu-autonomy.15s.sh`, `scripts/autonomy/swiftbar/swu-autonomy.30s.sh`,
`src/autonomy/ctl.ts`, `docs/runbooks/local-autonomy.md`

**Open gaps**: whether the Tailscale standalone app (1.102.4) runs a Tailscale SSH server is unverified. The design
does not depend on it. A tailnet policy rule limiting port 22 on macstudio to grahams-macbook-neo is optional
hardening for the owner.

## first-week-observations — First-week observation log for the measurements the compute plan could not make

**Goal**: Measure in production what the compute plan could not measure in a 52-second window, and turn each result
into a kept or changed threshold. Undecided numbers then get settled by evidence, not by default.

**Acceptance**:
- `docs/research/local-autonomy-first-week.md` records, per night for 7 nights:
  - `thermalState` and `pmset -g therm` per stage;
  - games/s against the stage's rolling median;
  - load average and `kern.memorystatus_level` at each stage start;
  - swap use (it was already at 96% before the loop);
  - `runs` and `last exit code` after the 23:00 fire;
  - control detection per stage;
  - triggers fired, with JQ2 and JQ3 per judge set;
  - JQ5 (the Spearman of judge `win` against the confirm field difference) on runs whose controls were detected.
- One measured A/B each, with commands:
  - `Nice 5` against no `Nice`, on rung-1 games/s;
  - a fair-rung worker sweep at 8, 12 and 14;
  - build and panel step durations;
  - TMPDIR use of a full gauntlet stage.
- One owner-run `sudo powermetrics` sample under `Standard` during a fair-rung stage, recording performance against
  efficiency core use. It is owner-run because it needs root.
- `OLLAMA_NUM_PARALLEL=2` is recorded as untested. Architecture `qwen35` does not support parallel requests on
  0.32.14, so it is rechecked only after an Ollama upgrade, and never by changing the shared daemon without the owner.
- Ollama determinism is re-run with `ctl verify-capture` on 3 captures after any Ollama upgrade.
- Each threshold kept or changed is listed with its evidence. A changed threshold lands as a code change plus an
  amendment line on D112.

**Touches**: `docs/research/local-autonomy-first-week.md`, `src/autonomy/guards.ts`, `docs/decisions.md`

**Open gaps**: the observations depend on the owner queueing deck sets during the week.

## Non-goals

- Qwen ideation, or any model writing, editing, building or removing a deck. The inputs are decks already ideated.
- Any change to card scoring: `score_card`, the rubric, the curated tables and the advice tools stay as they are.
- Pushing anything, or any git operation by the loop: no commit, tag, push or release. Promotion into `data/pinned/`
  is an owner or agent-git-guardian action.
- A VALUABLE claim. An advice-tool change still needs the judged-sessions rerun (docs/runbooks/judged-deck-sessions.md).
- Changing the D88 calibration gates, `simulate_matchup`'s served modes, or the bot rungs, including speeding up the
  fair rung, which needs its own `rung3` profile first.
- Reconfiguring the shared Ollama daemon (`com.ollama.serve`) or sending `keep_alive: 0`.
- Any public or HTTP control surface: no Funnel, no `tailscale serve` endpoint, no Caddy route.
- Running compute on grahams-macbook-neo. It runs the SwiftBar plugin only.
- Reusing the 74 legacy models on `/Volumes/Models/swu` (D93).

---
type: runbook
status: active
review_by: 2026-12-31
related: ["CLAUDE.md", "docs/decisions.md", "docs/specs/learned-play-policies.spec.md", "docs/verification/2026-10-31-sim-calibration.md", "docs/verification/2026-10-31-bot-ladder.md", "docs/research/sim-compute-measurements.md"]
---

# Simulation pipeline

What this is: how the bot-versus-bot simulation code is set up, run, gated and re-run. Simulations are local only and never ship in the data release (D88). Bot play is the last tier of play data (D21), so a simulated win share never mixes with tournament numbers.

Status today: every bot rung fails the external calibration gate, so `simulate_matchup` serves no win share. Details are under "Current status" below.

## Engine pin

The rules engine is forceteki, an input like any decklist (`src/sims/engine-pin.ts:9-16`). One commit, one card-data snapshot and the Node version are recorded in `data/pinned/forceteki/pin.json` (`src/sims/engine-pin.ts:19`).

- `pnpm sims:pin` verifies the local clone against the pin and exits 1 on any mismatch (`scripts/sims/pin-engine.ts:1-10`).
- `pnpm sims:pin --setup` clones the engine at the pinned commit and builds it. A clone at another commit is refused, never checked out over (`src/sims/engine-pin.ts:137-140`).
- `pnpm sims:pin --write` records the clone's current state as the new pin. Use it only for a deliberate re-pin; it makes every ladder and gate record stale (see "Rerun triggers").
- Every simulation verifies the pin before it loads the engine (`src/sims/engine.ts:143-144`).
- The engine runs with `NODE_ENV=test` because forceteki words prompts by environment (`src/sims/engine.ts:120-125`).

## Typed driver and determinism

Every match is a record that replays (D80, `docs/decisions.md:186`).

- Each legal answer becomes a descriptor, sorted in code-point order, so no choice depends on the engine's enumeration order (`src/sims/actions.ts:98`).
- Bot randomness is counter-based: draw j at decision k for seat s is `seededRandom("bot|seed|s|k|j")` (`src/sims/rng.ts:15`). A branch at decision k leaves every earlier decision byte-identical, and a policy change cannot shift the other seat's draws.
- The engine seed is set before the deck is selected, and the adapter's counting wrapper throws on any engine draw before the seed (`src/sims/engine.ts:269`, D80).
- Header, decision and footer records use strict Zod schemas with no wall-clock field (`src/sims/schemas.ts:86`).
- The replay gate is `pnpm sims:replay-gate`. It plays the panel matches, replays every record to an identical `traceSha256`, checks that worker threads equal one thread, and checks that rung 0 traces do not depend on undo mode (`scripts/sims/replay-gate.ts:1-14`). `pnpm sims:replay` replays one record and stops at the first mismatch.

## Bot ladder

A rung is a pure function from the actor's view, the canonical legal actions, its pinned tables and the decision randomness to one index (`src/sims/policy.ts:7-15`). A prompt a rung does not cover descends to the next rung down, ending at rung 0, and the share it answered itself is reported.

- Rung 0: uniform over the canonical actions, `Done` half the time on a multi-select prompt (`src/sims/policy.ts:64`).
- Rung 1: plays from card data (cost, power, HP, damage, keywords, aspects, parsed text). It is the first promoted rung (D79, `docs/decisions.md:184`; `src/sims/policies/rules.ts:115`).
- Pilot switches on rung 1: `sacGuard`, `initDraw`, `handCap`, `aspectCall` (`src/sims/policies/rules.ts:50`). A switch is a 0-or-1 flag in the policy name. It enters the params hash only when set to 1 (`src/sims/policies/index.ts:58`), so `rung1` keeps its pinned hash. D92 keeps `sacGuard` and `handCap`; it rejects `initDraw` and `aspectCall` (`docs/decisions.md:210`). The pilot named `rung1:sacGuard=1,handCap=1` is the kept form.
- Rung 2: adds pair and leader bonuses to rung 1. It is not promoted. At 800 held-out pairs it won 48.55% against rung 1 (D79, `docs/verification/2026-10-31-bot-ladder.md:54`).
- Rung 3: searches on the engine with snapshots and rollback (D81, `docs/decisions.md:188`). It has two forms, both deterministic counts with no time budget:
  - `rung3` is a top-K lookahead ranked by rung 1 (`src/sims/policies/rung3.ts:145`). The measured form is `rung3:k=8`.
  - `rung3mc` is flat Monte Carlo over every legal main action (`src/sims/policies/flat-mc.ts:89`), for example `rung3mc:playout=rung1,n=2`.
- Rung 4 is the planned learned evaluator (see "E9 lifecycle").

Throughput on 12 workers, both seats on the rung: rung 1 about 47 games per second, rung 3 top-K about 1.2, flat Monte Carlo about 0.24 (`src/tools/sims.ts:49`).

## Calibration gate

A rung's win share reaches `simulate_matchup` only when its pinned gate record passes four gates (D88, `docs/decisions.md:202`). `scripts/sims/calibration-gate.ts` writes one record per rung to `data/pinned/sim-calibration-v1/` (`gateRecordSchema`, `src/sims/calibration.ts:229`).

The four parts and their thresholds (`CALIBRATION_THRESHOLDS`, `src/sims/calibration.ts:23-30`):

1. Replay: 50 calibration matches replay to the worker's trace (`replayMatches: 50`).
2. Health: non-decisive games at most 2% (`nonDecisiveMax: 0.02`) and fallback decisions at most 5% (`fallbackMax: 0.05`).
3. Ladder: the rung beats rung 0 and its promoted predecessor, from pinned ladder records under `data/pinned/sim-ladder-v1/` with the same candidate, engine and card tables (`ladderStep`, `src/sims/calibration.ts:187`).
4. External: Spearman rank correlation between sim shares and swumetastats tournament shares of at least 0.5 (`spearmanMin: 0.5`), and the sim favourite agrees with the tournament favourite more often than chance by a one-sided exact sign test at p < 0.05 (`favouriteAlpha: 0.05`). Tournament matchups need at least 10 decisive matches (`minN: 10`).

The thresholds were fixed before the first measurement. Changing one needs a measurement posted on #118 first and a D-entry that says so (D53, `docs/decisions.md:134`).

To measure a rung, run `scripts/sims/calibration-gate.ts --policy <spec>` with the preload shown in the README (`README.md:221`). Use `pnpm sims:batch` for batches and `scripts/sims/ladder.ts` for ladder records. Each long run emits a progress file under `reports/.progress/`.

## `simulate_matchup`

- It is registered only when the server runs with `SWU_MCP_SIMS=1` (`src/tools.ts:197-198`). The public endpoint and the `npx` path never start the engine.
- It picks the pilot with `choosePilot` and returns a plain error naming the failed gate when no rung passes (`src/tools/sims.ts:196`, `src/sims/calibration.ts:331`). With no passing record it refuses to report a win share.
- It runs one deterministic background job at a time, keyed by its input (`src/tools/sims.ts:227-229`).
- Its output is labelled bot play, `status: candidate`, and never a tournament win rate (D21).

## Current status

- Rung 1 and rung 3 top-K pass replay, health and ladder, and fail the external gate: Spearman -0.17 and -0.21, favourite agreement 15 and 16 of 37 (D88, `docs/verification/2026-10-31-sim-calibration.md`).
- The failure is real. It is not an orientation or identity bug, and not the choice of one list per archetype (D90, `docs/decisions.md:206`).
- The cause is a tempo bias in the bot pilots. They play some archetypes far below their tournament share, for example Krennic. Pilot switches moved the shares toward the tournaments but no pilot passes (D92, `docs/decisions.md:210`).
- The next lever is the learned evaluator, E9.

## E9 lifecycle

E9 (#122) trains an evaluator that steers rung 4. The spec is `docs/specs/learned-play-policies.spec.md`. The phases, in order:

1. #123 inventory: the models already on `/Volumes/Models/swu`, pinned by hash and provenance. All are quarantined (D52, D93); none is reused. Landed in commit e08c163.
2. #124 encoding: a versioned state encoding (`STATE_VERSION`, `src/sims/state.ts:15`) and a pinned card vocabulary under `data/pinned/sim-vocab/`. Landed in commit 8ee9932.
3. #125 dataset: branch-sampled decision values from seeded games, with a manifest under `data/pinned/` and the bulk data on `/Volumes/Models/swu`.
4. #126 training: the model is fitted once, captured as a pinned, hashed input, and never trained inline (D3). The committed baseline is the constant model until a model trained on allowed data exists (D52).
5. #127 inference: the evaluator runs inside the game loop under a throughput gate.
6. #128 rung 4: lookahead with the evaluator, determinized over seeds, then the ladder and the four gates.
7. #130 self-play: an iteration loop with a stop rule and its own seed ranges.

#133 holds the D-entries. Rung 4 needs its own D-entry before any tool reads an evaluator output (D53, CLAUDE.md "No model in the scoring path"). Check the tracker for the current open state of each issue; this list gives the order, not the status.

## Rerun triggers

Each rerun posts its measurement on #118 before any threshold or default moves (D53).

- Engine pin change: every ladder and gate record goes stale. Rerun the ladder step, then the gate, for the best candidate rung and for any rung currently serving.
- New data release:
  - If the card-table hash moved, rerun the ladder and the gate.
  - If only the meta hash moved (new swumetastats or melee data), rerun the external gate only. Replay, health and ladder do not read meta.
- New vocabulary revision (a new set): the evaluator goes stale. Retrain, then run the rung 4 ladder and gate.
- New rung or new policy params hash, including a new evaluator capture: the ladder step against its promoted predecessor, then the four gates.
- A rung is served only from a record whose engine commit equals the pinned one (`src/sims/calibration.ts:331-336`), so a stale record serves nothing.

## Watching runs

`pnpm sims:watch` shows every running or just-finished simulation job in one terminal (D99, #178). Run it in a second terminal; it only reads and writes nothing. Options: `--all` (every heartbeat file, not only live jobs and jobs from the last hour), `--once` (print one frame and exit; also the default when output is not a terminal), `--interval <s>` (default 2), `--no-color`. `q` or Ctrl-C quits. Without the pnpm shim: `node node_modules/tsx/dist/cli.mjs scripts/sims/watch.ts`.

Where it looks. It lists the main checkout and every linked worktree with `git worktree list --porcelain` (`src/sims/watch.ts:47`, `scripts/sims/watch.ts`), and reads `reports/.progress/*.json` in each, plus `tmp/sims-jobs/<key>/progress.json` for `simulate_matchup` jobs (`src/sims/watch.ts:107`). A file that does not parse is counted in the last line of the screen, never dropped silently. By default it shows live jobs, a stalled job whose process still exists, and anything that finished or went quiet in the last hour (`src/sims/watch.ts:135`).

What each block shows, top to bottom:

- Header: job name, `[worktree branch]`, state, heartbeat age. RUNNING is a fresh heartbeat. STALLED means the heartbeat file is older than 5 minutes (`STALLED_AFTER_S`, `src/sims/watch.ts:18`). DEAD means the pid in the heartbeat no longer exists. DONE means the job wrote `phase: done`.
- `x of y games (pct)`, a bar, ETA and games per second. These come from the heartbeat envelope (`scripts/lib/progress.mjs`): `done`, `total`, `eta_s` and the new `games_per_s` (two decimals; `rate_per_s` stays the rounded integer). In the calibration gate the count is games first, then replay and undo checks, and the block says so.
- `phase n: <name> (a of b games in this phase)`: the running phase of a multi-phase job (each ladder step, each h2h variant, the mirror, a field policy).
- The subject's share of decisive games with the Wilson 95% interval (`shareOf`, `src/sims/policies/ladder-stats.ts:49`). A draw, timeout, stuck game or error is not decisive and is not in the share.
- `paired:` for duplicate pairs (the same seed with the seats swapped): pairs the subject won in both seats against pairs it lost in both, and the exact two-sided sign test on those (`signTest`, `src/sims/policies/ladder-stats.ts:16`). It is the same test the pinned record reports at the end, run on the pairs finished so far, so an early p is a progress reading and not a verdict.
- `health:` decisive games, draws, timeouts, stuck games and errors, mean rounds and decisions per game, and the share of decisions that fell back to rung 0. Error seeds are listed so a failing game can be replayed.
- `seat 1 won`: seat 1's share, over the mirror games when the phase has some, else over all games. A share far from 50% in a mirror is a seat bias.
- Groups and rows: one line per candidate or subject (with its own sign test), and one entry per opponent archetype or archetype pair.
- `counters:` named integers where a job exposes them. The branch sampler reports rollbacks, determinizations, continuations, replay and trace mismatches, and the drift counters that must stay 0. The calibration gate reports replay checks. The cost mode reports search bookmarks and rollbacks. Games on the worker pool return footers only, so a ladder or calibration run has no per-game search counters.
- `provenance:` policy names with the first 12 characters of their params hash, the seed range, the engine pin, the code commit and the run date.
- `last progress`: seconds since a tick last wrote. The heartbeat age counts the keepalive (below), so a live process that moves nothing shows a fresh heartbeat and a growing `last progress`.

How the payload travels. The writers are `scripts/sims/ladder.ts`, `calibration-gate.ts`, `sample-branches.ts` and `matchup-job.ts`. Each feeds finished games into `LiveStats` (`src/sims/live-stats.ts:173`) and passes the snapshot to the heartbeat under the key `stats`, parsed by `liveStatsSchema` (`src/sims/live-stats.ts:46`, a strict Zod v4 schema) in the reader. The payload goes to the heartbeat only: no gate, ladder or match record contains it, so a record keeps its bytes (D99). It holds no clock field; ETA and rate belong to the envelope. The pool returns a batch of games at a time (40 per worker), so the counts move once per batch: a rung 3 batch can take minutes. `KEEP_ALIVE_MS` (`scripts/sims/live.ts:13`) rewrites the latest heartbeat every 15 s so a long batch does not read as STALLED. `simulate_matchup` status replies carry the same payload as `progress.stats` (`src/tools/sims.ts:155`).

Reading a stall. The Pool rule below still holds: a heartbeat that has not moved in 5 minutes is checked, and the job is killed only if you started it. STALLED with a live pid and a growing `last progress` is a hung pool; DEAD is a crash (read the job's stderr).

## Condensed summary for widgets

`pnpm sims:summary` reads the same heartbeats as `sims:watch` (the main checkout and every linked worktree, `reports/.progress/*.json` and `tmp/sims-jobs/*/progress.json`; discovery and the running, stalled, dead and done classification are `src/sims/watch.ts`, the checkout list is `src/sims/sources.ts`) and prints a small versioned document for a schickso in-pull plugin and a TerminalWidget provider (D100, #179). Call it as `node "<repo>/node_modules/tsx/dist/cli.mjs" "<repo>/scripts/sims/summary.ts" --json`; a bare `pnpm` call costs about 30 s on this volume. `--text` is the default.

Exit codes. 0 with an empty `jobs` list when nothing ran recently. 2 when the repo cannot be read, when both flags are given, or when the summary fails its own schema (the emitter gate, `simsSummarySchema.parse` at the end of `summarize`, `src/sims/summary.ts:180`).

The JSON (schemaVersion 1; the schema is `simsSummarySchema`, `src/sims/summary.ts:49`, and the JSON Schema export is `docs/schemas/sims-summary.v1.schema.json`):

- `schemaVersion` 1, `generatedAt` (ISO, UTC), `repo` (directory name only).
- `totals`: `running`, `stalled`, `dead`, `doneLastHour`. They count every visible job, before the cap on `jobs`.
- `jobs`, at most 8, in this order: stalled, then dead, then running (an urgent job is never cut by the cap), then finished jobs from the last hour, newest first. Within a state the freshest heartbeat comes first. A job is visible by the same rule as the `sims:watch` default view (`selectVisible`, `src/sims/watch.ts`).
- Per job: `id` (the heartbeat's job name), `worktree` ("main" for the main checkout, else the worktree directory name), `kind` (ladder, field, h2h, tune, cost, calibration, branches, matchup, other; the writer's own kind from the live stats, with grid as other, and for a heartbeat without stats the kind the job name says), `state`, `phase` (at most 80 characters, "done" once finished), `done`, `total`, `pct`, `etaS` (null once finished), `gamesPerS`, `updatedAgeS` (seconds since the file was last written, the keepalive counts), `result`, `health`, `verdict`, `headline`.
- `result` is null or `{ subject, share, low, high, p, n }`: the subject's share of decisive games with its Wilson 95% interval, `n` the decisive games, `p` the running exact sign test on duplicate pairs or null without pairs. A running `p` is a progress reading, never a stopping rule (D99 point 2). A finished job with no running phase falls back to its last finished phase.
- `health` is `{ errors, draws, timeouts }` over the whole run; all zero when the heartbeat has no stats, which says nothing about the run's health.
- `verdict` is null, or `{ pass, failedGates }` for a finished calibration or ladder job whose done heartbeat carries `pass` (`scripts/sims/calibration-gate.ts:352` writes `pass` and `failedGates`; `scripts/sims/ladder.ts:432` writes `pass` only, so a ladder verdict has an empty `failedGates`).
- `headline` is one line of at most 72 characters, for example `h2h base vs anakin 36% 4560/12600 ETA 1h45 base 51.2% [47.9,54.5] p .31`. STALLED and DEAD jobs start with that word and end the progress part with `quiet <age>` in place of the ETA. A finished job reads `done <done>/<total>` and PASS or FAIL with the failed gates. The contenders (or the shortened job name) shrink first when the line is too long; the progress and the result stay.

`--text` is at most 5 lines of at most 60 characters. Line 1 is the totals, `SWU sims 1 running, 0 stalled, 3 done/1h` (a nonzero stalled count is capitalised and a nonzero dead count adds `, N DEAD`). Then one line per job in the JSON order, with STALLED and DEAD in capitals; with more than four jobs it shows three and a last line `+N more jobs`. A text line drops the counts and the interval to fit.

What it never contains: an absolute path or a hostname (strings are scrubbed in `summarize` and the schema rejects a leak), or any Karabast-derived figure (it reads only simulation heartbeats; D22).

The export. `pnpm sims:summary:schema` rewrites `docs/schemas/sims-summary.v1.schema.json` from the Zod schema with `z.toJSONSchema` (`scripts/sims/export-summary-schema.ts`; `--check` only compares). `tests/sims/summary.test.ts` fails when the committed file is stale. A field change is a new schemaVersion and a new schema file, never an edit of v1.

## Pool rule

Run one sims pool job at a time. Each job takes 12 workers, the number of performance cores on the dev machine (`src/tools/sims.ts:104`). More workers do not raise throughput and do raise memory. The measurements are in `docs/research/sim-compute-measurements.md`.

Bound every wait. Check a backgrounded run within 5 minutes and kill it if its `reports/.progress` file has not moved (CLAUDE.md, volume and operations).

## Scripts

The `pnpm sims:*` scripts in `package.json:45-59`:

- `sims:pin`: verify, set up or re-pin the forceteki engine (`scripts/sims/pin-engine.ts`).
- `sims:bridge-coverage`: engine id coverage report over a deck folder (`scripts/sims/bridge-coverage.ts`).
- `sims:play`: the batch runner on this thread only, one game by default (`scripts/sims/play.ts`).
- `sims:batch`: the batch runner on the worker pool (`scripts/sims/run-batch.ts`).
- `sims:replay`: replay match records from a JSONL file and stop at the first mismatch.
- `sims:replay-gate`: the replay gate (see "Typed driver and determinism").
- `sims:branch-probe`: probe a snapshot branch from a decision K of a seeded game.
- `sims:feature-map`: the legacy feature map the existing models use (`scripts/sims/feature-map.ts`).
- `sims:inventory`: inventory the models on `/Volumes/Models/swu` into `data/pinned/sim-models/` (D93).
- `sims:vocab`: build the pinned card vocabulary under `data/pinned/sim-vocab/`.
- `sims:watch`: the live terminal view of every running simulation job (see "Watching runs").
- `sims:summary`: the condensed JSON or text summary for widgets (see "Condensed summary for widgets"); `sims:summary:schema` regenerates its JSON Schema.

Other scripts in `scripts/sims/` have no `pnpm` alias: `calibration-gate.ts`, `calibration-report.ts`, `ladder.ts`, `trace-calibration.ts`, `model-parity.ts`, `matchup-job.ts`. Run them with `tsx` and read each file's header for its usage.

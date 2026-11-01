---
type: research
status: draft
review_by: 2026-12-31
question: Can swu-mcp run forceteki itself to produce deterministic bot-vs-bot game records and a decklist battle-test tool?
as_of: 2026-10-30
related: [../decisions.md, ../../scripts/sims/play.ts, ../../scripts/sims/run-batch.ts, ../../scripts/sims/branch-probe.ts, ../../scripts/sims/replay.ts]
---

# Running forceteki inside swu-mcp

## TL;DR

Yes, it is feasible. forceteki (the open-source Karabast rules engine, MIT) built on this machine in 11 s, passed the unit specs I ran, and played all 600 games I ran on three real tournament lists (three pairs, 100 games each, two policies) with no error once my driver's own indirect-damage mistake was fixed, using a driver I wrote (about 320 lines) (`scripts/sims/play-game.mjs` at 8a9fb48) that answers the engine's prompts in process, with no client, lobby or server. Games are seedable and byte-replayable: the same seed gave the same decision trace in separate processes and under 1, 4, 8, 12 and 16 worker threads. Speed is 3.8 games per second on one thread and 15 to 36 games per second on 16 worker threads (100 games in 2.8 to 6.7 s), so a 10 to 30 s interactive budget holds for about 100 games of one matchup and for roughly 600 games (six archetypes at 100 each) on this machine only.

The weak point is the player, not the engine. forceteki ships no bot. A uniformly random bot passes about as often as it plays, and a 10-line "prefer playing and attacking over passing" policy beat it in 91% and 93% of 200 mirror games per seat. A win share from random bots measures tempo, not deck strength, so the deck-testing tool needs a scored policy built from swu-mcp's own tables, and its output must be labelled bot play (D21 puts bot simulations in the last tier).

Snapshot and branching also work (rollback in 3 to 6 ms), with two caveats listed under determinism.

## What forceteki is, and what the existing sims extract came from

forceteki is the server-side rules engine for Star Wars: Unlimited behind Karabast, plus a Node game server. Repository: https://github.com/SWU-Karabast/forceteki. License: MIT (GitHub reports key `mit`; `LICENSE` in the clone credits Ringteki and Addison Mayberry). The architecture is inherited from Ringteki: a pipeline of nested prompts and windows that unwinds to the caller whenever it needs player input (`CLAUDE.md` in the clone, section "Layers" and "Action and trigger flow").

The existing `data/originals/sims/sims-dcae65b3aba8.jsonl.gz` (133,277 games) came from a different, earlier project, not from mault-train. Evidence:
- `data/originals/sims/sims-dcae65b3aba8.manifest.json` lists three inputs named `game_records_2026-01-29T04-33-16-563Z.jsonl` and siblings (12.9 GB, `kind: forceteki-sim-games`), and its notes say "Bot-vs-bot games on the Karabast engine (forceteki); not human play".
- `scripts/bench/extract-sims.ts:26` reads them from `/Volumes/Models/swu-data/data/simulations`.
- The generator is `/Volumes/Models/swu-data/simulation` ("Batch simulation system for testing Star Wars Unlimited deck combinations using the forceteki game engine", its `README.md`), run against an older forceteki clone at `/Volumes/Models/swu-data/engines/forceteki` (commit 4ca1f881, 2026-01-28, one local patch to `server/game/gameSystems/PlayCardSystem.ts` plus `SIMULATION_PATCHES.md`).
- A grep of `/Volumes/Local Files/Projects/mault-train` for forceteki finds only a mention in `swu-card-data/embed/pkg/docs/swu-card-value-rubric.md` and in `swu-embedder/data/cards.jsonl`; no generator.

That generator has three AI players in `simulation/src/ai/`: `random-ai.ts`, `heuristic-ai.ts` and `strategic-ai.ts`, plus ML-model players. The record header carries no policy field, so which AI wrote the 133,277 games is unknown (unverified). One warning sign: the manifest counts `zeroCardsPlayedBothSides: 111359`, which is 83.5% of games; either the counter was never filled in or those bots rarely played cards.

forceteki-agent-kit (https://github.com/SWU-Karabast/forceteki-agent-kit) is not a source of headless play. Its plugin has one command, `/forceteki:setup-workspace`, and empty `agents/` and `skills/` folders (`.gitkeep` only), and it exists to share server-and-client knowledge between the two Karabast repos.

Record format of the existing sims: one JSON line per game with a header (`gameId`, `timestamp`, `format`, `player1` and `player2` with `deckId`, `deckName`, `leaderId`, `baseId`, `cardsPlayed`, `winner`, `winReason`, `turnCount`), then `initialState`, `actions`, `digests`, `checkpoints`. `scripts/bench/sims.ts:21` (`simHeaderSchema`) reads only the header.

## Build and run facts (measured)

- Clone: `/Volumes/Local Files/Projects/forceteki`, commit `445792e6185c10ca66c27a95893474c25256f3cc` (2026-10-30, "Support authenticated test users with and without local DynamoDB (#2655)"). Card data version file: `card-data-version.txt` = `20260423_00`.
- Node: `package.json` requires `>=26.12.1 <27` and `.npmrc` sets `engine-strict=true`; `.tool-versions` says 26.12.1. This machine has Node 26.4.0 (Homebrew), so `npm install` needs `--engine-strict=false`. Build, tests and 600 games all ran fine on 26.4.0, but that is an unsupported combination. The engine's own `CLAUDE.md` says "Node 22.x", which contradicts its `package.json` (stale doc).
- Steps run: `npm install --engine-strict=false --no-audit --no-fund` (3 s, 665 packages, cache under the worktree `tmp/npm-cache`), `npm run get-cards` (5 s; downloads 2,516 card JSON files, 10 MB, from https://admin.starwarsunlimited.com/api/cards, `scripts/fetchdata.js:430,550`, into git-ignored `test/json/`), `npm run build` (11 s; `tsc` into `build/server`), then `npm run test-fast build/test/server/cards/01_SOR/bases/Tarkintown.spec.js` (2 specs, 0 failures, 21 s including the test build) and all 18 leader specs under `01_SOR/leaders` (111 specs, 0 failures, 2 pending, 0.9 s).
- Card data needs the network once, at `get-cards`. The engine itself runs offline after that. Card data is Fantasy Flight's, which is a launch-stage licensing question (noted, proceeding).
- Memory: peak resident set 2.7 GB for 16 worker threads (about 170 MB each), measured with `/usr/bin/time -l`.

## The headless driver

Files, all in the swu-mcp worktree (`/Volumes/Local Files/Projects/swu-mcp/.claude/worktrees/feat-forceteki-sims/scripts/sims/`):
- `play-game.mjs`: loads the compiled engine from the clone, plays one game, exposes `Session` for pause and branch.
- `run-batch.mjs`: splits a seed range across `worker_threads`.
- `branch-probe.mjs`: snapshot and branch experiment.

Those three files are the spike's driver. Commit 35ddbd0 replaced them with the typed driver in `src/sims/` and `scripts/sims/`; the commands below are the current ones (scripts in `package.json:47-49` and `:51`, flags from the `parseArgs` calls and defaults in `scripts/sims/play.ts:13`, `scripts/sims/run-batch.ts:25-42`, `scripts/sims/replay.ts:19`, `scripts/sims/branch-probe.ts:20-22`). Every command also takes the context flags `--forceteki <dir>`, `--run <dir>`, `--originals <dir>` and `--no-memo` (`scripts/sims/context.ts:20-25`).

Commands:
- One matchup, N games, in this thread with full decision records: `pnpm sims:play --deck1 <swudb.json> --deck2 <swudb.json> [--games N] [--seed S] [--out <records.jsonl>] [--trace]` (one game by default)
- Parallel batch: `pnpm sims:batch --deck1 <swudb.json> --deck2 <swudb.json> [--games N] [--seed S] [--workers auto|N|0] [--policy1 rung0] [--policy2 rung0] [--record compact|full] [--out <records.jsonl>] [--undo] [--max-decisions N] [--quiet] [--trace]` (100 games, seed 1 and `--workers auto` by default)
- Replay recorded matches: `pnpm sims:replay --records <records.jsonl> [--index N]`
- Branch: `pnpm sims:branch-probe --deck1 <swudb.json> --deck2 <swudb.json> [--seed S] [--at K] [--branches N]` (seed 100, decision 150 and 20 branches by default; the engine is always run with `NODE_ENV=test`, `src/sims/engine.ts:124`)

How it works: it builds `new Deck(decklist, cardDataGetter)` for each seat (`server/utils/deck/Deck.ts:37-39` takes the leader, base and cards by set code), constructs `new Game(config, { router })` with a no-op scheduler and `UndoMode.Disabled`, calls `game.setRandomSeed(...)`, `game.selectDeck(...)`, `game.initialiseTokens(...)` and `await game.initialiseAsync()`, then loops: read the seat's prompt, pick an answer, call the matching `Game` method, call `game.continue()`, until `game.isEnded` (`server/game/core/Game.ts:254`). It follows the same recipe as the engine's own test harness (`test/helpers/GameFlowWrapper.js:41`, `test/helpers/GameStateBuilder.js`).

Measured throughput, Apple M4 Max (16 logical CPUs), Node 26.4.0:
- One thread, random bots, Cad Bane vs Krennic, 100 games: 26.2 s (3.8 games per second, about 260 ms per game, about 490 prompts per game, about 0.5 ms per prompt). Engine load is about 0.25 s once per process.
- One thread, 40 games per policy: random 272 ms per game; the scored policy 153 ms per game (it ends games in about 330 prompts instead of about 560). Tracing every decision added no measurable time.
- 100 games, Cad Bane vs Krennic, random bots, by worker count: 1 worker 26.2 s, 4 workers 8.2 s (12.3 games per second), 8 workers 6.0 s (16.6), 12 workers 5.6 s (17.8), 16 workers 5.6 s (18.0). Scaling stops near 8 to 12 workers (the machine has 12 performance cores).
- 100 games on 16 workers, three real-list pairs, random bots: 6.7 s, 4.8 s, 4.4 s (15.0, 20.9, 22.6 games per second); scored policy: 4.0 s, 4.7 s, 2.8 s (25.3, 21.3, 36.2).
- Undo mode on (snapshot at every timepoint) cost 37% more wall time on 20 games (7.7 s vs 5.6 s) and gave identical results.

## How a decklist reaches the engine

The engine takes SWUDB-format lists: `{ leader: { id: "SOR_005", count: 1 }, base: { id }, deck: [{ id, count }], sideboard }` where `id` is a set code `SET_NNN` (`server/utils/deck/DeckInterfaces.ts`, `Deck.buildDecklistEntry` in `Deck.ts:12-19` resolves it through `cardDataGetter.setCodeMap`). The tournament lists in `data/originals/decks/2026-10-17/*.json` are already in exactly this shape, so they feed the engine unchanged.

Coverage check over all 27,213 deck files there (melee 23,332, swudb 3,880, one other), against the engine's `test/json/_setCodeMap.json` (2,662 set codes):
- 782,616 card slots (leader, base, deck, sideboard); 522 slots (0.07%) are unmapped, all one id: `J24_005`, "Wrecker | Boom!" (a 2024 promo set code the engine's data lacks).
- 517 of 27,213 deck files (1.9%) contain it; all 517 are melee tournament lists. The other 26,696 decks (98.1%) map completely.
- The three lists used below (Krennic, Cad Bane, Luke) have 0 unmapped cards. In a random sample of 180 melee decks, 4 (2.2%) failed at `new Deck` with "Card undefined not found in card map".
- Fix for the 1.9%: translate by card identity, not by set code (`engineSlug` in `scripts/bench/card-map.ts:110` already builds the engine's `title#subtitle` slug, and `_cardMap.json` maps slug to set-code entries). Untested.

Our own ids are cardKeys such as `08010011` (Cad Bane, Still Faster than You, from `data/runs/2026-10-30/meta/archetypes.json`). The mapping layer is the inverse of `buildSetNumberIndex` (`scripts/bench/card-map.ts`, SET_NNN to cardKey): pick, for each cardKey, the best-ranked printing whose `SET_NNN` exists in the engine's set-code map, falling back to the title-and-subtitle slug. I did not test the cardKey-to-engine direction (unverified), only the SET_NNN direction.

Choosing a leader and base: yes. `Deck` takes them as plain entries and does no legality check (legality lives in `DeckValidator.ts`), so any leader and base pair starts a game. Real pairs only were tested.

## Determinism and replay

Source of randomness: every random draw goes through one seedable generator, `Game.randomGenerator` (`server/game/core/Game.ts:344,454`, class in `server/game/core/Randomness.ts`, a wrapper over the `seedrandom` package). Consumers I found: the coin flip for who chooses initiative (`phases/SetupPhase.ts:68`), the mulligan reshuffle (`prompts/MulliganPrompt.ts:111`), deck shuffles (`Player.ts:756`, `zone/DeckZone.ts:135`), resource-zone shuffles (`zone/ResourceZone.ts:88`), random targets and random discards (`gameSystems/RandomSelectionSystem.ts:41`, `DiscardCardsFromHandSystem.ts:107`, `TakeControlOfResourceSystem.ts:76`, `MoveCardSystem.ts:220`). `grep -rn "Math.random" server` finds nothing; the only `Math.random` I found outside `server/` is retry jitter in `scripts/fetchdata.js:25`.

Seeding: `game.setRandomSeed(seed)` (`Game.ts:785`) must run before `initialiseAsync()`, because the first coin flip and shuffles happen inside it. My driver does that. The older generator calls `setRandomSeed` after `initialiseAsync` (`/Volumes/Models/swu-data/simulation/src/game-runner.ts`, seed branch); whether that left the opening shuffle unseeded I did not test. The bot needs its own seeded stream, separate from the engine's, so that a changed policy does not shift the engine's draws; the driver uses `seedrandom("bot:<seed>")`.

Measured replay evidence:
- Seeds 100 to 129 (Cad Bane vs Krennic, random bots) gave identical SHA-256 of the decision trace in two separate processes. Seed 105 played alone in a fresh process matched its trace from inside a 30-game run, so games do not leak state into each other.
- A 100-game batch gave identical per-seed traces with 1, 4, 8, 12 and 16 workers, and identical to the single-thread CLI.
- Same machine, same Node (26.4.0), same clone commit only. Cross-machine and cross-Node identity is untested.
- What makes a record byte-identical: pinned decklists, pinned engine commit and card-data hash, the engine seed, the bot seed, the policy version, and a canonical ordering of the options the bot sees (next point). No timestamp or UUID may enter the record (the driver uses none; the engine's `startedAt` and card UUIDs are random and are never written).

Option order is not stable across rollback. In one test the same three buttons ("Play First Light using Plot", "Play Jar Jar Binks using Plot", ...) came out in a different order after a rollback. The driver now sorts the options by `kind|label` before the policy sees them (`legalAnswers` in `play-game.mjs`); with that, traces after rollback matched at two of three test points.

Replay of a recorded action log: the engine has no replay-input format. A replay is a re-run with the same decision stream, which works because the engine is deterministic given the seed. To fork, use snapshots:
- Snapshot machinery: `server/game/core/snapshot/SnapshotManager.ts` (action, phase and manual snapshots; limits 3 action and 2 phase snapshots at lines 37-40; a snapshot per timepoint at `moveToNextTimepoint`, line 113), `SnapshotFactory.ts:155-157` stores the game state, object states and `rngState`, and `SnapshotContainerBase.ts:78` restores the RNG. Public calls on `Game`: `takeManualSnapshot(player)` (`Game.ts:1956`) and `rollbackToSnapshot(playerId, { type: 'manual', playerId, snapshotId })` (`Game.ts:1967`). It needs `UndoMode.Free` (`Game.ts:326`).
- Granularity: snapshots exist at timepoints (start of each action, mulligan, setup and regroup resourcing, phase boundaries), not at every prompt. "Decision k" means the nearest action timepoint.
- Measured (`branch-probe.mjs`, Cad Bane vs Krennic, seed 100): `takeManualSnapshot` 0.1 ms; rollback 2.9 to 6.1 ms; each continuation to game end 250 to 380 ms. Branching 30 different bot streams from decisions 61, 181 and 301 gave 30 distinct outcomes each (winner tallies 14/15/1 draw, 11/18/1, 22/8/0 for seat one/seat two/draw). Two continuations from the same restored state with the same bot stream were identical at all three points.
- Caveat 1: at decision 301 a game played straight through did not match the first rollback of itself (the live prompt offered 5 options; the restored one 13). I did not find the cause (unverified). Protocol that avoids it: take the snapshot, roll back once at once, and treat the restored state as the branch root for every continuation, main line included.
- Caveat 2: the option-order instability above.

## Record shape versus simHeaderSchema

`simHeaderSchema` (`scripts/bench/sims.ts:21`) needs `gameId`, `timestamp`, `player1` and `player2` each with `deckId`, `deckName`, `leaderId`, `baseId` (all strings); `winner`, `winReason`, `turnCount`, `format` are optional; `cardsPlayed` is optional per player. The driver's per-game summary maps as follows:
- `gameId`: derive from the pair id and the seed, for example `<deckKeyA>__vs__<deckKeyB>__seed_<n>` (the old format was `<deck>__vs__<deck>__game_<n>`).
- `timestamp`: a pinned run date, never `new Date()`.
- `player1.deckId`, `deckName`: from the decklist metadata (`metadata.name`, deck file key). `leaderId`, `baseId`: `leader.id` and `base.id` (SET_NNN, the same form the old records used, for example `SHD_014`).
- `winner`: 1, 2 or null (driver `winner`; null for a drawn game, which random bots produced in 6 of 100 Cad Bane vs Krennic games). `winReason`: `base_destroyed`, `draw`, `timeout`, `error` (old values were `base_destroyed`, `timeout`, `error`). `turnCount`: `rounds`.
- `cardsPlayed`: not produced yet. The engine has a statistics tracker (`server/gameStatistics/GameStatisticsTracker.ts`); counting plays from it is an open task.
- Not in the old header and new here: `engine` (commit and card-data hash), `seed`, `botSeed`, `policy` and its version.
- `extract-sims.ts` joins decks by (normalised name, leader, base); records we generate know their deck keys exactly, so that join becomes an identity and the `ambiguous` and `unknown` counts go to zero.

## Do the bots mean anything?

forceteki ships no bot or AI player: a grep of `server/` for bot, AI player, autoplay and random action found no file; the only automatic decisions are the engine's own auto-resolve of single targets (the `autoSingleTarget` setting). The old generator in `/Volumes/Models/swu-data/simulation/src/ai/` has random, heuristic and strategic players; its docs claim 14 to 17 games per second on one engine configuration (`docs/AI_IMPROVEMENT_SUMMARY.md:76-77`), 80 per second on 16 cores (`docs/COMPLETE_PIPELINE_GUIDE.md:23`) and 160 per second (`CLAUDE.md`); those claims disagree with each other and I did not re-measure them (my measured range is 15 to 36).

What I measured, with the driver's two policies:
- Random bots: each prompt gets a uniformly random legal answer, so "Pass" competes with every playable card. In a Cad Bane mirror (same list both seats) over 200 games they split 100 to 96 with 4 draws, so there is no seat bias. Games last about 17 rounds.
- A "greedy" policy (`makeGreedyPolicy` in `play-game.mjs`): prefer a card in hand (dearest first) over a unit action, prefer any action over Pass, break ties with a seeded random draw. Its card weights are synthetic hashes, so only the structure is meaningful. In the same mirror, greedy in seat one beat random 182 to 18 (91%) and greedy in seat two beat random 186 to 14 (93%), over 200 games each. Games last about 11 rounds.
- The same three real-list matchups move with policy. Krennic (seat one) vs Cad Bane (seat two), 100 games each: random bots 41 to 53 with 6 draws; greedy 22 to 78. Cad Bane (seat one) vs Luke (seat two): random 64 to 36; greedy 73 to 27. Krennic vs Luke: random 56 to 44; greedy 33 to 67.

Meaning: a random-move win share is dominated by how often each deck's cards get played at all, and says little about card quality. A simple policy reversed one of the three matchup orders (Krennic vs Luke) and moved Krennic vs Cad Bane from 41 to 53 to 22 to 78. Treat random-bot output as a plumbing test and a lower bound on noise. A deck-testing win share is only worth showing if (a) it comes from a policy that plays tempo-sensible moves, (b) it names that policy, and (c) it is checked against the tournament matchup table for rank agreement before anyone trusts it. D21 already ranks bot simulations last and forbids pooling tiers; this tool must output the label "bot play (forceteki, <policy>), not human results" and must not feed `meta_*` or `play_stats` tools.

## Answers to the owner's design questions

1. Decision-point hook. There is no policy interface in the engine. The in-process equivalent of the WebSocket client is four `Game` methods: `cardClicked(playerId, cardUuid)` (`Game.ts:921`), `menuButton(playerId, arg, promptUuid, method)` (`Game.ts:1220`), `perCardMenuButton(playerId, arg, cardUuid, promptUuid, method)` (`Game.ts:1231`) and `statefulPromptResults(playerId, result, promptUuid)` (`Game.ts:1243`), each followed by `game.continue()`. The client path is socket to `Lobby.onGameMessage`, which checks the name against `allowedGameCommands` (`server/gamenode/Lobby.ts:1644-1654`), then runs `this.game[command](userId, ...args)` and `this.game.continue()` (`Lobby.ts:1725-1727`). The engine's test harness calls the same methods through `test/helpers/PlayerInteractionWrapper.ts` (`clickCard` :991, `clickPrompt` :748, `chooseListOption` :884, `setDistributeAmongTargetsPromptState` :922, `clickDisplayCardPromptButton` :940, `clickCardInDisplayCardPrompt` :948). The hook is therefore the loop in the caller: when the pipeline stops, read each seat's prompt, pick, submit. That is what `Session.run` in `play-game.mjs` does; a policy is a function from the list of legal answers to one index.
2. Legal-action enumeration. Yes, as data, in two levels. Level one: `player.currentPrompt()` returns `PlayerPromptState.getState()` (`server/game/core/PlayerPromptState.ts:139-155`): `buttons` (with `disabled`), `selectableCards` (`:61`), `selectCardMode` (single or multiple, `:38`), `selectNumber`, `dropdownListOptions`, `displayCards` and `perCardButtons`, `distributeAmongTargets`, and a `promptType` (`PromptInterfaces.ts` enum: initiative, number, resource, actionWindow, displayCards, distributeAmongTargets, triggerWindow, passDelay, optionalTrigger, actionSelection, modalEffectSelection). In the action window, `selectableCards` is exactly the cards with at least one legal action (`ActionWindow.ts:279-306`, `getCardLegalActions` :308 keeps actions whose `meetsRequirements` is empty), and the buttons are Pass and Claim Initiative. Level two: clicking a card with more than one legal action opens an `ActionSelectionPrompt` listing each action with a `hasLegalEffects` flag (`ActionWindow.ts:55-90`); choosing one then raises target prompts (`SelectCardPrompt`) whose `selectableCards` are the legal targets. So there is no single flat list of (card, action, target); a bot scores at each level, and the driver's `legalAnswers` flattens one level at a time. Mean 6.4 legal answers per decision in a sampled game (316 decisions, 306 with more than one option).
3. Determinism and replay: see the section above. One seedable generator, a re-run replays, snapshots fork at action timepoints at about 5 ms.
4. Policy, below.

## Proposed policy (not built)

A policy ranks the legal answers at each prompt using lookups that already exist as committed data, so no model runs at play time (CLAUDE.md "No model in the scoring path"):
- Card value: the play-calibrated score from `data/runs/<date>/scores/scores.json` (the `score_vs_play` view), keyed by cardKey, mapped to engine slugs once per run.
- Leader fit: per-leader inclusion and lift from `data/runs/<date>/meta/leader-cards.json` (D38), so a leader's core cards rank above its off-pattern cards.
- Pairing: edges between a candidate card and cards already on the board or in hand from `data/runs/<date>/synergy/pairs.toon`, with edges flagged `status: candidate` (about 74% precise per CLAUDE.md "Accuracy, honestly") worth less than trait-only edges only if `verify:pairs` supports it.
- Rules of thumb that cost nothing and carry most of the measured gain: never pass while a playable card exists; spend all resources each round; attack with ready units that survive the trade; resource the least-valued card in hand; keep the mulligan on a hand with a two- or three-cost play.
Cost estimate: every lookup is a Map read; the greedy policy above, which does a score read plus one pair-key lookup per board card per candidate, ran at 0.47 ms per prompt against 0.49 ms for random, so scoring is below measurement noise next to the engine's own 0.5 ms per prompt. Expect games per second near the greedy figures (21 to 36 on 16 workers) because games finish in fewer prompts. A one-ply lookahead by snapshot (try each candidate, roll back, compare) multiplies per-decision cost by the number of candidates times about 5 ms per rollback plus the continuation cost, and is not recommended for the first version.

Decision-point log shape (implemented as `Session.log` when `--trace` is set; about 100 KB of JSON per game uncompressed):

```
{ "k": 38, "phase": "action", "actor": 2,
  "legalActions": ["button|Claim Initiative", "button|Pass", "card|cad-bane#still-faster-than-you"],
  "chosen": "2|card|cad-bane#still-faster-than-you",
  "rngCursor": "115.110.59.136.115.110" }
```

with a match header `{ engine: { commit, cardDataHash, node }, seed, botSeed, policy: { name, version }, deck1, deck2 }`. `rngCursor` is a fingerprint of the `seedrandom` state (`i`, `j` and four state words), not a draw count, because the engine restores the state on rollback; it proves two runs consumed the same random stream up to that decision. In the sample game, setup took 35 decisions, the action phase 130 and regroup 151, so about half of all decisions are regroup resourcing.

## Deck-testing tool

Purpose: let an assistant battle-test a decklist it built, against the real competitive field, with an honest interval. All output is labelled "bot play (forceteki <policy> bots), not human results" (D21).

Proposed MCP tool `simulate_matchup` (name from the owner brief):
- Input: `deck` (leader cardKey, base cardKey, cards as `{ cardKey, count }`), `opponent` (one of: an archetype id from `meta/archetypes.json`; a tournament deck key under `data/originals/decks/<date>`; or `"field"`), `games` (default 100 for one opponent; capped), `seed`, `policy` (default the current scored policy).
- Opponent seat for `"field"`: sample archetypes by placement-weighted share (`share` in `meta/archetypes.json`), then pick a real tournament list of that archetype by placement weight, from `data/originals/decks/<date>` (scripts/bench/decks.ts and `src/meta/build.ts` define archetypes and weights). A fixed hand-picked list is allowed only when the caller names one.
- Output: `population` (opponent description, deck count, window), `n`, `wins`, `winShare`, `wilson95` [low, high], `meanRounds`, `endBoardTopCards` (cards most often on board when the game ended, by count), `perArchetype` rows each with their own Wilson interval and `n`, `drawRate`, `errorRate`, `replay` ({ inputHash, codeCommit, outputHash }, engine commit, seed, policy version) and the fixed label. Status is `candidate`, never `fact`.
- Runs in a child-process pool (worker threads loading the engine once each), because the engine loads about 2,000 card classes per process (about 0.25 s) and a stdio MCP server must not block.

Measured budget (this machine, 16 worker threads, warm pool would save the 0.25 s load per worker):
- 100 games of one matchup: 2.8 to 4.7 s with the scored policy, 4.4 to 6.7 s with random bots; one thread 15 to 26 s. A 10 to 30 s interactive budget is realistic at 100 games on 8 or more cores. On 4 cores, random bots took 8.2 s per 100 games.
- Parallel workers work and are deterministic (same traces at 1 to 16 workers).
- Memory: about 2.7 GB for 16 workers.
- Games to reach a Wilson 95% half-width of 0.10 or less: 93 games at a true win rate of 0.5 (89 at 0.4; 78 at 0.3), so plan 97 to 100 per opponent. Wilson formula with z = 1.96, my calculation, not a library call.
- Top six tournament archetypes in `data/runs/2026-10-30/meta/archetypes.json` (window 2026-07-20 to 2026-10-17): Director Krennic 7.54%, Cad Bane 7.16%, Luke Skywalker Hero of Yavin 5.10%, Boba Fett 4.78%, Darth Vader Victor Squadron Leader 3.85%, Ahsoka Tano 3.65%; together 32.1% of the field (the other 239 tournament archetypes share the remaining 67.9%).
- Budget for a per-archetype interval narrower than plus or minus 10 points at those six: stratified, 6 x 100 = 600 games, about 17 to 29 s with the scored policy (21 to 36 games per second) or 27 to 40 s with random bots. If instead games are drawn in proportion to share, the sixth archetype needs about 97 / 0.0365 = 2,660 total games for 97 of them (the first needs about 1,290), roughly 1.5 to 2 minutes. So the tool should stratify by archetype, report the pooled field result as a share-weighted combination of the strata, and give a rest-of-field stratum its own n.
- 1,000 games of the scored policy: about 28 to 48 s on 16 workers (or about 2.6 minutes on one thread at 153 ms per game); random bots about 45 to 67 s. Output per game without per-decision logs is about 0.5 KB, so 1,000 games is about 0.5 MB before compression.

Not yet tested for this tool: a cardKey deck (we tested set-code lists only), deck sizes other than 50 to 60 (the 60-card lists in the repo ran), arbitrary leader and base pairs, and non-Premier formats.

Built (#116, D88): `simulate_matchup` (`src/tools/sims.ts`) takes a cardKey deck or a SWUDB document and sends each cardKey through the engine bridge, refusing a card the engine lacks by name; it rejects decks outside 50 to 60 main-deck cards, more than 3 copies, and a non-Leader or non-Base in those slots, and plays Premier only (`validateDeck`, `src/sims/matchup.ts`). Games run in a detached job on the warm worker pool, the rung on both seats, keyed by input and pins, one job at a time. Measured on 12 workers with rung 3 top-K (`rung3:k=8`) on both seats, 2026-11-01: a head-to-head job (100 seeds played twice with the seats swapped, plus a 100-game mirror) took 336 s for 300 games, and a field job (7 strata of 100) took 571 s for 700 games, 0.9 and 1.2 games per second including about 10 s of worker start-up; the 2,640 calibration games took 2,502 s. Rung 1 plays about 47 games per second (2,640 games in 56 s). So a default field request is a ten-minute background job, not a 30 s interactive call, which is why the tool returns at once and reports progress. Neither rung may report a win share yet: both fail the calibration gate (`docs/verification/2026-10-31-sim-calibration.md`).

## Proposed committed step `scripts/sims/run-games.ts`

Manipulation node (expands): inputs are pinned decklists plus a seed list; output is `data/originals/sims/<date>/records.jsonl.gz` plus a manifest.
- Input: `pairs.json` (list of `{ deckA, deckB, seeds | { from, count } }`, deck keys under `data/originals/decks/<date>`), policy name and version, engine pin (`forceteki` commit and `card-data-hash.txt`, Node version).
- Per game: header per the mapping above, plus the compact decision trace only when `--trace` (default off), sorted by `(pairId, seed)` using `compareCodePoints`, one line each.
- Manifest: sha256 of every input deck file, of the engine's `test/json` card data, of the driver, of the output; counts of games, winners, draws, errors, timeouts; `{ inputHash, codeCommit, outputHash }` replay record like `scripts/build-data.ts`; no `Date.now()` (the date is an argument).
- Gates (Zod v4, parse at each foreign seam): the decklist parse (shape of `leader`, `base`, `deck`), the engine's per-game summary (a worker returns foreign data), the manifest. Emitter gate on the record, consumer gate in `extract-sims.ts` via the existing `simHeaderSchema`.
- Progress: worker pool emits `reports/.progress/run-games.json` through `scripts/lib/progress.mjs` for runs over 30 s.
- Parallelism: worker threads (piscina is the framework the old generator used and the preferred-stack default for pools; the spike used plain `worker_threads` to avoid adding a dependency).
- Reproducibility test: a Vitest case plays 3 seeds twice and asserts identical output bytes; a CI-skippable test because it needs the forceteki clone.
- Cost: about 28 to 67 s per 1,000 games on this machine (16 workers); about 0.5 MB per 1,000 games without traces. For comparison the existing extract holds 133,277 games in 12.4 MB because it keeps headers only.

## What it means for D21

D21 says bot simulations are the last tier and are never pooled. This work does not change that. It does add one new rule candidate for `docs/decisions.md` (not written, per the brief): "Engine-simulated games are generated by committed code from pinned decks, an engine commit and seeds; every win share from them is labelled with its policy and stays out of tournament, community and casual tiers." What a random bot can tell us: that a list is legal and playable by the engine, that cards do not crash, rough game length, how often each card reaches the board, and which cards are inert. What it cannot tell us: relative deck strength (a simple policy reversed one of three tested matchup orders and widened another from 41 to 53 to 22 to 78). What a scored policy can add: a repeatable, adjustable baseline for comparing two versions of one deck against the same field, where the policy bias cancels because both versions face the same player. That comparison, version A versus version B of a deck, is the strongest use and the one that needs no claim about human play.

## Risks found

- Unsupported Node: engine wants 26.12.1 or newer; this machine has 26.4.0. swu-mcp declares Node 22 or newer, so the sim tool should be a separate, local-only child process that is not part of the public `npx` path. The release path in `CLAUDE.md` would not carry the engine.
- Engine errors under our driver, broad smoke: 180 distinct tournament decks (every 130th file of the sorted melee decks) each played one greedy game against the Cad Bane list: 170 finished (94.4%), 4 failed to build (the unmapped `J24_005`), 6 threw during play (3.3%): four "Unexpected menu command: 'Card_N'" (likely a driver gap on one display-card prompt type; unverified), one `Cannot read properties of undefined (reading 'willDefeat')` and one "Null-like object value". The older generator reported 17% unfinished games (draws) at first and 2.4% after fixes to its own prompt handling and two local engine patches (`/Volumes/Models/swu-data/simulation/docs/AI_IMPROVEMENT_SUMMARY.md`, `docs/FORCETEKI_FIXES.md`); our fresh clone is unpatched. Any harness must count errors and report `errorRate`, never silently drop games.
- An engine crash must not read as a win: the driver records `endCondition: error` and a null winner.
- Card data is fetched live from Fantasy Flight's API and the engine tracks the live card pool; the pinned `card-data-version.txt` and the hash of `test/json` must go into every manifest, or replay breaks silently when cards change.
- The engine rejects illegal answers with a Contract failure (an early version of my driver put too much indirect damage on a unit and failed 22% to 36% of games with Luke lists until fixed). That is a useful strictness: the bot cannot cheat, but every new prompt type needs an answer builder.

## Open questions

- Open question: why does the state restored from a snapshot differ from the live state at decision 301 (see Caveat 1)? Needed before branching from arbitrary decisions is trusted; the root-after-restore protocol avoids it.
- Open question: which AI wrote the 133,277 existing games, and is `cardsPlayed = 0` in 83.5% of them a counter gap or real play? Check the old generator's record writer.
- Open question: does the engine's determinism hold across machines and across Node 26.4.0 versus 26.12.1? A second machine or the supported Node would answer it.
- Open question: what do the four "Unexpected menu command" errors come from, and does the engine have a bug behind the `willDefeat` one? Needs a trace of those seeds.
- Open question: how well does the scored policy's win share rank-agree with tournament matchup win rates in `meta/winrates.json`? That decides whether the tool may show a number at all, and is the acceptance test for the policy.
- Open question: is the Fantasy Flight card data usable in a public build? Launch-stage, noted once.

## Task list for the epic

1. Engine pin: script that clones forceteki at a recorded commit, installs, runs `get-cards`, builds, and records `{ commit, card-data-hash, node }`; fail loudly if the hash changed.
2. Id bridge: cardKey to engine set code (inverse of `buildSetNumberIndex`, slug fallback), with a test that all ids in the 2026-10-17 deck folder map, and a report of the 517 `J24_005` lists.
3. Promote `play-game.mjs` and `run-batch.mjs` into typed, linted `scripts/sims/` modules with Zod gates, canonical option ordering, error taxonomy and `cardsPlayed` from the statistics tracker; resolve the four menu-command errors.
4. `scripts/sims/run-games.ts`: pinned pairs and seeds to `records.jsonl.gz` plus manifest and replay record; Vitest replay test; wire into `build-data` only as an optional step.
5. Extend `scripts/bench/extract-sims.ts` to read the new records exactly (identity join) and keep the old file as a separate, labelled population.
6. Policy v1: tempo rules plus table lookups (scores, leader-cards, pairs) behind a versioned name; unit tests on synthetic prompts; policy-vs-random and policy-vs-policy-version regression runs.
7. Policy validation: rank agreement against `meta/winrates.json` for the top 12 archetypes; publish the figure in `docs/verification/`; decide whether `simulate_matchup` may show win share.
8. Branching: implement the root-after-restore protocol and the fork API (`fork(session, k, n)`), with a test that two forks from one root with equal bot seeds are identical; root-cause Caveat 1.
9. `simulate_matchup` MCP tool: worker pool, stratified archetype sampling, Wilson intervals, per-archetype rows, labels, caps on `games`; a local-only registration so the public data release does not depend on the engine.
10. Documentation: new D-entry for engine-simulated play, README tool entry, update `tests/e2e.test.ts` arguments.
11. Decide where the engine runs for people without a clone (out of scope for the first version; local-only is the default).

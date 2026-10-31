---
type: research
status: draft
review_by: 2026-12-31
question: LampaGJ/swu-mcp#104 - which bot policy drives deterministic local forceteki simulations, rung by rung, and what its win shares may honestly claim
as_of: 2026-10-30
related: ["docs/decisions.md", "docs/research/forceteki-simulation.md", "scripts/bench/sims.ts", "src/scorer/score.ts", "src/synergy/graph.ts", "src/meta/stats.ts"]
---

# Sim bot policy ladder

## TL;DR

The bot is a ladder of six rungs. A rung is used only after the rung below it has been measured against it. Rungs 0 to 4 are deterministic code over pinned inputs and run inside a game. Rung 5, an LLM, never runs inside a game: it annotates captured decision logs offline, and its verdicts enter only as pinned, hashed input (D1, D3).

The proposed default for `simulate_matchup` is rung 2, pairing-aware scoring, on both seats. It is the cheapest rung that expresses the owner's "favour powerful card pairings" intent, and it costs tens of microseconds per decision (estimate). Rung 3, one-ply lookahead on engine snapshots, becomes the default only if it beats rung 2 head to head and still fits the 100-game interactive budget.

Every match writes a header (seed, decks, engine commit, policy versions, input hashes) and one record per decision. Replaying the records reproduces the trace hash byte for byte (D2). Branching at decision k replays decisions 0 to k-1 from the same seed, takes a different legal action at k, and continues.

A win share from any rung is bot play, the last tier under D21. It is labelled with rung, engine commit, population and n, and it is never pooled with tournament or casual data. A ±10-point Wilson 95% interval needs 93 decisive games per matchup at a 50% win share (89 at 60%, 78 at 70%). The six-archetype breakdown therefore needs 558 decisive games per deck. Showing that rung n beats rung n-1 at a true 55% head-to-head share needs about 783 decisive games (80% power, two-sided 0.05); at 60% it needs about 194.

No rung's win shares reach a tool until that rung passes four gates: replay, health, ladder and external calibration against tournament matchups.

Input status: the engine spike report `docs/research/forceteki-simulation.md` had not landed when this was written. The design targets the generic shape: at each decision point the engine yields a list of legal actions with structured fields (action kind, card, targets) and asks for one. Engine-specific claims cite forceteki source and the spike driver `scripts/sims/play-game.mjs` at 8a9fb48. The typed driver replaced the spike in 35ddbd0, so every spike citation is pinned to that commit, the last one that held those files, and names its symbol; where the typed driver now implements a proposal, a second citation names the current line. Re-check them against the spike report when it lands.

## Sources and citation base

- swu-mcp citations are against `main` at `6109b0e`. This worktree's HEAD is `34fd3bf`, two commits behind; `leaderFactor` (`src/tools/synergy.ts:166-170`) exists only on `main`.
- forceteki citations are against https://github.com/SWU-Karabast/forceteki at `445792e`, card data `20260423_00` (`forceteki/card-data-version.txt`).
- Decisions used as the yardstick: D1 (`docs/decisions.md:16`), D2 (`:18`), D3 (`:20`), D11 (`:40`), D12 (`:42`), D13 (`:44`), D14 (`:46`), D15 (`:48`), D16 (`:50`), D19 (`:60`), D20 (`:62`), D21 (`:64`), D26 (`:76`), D37 (`:102`), D38 (`:104`), D42 (`:112`).
- Owner statements on #104, 2026-10-30. The purpose is bot simulations of decks we construct, served by a read-only `simulate_matchup(decklist, leader, base, opponent archetype or decklist, games, seed)` returning a win share with a Wilson interval, labelled bot play. The opponent seat is sampled from real melee tournament decklists by placement-weighted archetype share. Sims are local and deterministic. The bot uses the play-calibrated score, the pairing graph and leaderInclusion to favour powerful pairings. Every decision point is recorded so a match replays byte for byte and branches at any decision.

## 1. The method ladder

### Shape shared by every rung

A policy is a pure function. Its inputs are the actor's view of the state, the canonical legal actions, the pinned tables and the decision randomness. Its output is one index into the legal actions.

Legal actions are canonicalised before any policy sees them. Each action gets a descriptor string `kind|cardKey|zone|ordinal|targets…`. The list is sorted by `compareCodePoints` (`src/swu/canonical.js`), so a choice never depends on the engine's internal enumeration order.

Each rung covers some prompt kinds. A prompt the rung does not cover descends to the next rung down, ending at rung 0. The record then carries `fallback: <reason>`. A rung's coverage is the share of decisions it answered itself. Coverage is reported with every result, because a rung-3 bot that falls back on 40% of its decisions is partly a random bot.

Both seats always run the same rung when a deck is being tested. An asymmetric pairing measures the policy gap, not the deck. Asymmetric matches are used only in the ladder harness of section 4.

### Determinism hazards shared by every rung

- **Unseeded engine RNG before `setRandomSeed`.** The game constructs `new Randomness()` with no seed (`forceteki/server/game/core/Game.ts:454`), and seedrandom with no seed seeds itself from entropy. Any draw before `setRandomSeed` (`Game.ts:785-786`) cannot be replayed. The spike seeds before `selectDeck` (`scripts/sims/play-game.mjs:240-242` at 8a9fb48, `startGame`; now `src/sims/engine.ts:273-276`, with a guard that throws on a draw before the seed at `src/sims/engine.ts:265-272`). A replay test must assert that order.
- **Prompt uuids are random.** `UiPrompt` takes `uuid()` from uuid v1 (`forceteki/server/game/core/gameSteps/prompts/UiPrompt.ts:1`, `:12`), so a prompt uuid differs between runs. Never log, hash or sort by a prompt uuid.
- **Card object ids are a counter.** Game object uuids are `<name>_<n>` from a counter (`forceteki/server/game/core/snapshot/GameStateManager.ts:87-89`), so they are deterministic for one engine version. They still change across engine versions, so the record logs `cardKey`, zone and ordinal instead.
- **Clocks.** The spike passes a scheduler whose `now()` returns 0 (`scripts/sims/play-game.mjs:86-91` at 8a9fb48, `scheduler`; now `src/sims/engine.ts:217-222`). Policy code obeys the project ban on `Date.now()`, `Math.random()` and locale-sensitive sorts (CLAUDE.md:67). The match header carries no wall-clock timestamp, because one would break byte-identical replay; the date comes from the run directory.
- **Card identity.** The engine names cards by its own slug; swu-mcp keys by `cardKey`. The mapping goes through `engineSlug` (`scripts/bench/card-map.ts:110`). An unmapped card is logged with its engine id and `cardKey: null`, and the gap rate is reported.
- **Float ties.** Every score comparison breaks ties by the canonical descriptor, never by float noise. Sums iterate in sorted `cardKey` order.
- **Pins.** The header records the engine commit, card-data version and the sha256 of every table a rung reads.

### Rung 0: random legal action (the null policy)

**What it decides.** Nothing. It picks uniformly among the canonical legal actions. On a multi-select prompt the spike takes Done half the time (`scripts/sims/play-game.mjs:170-174` at 8a9fb48, `randomPolicy`; now `src/sims/policy.ts:48-60`, `rung0`, with the probability at `src/sims/policy.ts:46`).

**Why it exists.** Rung 0 is the baseline for every claim. "Rung r beats rung 0" is the minimum bar for any rung. A deck's win share under rung 0 measures raw card efficiency under incoherent piloting.

**What it cannot decide.** Anything strategic. Random games also run long, and the bias is systematic: cheap efficient units gain and decks that need a line lose.

**Cost per decision.** One draw, about 1 µs (estimate). Engine stepping dominates the game cost. Games per second is the spike's measurement (`scripts/sims/run-batch.mjs:53` at 8a9fb48 prints `gamesPerSecond`; now `scripts/sims/run-batch.ts:107`).

**Determinism hazard and fix.** The spike draws both seats' choices from one stream seeded `bot:${seed}` (`scripts/sims/play-game.mjs:336` at 8a9fb48, `playGame`). With one shared stream, seat 1's choices shift seat 2's later draws, and branching needs a stream cursor. Proposal: counter-based decision randomness. Draw j at decision k for seat s is `u = seededRandom("bot|" + seed + "|" + s + "|" + k + "|" + j)()`, reusing the existing sha256-to-mulberry32 helper (`scripts/bench/stats.ts:13-15`). It is stateless, so replay and branching need only the header seed and k. The typed driver implements this scheme (`src/sims/rng.ts:11` names it, `src/sims/rng.ts:15` draws).

### Rung 1: fixed priority rules

**Rules, in priority order.** The rules apply to the prompt kinds they name. Every threshold here is an estimate, to be tuned by the seeded grid in section 4.

1. Mulligan: keep a hand with at least two cards of cost 3 or less.
2. Resource: resource the card in hand with the lowest `playCalibrated`. A second copy of a unique card already in play goes first. A card with a null score ranks at its type's median, so unscored cards are not dumped indiscriminately. In the 2026-10-30 run, 197 of 1,609 rows in `data/runs/2026-10-30/scores/scores.json` have a null `playCalibrated`.
3. Lethal: attack the base when the ready attackers can deal the opponent base's remaining HP this phase. Count Raid and Overwhelm excess. Treat a Sentinel unit as blocking base attacks from its arena.
4. Favourable trade: attack an enemy unit when, by printed power and HP with current damage counted, the defender dies and the attacker survives. Shielded counts as one absorbed hit. When both die, attack only if the defender's `playCalibrated` exceeds the attacker's.
5. Play: play the affordable card with the highest `playCalibrated`. The engine's legal list already applies the aspect penalty to affordability. Ties go to the higher cost, then the descriptor.
6. Attack the base with any ready unit that has no favourable trade.
7. Deploy the leader as soon as it is legal. Take the initiative when nothing above applies. Otherwise pass.
8. Targets: a harmful effect targets the enemy unit with the highest `playCalibrated` that the effect defeats, else the highest overall. A beneficial effect targets our own unit with the highest `playCalibrated`.

**What it decides.** Card quality and tempo, from a single score.

**What it cannot decide.** It cannot sequence across turns, hold an event, set up a combo or time the initiative. `playCalibrated` is fitted in log-inclusion units (`src/scorer/score.ts:9-11`, `:177-190`). It measures how often players include a card: a popularity-calibrated proxy for strength, not the tactical value of a card on this board. It also inherits the parser's error rate: parsed card text is wrong on about 1 card in 5 (CLAUDE.md:35).

**Cost per decision.** A sort of about 20 actions with Map reads, about 10 µs (estimate).

**Determinism hazard and fix.** Scores are stored rounded to 4 places (`src/scorer/scores-file.ts:114`), so comparisons do not hang on float noise. The header pins the sha256 of `scores.json` and its `coefficientsSha256`.

### Rung 2: pairing-aware scoring

**Utility of a candidate play X.**

`utility(X) = playCalibrated(X) + μ · leaderInclusion(X) + λ · pairBonus(X)`

- `leaderInclusion(X)` is the placement-weighted share of this leader's tournament decks that play X. It comes from `meta/leader-cards.json` (D38) and is 0 for an unplayed card. The 2026-10-30 run has 115 tournament leaders and 38 community fallbacks over 2026-07-20 to 2026-10-17. The prior is additive, not D42's multiplicative `0.5 + inclusion` (`src/tools/synergy.ts:166-170`). The reason is that `playCalibrated` can be negative, and multiplying a negative score by a larger factor would rank a played card below an unplayed one.
- `pairBonus(X)` sums over partners Y: our leader, our base and our units in play at weight 1, and cards in our hand at weight 0.5 (estimate). For each partner it adds `w(Y→X) + w(X→Y)`. Direction follows the graph: A offers, B wants (`src/synergy/graph.ts:7-13`).
- The edge weight is `w(e) = e.traitOnly ? 0 : e.score` times `rowPrecision(e)`. This keeps D16's +10% trait bonus on a mechanical pair (`src/synergy/graph.ts:42`, `:198`) and gives a trait-only pair nothing.
- `rowPrecision(e)` is the measured precision of the edge's highest-weight mechanical row, read from `data/runs/<date>/verify/pair-precision.json` `perRow`. It is shrunk toward the mechanical figure 0.7267 (D42) with 10 pseudo-items (estimate), because each row holds only 3 to 12 fixture items. For example, in the 2026-10-30 file bounce-replay is 9 of 12 and discard-payoff is 0 of 3. A row with no fixture items uses 0.7267. This follows D26's rule of weighting by measured row precision.

**Targets.** When a prompt asks for a target for an effect from source S, rung 2 prefers a target T that S has an edge to. Example: a sacrifice outlet picks the friendly unit whose When Defeated is the payoff (row `sac-outlet-when-defeated`, `data/complementarity.json:7`). Target choice is where pairings pay out in play.

**Resource protection.** Rung 2 never resources a card whose `pairBonus` against our current board exceeds a threshold (estimate).

**Optional rung 2b: counters.** `data/counters.json` (10 threats, 14 relations) can steer removal toward the opposing archetype's key units. Archetype key units are public meta knowledge. The bot never reads the opponent's actual decklist. Rung 2b is measured as its own step on the ladder.

**Tuning.** μ and λ are chosen by a seeded grid on a tuning seed range and judged on a disjoint held-out range. With μ = λ = 0, rung 2 reduces exactly to rung 1, so the ablation is clean.

**What it decides.** Which card to play now and which target to pick, given the pieces already present, and which cards to keep out of the resource row.

**What it cannot decide.** It cannot tell whether a combo line actually wins, or when to delay a payoff because the opponent holds removal. The edges are candidates (D15): 0.7617 precise overall and 0.7267 for mechanical links on pairs-v1 (D42), so about 1 preferred edge in 4 is wrong.

**Circularity trap.** Rung-2 sims cannot validate pairing edges by co-occurrence, because the bot made the cards co-occur. The only valid test is an ablation: mask the edge and re-run the same seeds.

**Cost per decision.** About 20 actions times about 15 partners times 2 directions gives about 600 lookups into `edgeByKey`, keyed `a>b` (`src/synergy/graph.ts:31`, `:162`). That is about 50 µs (estimate). The spike's greedy policy exists to time exactly this cost with synthetic weights (`scripts/sims/play-game.mjs:180-214` at 8a9fb48, `makeGreedyPolicy`).

**Determinism hazard and fix.** Partners are summed in sorted `cardKey` order. The header pins the hashes of `pairs.toon` (via `synergy/replay.json`), `pair-precision.json` and `leader-cards.json`, with μ and λ in the policy params hash.

### Rung 3: one-ply lookahead on the engine

**Procedure.** Rung 3 acts at main-action prompts: play, attack, ability, deploy, initiative and pass.

1. Rung 2 ranks the canonical actions.
2. Rung 3 takes the top K (K = 5, estimate).
3. For each of the K actions: take a snapshot, apply the action, and resolve every sub-prompt it opens with rung 2, so the ply is one whole action.
4. Stop at the opponent's next decision or the end of the phase.
5. Score the state with V, then roll back.
6. Pick the action with the highest V. Break ties by rung-2 utility, then by descriptor.

**State evaluator V, for the actor.** Lethal scores +∞ or −∞. Otherwise:

`V = w_base·(oppBaseDamage − ownBaseDamage) + w_board·(Σ own (power + remaining HP) − Σ opp (power + remaining HP)) + w_hand·(ownHandSize − oppHandSize) + w_res·(ownResources − oppResources) + w_ready·(ownReadyUnits − oppReadyUnits)`

The starting weights are all 1 except `w_base` at 1.5 (estimate). They are tuned the same way as μ and λ.

**Hidden information.** The engine state holds the opponent's hand and both deck orders. V reads only public facts plus our own hand: the opponent's hand is a count, and decks are counts. A trial that draws a card must not score the drawn card's identity. One-ply on the true state still leaks some random outcomes, for example a revealed top card. Rung 3 accepts that leak, and its results say so. Determinization (sampling hidden zones from the opponent's archetype, as in information-set MCTS) is deferred.

**Snapshots.** A forceteki snapshot holds the v8-serialised game state and the RNG state (`forceteki/server/game/core/snapshot/SnapshotFactory.ts:155-157`). Rollback restores that RNG state through `Randomness.restore` (`forceteki/server/game/core/Randomness.ts:27-29`). Manual snapshots exist (`SnapshotManager.ts:143-144`, `:214`, `:352`). Snapshots are off when undo is disabled: `takeSnapshot` returns -1 in that mode (`SnapshotManager.ts:134-136`). The spike disables undo by default (`scripts/sims/play-game.mjs:223` and `:236` at 8a9fb48, `startGame`; now `src/sims/engine.ts:253` and `scripts/sims/run-batch.ts:38`, where `--undo` defaults to false). So rung 3 needs undo mode on, and section 4's replay gate must show that undo mode does not change rung 0 to 2 traces (now `scripts/sims/replay-gate.ts:87-91`).

**Test oracle.** Replay from the seed and the decision prefix always works, but it costs O(k) per trial, which is too slow for play. It serves as the oracle for snapshot fidelity: trial, rollback and continue must give the same trace hash as replaying the prefix and continuing.

**What it decides.** One-action tactics: which attack, which trade first, whether to play now or pass. The engine resolves the card text itself, so the parser's 1-in-5 error stops mattering for the immediate effect.

**What it cannot decide.** Multi-turn plans and opponent replies, because there is no opponent layer in the search. It handles hidden information only approximately, and its evaluator is hand-written.

**Cost per decision.** K times (apply, resolve, V, rollback). Each rollback deserialises the state. Estimates, to be measured by the spike:

- 1 to 10 ms per trial, so 5 to 50 ms per main decision.
- 50 to 100 main decisions per seat per game, so 0.25 to 5 s per game per rung-3 seat.
- 100 games take 25 s to 8 min on one thread, divided by the worker count (`scripts/sims/run-batch.mjs:33-48` at 8a9fb48 spreads seeds over `worker_threads`; now `src/sims/pool.ts:49`, with workers claiming seeds from a shared counter at `src/sims/worker.ts:26-29`).

**Determinism hazards and fixes.**

- Rollback fidelity is checked against the replay oracle.
- Trials draw no decision randomness.
- No bot-side cache survives between trials.
- K and the V weights go in the params hash, and the V version goes in every record.

### Rung 4: a small learned evaluator, fitted offline

**What it is.** V is replaced by `V̂(s) = sigmoid(w · φ(s))`, the actor's predicted win probability. φ holds rung 3's features plus richer public ones: round, initiative, live mechanical edges in play, Sentinel and Shielded counts, the `playCalibrated` sum in play, and whether the leader is deployed. The search is rung 3's.

**Cold path.**

- Self-play logs come from rung-2 and rung-3 bots across the deck panel. They are seeded and pinned under `data/pinned/sim-selfplay-v1/` with a sha256 per file.
- Each state is labelled with the game's final outcome for its actor.
- Train and test split by seed range, that is by game, never by state. States within one game are correlated, and a split by state inflates apparent accuracy.
- The fit is L2 logistic regression with a fixed deterministic solver: fixed iteration count, sorted rows, single thread. This is the same pattern as the rubric's pinned OLS coefficients (`data/rubric-coefficients.json`, D1).
- A tree ensemble is admitted only if it beats logistic regression on held-out log-loss and in head-to-head play. It is exported to JSON and walked by plain TypeScript.

**Artifact.** `data/pinned/sim-evaluator-v1.json` holds `evaluatorVersion`, `features[]`, `weights[]`, `fittedOn` {logsSha256, seedRange, engineCommit, scoresSha256, pairsSha256}, `heldOut` {logLoss, brier, ece} and `codeCommit`. Model output enters as captured, hashed input (D3). Inference is arithmetic.

**Staleness.** The rule is modelled on D37's `membersSha256`. The evaluator records the hashes it was fitted under. When the loaded run's scores, pairs or engine commit differ, the tool reports `evaluatorStatus: stale` and drops to rung 3, logged as a fallback. A new set or a new meta window triggers a refit.

**What it decides.** It weighs state features by learned importance, which should give a better-calibrated V than hand weights.

**What it cannot decide.** Anything outside its features. It learns the self-play bots' habits, so its sense of a good state is the bot's, not a human's.

**Cost per decision.** Rung 3's cost plus a dot product of about 30 terms per trial, under 10 µs (estimate). The cold-path fit takes seconds to minutes (estimate).

**Determinism hazards and fixes.** Thread count and summation order in the fit are fixed. The artifact is pinned. Inference sums in a fixed order.

### Rung 5: an LLM, only ever as an offline annotator of decision logs

**Boundary.** An LLM never runs inside a game and never runs in the tool path (D1, D3; CLAUDE.md:66, :74). It reads captured decision records and labels them.

**Admission bar.**

- *Load-bearing.* The question is "was decision k a blunder, and why, in game terms". Answering it means reading card text and board context in natural language. Rungs 3 and 4 can flag decisions where the chosen action's V is far below the best one tried. They cannot explain the gap, and they cannot catch errors in their own evaluator, because the check would be circular. A rule-based blunder detector only finds what its rules already encode.
- *Rejected alternatives.* V-delta flagging is kept as the cheap first filter that picks which decisions go to the LLM. Rule checks are kept as a lint. Human review is kept for spot checks only, because owner time is the scarcest input.
- *Acceptance criterion.* Take a stratified sample of 200 flagged decisions. Every verdict parses under a strict Zod schema; that is 100% by construction under constrained decoding. A second model's adjudication agrees on at least 80% of verdicts (estimate threshold). The precedent is pairs-v1, judged by haiku and re-judged item by item by sonnet (D19, `docs/decisions.md:60`).

**Structure is not truth.** A schema-valid verdict can still be wrong. Adjudication is the correctness check, not the schema.

**Pinning.** Verdicts live in `data/pinned/sim-annotations-v1/`, keyed by the decision record's sha256. This mirrors the curated ability table keyed by `clauseSha256` (D3, `docs/decisions.md:20`).

**Uses.**

- A blunder rate per rung, reported next to the win share as a quality figure.
- Candidate rules for rungs 1 and 2. Each rule becomes committed code and must win the ladder test.
- A pinned strategy fixture for regressions.

**Cost.** Zero in game. Offline it costs about 1 to 3 s per decision on a local 7B to 8B model, or one haiku-class call (estimate). An existing local model under `/Volumes/Models` is reused before any download.

**What it cannot do.** Decide a move or contribute to a win share.

### Not on the ladder yet

Deeper search, such as two-ply minimax or determinized MCTS, multiplies rung 3's cost by the branching factor. It is added only if rung 3 shows that search pays and the budget allows.

## 2. Decision-point record and branching

### Schema, in Zod v4 prose

All objects are `z.strictObject`. Integers use `z.int()`. Maps use two-arg `z.record`. No field carries a wall-clock time.

**Match header.**

- `schemaVersion: z.literal(1)`
- `matchId`: sha256 hex of the canonical JSON of {seed, decks, policies, engine}.
- `seed: z.string().min(1)`
- `engine: z.strictObject({ repo, commit, cardDataVersion, undoMode })`
- `rng: z.strictObject({ engineSeed, botScheme: z.literal("sha256-counter-v1") })`. `engineSeed` is `"engine:" + seed`, as the spike does (`scripts/sims/play-game.mjs:240` at 8a9fb48; now `src/sims/schemas.ts:73`, with the `engine:<seed>` check at `src/sims/schemas.ts:88`).
- `decks`: a two-element tuple, each `{ seat: z.literal([1, 2]), leader: cardKey, base: cardKey, cards: z.array(z.strictObject({ cardKey, count: z.int().positive() })), deckSha256, source }`. `source` names the tournament list, archetype id and sampling draw for an opponent.
- `policies`: a two-element tuple, each `{ rung: z.int().min(0).max(4), policyId, policyVersion, paramsSha256, inputs: z.record(z.string(), sha256Hex) }`. `inputs` maps scores, pairs, pairPrecision, leaderCards, counters and evaluator to their hashes. A rung-5 hash can never appear here.
- `branch: z.strictObject({ parentMatchId, atK: z.int().nonnegative(), alternative: descriptor }).nullable()`
- `codeCommit`

**Decision record, one per decision.**

- `k: z.int().nonnegative()`, contiguous from 0.
- `round: z.int().positive()`
- `phase: z.enum(["setup", "action", "regroup"])`, matching forceteki's `PhaseName` (`forceteki/server/game/core/Constants.ts:215-219`).
- `actor: z.literal([1, 2])`
- `promptKind: z.enum(["mulligan", "resource", "mainAction", "target", "choice", "number", "distribute", "multiSelect"])`
- `legalActions`: an array of `{ i: z.int().nonnegative(), kind, cardKey: z.string().nullable(), engineCardId, zone, ordinal: z.int().nonnegative(), targets: z.array(z.strictObject({ cardKey, owner: z.literal([1, 2]), zone, ordinal })), descriptor, label }`. `kind` is one of play, attack, resource, deployLeader, ability, takeInitiative, pass, target, choose, number, distribute, mulligan, done. The array is sorted by descriptor; `label` is the engine text, kept for debugging only.
- `chosen: z.strictObject({ i, descriptor })`. The descriptor is stored redundantly, so a record whose index and descriptor disagree fails to parse.
- `rngCursor: z.strictObject({ engineDraws: z.int().nonnegative(), engineStateSha: z.string().length(16), botDraws: z.int().nonnegative() })`. `engineDraws` comes from a counting wrapper around `game.randomGenerator.next` in our adapter, never an engine edit (now `src/sims/engine.ts:265-272`). `engineStateSha` hashes the full seedrandom state, which is stronger than the spike's six-field fingerprint (`scripts/sims/play-game.mjs:218-221` at 8a9fb48, `rngFingerprint`; now `src/sims/engine.ts:286-289`, `engineStateSha`, assembled into the cursor at `src/sims/engine.ts:292` and typed at `src/sims/schemas.ts:121-126`).
- `evaluator: z.strictObject({ rung, version, sha256: z.string().nullable() })`
- `utilities: z.array(z.number()).nullable()`, one per legal action. It is written in trace mode, so an annotator can see why the bot chose as it did.
- `fallback: z.string().nullable()`

**Footer.**

- `result: { winner: z.literal([1, 2]).nullable(), endCondition: z.enum(["base_destroyed", "draw", "timeout", "stuck", "error"]), rounds, decisions }`. These are the end conditions the spike already emits (`scripts/sims/play-game.mjs:258`, `:269`, `:302`, `:308` and `:320` at 8a9fb48, `Session`; now the enum at `src/sims/schemas.ts:94` and the assignments at `src/sims/session.ts:103` (stuck), `:115` (base_destroyed or draw), `:119` (timeout) and `:136` (error)).
- `traceSha256`: sha256 over the chosen descriptors in order.

**Bulk mode.** Full records cost an estimated 2 KB per decision, so a few hundred KB per game. Bulk runs therefore log `legalActionsSha256` and `chosen.descriptor` only. Full records are written on request and for any match that will be branched. Generated logs live under `data/runs/<date>/sims/`, which is git-ignored. Only small fixtures are pinned under `data/pinned/`.

### Replay

1. Parse the header.
2. Start the engine at the pinned commit with `engineSeed`.
3. At each k, enumerate and canonicalise the legal actions, and assert that their hash equals the logged one.
4. Apply the action whose descriptor equals `chosen.descriptor`.
5. Assert `rngCursor` after each step.

The first mismatch stops the replay and reports k and the differing field. A full replay must end on the logged `traceSha256` (D2).

### Branching at decision k

1. Replay decisions 0 to k-1 as above.
2. At k, apply a different legal action, named by descriptor.
3. Continue with the header's policies. Decision randomness is counter-based, so the continuation needs no cursor.
4. Write a child header with `branch: { parentMatchId, atK: k, alternative }`. The child's `matchId` hashes the parent's id, k and the alternative.

The fast path restores a snapshot at k instead of replaying. It is allowed only after the snapshot-fidelity oracle passes.

A single continuation is one sample. To estimate the value of an alternative, run M continuations, reseeding the engine RNG at k with `"branch:" + seed + ":" + k + ":" + m`. Label the result "conditioned on the deck order at k", because the deck order is already fixed in the state.

## 3. What a win share may claim

**Tier and label.** A sim win share sits in the last tier of D21 (`docs/decisions.md:64`): bot simulations. It is never pooled with tournament, decklist or casual data. Every output names the source and population: rung and policy version on both seats, engine commit, card-data version, our deck hash, the opponent population ("melee tournament decklists, 2026-07-20 to 2026-10-17, placement-weighted archetype share"), decisive n, non-decisive count and seed range. Karabast data never feeds the opponent pool or any figure (D22).

**What it may claim.** "Piloted by rung r on both seats, deck A won x of n decisive games against field F (Wilson 95% [lo, hi])." It describes the deck as this bot plays it, not as a human plays it.

**What it may not claim.**

- A tournament win rate.
- A matchup truth.
- A card's power.
- Any figure placed beside a swumetastats rate without the tier label.

**Pilot sensitivity.** A deck that needs lines is systematically undervalued by weak rungs. A deck whose win share climbs steeply from rung 1 to rung 3 is pilot-sensitive. That climb is itself worth reporting, and it is the reason a result always names its rung.

**Minimum games for a ±10-point interval.** The interval is the Wilson score interval, as implemented in `src/meta/stats.ts:10-18`: z = 1.959964, draws left out. The half-width depends on n and the true share p. The decisive games needed for a half-width of at most 10 points are:

- 93 at p = 0.5, the worst case and the planning number.
- 89 at p = 0.6.
- 78 at p = 0.7.
- 60 at p = 0.8.

For tighter intervals at p = 0.5, ±5 points needs 381 and ±3 points needs 1,064. These figures were computed for this document from the Wilson formula; they are not a spike measurement.

**Budget.** Budgeted games are `ceil(93 / (1 − d))`, where d is the measured non-decisive share (draw, timeout, stuck, error). At d = 5% that is 98 games.

**Field breakdown.** The owner asked for a per-archetype breakdown over the top six archetypes. That needs at least 93 decisive games per archetype, 558 per deck under test. The field figure is the share-weighted mean of the per-archetype win shares. Wilson does not apply directly to a weighted mean, so its interval comes from a stratified bootstrap (`scripts/bench/stats.ts:53` `bootstrapCI`, resampling within archetype). The 100-game interactive budget the owner named gives one ±10-point matchup, not a six-archetype field.

## 4. Evaluation harness

### Proving rung n beats rung n-1

**Deck panel.** The highest-placing list of each of the top six tournament archetypes in `data/runs/<date>/meta/archetypes.json`, drawn from the melee decklists in `data/originals/decks/`.

**Design: seeded round-robin with seat-swapped game pairs.**

- For every ordered deck pair (A, B), mirrors included, and every seed s, play two games with the same engine seed. Rung n pilots seat 1 in the first game and seat 2 in the second.
- Decks stay in their seats and only the policies swap. The engine therefore sees identical inputs, and deals identical shuffles, up to the first decision where the policies differ.
- This is the duplicate design used in bridge and by Stockfish's fishtest (https://github.com/official-stockfish/fishtest). It cancels seat, initiative and shuffle luck within each pair.

**Mirror matches** (A against A) isolate policy strength from deck strength. Cross-deck matches expose policy × deck interaction.

**Statistic.**

- Each pair scores 0, 1 or 2 wins for rung n.
- An exact two-sided sign test runs on the discordant pairs (2-0 against 0-2).
- The Wilson interval on rung n's game share is reported beside it.
- The ladder steps are tested at α = 0.01, a Bonferroni split of 0.05 over up to five steps.

**Sample size.** To detect a true 55% share against 50% at 80% power and two-sided 0.05 takes about 783 decisive games; a 60% share takes about 194, and 65% about 85. These are normal-approximation figures computed for this document. Plan 200 seed pairs (400 games) per step and escalate to 800 pairs when the result is inconclusive. The sample size is fixed in advance. A sequential test (fishtest's SPRT) is an option for later, adopted only as a documented exception or a framework, never by stopping early when a result looks good.

**Pass rule.** Rung n replaces rung n-1 when both hold:

- The pooled sign test passes.
- The point estimate exceeds 50% in at least five of the six panel decks, and no deck's interval lies wholly below 50%.

**Tuning hygiene.** Seed ranges are disjoint and recorded:

- tuning seeds for μ, λ, K and the V weights;
- evaluation seeds for the ladder test;
- fitting seeds for rung 4.

Re-using a tuning seed in evaluation voids the result.

### Calibration gate before a tool shows any rung's results

A rung's win shares reach `simulate_matchup` only when a pinned gate record for that rung, engine commit and input hashes shows all four gates passing. Otherwise the tool returns `isError` with a plain sentence naming the failed gate (D9). The tool always serves the highest rung that passed.

1. **Replay gate.** 50 matches spread over the panel replay to identical `traceSha256`. Results from worker threads equal single-thread results; the spike's batch runner claims this property (`scripts/sims/run-batch.mjs:3-4` at 8a9fb48). The typed driver checks it in `scripts/sims/replay-gate.ts:84-85` (cold and warm pools equal one thread) and `:87-91` (undo on equals undo off), and replays each record at `:59-62` through `replayMatch` (`src/sims/match.ts:158`). Rung 0 to 2 traces are identical with undo mode on and off. For rung 3 and up, snapshot rollback agrees with the replay oracle on every trial in a 20-match sample.
2. **Health gate.** The non-decisive share is at most 2% (estimate), and the rung's fallback share is at most 5% of its decisions (estimate). Above that, the rung is mostly its fallback.
3. **Ladder gate.** The rung beats rung 0, and beats its predecessor, under section 4's pass rule.
4. **External calibration gate.** This compares tiers; it never pools them. Over the top archetype pairs that have tournament evidence in `data/runs/<date>/meta/winrates.json` (swumetastats matchups per leader and base aspects, `minN` 10), two checks run:
   - The rank correlation (Spearman) between sim and tournament win shares is at least 0.5 (estimate).
   - The sim favourite matches the tournament favourite significantly more often than half the time. Only matchups whose tournament Wilson interval excludes 50% count.

   A rung that fails this gate may still serve decision logs and branching. It does not serve a win share.

For rung 4, a further check applies: the evaluator's held-out calibration (expected calibration error at most 0.05, plus the Brier score) is recorded in its artifact. A stale evaluator drops the tool to rung 3.

## 5. Task list for the epic

1. Canonical action adapter. Build legal-action enumeration into descriptors (`cardKey`, zone, ordinal, targets) with `engineSlug` mapping, and report the mapping gap rate. Acceptance: one prompt fixture per kind, and no prompt uuid appears anywhere in the output.
2. Counter-based decision randomness, `sha256-counter-v1`, replacing the shared bot stream. Acceptance: a branch at k leaves decisions before k byte-identical.
3. Zod v4 schemas for the match header, decision record and footer, plus an `agent-zod-zealot` review. Acceptance: parse and round-trip tests on synthetic fixtures.
4. Replay and branch CLI (`pnpm sims:replay`, `pnpm sims:branch --at k --alt <descriptor>`). Acceptance: replay reproduces `traceSha256`; the first divergence reports k and the field.
5. Rung 0 under the new adapter, plus the per-rung fallback chain and coverage counter. Acceptance: replay gate passes on 50 matches.
6. Rung 1 rules, reading pinned `scores.json`. Acceptance: one deterministic fixture per rule, and the ladder test against rung 0.
7. Rung 2 utility (μ, λ, `rowPrecision` shrinkage, target preference, resource protection), reading pinned pairs, pair-precision and leader-cards. Acceptance: with μ = λ = 0 the trace is identical to rung 1; the seeded grid on tuning seeds; the ladder test against rung 1.
8. Rung 2b counters, as its own measured step.
9. Edge-ablation harness: mask one pairing edge and re-run the same seeds. This is the only sim-based edge measure allowed (the circularity trap). Results are labelled bot play, separate from `verify:pairs`.
10. Snapshot-fidelity oracle: rollback against prefix replay, with undo on and off. This depends on the spike report.
11. Rung 3 one-ply search with the hand-written V and the hidden-information mask. Acceptance: the per-decision cost is measured, not estimated; the ladder test against rung 2; the 100-game wall time is recorded.
12. Deck panel and opponent sampler: placement-weighted archetype draw from melee decklists, seeded, with the source recorded in the header.
13. Ladder harness: seat-swapped seed pairs, sign test, Wilson intervals and a pinned gate record per rung. It emits pollable progress via `scripts/lib/progress.mjs`.
14. External calibration gate against `meta/winrates.json`.
15. `simulate_matchup` tool: read-only, TOON output, serving the highest gated rung, with the D21 label, Wilson interval, average length and end-board cards. Includes an e2e entry in `tests/e2e.test.ts`.
16. Rung 4 cold path: pinned self-play logs, deterministic logistic fit, artifact with `fittedOn` hashes, staleness check, and the ladder test against rung 3.
17. Rung 5 offline annotator: V-delta filter, constrained-decoding verdict schema, adjudication sample and pinned annotations keyed by record sha256. Report blunder rate per rung.
18. Decision log entries in `docs/decisions.md`, once the owner rules: the bot ladder and its D21 labelling; the learned evaluator as a pinned fit under D3; the calibration gate.

## Open questions

Ruled by the owner on 2026-10-31 (D53 in `docs/decisions.md`): the maintainer settles all three iteratively, and every change is posted on #118 with its measurement before it lands. Current values:

- Gate thresholds: Spearman ≥ 0.5, non-decisive ≤ 2%, fallback ≤ 5%, annotation agreement ≥ 80% (rung 5 only). These are the starting estimates; the first reset comes from the rung-1 measurements (#114).
- Rung 4: a learned move evaluator is a pinned, hashed fit under D3 and needs its own D-entry before any tool reads its output. D1 stands: no model output decides a card score.
- `simulate_matchup` defaults to rung 2 on both seats. Rung 3 becomes the default only if it beats rung 2 head to head and fits the 100-game interactive budget.

---
type: report
status: final
related: ["#114", "#163", "#104", "#110", "#112", "docs/research/sim-bot-policy-ladder.md", "docs/decisions.md"]
review_by: 2026-12-31
---

# Bot ladder, rungs 1 to 3, 2026-10-31

What this answers: does a bot that plays from the card data (cost, power, HP, damage, keywords, aspects, parsed card text, the play-calibrated score) beat the random bot and the old name-hash greedy bot, does the pairing-aware rung 2 beat it, and does swapping cards in the owner's deck move its bot win share?

Every figure is bot play on the forceteki engine (D21's last tier) through the typed driver (#110, `src/sims/`, main `a5edac6`, driver code from `35ddbd0`), engine commit `445792e`, card data `20260423_00`, run `data/runs/2026-10-31`, policy code `9f224cf` plus this change (uncommitted when measured, recorded as `-dirty`). It is not a human win rate. Gate records: `data/pinned/sim-ladder-v1/`.

## TL;DR

- Rung 1 passes the ladder against rung 0 (random): 99.75% of 400 decisive games, Wilson 95% [98.60, 99.96], discordant pairs 199 to 0, sign test p = 2.5e-60, above 50% in all six panel decks.
- Rung 1 beats the old greedy bot that scored cards by a hash of their names: 95.73% of 398 decisive games [93.27, 97.32], discordant 181 to 0, p = 6.5e-55, above 50% in all six decks (Krennic lowest at 82.9% [72.4, 89.9]).
- Rung 2 does not pass. On the tuning seeds no (mu, lambda) setting differed from rung 1 by more than noise (47.0% to 51.6%); the best, mu = 0 and lambda = 1, won 48.55% [46.10, 51.01] of 1,588 decisive held-out games over 800 pairs, discordant 51 to 78 (p = 0.022, leaning against it). The pair bonus helps four decks (56% to 65%) and hurts Krennic (14.0%) and Ahsoka (35.4%).
- Owner's deck (The Warrior / Origin Tree) against the panel, rung 1 on both seats, 1,800 games per variant on the same seeds: base 42.61% [40.34, 44.91]. Oppo Rancisis swapped for Anakin Skywalker, Force Prodigy moves it to 45.44% [43.16, 47.75], above the base interval; the paired test on the same seeds gives 160 to 109, p = 0.0022, so this one-card swap is detected. One The Chieftain swapped for Champion's KT9 Podracer gives 45.00% (paired 189 to 146, p = 0.022): a move, but upward, so in this bot's hands the Podracer outplays the Chieftain, and it misses the 0.01 bar. Three larger control swaps moved it at most 2.2 points and none past p = 0.01, so at 1,800 paired games rung 1 resolves changes of about 2 to 3 points.
- Health: non-decisive share 0% to 0.75% (forceteki errors and draws, no timeouts), rung 1 fallback share at most 0.02%. Speed: 32 to 59 games per second on 12 workers.

## What was built

- `src/sims/policies/types.ts` is the seam every rung is written against: `(answers: LegalAnswer[], view: GameView) => index`, with a GameView of both sides' units (cost, power, HP, damage, keywords, Raid, Shield, exhaustion, aspects, score), our hand, resources, bases, leaders, initiative and the current prompt.
- `src/sims/policies/engine-view.ts` builds that view from the engine's live card objects and turns the driver's canonical actions into answers, finding the engine card behind each action by internal name, controller, zone and ordinal (`ViewBuilder.build`, `src/sims/policies/engine-view.ts:331`). Its header lists how every prompt kind is detected.
- `src/sims/policies/typed-adapter.ts` wraps a rung as a driver `Policy` (`driverPolicy`, `:48`): a prompt no rule covers returns null, the driver's chain falls back to rung 0, and the driver's coverage counter records it. `registerRungs` (`:122`) adds the rungs to the driver's `POLICIES`; `scripts/sims/ladder-preload.ts` does that in every pool worker.
- `src/sims/policies/rules.ts` is rung 1 and rung 2 (`makeRulePolicy`). The action-window order is at `src/sims/policies/rules.ts:243-286`: lethal on the base (Raid and Overwhelm excess counted, Sentinel blocking, `src/sims/policies/combat.ts:57`), favourable trade by current power and HP (a Shield absorbs one hit, Saboteur strips it, `src/sims/policies/combat.ts:38`), play by score and curve (a knapsack over the ready resources with the aspect penalty; removal and healing events held when they have nothing to hit), attack the base, deploy the leader, card abilities, take the initiative, pass. Mulligan, resource, attack target, effect targets by threat and effect intent, Ambush, trigger order, credit payments, "no effect" confirmations, damage-or-discard tolls and distribute allocations each have their own rule.
- Rung 2's utility is `playCalibrated + mu * leaderInclusion + lambda * pairBonus` (`src/sims/policies/rules.ts:100-136`); an edge weighs its pair score times the measured precision of its strongest mechanical row, shrunk toward 0.7267 with 10 pseudo-items (`src/sims/policies/tables.ts:124`). With mu = lambda = 0 its trace equals rung 1's (`tests/sims/policies/engine.test.ts`).
- `scripts/sims/ladder.ts` is the harness: the panel, seat-swapped duplicate pairs on the driver's warm pool, the sign test and Wilson shares (`src/sims/policies/ladder-stats.ts:16`, `:68`), the pass rule, pollable progress and one gate record per step.

## Deck panel

The panel of the opponent sampler (#112, `deckPanel` in `src/sims/opponents.ts`): the highest-placing buildable melee list of each of the six largest-share archetypes, all first-place lists in `data/originals/decks/2026-10-17/`.

- t001 Director Krennic / Vigilance: `melee-5681125d-f7a1-4c75-87ca-b4bc0160f8a6.json` (72 players)
- t002 Cad Bane / Vigilance: `melee-2162c700-3b5a-424d-95cb-b4920028faa5.json` (545)
- t003 Luke Skywalker, Hero of Yavin / Command: `melee-46ae29fa-01b5-4a84-8a78-b4d101228caf.json` (97)
- t004 Boba Fett, Any Methods Necessary / neutral: `melee-94acf967-5ed2-4f3f-9b7c-b4c90186712e.json` (42)
- t005 Darth Vader, Victor Squadron Leader / Cunning: `melee-56969b6a-395c-41f9-91cb-b4ad00fe690f.json` (24)
- t006 Ahsoka Tano, Trust in the Force / Vigilance: `melee-4ae98532-3303-470b-b77d-b4d1002ee4ac.json` (74)

## Design and seeds

Each seed pair plays one ordered deck pair (36, mirrors included, cycled) twice with the same engine seed `engine:<seed>`: the candidate in seat 1, then in seat 2, decks fixed in their seats. Bot draws are the driver's counter-based `sha256-counter-v1`, so a policy's choices never shift the other seat's draws. Seed ranges are disjoint: tuning 1,000,000 to 1,000,143, evaluation 2,000,000 onward, deck checks 3,000,000 onward (`scripts/sims/ladder.ts:37`). The plan was 200 pairs per step, escalating to 800 when inconclusive; only rung 2 escalated.

## Results

**Rung 1 against rung 0**, record `rung1-vs-rung0.json`: 399 of 400, 99.75% [98.60, 99.96]; discordant 199 to 0, p = 2.5e-60. Per deck: Krennic 69/70, Cad Bane 70/70, Luke 69/69, Boba Fett 65/65, Vader 63/63, Ahsoka 63/63. Pass. Non-decisive 0. Rung 1 answered all but 5 of its 23,015 decisions (fallback 0.02%). Mean 6.4 rounds and 99 decisions per game.

**Rung 1 against the greedy name-hash bot** (the spike's `makeGreedyPolicy`, ported as `greedyHashPolicy`, `src/sims/policies/typed-adapter.ts:78`), record `rung1-vs-greedy-hash.json`: 381 of 398, 95.73% [93.27, 97.32]; discordant 181 to 0, p = 6.5e-55. Per deck: Krennic 58/70 (82.9%), Cad Bane 66/70 (94.3%), Luke 69/69, Boba Fett 64/64, Vader 63/63, Ahsoka 61/62 (98.4%). Pass. Non-decisive 2 of 400 (forceteki errors).

**Rung 2 tuning**, mu in {0, 0.5, 1, 2} by lambda in {0, 0.25, 0.5, 1} against rung 1, 144 pairs each, record `rung2-tuning.json`. Shares ran from 47.0% (mu = 2, lambda = 1, discordant 13 to 23) to 51.6% (mu = 0, lambda = 1, discordant 16 to 12, p = 0.57); no point was significant.

**Rung 2 (mu = 0, lambda = 1) against rung 1**, held out, escalated to 800 pairs, record `rung2-vs-rung1.json`: 771 of 1,588, 48.55% [46.10, 51.01]; discordant 51 to 78, p = 0.022. Per deck: Krennic 14.0% [10.4, 18.7], Cad Bane 63.9%, Luke 56.2%, Boba Fett 64.5%, Vader 57.6%, Ahsoka 35.4% [29.8, 41.4]. Fails all three parts of the pass rule. Non-decisive 12 of 1,600 (10 errors, 2 draws).

**Cost check**, 36 mirror games per policy on one thread (`--mode cost`): time inside the policy per decision was 0.010 ms for the greedy bot, 0.228 ms for rung 1 and 0.229 ms for rung 2 (mu = lambda = 1, pair table loaded); whole decisions cost 0.55 to 0.86 ms with the engine. Rung 1's cost is mostly reading the engine's card objects into the view, not the table lookups. Rung 1 games end in about 139 decisions against 220 for rung 0, so one thread plays 8.4 rung-1 games per second against 6.0 for rung 0.

## The owner's deck: does a card swap move the win share?

`tests/fixtures/decks/warrior-chewie-raid.swudb.json` against each panel deck, both seats, 150 seeds per opponent per seat (1,800 games per variant), rung 1 on both seats, the same seeds for every variant so the shuffles line up card for card. Records `warrior-deck-rung1.json` and `warrior-deck-rung1-controls.json`; the base deck reproduced exactly (767 of 1,800, identical per-opponent shares) in both runs.

- Base: 767 of 1,800, 42.61% [40.34, 44.91]. Against Krennic 86.3%, Cad Bane 12.3%, Luke 50.7%, Boba Fett 23.3%, Vader 49.3%, Ahsoka 33.7%.
- Oppo Rancisis (LOF_105) for Anakin Skywalker, Force Prodigy (LOF_190): 45.44% [43.16, 47.75]; seeds won only by the base 109, only by the variant 160, p = 0.0022. Detected: the point estimate sits above the base interval and the paired test clears 0.01.
- One The Chieftain (HMW_212) for Champion's KT9 Podracer (LAW_232, 3-cost 2/3 that makes a Credit token): 45.00% [42.71, 47.31]; 146 against 189, p = 0.022. The share moves up, not down: the Chieftain's Raid grows only with other Tuskens, while the Credit token is a spare resource rung 1 spends. Not significant at 0.01.
- Control, both Captain Tarpals and one Boba Fett, Family Found (the three highest play-calibrated units) for three Podracers: 41.61% [39.35, 43.90]; 277 against 259, p = 0.46. Not detected.
- Control, both Jod Na Nawood (4/3 Sentinel) and two Darth Traya (2/5, Villainy, so 5 resources with the aspect penalty here) for four Podracers: 43.94% [41.67, 46.25]; 217 against 241, p = 0.28. Up, not down: Traya pays a 2-resource penalty in this deck, so this "downgrade" was not one.
- Control, both Captain Tarpals and both Neel (1-cost) for four Coastal Catamarans (7-cost Vigilance, 9 with the penalty): 40.39% [38.14, 42.67]; 284 against 244, p = 0.090. Down 2.2 points, short of significance: an uncastable card still becomes a resource, which caps what a dead card costs.

Reading: rung 1 tells some single cards apart (Oppo against Anakin, and the Chieftain against the Podracer in the opposite direction to the score), and its sensitivity is about 2 to 3 points at this sample. It does not realise the value the play-calibrated score gives Captain Tarpals and Boba Fett, Family Found, whose strength is a 1-cost Raid body and an Ambush-granting engine; a rule bot that plays its best-scored card, then attacks, does not build those lines. Rung 2 failed its ladder step, so it was not run on the deck.

## Cross-check on the spike driver

Before #110 landed the same policies ran on the spike driver (`scripts/sims/play-game.mjs` at `9f224cf`, a shared bot stream, an earlier panel pick). The conclusions match: rung 1 beat rung 0 (99.25%, discordant 196 to 0) and the greedy bot (89.14%, 155 to 2); rung 2 tuned to mu = 2, lambda = 0 failed on 800 held-out pairs (49.34%, 70 to 79, Krennic 10%); on the owner's deck the Oppo-to-Anakin swap moved 37.50% to 39.94% (paired p = 0.0029) and the Chieftain swap did not (p = 0.40). Those runs are not recorded as gate records.

## Limits

- Bot play only. Both seats run the same rung in the deck check, so the figure is "this deck as rung 1 plays it".
- Rung 1's thresholds (threat weights, tempo 0.5, resource cap 7, mulligan two cards of cost 3 or less) are estimates set before the evaluation seeds ran and not tuned on them.
- Parsed card text is wrong on about 1 card in 5 (CLAUDE.md "Accuracy, honestly"); rung 1 reads it only to hold removal and healing events and to read upgrade stat signs.
- forceteki errors (`Contract assertion failure`, `reading 'willDefeat'`) end up to 0.6% of games on legal input; they count as non-decisive.
- Circularity trap: rung 2 sims cannot validate pairing edges by co-occurrence, because the bot made the cards co-occur; the only sim edge test is an ablation.

## Open questions

- Open question: why do rung 2's priors swing the Krennic list (14% with the pair bonus, 10% with the leader prior on the spike) and Ahsoka while helping the other four? A per-deck look at what rung 2 resources and plays first would say; until then rung 2 stays off.
- Open question: Captain Tarpals and Boba Fett, Family Found carry high play-calibrated scores yet removing them does not move rung 1's win share; either rung 1 cannot use them or the score overrates them for this deck. Answered by rung 3 below: with top-K rung 3 on both seats, removing them costs 5.8 points against the panel (p = 4.4e-5).
- Open question: the harness imports the driver by path (`SIMS_DRIVER_ROOT`, default this repo) because the branch was cut before #110 landed; once rebased, the imports can become static.

## Rung 3: search on the engine (#163)

Every figure in this section is bot play on the same engine pin, card data and run as above, with undo mode on for any game that has a rung 3 seat. Policy code is this change, uncommitted when measured (records say `-dirty`). Gate records: `data/pinned/sim-ladder-v1/`. Wall times were measured while another agent's simulation batches shared the machine (load average above 100 at times), so they are upper bounds.

### TL;DR

- Two rung 3 bots try moves on the real rules engine and roll back. Top-K tries rung 1's best 8 actions, each rolled out to the end of the action phase. Flat Monte Carlo (the owner's "do all possible moves") tries every legal action with 2 seeded rung 1 playouts each in sampled hidden worlds. Both are deterministic: fixed counts and counter-based randomness, with no time budget.
- Fidelity holds. Every rollback restored the full state (13,195 checked); every record replays move for move with no search at all; traces are identical on 3 and 12 workers; undo mode changes no rung 1 or rung 2 record.
- Both beat rung 1 by #114's pass rule on held-out seeds. Top-K won 83.0% [79.0, 86.3], discordant 131 to 0, p = 7.3e-40. Monte Carlo won 79.0% [74.7, 82.7], 116 to 1, p = 1.4e-33. Both were above 50% in all six panel decks.
- The owner's deck against the panel, 1,800 paired games per variant, top-K on both seats. It detects the dead-card control at -10.2 points, p = 1.7e-13 (rung 1: p = 0.090). It detects the Tarpals and Boba control at -5.8 points, p = 4.4e-5 (rung 1: p = 0.46). It does not detect the Oppo-to-Anakin swap (p = 0.44), which rung 1 does (p = 0.0022).
- Head to head on seeds 1 to 900, base against its own variant, rung 1 detects the dead-card control (p = 3.0e-11) and the Anakin swap (p = 0.023), but top-K rung 3 detects neither (p = 0.37, p = 0.51). The Monte Carlo bot, on seeds 1 to 450, does detect the dead-card control head to head (55.1%, p = 0.0024) and, like top-K, not the Anakin swap (p = 0.58). It was not run against the panel (about 2 hours per 1,800 games at measured speed; see Cost).
- Random playouts work only in numbers. One random playout to the end of the game per move plays far worse than rung 1 (5.3%). Four random playouts to the end of the action phase win 67.4%, and rung 1 playouts are better still.
- Cost: top-K takes 167 ms per searched decision and about 25 minutes per 1,800-game deck check on 12 workers. Monte Carlo takes 685 ms per search and about 2 hours per 1,800 games.

### What was built

Two rung 3 bots share one mechanism: bookmark the engine at a main-action prompt, try something, roll back.

- Engine bookmarks. forceteki's manual snapshot bookmarks the snapshot taken when the current action began, so it equals the live state exactly at a main-action prompt (`bookmarkState`, `src/sims/engine.ts:307`). The rollback makes the two calls the engine's own undo makes, without its two full game-state captures and chat alert, then puts back the adapter's engine-draw counter and checks the engine RNG state came back (`rollbackState`, `src/sims/engine.ts:318`). A spent bookmark is released, because forceteki keeps every manual snapshot until removed (`src/sims/engine.ts:328`).
- Session hooks. Every policy view carries bookmark, rollback and release hooks plus the match seed (`src/sims/session.ts:121`). After a search the session enumerates the legal actions again and refuses to continue if they changed, because the rebuilt prompt has a new uuid and the old closures would submit to a dead prompt (`src/sims/session.ts:227`).
- Top-K lookahead (`rung3`, `src/sims/policies/rung3.ts:148`). Rung 1's order by exclusion: its pick, then its pick with that answer removed, up to K (`rankByExclusion`, `src/sims/policies/lookahead.ts:148`). Each candidate is applied, every following prompt of both seats is answered by fresh rung 1 bots up to the horizon (the next main-action prompt, or the end of the action phase), and the state is scored with V. Ties go to rung 1's order, then the descriptor (`pickCandidate`, `src/sims/policies/lookahead.ts:173`). With K = 1 it plays rung 1's trace exactly (`tests/sims/policies/rung3-engine.test.ts`).
- Flat Monte Carlo (`rung3mc`, the owner's "just do all possible moves for each game state", `src/sims/policies/flat-mc.ts:143`). Every legal main action is a candidate, with no rung 1 filter; a sub-prompt of ours inside the candidate's own action (a target, a choose-one) is branched too when it has at most 6 answers, two levels deep, within a cap of 40 candidates whose firings are counted. A candidate that returns to our own main action with nothing done (a cancelled click) is dropped. Each candidate gets N playouts by rung 0 (or rung 1) on both seats, to the end of the game (scored as a win share) or of the action phase (scored by V). The best mean wins, ties by descriptor path (`pickBestPath`, `src/sims/policies/lookahead.ts:259`). The chosen path's sub-prompt answers are replayed when those prompts arrive; every other prompt is rung 1.
- Determinism. N and K are fixed counts: no decision has a time budget. Playout p of candidate c at decision k draws from `mc|seed|seat|k|c|p` (`mcStreamKey`, `src/sims/policies/lookahead.ts:245`) and a top-K trial's rung 1 fallback from `trial|seed|seat|k|candidate`, never from the match's decision randomness, so the session's bot-draw cursor does not move during a search.
- V, for the actor: `1.5 (opponent base damage - own) + (own power + remaining HP - opponent's) + (hand sizes) + (resources) + (ready units)`, the ladder doc's starting weights, and plus or minus infinity for a won or lost game (`evaluateV`, `src/sims/policies/lookahead.ts:129`). An optional term on the play-calibrated score of units in play, `wScore`, is 0 by default.

### Hidden information

V reads the state only through `maskState` (`src/sims/policies/lookahead.ts:110`): the opponent's hand and both decks are counts, and a card drawn during the trial counts toward hand size but its identity never reaches V. The engine read itself takes only the lengths of those zones (`readRaw`, `src/sims/policies/rung3.ts:59`). Fixture tests pin this: changing the opponent's hand, the deck orders, or which card a trial drew leaves the masked state and V unchanged (`tests/sims/policies/lookahead.test.ts`).

Playouts are a second path for hidden facts, because they play on the engine state. The Monte Carlo bot therefore samples a world per playout index: it reseeds the engine RNG with `mc-world|seed|seat|k|p`, puts the opponent's hand on the bottom of their deck, shuffles both decks, and draws the opponent back to the same hand size, the way the engine's own mulligan redeals (`determinize`, `src/sims/policies/flat-mc.ts:69`). Every candidate shares world p, so candidates are compared on the same samples. The rollback restores the real state (`tests/sims/policies/rung3-engine.test.ts`, "flat Monte Carlo determinization"). The top-K bot's rung 1 rollouts still play the true state: the opponent's sub-prompt answers and the end-of-phase rollout read the real hand and the real next draw within the action phase. That leak is measured below for the Monte Carlo bot (`determinize=0`).

### Fidelity: does a rollback leave anything behind?

Three checks, all deterministic.

- Fingerprint at every rollback. In fidelity mode the session hashes what a rollback must restore when it bookmarks (engine RNG state and draw count, round, phase, active player, every card of both players in every zone with damage and exhaustion, base damage, the statistics log, both seats' canonical legal actions) and compares after every rollback; a difference ends the match as an error (`stateFingerprint`, `src/sims/session.ts:50`).
- Replay oracle. The match record is replayed by descriptor with no search at all (`replayMatch` with `byDescriptor`, `src/sims/match.ts:164`): at every decision the legal-action hash and the engine RNG cursor must match, then the result, cards played, base damage, end board and trace. Any residue a rollback left would change a later decision's legal actions or RNG, or the outcome.
- Workers. The same rung 3 matches on worker pools of 3 and 12 threads must give the single-thread traces.

Record `rung3-fidelity.json` (final code, seeds 1 to 20 over the replay gate's four-deck panel, a rung 3 seat against rung 1, alternating seats):

- Top-K (`rung3:k=8`): 20 matches, 462 searches, 2,236 rollbacks, every one restored the full fingerprint; 20 of 20 records replayed by descriptor with no search to the same trace, and 20 of 20 with their own policies; on pools of 3 and of 12 workers, 20 of 20 traces equal to one thread each time.
- Flat Monte Carlo (`rung3mc:playout=rung1,n=2`): 20 matches, 462 searches, 10,959 rollbacks, all restored; 20 of 20 oracle replays and 20 of 20 policy replays identical; 20 of 20 traces identical on 3 and on 12 workers.
- Undo mode on did not change a single rung 1 or rung 2 record: 20 of 20 each, decisions and footer compared whole (rung 2 at mu = 0, lambda = 1); the rung 0 part of the gate also passed (20 of 20 replays, worker pools and undo).
- The engine tests pin the same properties on single matches and add that rung 3 with K = 1 plays rung 1's trace exactly and that a search with undo off errors instead of playing on (`tests/sims/policies/rung3-engine.test.ts`).
- Two defects were found and fixed on the way, each by a check above: Monte Carlo playouts in worlds after the first failed 12% of the time when a sub-prompt from after a phase-ending pass was branched (fixed by branching only inside the candidate's own action), and the engine's chat log, which no snapshot restores, filled a 128 MB worker during game-length playouts (fixed by trimming it at each rollback, `src/sims/engine.ts`).

### Tuning, on the tuning seeds

Top-K lookahead, each point against rung 1 on 144 seat-swapped pairs (288 games), seeds 1,000,000 to 1,000,143. Records `rung3-tuning-k-horizon.json` and `rung3-tuning-weights.json`.

- Horizon: rolling out to the end of the action phase beats stopping at the next main-action prompt at every K tried: K = 3 won 73.3% [67.9, 78.0] against 61.2% [55.4, 66.6]; K = 5 won 77.1% [71.9, 81.6] against 62.2% [56.5, 67.7].
- K, end-of-phase horizon: K = 2 won 67.6% [62.0, 72.8], discordant 52 to 1; K = 3 73.3%, 67 to 0; K = 5 77.1%, 78 to 0; K = 8 78.1% [73.0, 82.5], 81 to 0, above 50% in all six panel decks.
- Weights at K = 5, one change at a time: `wBase` 3 won 75.3%, `wHand` 0.5 77.1%, `wReady` 0 76.7%, `wResources` 0 77.4%, `wScore` 1 77.4%. Against 77.1% for the doc's weights, every change landed between 5 games worse and 1 game better in 288, well inside the interval, so the doc's weights stay; `wScore` (the play-calibrated score of units in play) bought nothing measurable.
- Pick, by the rule #114 used (highest pooled share on the tuning seeds): K = 8, end-of-phase horizon, the doc's weights (`rung3:k=8`).

Flat Monte Carlo, the N curve the owner's redirect asked for: each point against rung 1 on 48 seat-swapped pairs (96 games, so intervals are wide), seeds 1,000,000 to 1,000,047, record `rung3mc-curve.json`. Every point samples hidden worlds (determinize on) unless named.

- Random playouts (rung 0 on both seats) to the end of the action phase, scored by V: N = 1 won 52.6% [42.7, 62.4]; N = 2 55.2% [45.3, 64.8]; N = 4 67.4% [57.4, 76.0], discordant 17 to 0. Strength climbs with N, as averaging noisy random playouts should.
- Rung 1 playouts to the end of the action phase: N = 1 won 73.7% [64.0, 81.5]; N = 2 75.8% [66.3, 83.3], discordant 24 to 0, above 50% in all six decks. One rung 1 playout beats four random ones.
- Random playouts to the end of the game, scored as a win share, N = 1: 5.3% [2.3, 11.7], discordant 0 to 42. A single random game to the end says almost nothing about the move that started it, so most candidates tie at 0 or 1 and the descriptor tie-break picks for them; that plays worse than rung 1, and worse than any other point. Game-length playouts are also long: about 160 decisions each against about 5 for a playout to the end of the action phase (single-thread probes, 654 and 3,677 playouts). "Random actions, see who wins" needs far more playouts than this machine can give per decision.
- Hidden-information leak: N = 2 random playouts on the true state (`determinize=0`) won 58.5% [48.4, 67.9] against 55.2% sampled, about 3 points, inside the noise.
- Pick, by the same rule: `rung3mc:playout=rung1,n=2` (rung 1 playouts, N = 2, end of the action phase, determinized).

### Ladder: rung 3 against rung 1, held out

Seeds 2,000,000 to 2,000,199 (the evaluation range, the same seeds as #114's rung 1 records), 200 seat-swapped pairs over the 36 ordered deck pairs, rung 3 against rung 1, the pass rule fixed by #114 (`summarizeLadder`, `src/sims/policies/ladder-stats.ts:68`).

- Top-K (`rung3:k=8`), record `rung3-vs-rung1.json`: 331 of 399 decisive games, 83.0% [79.0, 86.3]; discordant pairs 131 to 0, sign test p = 7.3e-40. Per deck: Krennic 68.6% [57.0, 78.2], Cad Bane 85.7%, Luke 92.8%, Boba Fett 95.4%, Vader 82.3%, Ahsoka 73.0% [61.0, 82.4]. Pass: the sign test clears 0.01, all six decks sit above 50% (the issue's stricter "every panel deck at or above 50%" holds too), none wholly below. One game of 400 ended in a forceteki error (`Contract assertion failure: Null-like object value`); rung 3's seat fell back to rung 0 on 2 of 25,084 decisions. Mean 6.9 rounds and 122.6 decisions per game.
- Flat Monte Carlo (`rung3mc:playout=rung1,n=2`), record `rung3mc-vs-rung1.json`: 315 of 399 decisive games, 79.0% [74.7, 82.7]; discordant pairs 116 to 1, sign test p = 1.4e-33. Per deck: Krennic 60.0% [48.3, 70.7], Cad Bane 84.3%, Luke 89.9%, Boba Fett 86.2%, Vader 82.3%, Ahsoka 71.4% [59.3, 81.1]. Pass, every deck above 50%. One forceteki error in 400 games (the same `Null-like object value` class); rung 3's seat fell back to rung 0 on 29 of 25,444 decisions (0.11%, the loop guard and rung 1's own fallbacks). Wall time 595 s for 400 games on 12 workers, one searching seat per game.
- Both variants clear the step against rung 1. They have not been played against each other.

### The owner's deck: head-to-head and against the panel

Two designs, the same deck changes as #114: the dead-card control (both Captain Tarpals and both Neel, 1-cost units, for four Coastal Catamarans, 7-cost Vigilance, 9 with the aspect penalty), Oppo Rancisis (LOF_105) for Anakin Skywalker, Force Prodigy (LOF_190), and the Tarpals and Boba Fett control (both Tarpals and one Boba Fett, Family Found for three Champion's KT9 Podracers). Both seats always run the same policy.

**Head-to-head** (the owner's design, 2026-10-31: with rung 1 it was far more sensitive than deck against panel). The base deck against each variant on seeds 1 to 900, two games per seed with the decks' seats swapped, sign test on the seeds one deck won both; the mirror (base against base) is the seat control. Record `warrior-h2h-rung3.json`, 9,000 games, all decided.

- Rung 1, replayed on the same seeds as the owner's rung 1 evidence: base beats the dead-card variant 1,041 of 1,800, 57.8% [55.5, 60.1], seeds won both by base 296 against 155 by the variant, p = 3.0e-11; Anakin beats base, base 47.7% [45.4, 50.0], 135 against 176, p = 0.023; mirror seat 1 52.7% [49.4, 55.9]. All three trace hashes equal the owner's run hash for hash (that run used `scripts/sims/run-batch.ts`), so the harness and the batch runner replay each other.
- Top-K rung 3 (`rung3:k=8`): base against the dead-card variant 920 of 1,800, 51.1% [48.8, 53.4], 235 against 215, p = 0.37, not detected; base against Anakin 50.7% [48.4, 53.0], 169 against 156, p = 0.51, not detected; mirror seat 1 51.8% [48.5, 55.0]. Mean 9.5 rounds and 164 decisions per game.
- Reading: rung 3 is much the stronger pilot (83% against rung 1) and, piloting both decks, it hides the dead-card swap that rung 1 shows at p = 3e-11. A stronger pilot narrowing the gap between a deck and a weakened copy is possible; it is not explained by these runs. Open question: what does rung 3 do with the four Catamarans (resource them on turn one, the way the 1-cost units would have been played?) that rung 1 does not; a per-decision trace of a few seeds would say.
- Flat Monte Carlo (`rung3mc:playout=rung1,n=2`), seeds 1 to 450 (900 games per variant, half the seeds, because a Monte Carlo game costs about four times a top-K one; the mirror was skipped), record `warrior-h2h-rung3mc.json`, 1,800 games, all decided: base against the dead-card variant 55.1% [51.8, 58.3], seeds won both by base 134 against 88 by the variant, p = 0.0024, detected at p < 0.01; base against Anakin 50.9% [47.6, 54.1], 85 against 77, p = 0.58, not detected. Rung 1 on the same 450 seeds (from the owner's run): dead-card 56.9%, 145 against 83; Anakin, base 47.1%, 66 against 92. So the Monte Carlo pilot keeps rung 1's head-to-head view of the dead cards, about 2 points weaker, where top-K lost it, and like top-K it loses the Anakin swap. Seeds 451 to 900 can be added with `--seed0 451 --pairs 450`; results are per seed and deterministic.

**Against the panel** (the #114 design): each deck against the six panel decks, both seats, 150 seeds per opponent per seat, 1,800 games per deck on seeds 3,000,000 to 3,001,799, the same seeds as #114's rung 1 records; the paired test compares each variant with the base on the same seeds. Rung 1 was replayed on the same seeds in the same run (`--compare rung1`). Record `warrior-deck-rung3.json`, 14,400 games, all decided.

- Rung 1, replayed: base 767 of 1,800, Oppo to Anakin 818, dead-card control 727, Tarpals and Boba control 749, the same counts as #114's pinned records (`warrior-deck-rung1.json`, `warrior-deck-rung1-controls.json`), so the earlier figures reproduce exactly.
- Top-K rung 3, base: 752 of 1,800, 41.8% [39.5, 44.1]. Against Krennic 48.7%, Cad Bane 20.7%, Luke 51.7%, Boba Fett 35.3%, Vader 45.3%, Ahsoka 49.0%.
- Dead-card control: 569 of 1,800, 31.6% [29.5, 33.8]; seeds won only by the base 401, only by the variant 218, p = 1.7e-13. Detected, at a 10-point drop; rung 1 on the same seeds saw 2.2 points and p = 0.090. This meets the issue's bar (p < 0.01 at 1,800 paired games).
- Tarpals and Boba control: 648 of 1,800, 36.0% [33.8, 38.3]; 371 against 267, p = 4.4e-5. Detected, a 5.8-point drop; rung 1 saw 1 point and p = 0.46. Rung 3 realises the value the play-calibrated score gives Captain Tarpals and Boba Fett, Family Found, which answers the open question #114 left.
- Oppo Rancisis to Anakin: 768 of 1,800, 42.7% [40.4, 45.0]; 181 against 197, p = 0.44. Not detected under rung 3, where rung 1 detects it (45.4%, p = 0.0022), so the issue's "the Oppo-to-Anakin swap stays detected" fails for rung 3. In rung 1's hands Anakin outplays Oppo by about 3 points; with a stronger pilot on both seats the two cards come out level.
- Pilot sensitivity, rung 1 to rung 3, each deck against the same panel on the same seeds: base -0.8 points (same-seed paired test p = 0.56), Oppo to Anakin -2.8 (p = 0.046), dead-card control -8.8 (p = 2.2e-11), Tarpals and Boba control -5.6 (p = 2.4e-5). No deck climbs: the panel decks gain more from the stronger pilot than the owner's deck does, and the weakened variants lose the most, which is what a pilot that exploits card quality should do.
- Reading the two designs together: head to head, top-K rung 3 sees neither swap; against the panel it sees both controls strongly and loses the Anakin swap. The dead-card variant mostly loses to the panel's strong decks, not to its own base deck. Open question: why the head-to-head gap closes under rung 3 while the field gap widens.

### Cost

One thread, 12 mirror games per policy over the panel's ordered pairs, seeds 2,500,000 to 2,500,011 (`--mode cost`), measured while other agents loaded the machine (load average about 150), so read the figures as upper bounds and as ratios:

- Rung 1: 1.46 ms per decision with the engine, 0.33 ms of it in the policy; 149 decisions and about 0.2 s per game.
- Top-K (`rung3:k=8`): 73.5 ms per decision on average and 167 ms per search (704 searches, 5.2 trials each, 10.6 rung 1 decisions per trial); about 10 s per game, both seats searching. The search changed rung 1's pick in 354 of 704 searches.
- Flat Monte Carlo with rung 1 playouts, N = 2: 315 ms per decision and 685 ms per search; about 39 s per game, both seats searching.
- Flat Monte Carlo with random playouts, N = 4: 317 ms per decision and 738 ms per search; about 37 s per game.
- Each trial or playout costs one rollback (about 2.5 ms) plus its own decisions at about 1.5 ms each with rung 1's view; a top-K search is about 5 trials of about 11 decisions, a Monte Carlo search about 20 playouts over about 10 candidates.

Warm pool, 12 workers (the performance cores, the measured best), other agents' batches sharing the machine (load average 100 to 160):

- Top-K, both seats searching (the owner-deck panel run): 7,200 games in 6,029 s, 1.2 games per second, so a 1,800-game deck check takes about 25 minutes on the warm pool. Rung 1 on the same 7,200 seeds took about 150 s.
- Top-K, one seat searching (the ladder): 400 games in 320 s while the Monte Carlo curve shared the pool.
- Flat Monte Carlo (`rung3mc:playout=rung1,n=2`), one seat searching (the ladder): 400 games in 595 s, 0.7 games per second. Both seats searching (the head-to-head run): 1,800 games in 7,532 s, 0.24 games per second, about 2 hours per 1,800 games under shared load.
- The issue's "about 20 minutes for 1,800 games" is met by top-K (about 25 minutes under shared load, so near it on a quiet machine) and missed by Monte Carlo; nothing was cut for speed, because the owner set the budget by local wall time, not tokens. K = 8 tried 5.2 candidates per search on average, because rung 1's order often runs out of distinct answers before 8.

### Limits and open questions

- Bot play only (D21's last tier). In every deck check both seats run the same policy, so a figure is "this deck as that bot plays it".
- The top-K bot's rollouts read the true hidden state inside the action phase: rung 1 answers the opponent's sub-prompts from their real hand, and a card effect that draws takes the real next card. V never sees those identities (the mask), but the chosen move can benefit from them. The Monte Carlo bot samples worlds instead; measured on it, the leak was worth about 3 points.
- Determinization redeals the opponent's hand from their own remaining decklist, which assumes their list is known (as a tournament archetype list would be). Cards an effect revealed from a hand are not tracked, so a redeal can hide them again.
- Sub-prompt answers are found in sampled world 0; if the real state offers different answers (a deck search shows other cards), the plan step is dropped and rung 1 answers.
- A rollback costs about 2.5 ms (deserialising the engine state, measured in a spike of 79 rollbacks), so a search pays it once per trial or playout.
- Parsed card text is wrong on about 1 card in 5 (CLAUDE.md "Accuracy, honestly"). Rung 3 leans on it less than rung 1, because the engine resolves every tried action's real text.
- Wall times in this section were measured while other agents' simulation batches shared the machine (load average often above 150), so they are upper bounds; the per-game figures from the single-thread cost run are the comparable ones.
- The K and horizon tuning record was written before two later code changes: a rung 1 fallback inside a top-K trial now draws from a stream that includes the match seed, and a rollback now trims the engine's chat log. The first can change a trial only when rung 1 declines inside it (in play, rung 1 declined 2 of rung 3's 25,084 ladder decisions; inside trials it is not counted); the second changes no decision. The ladder and deck records were run on the final code.
- Open question: random playouts to the end of the game were the owner's literal "random actions, see who wins". At one playout per candidate they play far worse than rung 1, and at this machine's speed (a 160-decision playout plus a rollback per candidate) dozens of playouts per candidate per decision would make a 1,800-game check take days. Whether a few hundred playouts would rank moves well is untested.
- Open question: rung 3 is not yet compared head to head with rung 2. Rung 2 failed its own step (D79), so the ladder doc's plan to make rung 3 the default only if it beats rung 2 head to head (`docs/research/sim-bot-policy-ladder.md:16`) needs a ruling on which comparison now decides it.

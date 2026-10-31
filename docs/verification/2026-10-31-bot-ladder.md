---
type: report
status: final
related: ["#114", "#104", "#110", "#112", "docs/research/sim-bot-policy-ladder.md", "docs/decisions.md"]
review_by: 2026-12-31
---

# Bot ladder, rungs 1 and 2, 2026-10-31

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
- Open question: Captain Tarpals and Boba Fett, Family Found carry high play-calibrated scores yet removing them does not move rung 1's win share; either rung 1 cannot use them or the score overrates them for this deck. Rung 3 (one-ply lookahead) is the test.
- Open question: the harness imports the driver by path (`SIMS_DRIVER_ROOT`, default this repo) because the branch was cut before #110 landed; once rebased, the imports can become static.

---
type: research
status: draft
review_by: 2026-12-31
related: ["docs/research/forceteki-simulation.md", "docs/research/sim-bot-policy-ladder.md", "docs/decisions.md"]
---

# Simulation evidence strategy: which cards work in the deck being built

What this answers: the owner asked how to use simulation to learn which cards work best in a deck under construction, with deck variants for candidate swaps ("x% of wins contain these cards") and best-of-three matches to test sideboards. Written by the SWU strategist agent on 2026-10-30 against the measured budgets in the two research docs above and the Comprehensive Rules 8.0; recorded verbatim apart from this header. Numbers marked as the agent's own calculation are estimates, not measurements.

## TL;DR

Use a duplicate design: every deck variant plays the same seeds against the same real opponent lists, in both seats, so each result is a paired contrast against the base deck rather than a standalone win rate. Show the paired variant difference first, then the shuffle-randomised access lift, and label the two association measures as association. Best-of-three and sideboard procedure are not settled by the Comprehensive Rules, so the match flow rests on labelled assumptions.

## 1. Variant construction

- Factor: one candidate swap, meaning one out-card replaced by one in-card at the same copy count. Deck size and copy counts stay inside CR 9.2.2.a ("A minimum of 50 other cards") and 9.2.2.b ("cannot include more than 3 copies of any unit, event, or upgrade").
- 1 to 3 candidates: test each as a one-swap variant against the base.
- Paired swaps: test as a 2x2 only when `explain_synergy` links the two in-cards. That 2x2 adds one interaction deck.
- 4 to 8 candidates: use a resolution-IV two-level fractional factorial with 16 decks. Each deck keeps or swaps each slot. Every game then informs every main effect, so 16 decks cost far less than 2^8 = 256.
- Cap: at most 16 decks per batch. More decks spread the games too thin to detect 10 points.

## 2. Variance control

- One seed covers the engine RNG and the opponent-list draw: the first-player coin flip, the shuffles, the mulligan reshuffle and random targets and discards (forceteki-simulation.md, Determinism). Bot randomness is counter-based, from sha256 of seed, seat, decision index and draw (sim-bot-policy-ladder.md, Rung 0).
- Seat swap: each seed plays twice, with decks swapped between seats (ladder doc, section 4).
- What the seed cannot pair: the in-card changes what is drawn and played, so games diverge from its first draw onward.
- Slot alignment: put the in-card at the out-card's index in a canonical deck array. If the engine shuffles by index (unverified), the in-card then lands exactly where the out-card would have. Index randomness by round and decision-within-round, so decisions after a divergence still line up.
- Sample size (the agent's normal-approximation calculation): a 10-point paired difference needs about 145 seed pairs if 20% of pairs are discordant, and about 310 if 40% are. Two independent arms need about 390 each.
- Consequence: 100 games per archetype gives a ±10-point absolute interval (93 games, both docs). It does not resolve a 10-point swap effect within one archetype. Pool the six strata for the swap contrast.

## 3. Attribution, in display order

1. Paired variant difference: exact sign test on discordant pairs, with an interval on the difference. Label: "effect of the swap on bot-play win share (rung N), paired by seed".
2. Access lift: within one variant, compare games where the card sat in the first 6 + 2N cards of the shuffled deck with games where it did not. Count before the mulligan and before any extra draws. The shuffle randomises this, so it is clean. Counting "drawn by turn N" instead lets mulligans and draw effects leak in. Label: "access lift (randomised by shuffle), bot play".
3. Played in won games vs lost games: long games show more cards, and winners can afford their expensive cards. Label: "association, not effect".
4. On board at game end: winners end with bigger boards (survivor bias). Label: "proxy, association only".
- "x% of wins contained these cards" only means something between variants, and there statistic 1 already answers it.

## 4. Best-of-three and sideboards

- The Comprehensive Rules do not say. They give no Premier best-of-three procedure, no time for sideboard swaps, no swap ratio, and no choice of first player in games 2 and 3.
- Nearest sections: 9.2.2.c "A Premier or Eternal deck may be accompanied by a sideboard of up to 10 cards." 9.3.3 is the only best-of-three procedure, and it sits under "9.3 TRILOGY FORMAT". 5.2.1.c, each game: "Randomly choose a player. That player then decides which player begins the game with the initiative counter (they may choose to start with the counter or give it to an opponent)."
- Engine defaults: apply 5.2.1.c in every game through the seeded coin flip. Treat "loser of the previous game chooses" and one-for-one swaps as configurable tournament assumptions, labelled as not from the CR.
- Plan table: pinned and keyed by opponent archetype. In-cards are the `meta_answers` cards for that archetype, taken from the 10-card sideboard. Out-cards are the lowest leader-fit main-deck cards with no `meta_answers` hit. Every row keeps its clause evidence (D26).
- Match flow: game 1 is blind. Games 2 and 3 use the plan, and the bot keys it on the opponent's public leader and base. Both arms share game 1 under the same seed, so only games 2 and 3 can split a pair.
- Sideboard viability: match win rate with the plan minus without it, per archetype, paired by seed.
- Matches needed: about 300 match pairs per archetype at 40% discordance (same calculation as section 2). That costs about 4 games each: 1 shared game, then 1.5 per arm.

## 5. Budget (15 to 36 games per second on 16 workers, forceteki-simulation.md)

- Default run: 5 decks (base plus 4 one-swap) x 6 archetypes x 100 paired games = 3,000 games, 83 to 200 s, a background batch.
- Best-of-three test: 6 x 300 x 4 = 7,200 games, 200 to 480 s, also a batch.
- 16-deck factorial: 9,600 games, about 4.5 to 11 minutes.
- Interactive tool: the 10 to 30 s budget buys about 360 to 1,080 games: one swap against the base at 600 paired games over the field (the spike timed 600 games at 17 to 29 s), or base vs field alone.

## 6. What the builder sees

- Line 1, the label: "bot play (rung N policy), not human results", then the engine commit, seed range, opponent population ("melee tournament decklists, window, placement-weighted") and the non-decisive count.
- For each variant: the swap, then the paired win difference with its interval and the number of discordant pairs.
- Under each swap: the in-card's access lift with its interval and how often it was resourced.
- Last: the sideboard result for each archetype, with the plan's out-cards and in-cards, the match-win difference with its interval, and n.
- The tool serves only rungs that passed the four gates (ladder doc, section 4).

## 7. Pitfalls specific to SWU

- Leader deploy: rung 1 deploys "as soon as it is legal" (ladder doc, rule 7). That undervalues leaders whose payoff depends on deploy timing. Report the deploy round for each variant.
- Resourcing: about half of all decisions are regroup resourcing (forceteki-simulation.md). The bot resources the lowest-scored card, so a low-scored in-card can be resourced in almost every game. Flag that card as "untested", not "weak".
- Mulligan: 5.2.1.e reads "Each player may only take one mulligan, and if they take a mulligan, they must keep their new hand." A swap that changes the curve also changes the bot's mulligan rate. The pre-mulligan access measure in section 3 avoids that.
- Mirrors: drop or report separately any opponent stratum that shares our leader.
- First player: the spike measured no seat bias for random bots in a mirror. The scored policy is unmeasured. Seat swaps cancel the effect, and first-player win share is reported separately.
- Engine errors: 3.3% of games threw in the smoke test. When either game of a seed pair ends in an error, drop the whole pair and report the error rate for each variant, because a card that crashes the engine biases its own variant.

## Task list for the simulation epic (#104)

1. Variant generator: one-swap, linked 2x2 and 16-run resolution-IV designs. Each variant checked against 9.2.2.a and 9.2.2.b, with slot-aligned canonical deck arrays.
2. Shuffle-alignment test: confirm whether the engine permutes by index, so a seed places the in-card in the out-card's slot.
3. Paired-seed runner: seat swap, archetype strata, pair-wise dropping of errored games, pollable progress.
4. Statistics module: sign test and interval on the paired difference, access lift, the two association measures, and D21/D26 labels on every number.
5. Best-of-three harness: pinned plan table from `meta_answers`, match flow, configurable tournament-assumption flags.
6. Result block in the deck tool, interactive tier capped at about 600 games, batch tier writing a pinned manifest.

Open: the best-of-three and sideboard procedure is not settled by the CR; the rulesVersion consulted was 8.0 (cover date 7/8/26).

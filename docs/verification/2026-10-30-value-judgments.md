---
type: decision
status: active
review_by: 2026-12-30
related: ["docs/verification/2026-10-30-codebase-review.md", "docs/decisions.md"]
---

# Judged deck-building sessions, 2026-10-30

What this answers: are the server's deck-building ideas worth having, measured the same way three times across the day's fixes. Each session is a verbatim run through the public endpoint of a builder making a Cad Bane, Still Faster than You / Nevarro City, Restored deck against the current Premier meta, scored step by step by an adversarial judge (opus, no stake, same rubric each time: 0 misleading or empty, 1 correct but nothing new, 2 would influence a real card choice, 3 a non-obvious idea a strong builder acts on).

## TL;DR

Mean score moved from 1.09 to 1.25 to 1.50 to 1.64 to 1.57 of 3 across five builds, and the share of steps a builder would act on from 2 of 11 to 9 of 14. The tournament-data tools (meta records, leader-ranked lists, `leader_cards` lift) earn their keep; the synergy path still lags. The verdict after the fifth session is MIXED, not yet VALUABLE; the plateau sits in the trio tool and the per-cost list caps.

## Sessions

- Session 1, build `cebc23f` (release `data-2026-10-30`), 11 steps: mean 1.09, 2 steps at 2 or above, verdict NOT YET. Top complaints: rankings ignored the tournament decklists the server holds (Porg led Cad Bane's list), leaders offered as pairing partners, a self-damage clause linked to another card's Grit, an evidence class reading "ok" on an 8-deck control group, raw token cluster labels, rotated cards worded as typos.
- Session 2, build `af05e0d` (release `data-2026-10-30.r2`), 12 steps: mean 1.25, 4 steps at 2 or above, verdict MIXED. `leader_cards` lift scored 3. Complaints: synergy tools ignored the leader's lists and target restrictions, `meta_answers` never addressed shields or sentinel walls, empty-cost fills with unplayed 9-to-11-drops, an 11-cost offered as a budget swap for a 7-cost with an impossible saving figure, no substitutes for Marrok.
- Session 3, build `6f1ca7d` (release `data-2026-10-30.r3`), 14 steps: mean 1.50, 7 steps at 2 or above, verdict MIXED. Scored highest: `leader_cards` lift (3), leader-weighted `find_pairings` explaining a stock card's link (2), per-archetype records in `meta_answers` (2). Remaining ranked defects, filed as #105 to #108: the audit compares against the whole pool rather than the leader's lists; substitutes match a clause rather than a unit's job; answers ignore what the leader already plays and sentinel walls get no answer; the offer-side trait restriction is unchecked; synergy aspects default to the leader's icons without the base; cost 11 still fills.

- Session 4, build `86c0b79` (release `data-2026-10-30.r4`), 14 steps: mean 1.64, 9 steps at 2 or above, verdict MIXED. Resolved: the audit flags Oggdo Bogdo from the leader's lists, Rancor Keeper reads penalty 0 under the base, cost 11 reads unfilled, listedCopies counts 50, Marrok gets keyword-matched substitutes. Remaining: Pilots offered to a non-Vehicle, a slot substitute bypassing the trait binding, one played card carrying two unplayed trio partners, the answers page being the deck's own staples with sentinel-wall at 0, every ping link worded as self-damage. Filed as #119 to #121.
- Session 5, build `e99ccc3` (release `data-2026-10-30.r5`), 14 steps: mean 1.57, 9 steps at 2 or above, verdict MIXED. Resolved: attach and give restrictions, no Always a Bigger Fish in slot lists, side-aware reasons, the pairing call leads with TIE Dagger Vanguard, symmetric sweeps demoted and sentinel-wall at 1. The mean dipped because the leader default made the second pairing call a repeat of the first, and the trio tool still scored 0 and 1 (one played member per trio, a loop whose links do not combine, a curated id shown in place of clause text). Also: perCost 3 drops staples above 60%, empty-cost rows cover costs the leader never fills, budget swaps offered for cards already under the cap. Filed as #134 and #135.

## What the sessions established

- Every tool answered every step with no `isError` across the five runs (65 calls).
- The pairs-v1 benchmark moved only upward through the matcher changes: 0.7424 to 0.7462 to 0.7617 to 0.7656 overall, 0.7048 to 0.7091 to 0.7267 to 0.7313 mechanical, recall of labelled-correct pairs 147 of 147 throughout.
- Complaints confirmed resolved by the third judge: leader-aware weighting, no Porg or unplayed 9-to-11 fills, cost-banded budget swaps with correct savings, rotated-set wording, no leaders as partners, honest evidence classes, pinned cluster labels, the token-Creature want-side check.

The session dumps and judge reports are session artifacts, not committed; the scoring rubric above is the reproducible part.

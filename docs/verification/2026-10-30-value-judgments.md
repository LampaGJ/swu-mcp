---
type: decision
status: active
review_by: 2026-12-30
related: ["docs/verification/2026-10-30-codebase-review.md", "docs/decisions.md"]
---

# Judged deck-building sessions, 2026-10-30

What this answers: are the server's deck-building ideas worth having, measured the same way three times across the day's fixes. Each session is a verbatim run through the public endpoint of a builder making a Cad Bane, Still Faster than You / Nevarro City, Restored deck against the current Premier meta, scored step by step by an adversarial judge (opus, no stake, same rubric each time: 0 misleading or empty, 1 correct but nothing new, 2 would influence a real card choice, 3 a non-obvious idea a strong builder acts on).

## TL;DR

Mean score moved from 1.09 to 1.25 to 1.50 of 3 across the three builds, and the share of steps a builder would act on from 2 of 11 to 7 of 14. The tournament-data tools (meta records, leader-ranked lists, `leader_cards` lift) earn their keep; the synergy path still lags. The verdict after the third session is MIXED, not yet VALUABLE.

## Sessions

- Session 1, build `cebc23f` (release `data-2026-10-30`), 11 steps: mean 1.09, 2 steps at 2 or above, verdict NOT YET. Top complaints: rankings ignored the tournament decklists the server holds (Porg led Cad Bane's list), leaders offered as pairing partners, a self-damage clause linked to another card's Grit, an evidence class reading "ok" on an 8-deck control group, raw token cluster labels, rotated cards worded as typos.
- Session 2, build `af05e0d` (release `data-2026-10-30.r2`), 12 steps: mean 1.25, 4 steps at 2 or above, verdict MIXED. `leader_cards` lift scored 3. Complaints: synergy tools ignored the leader's lists and target restrictions, `meta_answers` never addressed shields or sentinel walls, empty-cost fills with unplayed 9-to-11-drops, an 11-cost offered as a budget swap for a 7-cost with an impossible saving figure, no substitutes for Marrok.
- Session 3, build `6f1ca7d` (release `data-2026-10-30.r3`), 14 steps: mean 1.50, 7 steps at 2 or above, verdict MIXED. Scored highest: `leader_cards` lift (3), leader-weighted `find_pairings` explaining a stock card's link (2), per-archetype records in `meta_answers` (2). Remaining ranked defects, filed as #105 to #108: the audit compares against the whole pool rather than the leader's lists; substitutes match a clause rather than a unit's job; answers ignore what the leader already plays and sentinel walls get no answer; the offer-side trait restriction is unchecked; synergy aspects default to the leader's icons without the base; cost 11 still fills.

## What the sessions established

- Every tool answered every step with no `isError` across the three runs (37 calls).
- The pairs-v1 benchmark moved only upward through the matcher changes: 0.7424 to 0.7462 to 0.7617 overall, 0.7048 to 0.7091 to 0.7267 mechanical, recall of labelled-correct pairs 147 of 147 throughout.
- Complaints confirmed resolved by the third judge: leader-aware weighting, no Porg or unplayed 9-to-11 fills, cost-banded budget swaps with correct savings, rotated-set wording, no leaders as partners, honest evidence classes, pinned cluster labels, the token-Creature want-side check.

The session dumps and judge reports are session artifacts, not committed; the scoring rubric above is the reproducible part.

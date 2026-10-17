---
type: report
status: final
related: ["#14", "#15"]
review_by: 2027-01-17
---

# Pairing benchmark: the labelled 200-pair fixture (pairs-v1)

## TL;DR

After the #14 and #15 fixes, 147 of 199 judged pairs in a fixed, stratified 200-pair sample are genuine synergies: precision 73.9% (95% interval 67.4 to 79.5%). Weighting each complementarity row by its share of all emitted pairs gives 74.0%. Round 2 measured about 56% on a smaller fresh sample. The fixture is committed, so every later matcher change is now measured against the same 200 pairs instead of a new random draw.

## Method

- `pnpm verify:pair-fixture` draws 200 (pair, row) units from the 2026-10-17 run (buildHash `d2ad228a…`), stratified by complementarity row: proportional share, floor of 3 per row, seed `pair-fixture-v1`. 30 rows are represented. Packets show both cards' original text, their tags with provenance and the row definition.
- Eight haiku agents judged the eight packets blind (150 correct, 45 wrong, 5 unsure).
- Four sonnet agents re-judged every item, not only the flags, and overrode haiku on 15 of 200 items (10 to wrong, 5 to correct). Final labels: 147 correct, 52 wrong, 1 unsure.
- The raw verdicts and adjudications are pinned in `data/pinned/pair-fixture-v1/`. `pnpm verify:pair-fixture:pin --dir data/pinned/pair-fixture-v1` rebuilds `data/fixtures/pairs-v1.json` byte for byte (sha256 `f1af83b7…`).
- `pnpm verify:pairs` reports precision, recall of the labelled-correct pairs and how many labelled-wrong pairs a run still emits, overall and per row, with Wilson 95% intervals.

## Results by row (correct of judged)

- Strong (all or nearly all correct): extra-attack-on-attack 20/22, trait-reference 30/33, sac-outlet-when-defeated 8/10, ping-own-damage-payoff 14/18, and most new #14 rows (grant-hidden, grant-sentinel, exhaust-enemy, enemy-base-damage, own-upgrade-defeat-watcher and when-played-repeater 3/3 each; grant-shielded and weaken-enemy 2/3).
- Middling: bounce-replay 9/12, upgrade-stacking 8/13, ready-reuse 7/13, fodder-for-outlet 5/10.
- Weak, each 0 or 1 of 3: discard-payoff, draw-hand-size, fill-discard, ramp-threshold, enter-play-triggers, exhaust-own-payoff, self-defeat-defeat-watcher. These rows are small, so they move the overall figure little, but their candidates should not be trusted.

## Recurring defects in the wrong pairs

- Numeric qualifiers on the payoff side: power or HP limits ("4 or less power", "4 or less remaining HP") checked against the wrong card or not at all.
- Leader-side costs read as unit states: "exhaust this leader" does not exhaust a unit.
- Opponent-chosen modes ("An opponent chooses one") treated as guaranteed effects.
- Draws or discards that go to the opponent, or a hand-size cap that throws extra draws away.
- Piloting upgrades paired with non-Vehicle units.

## Use

Run `pnpm verify:pairs` after any change to the grammar, tags, qualifiers or complementarity table. A fix should raise precision without lowering recall of the labelled-correct pairs. Re-label only by adding a new fixture version; never edit pairs-v1.

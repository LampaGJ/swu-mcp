---
type: research
status: draft
review_by: 2027-01-16
related: ["#322"]
---

# SWU card value rubric (issue #322, round 2)

## TL;DR

- Scope: the rubric scores logical cards (one canonical printing each) that have any printing in Jump to Lightspeed (JTL) or later, or in those sets' Weekly Play sets. That is 1,597 cards. Curves and keyword prices are fitted on all nine sets where that adds data; every number below names its population.
- The vanilla stat curve is fitted, not guessed. Expected power plus HP for a keyword-less, text-less unit is 1.72 + 1.96 x cost, minus 0.38 in space, plus 1.71 when unique (n=65, R squared 0.97). A 3-cost ground vanilla unit expects 7.6 stat points, which settles round 1's "7 or 8" question at "between, nearer 8".
- Designers price power slightly above HP: one power costs 0.538 resources and one HP 0.458, a ratio of 1.17 [1.07, 1.31]. One resource buys about 2.0 stat points.
- Power creep is a single step, not a trend. Year 2 (JTL, LOF, SEC) cards carry 0.45 [0.25, 0.66] more stat points than year 1 at equal cost and text. Year 3 (LAW, ASH, HMW) equals year 2: minus 0.05 [minus 0.24, 0.14] within the JTL+ fit.
- Revealed keyword prices (stat points designers remove): Exploit 2.6, Shielded 1.2, Support 1.0, Ambush 1.0, Piloting 1.0, Grit 0.9, Plot 0.9, Sentinel 0.5, Restore 0.4, Raid 1 0.2 plus 0.6 per further point. Overwhelm, Saboteur, Coordinate and Smuggle are free. Bounty is a drawback worth plus 1.9.
- The decisive finding: designer-relative efficiency does not predict play. The residual from the cost curve has Spearman 0.005 with Premier inclusion over 1,042 JTL+ units. Designers price cards accurately; what separates played cards from unplayed ones is which abilities they carry.
- Ground truth found: SWU Stats publishes per-card Premier inclusion and win counts from Karabast and Petranaki games as a public JSON endpoint. That is 637,162 player-games from 2025-09-20 to 2026-10-16. A play-calibrated model on deterministic features predicts held-out sets with Spearman 0.29 to 0.55, against 0.00 to 0.28 for cost, type and aspect alone.
- The recommended score is therefore play-calibrated: every component weight is fitted to inclusion, every feature is deterministic, and the cost-curve residual stays as a secondary "efficiency" readout.
- Cheaper cards are worth more at equal content. Relative to cost 2, inclusion falls by 0.80 [0.30, 1.30] log points at cost 6 and 0.85 [0.26, 1.44] at cost 7+. This is the playability term T(cost), now an explicit component.
- No limited or draft card ratings were found for any set, and Homeworlds (HMW) has under one week of play data.
- Deterministic regex coverage is 77.3 percent of ability sentences on JTL+ cards (70.3 percent excluding pure keyword lines). 495 of 1,597 cards carry at least one unclassified sentence, which is flagged and scores 0.

## Scope and population

- Owner rule: score only logical cards, one row per card. Drop every printing that is a `variantOf` or `reprintOf` another. Where only reprints exist, take the earliest set by release order in [`packages/shared/src/adapters/swu/set-rotation.ts:12-22`](https://github.com/LampaGJ/mault/blob/feature/swu-support/packages/shared/src/adapters/swu/set-rotation.ts#L12-L22), then the lowest `serialCode`. `load.mjs` implements this.
- The API leaves some reprints unlinked. ASH's Consortium StarViper (`08010122`) duplicates SOR `0101112` with no `reprintOf`, and Intro Battle: Hoth (IBH) repeats cards inside one product. `load.mjs` collapses identical gameplay identity (title, subtitle, type, cost, stats, aspects, text), keeping the earliest release. That removes 75 rows and leaves 2,476 logical cards from 10,246 printings. A reprint therefore counts only in its original set.
- JTL+ population: a logical card with any printing in JTL, LOF, SEC, LAW, ASH, HMW or their Weekly Play sets (JTLP, LOFP, SECP, LAWP, ASHP, HMWP). That is 1,597 cards (`load.mjs`). This matches current Premier legality ([`packages/shared/src/adapters/swu/set-rotation.ts:9`](https://github.com/LampaGJ/mault/blob/feature/swu-support/packages/shared/src/adapters/swu/set-rotation.ts#L9)). Twenty-one cards first printed before JTL qualify through a later reprint, for example Death Trooper, Wampa and Shield. In JTL+ fits each such card counts in its first JTL+ set.
- Fit populations used below:
  - "all": canonical units from the nine main sets, 1,473 units.
  - "JTL+": 1,042 units.
  - "play": JTL+ units, events and upgrades excluding HMW, 1,172 cards.
- Data: the raw snapshot at `/Users/graham/.local/state/mault/raw/swu-cards/2026-10-16T21-28-37-247Z-snapshot/` (103 pages, 10,246 printings). Field meanings: `docs/concepts/swu-card-data-fields.md` in this repository.

## Scripts and pinned inputs

All scripts are node ESM, deterministic (seeded bootstraps, sorted output), and carry an `@pocTriage` header for the later committed scoring script. They live in `scripts/rubric/` in this repository (moved from mault-handoff in swu-mcp#4).

- `load.mjs`: snapshot to `printings.json` and `cards.json`. Canonical dedupe and the JTL+ flag.
- `ols.mjs`: ordinary least squares with HC1 robust standard errors, plus a seeded RNG (mulberry32). Hand-written because this is a probe. The committed script should go through the framework search first (judgment).
- `features.mjs`: every regex used (`EFFECTS`, `TIMINGS`, `KEYWORD_PARAMS`), quoted in the "Deterministic features" section below.
- `fit-units.mjs [all|jtl]`: vanilla curve M0, stats model M1, cost model M2, power creep M3. Outputs `fit-units.out.json` and `fit-units.jtl.out.json`.
- `fit-effects.mjs [all|jtl]`: stats model M4 with effect magnitudes and timing splits.
- `fit-other.mjs [all|jtl]`: events E1, upgrades U1, leaders L1, bases B1.
- `score.mjs`: residual score V0 and its validation against inclusion, win percentage and price.
- `play-model.mjs [window] [rarity|norarity]`: play-calibrated weights, T(cost), leave-one-set-out cross-validation, and per-card scores with and without T.
- `coverage.mjs`: regex coverage over JTL+ ability sentences.
- Pinned captures (sha256 prefix):
  - `gt/swustats-premier-w29-55.json` (757e28024d28152e)
  - `gt/swustats-premier-w0-55.json` (92abdce8e9334bba)
  - `gt/tcg-prices-import43.tsv` (5b14b16223f6f622), exported from `tcg_printings` for import 43
  - `cards.json` (b08299474bb4b03a)

## Vanilla curve (step 1)

Source: `fit-units.mjs` M0. Vanilla means a unit with no keywords and empty text. The population is "all" main sets (n=65). The JTL+-only fit is in brackets.

- Total stats = 1.72 [1.34, 2.09] + 1.96 [1.86, 2.07] x cost, minus 0.38 [0.11, 0.65] in space, plus 1.71 [1.07, 2.35] when unique. R squared 0.972, root mean square error 0.57. JTL+ (n=48): intercept 1.69 [1.28, 2.11], cost 1.97 [1.87, 2.08], space minus 0.26 [minus 0.61, 0.09], unique 1.71 [1.05, 2.37]. The fits do not differ.
- Power = 0.72 + 0.99 x cost, minus 0.62 in space. HP = 1.00 + 0.98 x cost, plus 1.56 when unique. Uniqueness buys HP, not power. Space costs power.
- Observed vanilla means of total stats, by arena and cost:
  - Ground: 1-cost 4.4 (n=8), 2-cost 5.9 (n=12), 3-cost 7.6 (n=14), 4-cost 9.9 (n=8), 6-cost 13.3 (n=3).
  - Space: 2-cost 5.0 (n=7), 3-cost 7.0 (n=3), 5-cost 11.0 (n=2).
  - Above cost 5 the cells hold 1 to 3 cards, so trust the linear fit there, not the cells.
- Round-1 seeds compared: the official "power equal to cost, HP cost plus 2" default (https://starwarsunlimited.com/articles/behind-unlimited-recalibrations) gives 2c + 2, which is 8 at 3-cost. The Fifth Trooper table (https://thefifthtrooper.com/evaluating-cards-in-star-wars-unlimited-tcg/) gives 7. The fit gives 7.6 for ground non-unique, 9.3 for ground unique, and 7.2 for space.
- Text-adjusted curve (`fit-units.mjs` M1, all sets, SOR baseline, ground, one aspect, no text) by cost 1 to 8: 3.5, 4.7, 6.3, 8.0, 9.5, 11.1, 12.8, 16.3. Add the set step (about plus 0.5 from JTL on) for current cards. This curve sits below the vanilla cells because vanilla units get a small stat bonus for having nothing else. M1 shows text-less units sitting 0.4 to 1.0 stat points above units with any ability line.

### Power versus HP

- Designer weight: `fit-units.mjs` M2 regresses cost on power, HP, keywords, effects, aspects, set and arena (n=1,473, R squared 0.893). One power costs 0.538 [0.507, 0.568] resources and one HP 0.458 [0.426, 0.490]. The ratio is 1.17 [1.07, 1.31] over 393 seeded bootstraps. JTL+ only: 1.13 [1.01, 1.28]. So 1 resource is about 2.0 stat points (`score.mjs` uses 2 / (0.538 + 0.458)).
- Play weight: `play-model.mjs` (play population). One point of power above the vanilla curve raises log inclusion by 0.229 [0.075, 0.382]. One point of HP raises it by 0.083 [minus 0.062, 0.228]. Players value power about 2.8 times HP, but the HP coefficient's interval includes zero, so the ratio has no usable interval.
- Rubric choice: weight power 1.17 and HP 1.0 in the efficiency readout, matching the designers. Let the play-calibrated weights carry the play preference.

### Power creep (SOR to HMW)

- With cost, keywords, effects, arena, unique and aspects held fixed (`fit-units.mjs` M1, all sets), set intercepts against SOR are:
  - SHD 0.46 [0.11, 0.80]
  - TWI 0.17 [minus 0.25, 0.59]
  - JTL 0.78 [0.41, 1.14]
  - LOF 0.73 [0.36, 1.10]
  - SEC 0.45 [0.14, 0.76]
  - LAW 0.27 [minus 0.06, 0.61]
  - ASH 0.75 [0.37, 1.14]
  - HMW 0.66 [0.32, 0.99]
- Block model (M3c): year 2 is plus 0.45 [0.25, 0.66] over year 1, and year 3 is plus 0.39 [0.17, 0.61]. Within JTL+ alone, year 3 against year 2 is minus 0.05 [minus 0.24, 0.14].
- Vanilla units only (M3a, n=65): no set differs from SOR except LAW, plus 0.62 [0.17, 1.08], from small cells.
- Raw surplus (power + HP minus 2 x cost) by set mean, descriptive (M3b): SOR minus 0.37, SHD 0.15, TWI minus 0.60, JTL 0.03, LOF 0.30, SEC 0.02, LAW minus 0.13, ASH 0.18, HMW 0.13.
- Conclusion: about half a stat point of creep arrived with year 2 and has stayed flat since. For the JTL+ scope, set intercepts are within about 0.8 stat points of each other. LAW sits lowest (minus 0.52 [minus 0.87, minus 0.16] against JTL in the JTL+ M1), plausibly because multi-aspect cards debuted there. The rubric fits a set term and scores against the card's own set, so drift does not leak into ranks.

## Revealed keyword prices (step 2)

Price means stat points designers remove for the keyword, from `fit-effects.mjs` M4 (stats model, "all" population, n=1,473, R squared 0.866). Positive means the card has fewer stats. The JTL+ fit (n=1,042) matches within its intervals for every keyword (`fit-units.mjs jtl`, M1 comparison). "Printed" means an ability line starts with the keyword. "Conditional" means the card gains it under a condition.

- Exploit: 2.60 [0.86, 4.35], n=20. Each further Exploit point adds minus 0.30 [minus 1.29, 0.70].
- Shielded: 1.18 [0.85, 1.51], n=55. Conditional 0.86 [0.07, 1.65], n=6.
- Ambush: 0.99 [0.65, 1.33], n=80.
- Piloting (the card also works as a pilot upgrade): 0.98 [0.55, 1.41], n=38.
- Plot: 0.92 [0.41, 1.43], n=20.
- Support (ASH): 0.84 [0.49, 1.18], n=25. JTL+ only: 0.96 [0.56, 1.36].
- Grit: 0.78 [0.48, 1.08], n=46.
- Sentinel: 0.49 [0.12, 0.85], n=91. Conditional Sentinel is minus 0.46 [minus 0.78, minus 0.15], n=53. Designers add stats to units that only sometimes guard.
- Restore N: 0.38 [0.13, 0.63] at N=1, plus 0.18 per further point [minus 0.19, 0.55], n=78.
- Hidden: 0.29 [minus 0.04, 0.62], n=56. JTL+ only: 0.40 [0.08, 0.71].
- Raid N: 0.21 [minus 0.04, 0.45] at N=1, plus 0.63 [0.48, 0.79] per further point, n=70. Raid 2 costs about 0.8 and Raid 3 about 1.5.
- Smuggle: 0.21 [minus 0.29, 0.71], n=24. Free.
- Saboteur: minus 0.13 [minus 0.39, 0.14], n=59. Free.
- Overwhelm: minus 0.36 [minus 0.82, 0.09], n=75. Free.
- Coordinate: minus 0.09 [minus 0.74, 0.55], n=20. Free.
- Bounty (on own unit): minus 1.87 [minus 2.40, minus 1.34], n=10. A drawback: the unit gets about 1.9 extra stats.
- Fortify (HMW): upgrades only. See "Upgrades" below.
- Other unit-level terms from the same fit:
  - Each ability line: 0.63 [0.37, 0.88].
  - Space: 0.50 [0.33, 0.68].
  - Unique: minus 0.48 [minus 0.66, minus 0.29]. Unique units get about half a stat point more, matching the official article's statement.
  - Each aspect icon: minus 0.25 [minus 0.37, minus 0.13]. More aspects means more stats.
  - Generic self-drawback line: minus 1.14 [minus 1.51, minus 0.78].

Effect prices on units are mostly not identified in the stats model. Beyond the generic 0.63 per ability line, almost every effect's interval spans zero. The exceptions:
- "When Played" Experience: 0.74 per token [0.30, 1.18].
- "When Played" Shield: 0.78 per token [0.22, 1.33].
- "When Played" defeat a unit: 1.50 [0.53, 2.47].
- Token units: 0.24 per token stat point [0.10, 0.38].
- Advantage: 0.17 per token [0.00, 0.34].

Designers appear to cost abilities largely by presence and timing, not magnitude. Effect magnitudes are priced better on events, where the whole cost is the effect.

### Effect prices from events (resources)

From `fit-other.mjs` E1: cost regressed on effect features. "All" n=407, R squared 0.32. JTL+ n=256, R squared 0.47. Values are resources, JTL+ in brackets where it differs. Multiply by about 2.0 for stat points. The baseline event costs 1.98 resources [1.37, 2.59].

- Take control: 2.48 [1.54, 3.41], n=6 (JTL+ 2.85).
- Defeat a unit: 1.94 [1.15, 2.73], n=45 (JTL+ 1.86).
- Capture: 1.80 [0.40, 3.20], n=8.
- Ready a unit: 1.41 [0.03, 2.79], n=16 (JTL+ 0.80).
- Damage equal to a variable: 1.13 [0.34, 1.92], n=23.
- Bounce to hand: 0.91 [minus 0.03, 1.86].
- Damage to each unit: 0.72 per point [0.35, 1.10], n=12.
- Credit token (LAW): 0.69 per token [0.13, 1.26], n=4 (JTL+ 0.88 [0.34, 1.42]).
- Base damage: 0.36 per point [0.16, 0.56].
- Card draw: 0.28 per card [0.01, 0.55], n=26.
- Token units: 0.18 per token stat point [0.07, 0.30]. A Beast token (3/3, HMW) is therefore about 1.1 resources, and a Mandalorian token (2/2 plus Shield, ASH) about 0.9 with the Shield judged as 1 stat point (judgment).
- Exhaust: minus 0.65, extra attack minus 0.89, and Smuggle minus 1.20. These are cheaper than baseline, meaning the baseline absorbs them.
- Plain "deal N damage to a unit" magnitude is not identified (0.01 per point [minus 0.17, 0.18]). Damage events cluster at similar cost, so the intercept absorbs them.

## Sets 7 to 9: new mechanics (step 3)

Enumerated from data: `load.mjs` output, keyword first appearance and first-appearing phrases per set. Rules text from official articles fetched through `https://admin.starwarsunlimited.com/api/articles?filters[slug][$eq]=<slug>`.

### A Lawless Time (LAW, set 7)

New keywords: none in the `keywords` field. New mechanics found in text:

- Credit token: "While paying resources, you may defeat this token. If you do, pay 1 resource less." This is the token card's own text (LAW `T01` in the snapshot). Credits do not count toward resources you control, so they cannot speed a leader deploy (https://starwarsunlimited.com/articles/aspects-and-credits, 2026-01-21). Forty cards mention Credit and 21 JTL+ cards create one.
  - Valuation: 0.69 [0.13, 1.26] resources per Credit created (events, all sets). JTL+: 0.88 [0.34, 1.42]. Unit stats price 0.46 [minus 0.28, 1.20] stat points per Credit, not identified.
  - Play effect: minus 0.22 [minus 0.79, 0.34] log inclusion (`play-model.mjs`), not identified.
  - Rubric value: 1 Credit = 0.8 resources = 1.6 stat points (judgment, between the two fits).
- Multi-aspect cards, the game's first (https://starwarsunlimited.com/articles/a-lawless-time, https://starwarsunlimited.com/articles/lawless-insights). Every LAW Common base has an Epic Action that ignores one aspect penalty in a game (same articles).
  - Valuation: each aspect icon adds 0.25 stat points (M4). On top of that, a two-non-alignment-aspect card gets minus 0.28 [minus 0.60, 0.05] (M1, n=96), not identified.
  - The aspect penalty rule is "pay 2 extra resources per icon beyond those provided by leader/base" (`/Volumes/Local Files/Projects/swu/complete_rules_digest.md:78`). The rubric therefore scores aspect count as deckbuilding restriction only. It does not apply the in-game penalty, which is deck context.
- "When Attack Ends:" trigger, new in LAW (21 lines).
  - Valuation: 0.46 stat points [minus 0.24, 1.16] above other timing classes (M1, n=14). Play effect minus 0.47 [minus 1.46, 0.52]. Neither is identified, so the rubric treats it like an "On Attack" line (judgment).
- New trait: Musician (`load.mjs` trait first appearance). Traits are not scored.

### Ashes of the Empire (ASH, set 8)

- Support keyword: "When you play this unit, you may attack with another unit. It gains this unit's other abilities for this attack." This is reminder text on ASH cards such as Rukh and Grand Admiral Thrawn (snapshot). Design intent: https://starwarsunlimited.com/articles/insights-to-ashes (2026-07-28). Support is on 29 cards.
  - Valuation: designer price 0.84 [0.49, 1.18] stat points (all) and 0.96 [0.56, 1.36] (JTL+).
  - Play effect: plus 0.50 [minus 0.28, 1.28] log inclusion, positive but not identified.
- Advantage token: an upgrade giving plus 1/plus 0 (snapshot `power` 1, `hp` 0), with "When attached unit's attack or defense ends: Defeat this upgrade." The designers say it is costed "much more aggressively" than Experience because it is temporary (https://starwarsunlimited.com/articles/insights-to-ashes).
  - Valuation: 0.17 [0.00, 0.34] stat points per token given (all), 0.24 [0.01, 0.46] (JTL+). Experience given "When Played" costs 0.74 per token, so an Advantage is worth roughly a quarter of an Experience. This fits the article.
- Mandalorian token unit: 2/2 with Shielded (snapshot; https://starwarsunlimited.com/articles/insights-to-ashes). Created by 16 cards. Priced through the pooled token-unit term: 0.24 stat points per token stat point on units (all), and 0.18 resources per token stat point on events. With Shielded counted as 1.18 (the Shielded price above), a Mandalorian token is about 5.2 stat-equivalents (judgment on summing).
- No new trait first appears in ASH.

### Homeworlds (HMW, set 9)

- Fortify keyword: "Attach this to your base, not a unit" (reminder text, HMW Dark Sanctum). Described as the game's first base upgrade (https://starwarsunlimited.com/articles/homeworlds, 2026-07-26; https://starwarsunlimited.com/articles/defend-and-destroy). On 16 cards. New trait Fortification.
  - Valuation: upgrades with Fortify cost minus 0.13 [minus 0.85, 0.60] resources against other upgrades with the same features (`fit-other.mjs jtl` U1, n=15). No premium or discount is detectable.
  - There is no play data yet. The rubric scores a Fortify upgrade from its "Attached base gains" effects at the event prices (judgment).
- Beast token: a 3/3 token unit, "the largest we've seen", harder to create (https://starwarsunlimited.com/articles/homeworlds). Created by 21 cards (10 units). Rubric value 6 token stat points, or 1.1 resources at the event token price.
- Weakness token: a minus 1/minus 1 upgrade (snapshot `upgradePower` minus 1, `upgradeHp` minus 1), "essentially the inverse of the classic Experience token" (https://starwarsunlimited.com/articles/homeworlds). Given by 22 cards (15 units).
  - Valuation: 0.43 [minus 0.28, 1.14] stat points per token (all), not identified. Rubric value: equal and opposite to an Experience token (0.74 stat points when played) (judgment, following the article).
- Base traits Tatooine, Naboo, Endor and Kashyyyk: each primary aspect has four Common bases, one per trait, and cards reference them (https://starwarsunlimited.com/articles/homeworlds). Traits are not scored. "If you control a <trait> base" conditions are flagged as conditional (see "Conditions" below).
- Space leader: the Grand Moff Tarkin leader deploys as the Death Star, the "first true space leader" (https://starwarsunlimited.com/articles/defend-and-destroy). The leader fit adds a space indicator for it.

### Earlier mechanics, for completeness

- Plot and disclose (SEC): Plot cards can be played from resources when you deploy your leader (https://starwarsunlimited.com/articles/disclosing-plots, 2025-09-03). Plot prices are above.
- Piloting (JTL), Hidden and the Force (LOF), Exploit and Coordinate (TWI), and Smuggle and Bounty (SHD) all have prices above. Smuggle is "Play from resources for Y" (`/Volumes/Local Files/Projects/swu/complete_rules_digest.md:391`). Exploit is "Defeat friendly units to reduce cost" (`complete_rules_digest.md:381`).

## Ground truth (step 4)

### Found and fetched in bulk

- SWU Stats card stats: `https://swustats.net/TCGEngine/Stats/CardMetaStatsAPI.php?startWeek=<a>&endWeek=<b>&format=premier` returns JSON. Each row has `cardUid`, `cardName`, `timesIncluded`, `timesIncludedInWins`, `timesPlayed`, `timesPlayedInWins`, `timesResourced`, and `timesResourcedInWins`. The page that calls it is https://swustats.net/TCGEngine/Stats/CardMetaStats.php.
- Provenance, from the open-source server code:
  - Rows are written by `SubmitGameResult.php`, which accepts only the Petranaki and Karabast API keys (https://github.com/TCG-Engine/TCGEngine/blob/main/APIs/SubmitGameResult.php, line 18).
  - It adds 1 to `timesIncluded` per player-game whose deck contains the card (same file, lines 477-478 and 532-543).
  - It buckets by week since 2025-09-20 (same file, lines 425-427).
  - The API aggregates weeks per card (https://github.com/TCG-Engine/TCGEngine/blob/main/Stats/CardMetaStatsAPI.php).
- Coverage: week 0 (2025-09-20) to week 55 (ending 2026-10-16). There are 637,162 Premier player-games in total, counted as the sum of leader inclusions (`score.mjs`). Weeks 29 to 55 (2026-04-11 to 2026-10-16) hold 276,978 player-games. This window postdates the year-1 rotation at LAW's release, so Premier is the JTL+ pool. All 2,352 rows matched a canonical card through `cardUid` (`load.mjs` plus a join check).
- Limits:
  - These are online simulator games, not tournament results.
  - "Percent included in wins" is a win rate given inclusion. It does not control for leader.
  - HMW (released 2026-10-09) has under one week of data, so HMW is excluded from the play fits.
  - ASH (July 2026) has about 13 weeks.
  - Other formats are available through `format=` (eternal, twinsuns, teamsuns, padawan, and preview formats).
- TCGplayer Standard non-foil price of the canonical printing: `tcg_printings`, import 43, `variant='standard'`, `price_normal` (pinned TSV). 1,565 of 1,578 scored JTL+ cards have a price.

### Not found or failed (honest record)

- Limited or draft card ratings: none found.
  - Searches: "Star Wars Unlimited Homeworlds draft limited card ratings tier list"; "Star Wars Unlimited "Ashes of the Empire" OR "A Lawless Time" limited draft set review grades every card"; "SWU limited pick order ratings spreadsheet …". These returned product pages and sports drafts.
  - https://starwarsunlimited.gg/ (formerly onepiece.gg) lists deck-level meta tier lists for JTL (https://starwarsunlimited.gg/jump-to-lightspeed-meta-tier-list-planetary-qualifiers-best-decks/) and draft strategy guides, but no per-card ratings in the fetched content.
- swudb.com, melee.gg, swucompetitivehub.com and Garbage Rollers: not retried this round. Round 1 recorded a tagline-only page and DNS failures (see Reproduction). SWU Stats also hosts Melee tournament aggregation (`Stats/MeleeTournamentAggregate.php` in the same repo), which was not explored.
- Local deck data, `/Volumes/Local Files/Projects/swu-data-counterfactual/decks/`: 9,857 JSON files (swudb deck exports). `createdAt` runs from 2025-12-20 to 2026-01-19. They hold 384 LAW card references (preview-season decks) and no ASH or HMW cards. SWU Stats supersedes them for validation.

## Validation run (JTL+ population)

Source: `score.mjs w29-55` and `play-model.mjs`.

### Designer-efficiency score V0 does not predict play

V0 is the residual from M4 for units, or the negated cost residual times 2.0 for events and upgrades. Spearman correlations by type:

- Units, n=1,042: inclusion 0.005 [minus 0.06, 0.07]; win percentage among cards with 500 or more inclusions 0.099 (n=565); price minus 0.015.
- Events, n=256: inclusion minus 0.19 [minus 0.30, minus 0.07]; price minus 0.12.
- Upgrades, n=110: inclusion minus 0.11 [minus 0.29, 0.08]; price minus 0.17.
- Leaders, n=104: inclusion 0.26 [0.07, 0.43]. V0 here is leader-unit stats against deploy threshold.
- Bases, n=66: inclusion 0.43 [0.21, 0.61]. V0 here is base HP against "has an ability".

In a regression of log inclusion on V0 plus cost, type, set, aspect-combination and rarity fixed effects (n=1,408), V0's coefficient is minus 0.118 [minus 0.191, minus 0.045]. Over-statted cards for their text are played less, because the ability is what gets them played. V0 stays in the rubric only as a secondary "efficiency" readout, and is useful for leaders and bases.

### Play-calibrated model

Source: `play-model.mjs w29-55 norarity`; n=1,172; 88 parameters; R squared 0.277. The outcome is log((inclusions + 1) / player-games). The model controls for set and aspect-combination fixed effects; those are context, not card value, and are excluded from the score.

- Held-out Spearman, leave one set out, full model versus a cost + type + aspect baseline:
  - JTL: 0.30 versus 0.13
  - LOF: 0.42 versus 0.21
  - SEC: 0.29 versus 0.16
  - LAW: 0.32 versus 0.00
  - ASH: 0.55 versus 0.28
- With rarity fixed effects in both, the full model scores 0.30, 0.42, 0.28, 0.35 and 0.57. The baseline becomes 0.17, 0.33, 0.22, 0.17 and 0.47. Rarity carries real signal (Legendary plus 1.17 log points), but the features still add on top.
- In-sample Spearman of the score with inclusion is 0.500 with T and 0.493 without.
- Components with intervals clear of zero, in log inclusion per unit of feature:
  - Unique 1.48
  - Ambush 1.80
  - Shielded 1.37
  - Raid 1.23
  - Sentinel 1.07
  - Plot 0.90
  - Take control 1.99
  - Defeat a unit 1.36
  - Opponent discards 1.30
  - Variable damage 1.14
  - Extra attack 1.01
  - Space 0.51
  - Base damage 0.50 per point
  - Unit damage 0.37 per point
  - Upgrade stats 0.36 per point
  - Power surplus 0.23 per point
  - Granting a keyword to another unit minus 0.69
- Designer prices and play value disagree sharply. Shielded, Ambush and Sentinel are priced as costs by designers, yet they are among the strongest play predictors. Overwhelm and Grit are free or cheap for designers and do not lift play (Overwhelm minus 0.47 [minus 1.03, 0.09]). Card draw gets no play lift (0.01 [minus 0.52, 0.53]).

### TCGplayer price as a weak signal

- The price fixed-effects regression has R squared 0.757, which is almost all rarity. V0's coefficient is minus 0.029 [minus 0.059, 0.001].
- Cost dummies in that fit are small: cost 3 0.11 [0.02, 0.20], cost 6 minus 0.11 [minus 0.24, 0.01] (`score.mjs`).
- Price is not usable for calibrating either V0 or T beyond confirming the sign at cost 6 and above.

## Playability term T(cost): does the rubric value cheaper cards more?

### Current behaviour without T

The efficiency readout V0 neutralises cost by construction. The curve already demands more stats per resource from cheap cards: the intercept of 1.72 means a 1-cost vanilla unit expects 3.7 stats (3.7 per resource), while a 6-cost unit expects 13.5 (2.25 per resource). An on-curve 2-cost unit and an on-curve 6-cost unit both score about 0, so V0 carries no tempo or flexibility premium.

### Why SWU should have one

- Tempo and initiative: each player starts with 2 resources and may add 1 per regroup phase (`/Volumes/Local Files/Projects/swu/complete_rules_digest.md:293, 309-310`). A 6-cost card is not castable before round 5 without ramp. A cheap card is on the board, or available as a response, from round 1. Rounds end only when both players pass, and taking the initiative passes the rest of the phase (`complete_rules_digest.md:141-142, 305`). Cheap cards let a player act twice before passing or claiming initiative.
- Flexibility: with 2 draws and 1 resource per round (`complete_rules_digest.md:309-310`), cheap cards pair two-per-turn and fit around leader abilities that cost resources.
- Counter-pressure: expensive cards have higher ceilings. Smuggle, Plot, Credits, ramp and cost reduction move expensive cards earlier, so their T should be partly refunded. That refund is not fitted (judgment).

### Empirical calibration

Source: `play-model.mjs`. Cost dummies are fitted against cost 2, with all content features, set and aspect fixed effects held fixed. Values are log inclusion:

- cost 0 (rare, dropped where support is under 5)
- cost 1: minus 0.33 [minus 0.74, 0.08], n=152
- cost 3: minus 0.20 [minus 0.57, 0.17], n=239
- cost 4: minus 0.15 [minus 0.56, 0.27], n=163
- cost 5: minus 0.38 [minus 0.81, 0.06], n=133
- cost 6: minus 0.80 [minus 1.30, minus 0.30], n=93
- cost 7+: minus 0.85 [minus 1.44, minus 0.26], n=96

With rarity fixed effects the values are cost 5 minus 0.46 [minus 0.90, minus 0.02], cost 6 minus 0.92, and cost 7+ minus 1.13.

The shape is a plateau from cost 1 to cost 4, a drop at 5, and a cliff at 6 and above. Cost 2 is the peak. There is no evidence that 1-cost cards beat 2-cost cards at equal content.

- In stat points, divide by the per-stat-point play value. Using the mean of the power and HP surplus coefficients (0.156): cost 6 is minus 5.1 and cost 7+ minus 5.5. Seeded bootstrap 95 percent intervals are [minus 30.2, minus 1.25] and [minus 24.0, minus 1.14]. Cost 1 to 5 run minus 0.9 to minus 2.4, with intervals spanning zero. The conversion is unstable because the HP play coefficient is near zero. Report T in log-inclusion units. If stat points are needed, convert with the power coefficient (0.229): cost 6 is about minus 3.5 power points (judgment on which divisor).
- Rubric default for T, in log-inclusion units relative to cost 2: cost 0 to 4: 0; cost 5: minus 0.4; cost 6: minus 0.8; cost 7+: minus 0.85. Values at 1, 3 and 4 are set to 0 because their intervals span 0 (judgment on the zeroing).
- Data that would sharpen it: per-deck lists with turn-played counts (SWU Stats `timesPlayed` is in the capture, but its per-turn field `turnResults` is only in the server's submission payload, `SubmitGameResult.php:452`). That would separate "included" from "cast on curve".

### Scores with and without T (5 JTL+ examples)

Source: `play-scores.w29-55.norarity.json` from `play-model.mjs`. Units are "play points", meaning the inclusion effect of one average stat point. They are rank-meaningful only, and the scale is unstable (see above). The example at each cost is the most-included Common unit.

- Imperial Door Technician (LAW `07010097`), cost 1: without T 7.88, with T 5.77; inclusion 8.01 percent.
- Outer Rim Constable (SEC `06010163`), cost 2: without T 7.73, with T 7.73; inclusion 24.03 percent.
- Droid Missile Platform (JTL `04010162`), cost 3: without T 17.41, with T 16.12; inclusion 11.12 percent.
- MC30 Assault Frigate (JTL `04010118`), cost 5: without T 7.46, with T 5.04; inclusion 3.96 percent.
- Fleet Interdictor (JTL `04010040`), cost 7: without T 20.51, with T 15.04; inclusion 1.34 percent.

These use the raw fitted T including cost 1, before the zeroing default. Fleet Interdictor shows the point: its content scores high, but T pulls it down toward its low play rate. T improves in-sample rank correlation only slightly (0.493 to 0.500), because the content features already carry most of the signal.

## The rubric (deterministic)

### Unit, event and upgrade score

Score = sum over components of (fitted weight x feature), computed per card. It excludes the set and aspect-combination fixed effects, which are context.

- Stat components (units): power surplus and HP surplus against the vanilla curve M0: E_power = 0.72 + 0.99c minus 0.62 x space + 0.14 x unique, and E_hp = 1.00 + 0.98c + 0.24 x space + 1.56 x unique. Upgrades use upgradePower + upgradeHp.
- Cost component: T(cost) as above.
- Type, space and unique indicators.
- Keyword components: printed keyword = 1, conditional = 0.5 (judgment).
- Effect components: the `EFFECTS` categories with magnitudes capped at 8.
- Timing components: the `TIMINGS` classes.
- Unclassified sentences: count reported, weight 0. Note that `play-model.mjs` currently fits `unmatchedLines` as a regressor (0.40 [minus 0.02, 0.82]); the scoring path must zero it.
- Weights: the `play-model.mjs` coefficients in this document, refit from the pinned SWU Stats capture when the capture is refreshed.
- Outputs per card:
  - the play score with T and without T
  - the efficiency readout V0 (stat points against design norm, for transparency)
  - a percentile within type and within the JTL+ population
  - flags: `unclassified_sentences`, `conditional_keywords`, `new_mechanic_no_play_data` (HMW-only features: Fortify, Beast, Weakness)

### Leaders

- Unit side: leader-unit power + HP = 0.49 + 1.68 x deploy threshold, minus 1.63 [minus 2.32, minus 0.94] for a space leader. n=157, R squared 0.674 (`fit-other.mjs` L1).
- Mean stats by threshold: 4: 7.1 (n=14); 5: 9.0 (n=64); 6: 10.4 (n=57); 7: 12.6 (n=19).
- The residual is the leader-unit efficiency. It correlates 0.26 [0.07, 0.43] with leader inclusion (`score.mjs`).
- Leader-side ability: the `EFFECTS` features on `text` plus the Action cost parsed from "Action [ … ]". Observed costs: "Exhaust" 59, "1 resource, Exhaust" 33, "Exhaust, use the Force" 9, plus rarer composites (`fit-other.mjs`).
- Leaders are ranked only against leaders, by their own inclusion-calibrated model when weighted. With 104 JTL+ leaders, fit only the threshold, stats residual, and 5 to 8 broadest effect classes (judgment).
- Four JTL+ leaders have no numeric threshold (Avar Kriss, LAW Chewbacca, ASH Bo-Katan Kryze, ASH Grogu). Their deploy is flagged as unclassified.

### Bases

- Bases with no ability have 30 HP (n=60, all Common). An ability costs 2.87 [2.21, 3.53] HP. Rarity adds nothing measurable: minus 0.60 [minus 2.06, 0.86] (`fit-other.mjs` B1).
- The base score is HP minus 30 plus 2.87 x hasAbility. Its Spearman with base inclusion is 0.43 [0.21, 0.61]. Abilities are classified by `EFFECTS` (42 percent sentence coverage, the weakest field).
- Bases are ranked only against bases.

### Conditions

Conditional clauses ("If you control …", "While …", trait or base-trait gates) are detected by the `TIMINGS.constant` and `selfKeywordConditional` patterns. Each condition halves the clause's component value (judgment). It is never resolved against a deck, because the rubric is deck-agnostic.

## Deterministic features: regexes and coverage

All patterns are in `features.mjs` and quoted verbatim here, so the parallel text-extraction work can build on them.

- Preprocessing (`clean`):
  - Replace `[‑–−]` with "-".
  - Strip `^Attach to [^.\n]*\.\s*` (upgrade restrictions).
  - Strip parenthesised reminder text `\([^)]*\)`.
  - Split ability lines on newlines.
- Shared fragment `UNIT` = `(?:(?:an?|another|each|up to \w+|\d+|that|the|this|target)\s+)?(?:[\w-]+\s+){0,4}?units?`
- `EFFECTS`, all case-insensitive. The magnitude is the captured number:
  - dmgUnit: `deal (\d+|X) damage to ${UNIT}` (X counts as 3, judgment)
  - dmgVariable: `deals? damage (?:to [\w ]+ )?equal to|deal damage to (?:a|an|another) [\w ]*?unit equal to`
  - taxOpponent: `(?:an opponent|enemy|opponents?) [\w ]*?costs? \[?\d+ resources?\]? more`
  - dmgEach: `deal (\d+) damage to each`
  - dmgBase: `deal (\d+) (?:indirect )?damage to (?:a|each|the|an enemy|your opponent's|their|that) (?:base|defending player|player|opponent)`
  - upgradeRemoval: `defeat (?:an?|each|that|up to \w+) (?:[\w-]+ ){0,2}?upgrades?`
  - recursion: `(?:from your discard pile (?:to|into) your hand|return (?:a|an|that) [^.]*? from your discard pile)`
  - smoothing: `look at the top (\d+|X) cards?`
  - defeatUnit: `defeat ${UNIT}(?! token)`
  - bounce: `return (?:an?|another|each|that|up to \w+) (?:[\w-]+ ){0,4}?(?:unit|upgrade|card)s? (?:[\w ]+ )?to (?:its|their) owner's hand`
  - capture: `\bcaptures?\b`
  - takeControl: `take control of`
  - debuff: `gets? -(\d+)\/-(\d+)` (magnitude = sum)
  - draw: `\bdraws? (a|an|one|two|three|\d+) cards?`
  - search: `search the top (\d+|X) cards?`
  - discardOpp: `(?:(?:opponent|each player|they) discards?|discard (?:a|an|\d+) [\w ]*?from (?:it|their hand|an opponent's hand))`
  - heal: `heal (\d+|all|up to \d+) damage` ("all" counts as 5, judgment)
  - exhaust: `exhaust ${UNIT}`
  - ready: `\bready (?:an?|another|each|that|this|up to \w+|a friendly) (?:[\w-]+ ){0,3}?(?:unit|resource|leader)`
  - extraAttack: `attack with (?:a|an|another|that|up to \w+) (?:[\w-]+ ){0,3}?units?`
  - buffTemp: `(?:gets?|give (?:a|an|another|each) (?:[\w-]+ ){0,3}?units?) \+(\d+)\/\+(\d+) for this (?:phase|attack)`
  - buffStatic: `gets? \+(\d+)\/\+(\d+)(?! for this)`
  - giveShield: `give (a|an|\d+|two|three) Shield tokens?`
  - giveExperience: `give (a|an|\d+|two|three|X) Experience tokens?`
  - giveAdvantage: `give (a|an|\d+|two|three|X) Advantage tokens?`
  - giveWeakness: `give (a|an|\d+|two|three|X) Weakness tokens?`
  - tokenUnit: `create (a|an|\d+|two|three|X) (Battle Droid|Clone Trooper|TIE Fighter|X-Wing|Spy|Mandalorian|Beast) tokens?`. The magnitude is the count times token stats: Battle Droid 2, Clone Trooper 4, TIE Fighter 2, X-Wing 4, Spy 2, Mandalorian 5 (2/2 plus Shield as 1, judgment), Beast 6.
  - credit: `create (a|an|\d+|two|three|X) Credit tokens?`
  - forceGain: `(?:the Force is with you|create (?:a|the) Force token|you gain the Force)`
  - forceUse: `use the Force`
  - ramp: `(?:into play as a resource|put (?:the top card of your deck|a card from your hand) .*?as a resource|gain (?:a|\d+) resources?)`
  - costReduce: `(?:costs? (\d+) (?:resources? )?less|pay (\d+) (?:resources? )?less|ignore (?:its|the|their) aspect penalt)`
  - playFromElsewhere: `play (?:a|an|that|it|the) (?:[\w-]+ ){0,4}?(?:from your discard pile|from (?:the top of )?your deck|from your resources)|for free`
  - protect: `(?:can't be attacked|can't be (?:defeated|damaged)|prevent (?:all|that|the|\d+) damage)`
  - grantKeyword: `(?:(?:units?|it|they) gains? (?:Sentinel|Ambush|Raid|Overwhelm|Saboteur|Restore|Grit|Hidden|Shielded)|gains? (?:…same list…) for|give (?:a|an|another|each) (?:[\w-]+ ){0,3}?units? (?:Sentinel|Ambush|Raid \d+|Overwhelm|Saboteur|Restore \d+|Grit|Hidden|Shielded))`
  - selfKeywordConditional: `(?:this unit|she|he|it) gains? (?:Sentinel|Ambush|Raid \d+|Overwhelm|Saboteur|Restore \d+|Grit|Hidden|Shielded)`
  - drawback: `(?:this unit can't (?:attack|ready)|can't attack bases|enters play exhausted|deal \d+ damage to (?:your|your own|this|friendly) (?:base|unit)|defeat a friendly|return a friendly|discard (?:a|\d+) cards? from your hand|you lose|opponent (?:draws|creates|may)|give (?:your opponent|an opponent) )`
- `TIMINGS`, anchored at the start of a line after keyword prefixes are stripped:
  - whenPlayed: `^(?:When Played(?: as a unit| as an upgrade)?|When played using Smuggle)(?:\/On Attack)?:`
  - onAttack: `^(?:When Played\/)?On Attack:`
  - whenDefeated: `^When Defeated:`
  - action: `^(?:Epic )?Action ?(?:\[[^\]]*\])?:`
  - whenAttackEnds: `^When Attack Ends:`
  - triggered: `^(?:When|Whenever|After|The first time|Each time)\b`
  - constant: `^(?:While|Each|Friendly|Enemy|Other|This unit|Units|You may|Attached)`
  - Otherwise the line is "constant".
- `KEYWORD_PARAMS`: Raid `\bRaid (\d+)`, Restore `\bRestore (\d+)`, Exploit `\bExploit (\d+)`, Smuggle `\bSmuggle \[(\d+)`, Piloting `\bPiloting \[(\d+)`. The keyword list itself comes from the structured `keywords` relation. "Printed" is decided by whether a cleaned line starts with the keyword name.
- Leader deploy threshold: `control\s+(\d+)\s+or\s+more\s+resources` on `epicAction` (`fit-other.mjs`).
- Coverage over JTL+ cards (`coverage.mjs`). A sentence counts as classified when an `EFFECTS` pattern matches, or when it is a pure keyword line or deploy boilerplate.
  - Overall: 2,238 of 2,894 sentences (77.3 percent). Excluding pure keyword lines and deploy boilerplate: 1,553 of 2,209 (70.3 percent).
  - Unit text: 82.0 percent of 1,620.
  - Event text: 72.5 percent of 473.
  - Upgrade text: 72.1 percent of 165.
  - Leader text: 64.6 percent of 178.
  - Leader `deployBox`: 71.5 percent of 207.
  - Leader `epicAction`: 79.7 percent of 128.
  - Base text: 42.4 percent of 33.
  - 495 of 1,597 cards have at least one unclassified sentence. Each gets the `unclassified_sentences` flag and 0 for that sentence.
- Known unclassified families, from samples: deck look-and-arrange ("Look at the top 2 cards … put … on the bottom"), copy effects (Clone), cost-halving (The Starhawk), stat replacement ("printed power is considered to be 5"), damage amplification (Vigil), naming cards (Transmission Jamming), modal choices ("An opponent chooses one"), additional costs ("As an additional cost …"), trait grants ("gains the Underworld trait"), disclose costs, and self-discard-then-return (Kuiil). Each needs its own pattern. None needs a model.

## What is no longer in the rubric

Round 1 routed conditions, multi-clause abilities, synergy text and new mechanics to "manual or model-assisted tagging". That route is removed (owner requirement: fully deterministic scoring). Every such clause is either matched by a listed pattern or counted as unclassified with value 0. Rarity, traits and printing variant remain excluded from the score. Rarity appears only as an optional control in validation.

## Open questions

- HMW has no play data yet. Fortify, Beast and Weakness values are designer prices or judgment until about 8 weeks of SWU Stats data exist. Refit then, and check the HMW held-out Spearman.
- Unit effects are not priced by magnitude in designer stats. Should the play model use magnitudes everywhere (it currently mixes magnitudes and indicators), and should it be regularised (ridge) given 88 parameters on 1,172 cards? (judgment)
- Inclusion is confounded by leader popularity and by what is good in the current meta. Aspect-combination fixed effects absorb part of it. A per-leader inclusion denominator would need the deck-level `deckstats` data, which the public card endpoint does not expose.
- T(cost) in stat points is unstable, because HP surplus has almost no play value. Should the rubric publish T in log-inclusion units only?
- Conditional halving and the "X counts as 3" and "all heal counts as 5" magnitudes are judgment calls with no fit behind them.
- Twin Suns and Eternal formats are available in the same endpoint. Should a card's score be per format?
- Leaders and bases each need their own small play model. The fits above use only stats or HP residuals.
- Draft or limited ratings: none exist publicly for LAW, ASH or HMW as far as this search found. A Limited-specific score would need SWU Stats' Padawan format, or event data from Melee.

## Reproduction

Commands, from the scripts directory:

```
node load.mjs
node fit-units.mjs all
node fit-units.mjs jtl
node fit-effects.mjs all
node fit-effects.mjs jtl
node fit-other.mjs all
node fit-other.mjs jtl
node score.mjs w29-55
node play-model.mjs w29-55 norarity
node play-model.mjs w29-55 rarity
node coverage.mjs
```

Official articles were fetched as JSON through `https://admin.starwarsunlimited.com/api/articles?filters[slug][$eq]=<slug>&populate=*`, for these slugs: homeworlds, insights-to-ashes, aspects-and-credits, welcome-to-ashes, defend-and-destroy, disclosing-plots, a-lawless-time, lawless-insights. Text extracts are in `articles/`.

Web searches this round:
- "Star Wars Unlimited Homeworlds draft limited card ratings tier list"
- "Star Wars Unlimited "Ashes of the Empire" OR "A Lawless Time" limited draft set review grades every card"
- "SWU limited pick order ratings spreadsheet Star Wars Unlimited draft "pick order" 2026"

Fetches this round:
- ok: https://swustats.net/TCGEngine/Stats/CardMetaStats.php (page and its JSON API, 3 windows)
- ok: https://starwarsunlimited.gg/ (redirect from https://onepiece.gg/star-wars-unlimited)
- partial: https://swustats.net/TCGEngine/SharedUI/MainMenu.php (no provenance in the first 100,000 characters)
- ok via `gh api`: TCGEngine `Stats/CardMetaStatsAPI.php` and `APIs/SubmitGameResult.php`

Round 1 failures (Garbage Rollers DNS, mtg.wiki 403, swucompetitivehub DNS, swudb tagline only) were not retried.

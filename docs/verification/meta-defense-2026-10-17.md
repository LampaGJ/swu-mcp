---
type: report
status: active
related: ["#25", "#26"]
review_by: 2027-01-17
---

# Meta defense benchmark: method only (local run, numbers not published)

## TL;DR

- `pnpm bench:meta-defense` checks whether the cards `meta_answers` suggests show up more in sides that beat an archetype's leader than other eligible cards do.
- It runs on private Karabast game data. Under decision D22 (owner ruling 2026-10-17), Karabast-derived numbers, aggregates included, never ship in the data release, in tool output or in a committed doc. So this page gives the method only.
- The report it writes stays local: `data/runs/<date>/verify/meta-defense.json` and `meta-defense.md`, both git-ignored.
- What the tools ship instead is swumetastats tournament evidence (melee.gg events): leader and base-aspect matchups for archetype strength, and deck-level evidence for answer cards. See the README tool lines.

## Method

- Archetypes: the largest tournament archetypes of the meta window (`meta/archetypes.json`). The answers to a leader are the union of the counter-table answers (`data/counters.json`) to that leader's archetypes.
- Units: every side that faced one of those leaders and has a known result. A card is eligible on a side whose leader and base cover its aspect icons, and only if the source shows the card at all.
- Per (leader, card): log ratio = ln((a + 0.5) / (winners + 1)) - ln((b + 0.5) / (losers + 1)), with a and b the winning and losing sides that show the card. A value is kept when both groups hold at least 20 eligible sides and the card shows at least 5 times.
- Controls: every other eligible card against the same leader. Intervals: seeded percentile bootstrap over distinct cards, because a card's values against every leader move together.
- Sources: a tournament match-results extract with both decklists (`--results`, #26) when one exists, and the private human-game extract under `data/originals/karabast/`. The benchmark reads that extract itself; the meta step never does (`tests/meta/no-karabast.test.ts`).

## Why it cannot run on public data yet

swumetastats publishes leader and base matchups and per-deck whole-event match records, but no per-match pairings (checked against https://swumetastats.com/openapi.json on 2026-10-17). Without the opponent of each match, no public source shows which cards a side played against which archetype.

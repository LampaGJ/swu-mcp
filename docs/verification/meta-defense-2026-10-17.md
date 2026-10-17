---
type: report
status: active
related: ["#25", "#26"]
review_by: 2027-01-17
---

# Meta defense benchmark: method only (local run, numbers not published)

## TL;DR

- `pnpm bench:meta-defense` checks whether the cards `meta_answers` suggests show up more in sides that beat an archetype's leader than other eligible cards do.
- Tournament match results with decklists, the primary outcome source, are not captured yet (#26): the swumetastats matchups give wins per leader and base pair but no card lists, so they cannot show which cards a winning side played.
- The benchmark's numbers are not published on this page; its report stays local.
- Read any result as association, not effect: a winning side has more turns to show its cards, and players who include answers may simply be stronger players.

## Method

- Archetypes: the largest tournament archetypes of the meta window (`meta/archetypes.json`). The answers to a leader are the union of the counter-table answers (`data/counters.json`) to that leader's archetypes.
- Units: every side that faced one of those leaders and has a known result. A card is eligible on a side whose leader and base cover its aspect icons, and only if the source shows the card at all.
- Per (leader, card): log ratio = ln((a + 0.5) / (winners + 1)) - ln((b + 0.5) / (losers + 1)), with a and b the winning and losing sides that show the card. A value is kept when both groups hold at least 20 eligible sides and the card shows at least 5 times.
- Controls: every other eligible card against the same leader. Intervals: seeded percentile bootstrap over distinct cards, because a card's values against every leader move together.

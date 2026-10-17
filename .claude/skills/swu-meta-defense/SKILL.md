---
name: swu-meta-defense
description: Find what a Star Wars: Unlimited Premier deck must include to beat the current top archetypes. Use when the user asks what the meta is, which decks are winning, what to tech against a leader or archetype, or which cards in their aspects answer the decks they will face. Not for building a deck from nothing (use the build_deck_for_leader prompt) or for rules questions (use swu-rules).
---

# SWU meta defense

Answer only from what the swu-mcp meta tools return. Never name a "top deck" or a win rate from memory.

## Steps

1. Resolve the user's leader, base and any listed cards with `resolve_card_name`. Call `data_version` once.
2. Call `meta_archetypes`. Report the largest archetypes with share, top-8 share and the date window. Say which population the list rests on: tournament decklists (melee.gg events, weighted by placement) are primary; community lists are a separate view or a labelled fallback.
3. Call `meta_threats` on the three to five archetypes that matter most. Name each one's key units (cost, power, HP, arena) and the threats it poses (for example Sentinel wall, go-wide, space-heavy).
4. Call `meta_answers` with the leader and base, or the decklist. Keep the penalty-free answers unless the user accepts an aspect penalty.
5. Check every answer you keep. Each one is a candidate: read its clause evidence; confirm with `card_features` or `get_card`; settle rules doubts with `keyword_rules` or `card_rulings`. Drop any answer the text does not support.
6. Propose swaps (cards out, answers in). Run `deck_audit` on the changed list, then `deck_legality_check` on the final list.

## Rules for the answer

- Name the source of every number. Archetype shares come from tournament decklists. Every win rate comes from swumetastats (melee.gg tournaments): leader and base-aspect matchup records for archetype strength, and deck evidence for answer cards.
- Give each win rate with its n, its 95% interval and its window. Never quote a rate without n. A rate is wins over decisive matches; draws are left out.
- Deck evidence compares comparable decks with the card against those without it. Opponents are unknown, so never present it as a win rate against an archetype, and call it association, not effect.
- Coverage is the share of the meta an answer reaches, not a win probability.
- If a meta tool errors (for example a data package without meta/), say which tool failed and stop; do not reconstruct the meta from memory.
- Keep it short: the archetypes, the threats, the swaps with evidence, the audit result, the data version.

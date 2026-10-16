---
type: spec
status: draft
related: ["#3", "#5", "#6"]
review_by: 2027-01-16
---

# swu-mcp tool catalogue: value chain convergence

Convergence phase of a Value Chain Analysis (Score, Cluster, Deepen). No new players or tools are generated here. Everything below comes from the five frozen blind branches, the draft catalogue (#5), the fungibility scope (#3), the rules scope (#6), and the four shipped tools. Branch tags: J = jtbd, F = finance, M = mcp, D = data, P = player.

## TL;DR

The catalogue reduces 360 listed tool lines (the branch headers say 352) to 112 distinct tools, resources and prompts. The one-line mission: ship the cheap, deterministic, differentiated tools first (aspect cover, rulings, prices, play stats, rubric, pairings, trios, fungibility, rules), and park anything that needs data swu-mcp does not hold.

Counts per bucket (distinct items, each exactly once):

- P0 (next build): 14
- P1: 35
- P2: 12
- Parked: 26
- Rejected: 25
- Total: 112

Of the P1 items, 4 are the shipped tools (maintenance and extension only), 4 are MCP resources and 2 are MCP prompts. Another 4 resources or prompts sit in P2.

Top 10 P0 tools, in build-value order:

1. fungible_substitutes
2. find_pairings
3. score_card
4. rank_cards
5. find_trios
6. aspect_cover
7. rules_search
8. card_rulings
9. get_rule
10. data_version

The other four P0 tools are card_features, find_by_effect, card_price and play_stats.

Top 3 players by leverage: (1) AI assistants and MCP hosts, (2) the official publisher data estate, (3) the competitive deckbuilder.

Assumptions used for tiering:

- Tier A means computable now from data swu-mcp already ships or from pinned inputs named as existing in context.md (card list, rulings field, TCGCSV prices as conformed by mault, SWU Stats per-card capture).
- Tier B means the tool waits on a planned transform: #1 scorer, #2 embeddings, #3 pairings, trios and fungibility, #6 rules.
- Tier C means new data is needed and the missing data is named.
- Tier X means out of scope (not read-only, a model in the scoring path, or against the owner constraints in context.md).
- The SWU Stats capture is per card (inclusion and wins). Leader-level, matchup-level and dated-slice views are therefore tier C.
- Price history needs accumulated dated snapshots, which context.md does not say exist. It is tier C.

## Value chain map

Scores are relevance / leverage, each 0 to 10. Relevance means how much the player matters to what swu-mcp delivers. Leverage means how much the player can make or break a move. Duplicate players across branches are merged; the count of raw lines was 217 (headers say 208), reduced to the 50 grouped entries below.

### Upstream

Data owners:

- Official card list API and the mault byte-exact raw cache — 10/9. Root of every card fact. One host, no contract. (J D F M P)
- Comprehensive Rules PDF v8.0 and per-card rulings (603 dated) — 8/7. No stable latest URL; the filename carries a hash. (J F D M P)
- Official articles API — 6/6. Only carrier of bans and suspensions today. Not ingested yet. (J F D M P)
- Publisher and licensors (Fantasy Flight Games, Asmodee, Lucasfilm, Disney) — 6/8. Owns card text, image rights and data terms. Regulator-like. Trap: regulator. (J F D M P)
- Organized Play ban and restricted committee, format designers (Premier, Eternal, Twin Suns) — 8/7. Decides legality; changes arrive overnight. Trap: regulator. (J F D P)
- Designers and dev diaries (keyword prices) — 5/4. Seed of rubric weights. (J D P)
- Future set reveals and spoilers — 6/6. New cards invalidate curated-table rows (the data cliff). (J D P)

Data suppliers:

- SWU Stats, fed by Karabast and Petranaki online games — 9/8. Only play data. Also a competitor and a single source. Trap: online meta is not paper meta. (J F M D P)
- TCGCSV and TCGplayer — 8/6. US-only price signal. Trap: US-centric. (J F D M P)
- mault conformance pipeline (corrections, quarantine) — 8/7. Cleans 8,882 priced printings. Owner-controlled. (J D F)
- Tournament results sites and deck-list platforms (Melee, Limitless, Longshanks) — 6/5. Not held; tier C for anything that needs deck lists. (J F M P)
- Other marketplaces and stores (Cardmarket, eBay, Card Kingdom-style buylists) — 4/3. Trap: US-centric blind spot; the rest of the world prices off Cardmarket. (J F M P)
- Pull-rate trackers, grading pop reports, price guides — 3/2. No source held. (F)
- Nomic embedding model — 6/4. Local, replaceable. (J F M D P)
- MCP SDK and the MCP specification (resources, prompts, annotations, structured output) — 6/5. Sets what a server can express. Regulator-like standard. (M)
- Official image CDN — 3/2. URL stems only. (J D P M)
- Hosting and distribution (GitHub, npm, uvx, Docker) — 3/3. P notes the host going down before a regional. (M P)

### Focal (swu-mcp capabilities owned)

- Text grammar and curated offers/wants table (with friendly/enemy polarity) — 9/8. The root of pairings, trios and fungibility. Hand-curated, so it is the maintainer bottleneck.
- Pairing and trio graph — 9/8. Owner scope: trios, especially low cost.
- Fungibility classes and cross-aspect substitute sets — 9/8. The newest and least-copied asset.
- Rubric scorer (cost curve 1.72 + 1.96 x cost, designer and play-calibrated weights) — 9/7. Trap: weights are fitted to SWU Stats wins, so a score-versus-play residual is partly circular.
- Aspect cover calculator (leader up to 2 aspects, base 1, +2 resources per uncovered icon) — 8/6. Tier A and cheap.
- Embeddings, similar and kin, 32 role clusters — 6/5.
- Rules section tree and keyword linker (#6) — 7/5.
- Pinned data-version manifest and replay records — 7/6. Makes every answer citable.
- Logical-card folder (1,609 Premier-legal cards) — 8/6. Trap: every folded card is legal by construction, so legality answers need the ban ledger to mean anything.

### Downstream

Channel and constraints:

- AI assistants and MCP hosts (Claude Code, Claude Desktop, claude.ai connectors, Cursor, ChatGPT, Gemini CLI, voice, local-model hosts) — 10/10. Every call passes through them. (J F M D P)
- Context window, token cost and host tool-count limits — 9/8. Output size and tool count decide whether a tool is ever chosen. Constraint. (M)
- MCP registries, directories, gateways and security scanners — 6/6. Discovery and tool-description auditing (tool poisoning checks). (J F M)
- Evaluation harnesses (MCP Inspector, evals) — 4/3. (M)

Consumers:

- Competitive deckbuilder — 9/8. Wants chains completed, aspect-feasible fills, play data. (J D P)
- mault sorter and collection tracker — 9/7. Owner's own product; holds the collection and bin rules. Privacy: collection data stays in mault. (J F M D P)
- Casual or new player, budget player, kitchen-table player — 7/5. (J F D P)
- Collector and trader — 7/5. (J F D P)
- Rules asker or judge — 7/5. (J D M P)
- Content creator, caster, podcast host, press — 7/6. Amplifier: their claims reach many players. (J F M D P)
- Tournament organiser and local game store — 5/4. (J F M P)
- Insurers and appraisers, parents and gift buyers — 3/2. Low fit; privacy for collection values. (J F)
- Fan translators — 2/1. Trap: non-English blind spot; no multilingual data held. (P)

### Substitutes, competitors, complementors, adversaries

- LLM training memory — 8/8. The ignored substitute: the assistant answers from stale knowledge unless a tool is clearly better. Trap: ignored substitute. (J D)
- Generic web search and fetch MCP servers — 7/7. The assistant can browse the official site. Trap: ignored substitute. (M)
- SWUDB, SWU-Base, Karabast deck tools and other deckbuilder sites — 8/7. Own deck lists, filters and prices. Competitor and complementor. (J F M D P)
- Tier lists, spreadsheets, Discord experts, local-store regulars, pencil and gut — 6/5. Human opinion in place of a deterministic score. Trap: ignored substitute. (J D P)
- Other game MCP servers (Scryfall, Pokemon) and other SWU MCP servers — 5/5. Set tool-shape expectations. (J F M)
- Collection and portfolio apps (TCGplayer app, ManaBox, Collectr and similar) — 5/4. Already hold collection value features. (F)
- Complementor MCPs (filesystem, spreadsheets, memory, planner, code execution, Discord) — 5/4. Code execution makes pure-arithmetic tools redundant. (M)
- Local game stores, distributors, big-box retail — 5/4. Where events, trades and sealed live. (J F P)
- Grading firms, proxy and print services, sleeve makers — 3/2. (J F P)
- Scalpers, counterfeiters, case breakers — 3/3. Adversaries; they distort price and authenticity. (J F)
- Other TCG ecosystems — 2/2. (F)
- Consumer-protection, ToS, tax and gambling regulators — 3/4. Launch-stage concern only (ToS and data-term risk applies at launch; noted, proceeding). (F P M)
- Payment and shipping providers, trade-show organisers — 1/1. (F)

### Deepened: the three highest-leverage players

1. AI assistants and MCP hosts (10/10)
   - Power source: they are the only caller. They choose whether a tool runs, read tool descriptions to choose, and spend a finite context window and token budget on every answer. Host tool-count and description-length limits mean 112 items would dilute selection.
   - Implication for swu-mcp: keep the callable tool count small by merging (this catalogue merged 360 lines into 112 items, and only 14 are P0). Make every output compact and citeable (data version in every response). Put static reference material in resources and workflows in prompts. The substitute to beat is the assistant's own memory, so lead with data it cannot know: pinned scores, pairings, fungibility, aspect cover, rulings with dates.
2. Official publisher data estate: card list API, rules PDF, rulings, articles, ban committee (9)
   - Power source: sole source of truth for card text and legality, controlling cadence and format. It can change legality overnight, rotate sets, or change data terms. There is no contract or stable URL.
   - Implication: every legality answer needs the ban ledger (tier C, from the articles API) or it is false assurance, because the logical-card folder makes every card look legal. Pin everything by hash and cite versions. New sets break curated rows, so tools that rest on the curated table must report coverage and caveats. Launch-stage data-term risk is noted only.
3. Competitive deckbuilder (8)
   - Power source: the demand anchor. This is the consumer who gains most from chains, trios and cross-aspect fungibility, and also the one with the most alternatives (SWUDB, spreadsheets, Discord). Their willingness to trust a number decides whether the scorer and graph matter.
   - Implication: the first-order differentiators are fungible_substitutes, find_pairings and find_trios with per-slot alternatives, aspect_cover, and score_card with a component breakdown. Matchup and leader-level stats are what this consumer asks for next, and they are tier C (Parked) until a leader-level capture exists.

Watch item: SWU Stats (9/8) is both supplier and competitor and the only play-data source. Single-source dependency; a change or block removes play_stats and weakens the play-calibrated scorer.

## Tool catalogue by job cluster

Only P0, P1 and P2 tools appear here, each with the details owed. Parked and Rejected tools are in the next section. Value is consumer value 0 to 10. "Serves" is the highest-leverage player the tool serves.

### Cards and search

- P1 `get_card` (shipped; merged J get_card, J get_printing partly, J bin_attributes) [J M D]
  - Purpose: one logical card in full by cardKey or exact title. Shipped; maintenance only, add a `fields` projection and a `format` param (json, toon, line) across tools.
  - In: cardKey string, or title string plus optional subtitle string, optional fields string array.
  - Out: card object with printings summary and dataVersion.
  - Source: logical-card folder over the official card list. Tier A. V9. Serves: AI assistants.
- P1 `search_cards` (shipped; merged J search_cards_text, J search_by_filters, M search_cards_page, M count_cards, D facet_algebra) [J M D]
  - Purpose: substring and filter search. Shipped; extend with cursor, `countOnly` and a price and cost range.
  - In: query string, type, aspect, trait, keyword, set strings, maxCost number, limit number, cursor string, countOnly boolean.
  - Out: total, nextCursor, rows of summary card objects.
  - Source: logical-card folder. Tier A. V9. Serves: AI assistants.
- P1 `list_facet` (shipped; merged D facet_counts) [D]
  - Purpose: all values of a facet with counts and definition. Shipped.
  - In: facet string. Out: values with count and definition. Tier A. V6. Serves: AI assistants.
- P1 `cards_by_facet` (shipped; merged F promo_scarcity) [F]
  - Purpose: cards in one facet value (includes variant and expansion). Shipped.
  - In: facet string, value string, limit number. Out: summary rows. Tier A. V6. Serves: AI assistants.
- P1 `get_cards_batch` (merged M card_fields_projection, M play_stats_batch use for cards) [M]
  - Purpose: many cards by id in one call, with field projection, to cut round trips and context.
  - In: ids string array, fields string array.
  - Out: array of projected card objects.
  - Source: logical-card folder. Tier A. V7. Serves: AI assistants (context window).
  - Rationale: M names the context window as a constraint; batch is the cheapest answer to it.
- P1 `resolve_card_name` (merged M suggest_cards, J scan_match_candidates) [M J]
  - Purpose: fuzzy name or partial text to ranked card candidates, with distance.
  - In: text string, limit number. Out: array of cardKey, title, subtitle, match score.
  - Source: deterministic string similarity over titles. Tier A. V7. Serves: AI assistants (typos, voice), mault.
  - Rationale: voice assistants and typos are the M use case; scan guesses are the J mault use case.
- P1 `get_printings` (merged J get_printing, J list_printings, M printings_of_card, D printing_variants, D raw_printing, D legal_printings, P printing_list, J card_image_url, M card_image_url, D image_url, F rarity_scarcity, F reprint_history) [J M D P F]
  - Purpose: every printing of a logical card with set, number, rarity, variant, image URL stem, legality flag, and optionally the original 49 raw fields.
  - In: cardKey string, raw boolean.
  - Out: array of printings with set, number, rarity, variant, imageStem, legal.
  - Source: official card list. Tier A. V7. Serves: collector, mault.
- P2 `card_errata_trace` (P) [P]
  - Purpose: text differences across printings of one logical card. Tier A. V4. Serves: judge. In: cardKey. Out: diffs by printing.

### Value

- P0 `score_card` (merged J score_card, M score_card, M explain_score, D score_breakdown) [J M D]
  - Purpose: rubric score with per-term breakdown, including T(cost) and unclassified flags.
  - In: cardKey string, optional includeBreakdown boolean.
  - Out: score number, expected stats, terms array of name and value, flags array, rubricVersion, dataVersion.
  - Source: rubric scorer (#1). Tier B. V9. Serves: competitive deckbuilder.
  - Rationale: the numbers an assistant cannot get from memory; breakdown lets a streamer read it aloud (P explain_rubric).
- P0 `rank_cards` (merged J rank_cards, M rank_cards, F staple_cards, P new_set_power_ranking, P new_set_hidden_hype) [J M F P]
  - Purpose: ranked list under filters, by rubric score, stat efficiency, inclusion or win rate.
  - In: set, aspect, type string, cost range, arena string, by enum (score, efficiency, inclusion, winrate), limit number.
  - Out: rows of cardKey, title, cost, aspects, metric value, rank.
  - Source: scorer (#1) and the SWU Stats capture. Tier B. V9. Serves: competitive deckbuilder, content creator.
  - Rationale: replaces tier lists with a pinned, citeable ranking; the new-set ranking views are filters on it.
- P1 `compare_cards` (merged J compare_cards, M compare_cards, P compare_cards) [J M P]
  - Purpose: side by side two or three cards: stats, score, price, plays.
  - In: cardKeys string array (2 to 3). Out: aligned columns with deltas. Source: scorer, prices, play stats. Tier B. V7. Serves: casual player, content creator.
- P1 `value_vs_price` (merged J, F, M, D value_per_score, P value_vs_price) [J F M D P]
  - Purpose: rubric value against market price, rank over- and undervalued.
  - In: set, aspect, maxPrice, limit, direction enum (cheap, dear). Out: rows with score, price, ratio.
  - Source: scorer plus conformed prices. Tier B. V8. Serves: collector and trader.
- P1 `play_value_vs_price` (merged F playability_vs_price, F price_per_inclusion, P hidden_gems, P overpriced_cards) [F P]
  - Purpose: inclusion or win rate against price (hidden gems, overpriced cards).
  - In: minSampleSize number, maxPrice number, direction enum, limit number. Out: rows with inclusion, win rate, n, price.
  - Source: SWU Stats capture and conformed prices, no scorer needed. Tier A. V8. Serves: collector, budget player, content creator.
- P1 `score_vs_play` (merged J underplayed_cards, J overplayed_cards, D underplayed_by_score, D score_residual) [J D]
  - Purpose: cards whose rubric score and play data disagree.
  - In: direction enum (underplayed, overplayed), minSampleSize, limit. Out: rows with score, inclusion, residual, n.
  - Source: scorer and play stats. Tier B. V7. Serves: content creator, deckbuilder.
  - Trap: play-calibrated weights make the residual partly circular; the output must say which weights are play-fitted.
- P1 resource `swu://rubric` (merged J explain_rubric, M explain_rubric, P explain_rubric, M rubric_version, D designer_price_lookup, M resource swu://rubric) [J M D P]
  - Purpose: formula, weights, designer keyword prices and calibration date as a static, cacheable resource.
  - Source: scorer config. Tier B. V6. Serves: competitive deckbuilder (trust). Resource, not a tool.

### Text features

- P0 `card_features` (merged J card_features, M card_features, D parse_clauses, D curated_row, D tag_provenance, J leader_profile) [J M D]
  - Purpose: parsed triggers, effects, conditions and offers/wants tags with polarity; says whether each tag came from grammar or the curated table. Works for leaders.
  - In: cardKey string, includeProvenance boolean. Out: clauses array with type, effect, condition, tags, provenance.
  - Source: text grammar and curated table. Tier B. V8. Serves: competitive deckbuilder.
  - Rationale: the foundation of pairings and fungibility; provenance is the trust surface.
- P0 `find_by_effect` (merged J find_by_effect, M find_by_effect, P find_by_effect, D cards_offering, D cards_wanting) [J M D P]
  - Purpose: cards producing a named effect or offering/wanting a tag, with target, arena and timing filters.
  - In: effect string, role enum (effect, offers, wants), aspect, maxCost, arena, timing, limit.
  - Out: rows of cardKey, matching clause, tags.
  - Source: text grammar and curated table. Tier B. V8. Serves: competitive deckbuilder, casual player.

### Synergy and combos

- P0 `find_pairings` (merged J find_pairings, M find_pairings, D enablers_for_payoff, D payoffs_for_enabler, D pairing_neighbours_in_aspects, P nonobvious_combos) [J M D P]
  - Purpose: offers-to-wants partners for a card, ranked by complementarity times non-obviousness, with a reason and a slot-alternatives field.
  - In: cardKey, direction enum (enablers, payoffs, both), leader, base, maxCost, limit.
  - Out: rows of partner, tags, reasons, aspectPair, penalty, score, alternatives by aspect.
  - Source: pairing graph (#3). Tier B. V9. Serves: competitive deckbuilder, content creator.
  - Rationale: the owner-scoped differentiator; slot alternatives implement the #3 scope that makes fungible_in_pair unnecessary.
- P0 `find_trios` (merged J find_trios, M find_trios, D trios_containing, D convergent_trios, D loop_trios, D chains_of_length, P missing_piece, P nonobvious_combos) [J M D P]
  - Purpose: chains, two-enablers-into-one-payoff and loops, ranked, low total cost favoured, with aspect cover.
  - In: cardKey or cardKeys (to find a missing third), shape enum (chain, convergent, loop), maxTotalCost, leader, base, limit.
  - Out: rows of cardA, cardB, cardC, shape, totalCost, aspectPair, penalty, reasons, score.
  - Source: trio graph (#3), shape, owner scope 2026-10-16. Tier B. V9. Serves: competitive deckbuilder, content creator.
- P1 `explain_synergy` (merged J, M explain_synergy, M explain_why_not, D pairing_explain_edge, P explain_synergy) [J M D P]
  - Purpose: tag and rank-term reasons for why two or three cards pair, or why a candidate scored low.
  - In: cardKeys array (2 to 3). Out: edges with offers, wants, quoted clauses, rank terms, non-obviousness.
  - Source: pairing graph. Tier B. V7. Serves: new player, content creator.
- P1 `similar_cards` (merged J, M, D similar_filtered, P) [J M D P]
  - Purpose: nearest neighbours by embedding with aspect, cost and set filters.
  - In: cardKey, aspect, costBand, set, limit. Out: rows with distance. Source: embeddings (#2). Tier B. V6. Serves: casual player, collector.
- P1 `kin_cards` (merged J, M, D kin_of_text, P) [J M D P]
  - Purpose: surface-blind equivalents that ignore traits, keywords and stats.
  - In: cardKey, limit. Out: rows with distance. Source: kin vectors (#2). Tier B. V7. Serves: content creator, deckbuilder.
- P2 `cluster` (merged J, M cluster, M list_clusters, D cluster_of, D cluster_members, P cluster_members) [J M D P]
  - Purpose: role cluster, counted label and members for a card or a cluster id. Tier B. V5. Serves: content creator. In: cardKey or clusterId. Out: label, count, members.

### Fungibility and substitutes

- P0 `fungible_substitutes` (merged J fungible_for_role, J aspect_swap_options, M fungible_cards, F fungible_substitutes, F cross_aspect_substitutes, D substitutes_for_role, D fungibility_class_of, D cross_aspect_substitutes, P fungible_substitutes, P fungible_cross_aspect) [J F M D P]
  - Purpose: cards that fill the same role (same offers/wants or effect profile), grouped by aspect, with cost band, price and aspect penalty under an optional leader and base.
  - In: cardKey or role string, leader, base, crossAspectOnly boolean, maxCost, limit.
  - Out: role class id, substitutes grouped by aspect with cost, penalty, price.
  - Source: fungibility classes (#3). Tier B. V9. Serves: competitive deckbuilder.
  - Rationale: highest-scoring tool in the set, found independently by all five branches (J F M D P). A deck can pick whichever aspect fits its leader and base and still complete a chain.
- P1 `fungible_in_deck` (merged J, M fungible_in_deck, D slot_fillers_for_deck) [J M D]
  - Purpose: per-slot substitutes for a supplied list under a given leader and base.
  - In: decklist array of cardKey and qty, leader, base. Out: per slot, substitutes with penalty. Source: fungibility classes, aspect cover. Tier B. V8. Serves: competitive deckbuilder.
- P1 `budget_alternatives` (merged J, M budget_alternatives, F budget_swap_suggestions, F substitute_price_gap, P budget_version) [J M F P]
  - Purpose: cheaper fungible cards with similar score, with price saved and score lost.
  - In: cardKey or decklist, maxPrice, leader, base. Out: rows with substitute, price saved, score delta.
  - Source: fungibility classes, scorer, prices. Tier B. V8. Serves: casual and budget player.
- P2 `chain_robustness` (merged D chain_robustness, D single_points_of_failure) [D]
  - Purpose: number of distinct completions of a chain per aspect combination, and slots with one filler. Tier B. V6. Serves: deckbuilder. In: cardKeys, leader, base. Out: completions count, single points of failure.
- P2 `swap_impact` (D counterfactual_swap) [D]
  - Purpose: chain score and cover cost if card A is replaced by substitute B. Tier B. V5. Serves: deckbuilder. In: chain cardKeys, swap pair. Out: score and penalty delta.

### Deckbuilding

- P0 `aspect_cover` (merged J, M, D aspect_cover_cost, P aspect_cover_pile) [J M D P]
  - Purpose: penalty-free leader and base pairs for a card or pile, or the penalty (+2 per uncovered icon).
  - In: cards string array, leader string, base string.
  - Out: per card, uncovered icons and extra cost; total penalty.
  - Source: aspect icons on the card list. Tier A. V8. Serves: competitive deckbuilder.
  - Rationale: computable now with no transform; every deck question ends here.
- P1 `suggest_leader_base` (merged J leader_suggestions, J base_suggestions, D best_base_for_leader, P best_leader_base_for_pile) [J D P]
  - Purpose: leader and base choices that minimise uncovered icons for a pile.
  - In: cards array, optional leader. Out: ranked leader and base pairs with penalty. Source: aspect icons. Tier A. V8. Serves: deckbuilder, new player.
- P1 `playable_cards` (merged M best_cards_for_leader, P fill_curve) [M P]
  - Purpose: cards playable under a leader and base, optionally filling empty cost slots of a partial pile.
  - In: leader, base, partial decklist, cost slots, role. Out: ranked rows by cost with penalty. Source: aspect cover, scorer. Tier B. V7. Serves: deckbuilder, kitchen-table player.
- P1 `deck_audit` (merged J deck_audit, J deck_gaps, J mana_curve, M decklist_score, M decklist_gaps, P curve_report, P curve_stats) [J M P]
  - Purpose: one-call list report: score, cost curve against 1.72 + 1.96 x cost, aspect penalties, orphan wants, role gaps against cluster norms.
  - In: decklist, leader, base. Out: score, curve, penalty, orphanWants, gaps.
  - Source: scorer, pairing graph, clusters, aspect cover. Tier B. V8. Serves: deckbuilder, casual player.
  - Rationale: collapses several calls into one, matching the tool-count constraint.
- P1 `deck_legality_check` (merged J, M decklist_check, P) [J M P]
  - Purpose: legality of a whole list: size, copy limits, leader and base rules, banned and suspended cards, with failing cards and reasons.
  - In: decklist, leader, base, format, asOf date. Out: legal boolean, failures with rule cite.
  - Source: CR deck-construction rules (#6) and the ban ledger. Tier C (ban ledger from articles API). V8. Serves: organiser, judge.
- P2 `sealed_pool_builder` (merged P draft_pick_order) [P]
  - Purpose: from a sealed pool, suggest leader, base and best 30+ cards; draft pick order. Tier B. V5. Serves: organiser, store regulars. In: pool cardKeys. Out: suggested build, pick ranks.

### Market and collection

- P0 `card_price` (merged J card_price, F card_price, M card_price, F price_by_printing, F cheapest_printing, D cheapest_printing, P cheapest_printing, J price_spread, F variant_premium, J price_data_quality, D price_quarantine_report, F price_source_provenance, F listing_sanity_check) [J F M D P]
  - Purpose: conformed price per printing (normal, foil, variants) with source, date, quality flag, spread, variant premium and cheapest printing.
  - In: cardKey or printing id, askPrice number optional. Out: printings with price, finish, date, quarantined flag; cheapest; ratio of askPrice to market.
  - Source: TCGCSV via the mault conformer (8,882 printings priced). Tier A. V8. Serves: collector and trader, mault.
  - Rationale: pinned US price with explicit quality flags; the Trap field is US-only coverage, say so in output.
- P1 `price_list` (merged J deck_cost, J collection_value, F deck_cost, F deck_cost_breakdown, F collection_value, F collection_value_breakdown, F collection_concentration, M collection_value, P deck_price_total) [J F M P]
  - Purpose: total price of a supplied list of printings or cards (cheapest printing option), grouped by set, rarity or aspect.
  - In: items array of id and qty, groupBy enum, finishPreference enum. Out: total, per line, grouped totals, share of top N.
  - Source: conformed prices. Tier A. V8. Serves: mault, deckbuilder, trader.
  - Trap: privacy; the list is supplied by the caller and is not stored. mault already values collections itself.
- P1 `trade_balance` (merged J, F trade_balance, F trade_fairness_range) [J F]
  - Purpose: compare two lists by market and by low price, and by rubric value.
  - In: sideA items, sideB items. Out: totals both ways, difference. Source: prices, scorer. Tier A. V7. Serves: trader.
- P1 `owned_vs_needed` (merged M, P owned_vs_needed, D collection_gap_for_chain, D substitutes_owned, J collection_gaps, F deck_cost_to_complete) [J F M D P]
  - Purpose: diff a decklist or chain against a supplied owned list, with cheapest buy for each gap and owned fungible substitutes.
  - In: decklist, owned items array. Out: missing lines with price, owned substitutes, cost to complete.
  - Source: prices, fungibility classes. Tier B. V7. Serves: mault, budget player.
- P2 `set_value_distribution` (merged F chase_cards, F finish_premium_table) [F]
  - Purpose: price share by rarity and set, top chase cards, foil to normal ratio. Tier A. V4. Serves: collector, store. In: set. Out: shares, top N.

### Play data and meta

- P0 `play_stats` (merged J play_stats, M play_stats, M play_stats_batch, M play_stats_meta, D play_stats_confidence, P play_stats) [J M D P]
  - Purpose: per-card Premier inclusion and win counts with sample size, date range of the capture and a Wilson interval.
  - In: cardKeys string array. Out: rows with inclusion, wins, games, rate, ci, captureRange.
  - Source: pinned SWU Stats capture (637k player-games since 2025-09). Tier A. V8. Serves: competitive deckbuilder.
  - Trap: online meta is not paper meta; output carries the capture range and source.

### Rules

- P0 `rules_search` (merged J search_rules, M rules_search) [J M]
  - Purpose: keyword search across Comprehensive Rules sections.
  - In: query string, limit number. Out: rows of section id, heading, snippet, ruleVersion.
  - Source: rules section tree from the PDF (#6; sections rebuilt from indentation). Tier B. V8. Serves: judge, casual player.
- P0 `get_rule` (merged J get_rule, J rule_context, M get_rule, M rule_outline, M rule_neighbors, D rules_section, D rules_neighbours, P rule_lookup) [J M D P]
  - Purpose: one numbered section with children, parent and siblings and cross-references.
  - In: section string, depth number, include enum (children, parent, siblings).
  - Out: section text, children, links, ruleVersion.
  - Source: rules section tree (#6). Tier B. V8. Serves: judge.
- P0 `card_rulings` (merged J, M, P card_rulings) [J M P]
  - Purpose: dated official rulings for a card, newest first.
  - In: cardKey. Out: rows of date and ruling text per printing, deduplicated.
  - Source: rulesStyled HTML table of dated rows in the card list (4,430 printings, 603 distinct). Tier A. V8. Serves: judge.
  - Rationale: data exists now and the rulings are the closest thing to a ground truth for disputes.
- P1 `keyword_rules` (merged J keyword_explainer, M keyword_rules, D keyword_rule_for_card, P keyword_explainer) [J M D P]
  - Purpose: rule text for a keyword, examples, and cards that carry it, or the rule sections for every keyword on a card.
  - In: keyword string or cardKey. Out: rule sections, cards. Source: keyword-to-rule linker (#6). Tier B. V7. Serves: new player, judge.
- P1 `search_rulings` (merged M search_rulings, M rulings_for_keyword, M rulings_by_date, D rulings_for_rule, J rulings_since, D rulings_since, P ruling_changes_since) [J M D P]
  - Purpose: text, keyword, rule and date filters over all dated rulings.
  - In: query, keyword, rule, since date, limit. Out: rows with card, date, text, linked rule if any.
  - Source: rulings field; the rule filter needs the ruling-to-rule linker (#6). Tier A for text and date, B for rule filter. V7. Serves: judge, content creator.
- P1 resource `swu://rules/{section}` (merged M resource) [M]
  - Purpose: static rules sections for host caching. Tier B. V5. Serves: AI assistants. Resource, not a tool.
- P1 prompt `rules_question` (M) [M]
  - Purpose: workflow template: find the rule, find the ruling, answer with citations. Tier A (text only). V6. Serves: judge.
- P2 `interaction_check` (merged J interaction_check, P interaction_rulings) [J P]
  - Purpose: retrieval bundle only: both cards' keywords, linked rule sections and rulings for two named cards (no verdict). Tier B. V5. Serves: judge. In: cardKeyA, cardKeyB. Out: keywords, rules, rulings.

### Sets and legality

- P1 `list_sets` (merged J list_sets, M set_info, M legal_sets) [J M]
  - Purpose: sets with code, release date, card count and Premier-legality status.
  - In: none. Out: array of sets. Source: set calendar from the card list. Tier A. V6. Serves: organiser.
- P1 `format_legality` (merged M, P format_legality, J legality_history, D legality_on_date, F rotation_status) [J M D P F]
  - Purpose: legality of a card in Premier, Eternal and Twin Suns on a date, with reason and ban or suspension.
  - In: cardKey, format, asOf. Out: legal boolean, reason, source article link.
  - Source: set calendar plus ban ledger. Tier C (ban ledger from the articles API; without it every folded card reads legal). V8. Serves: organiser, judge.
- P1 `ban_list` (merged J ban_list, M ban_suspension_list, D bans_timeline, P banlist_history) [J M D P]
  - Purpose: current and past bans and suspensions with dates and the article link.
  - In: format, asOf. Out: rows of card, status, date, articleUrl.
  - Source: ledger extracted from the articles API. Tier C (new ingest: articles). V8. Serves: organiser, content creator.
  - Rationale: unlocks format_legality and deck_legality_check; overnight changes are the publisher-regulator risk.
- P2 `search_articles` (merged J recent_announcements, M articles_search, M get_article, M list_announcements) [J M]
  - Purpose: official articles filtered by topic and date. Tier C (articles ingest, shared with ban_list). V5. Serves: content creator. Trap: duplicative of browsing the official site.

### Provenance and meta-tools

- P0 `data_version` (merged J, F, M, P data_version, M rules_version, M rubric_version, M server_health, J source_freshness, P upstream_staleness, M resource swu://data-version) [J F M D P]
  - Purpose: pin of every source with hash, date, code commit, rules version and rubric version, plus age of each feed.
  - In: none. Out: sources with hash and date, packageDate, codeCommit.
  - Source: pinned data-version manifest. Tier A. V8. Serves: AI assistants (citeability).
  - Rationale: the #5 contract says every tool cites its data version.
- P1 `diff_data_version` (merged D diff_data_version, M new_cards_since, M changes_between_versions, P set_spoiler_diff) [D M P]
  - Purpose: card-, tag- and score-level changes between two pinned versions (new cards, text changes).
  - In: fromVersion, toVersion. Out: added, changed, removed with kind. Source: manifest plus folder. Tier A. V7. Serves: content creator, mault.
- P1 resource `swu://usage-guide` (merged M list_tools_guide, M usage_hints_resource) [M]
  - Purpose: which tool for which question type, and how to ask well. Tier A. V6. Serves: AI assistants.
- P1 resource `swu://glossary` (merged J glossary, M glossary_term) [J M]
  - Purpose: game terms plus offers, wants, kin, fungible. Source: docs/concepts/swu-glossary.json. Tier A. V6. Serves: new player.

### MCP resources and prompts

- P1 prompt `build_deck_for_leader` (M) [M]
  - Purpose: workflow: choose leader and base, fill chains with substitutes, audit. Tier B (calls B tools). V7. Serves: competitive deckbuilder.
- P2 static catalogue resources (merged M swu://facets, swu://clusters, swu://sets, swu://card/{id}) [M]
  - Purpose: cacheable catalogues. Tier A. V4. Serves: hosts that cache resources.
- P2 prompt `evaluate_trade` (M) [M] — Tier A. V5. Serves: trader.
- P2 prompt `explain_card_to_new_player` (M) [M] — Tier A. V5. Serves: new player.
- P2 prompt `spoiler_season_digest` (merged M, P new_set_best_pairs, P what_it_replaces, D new_set_impact, F upcoming_set_overlap) [M P D F]
  - Purpose: workflow that summarises new cards using rank_cards, find_pairings and fungible_substitutes filtered to the new set. Tier B. V6. Serves: content creator.

## Parked and Rejected

### Parked (valuable, gated on named data or a decision)

Tier is the tier at which the tool would run once unblocked.

- `price_history` (merged J, F, M price_history_stub, D, P price_trend) [J F M D P] — Tier C: dated TCGCSV snapshots not accumulated. V7. Serves: trader. Promote once enough dated snapshots are pinned.
- `price_movers` (merged F price_movers, D price_diff_between_versions, F collection_delta, P collection_value_movers) [F D P] — Tier C: price history. V6.
- `ban_impact` (merged F ban_impact, F post_rotation_price_drop) [F] — Tier C: price history plus ban ledger. V4. Descriptive only; no causal claim.
- `play_stats_trend` (merged J stats_trend, D play_stats_drift, D play_stats_window) [J D] — Tier C: dated SWU Stats slices. V7. Serves: content creator.
- `stats_by_leader` (merged J stats_by_leader, P inclusion_by_leader) [J P] — Tier C: leader-level SWU Stats. V8. Serves: deckbuilder. Highest-value parked tool.
- `meta_snapshot` (merged J, P meta_snapshot, F meta_share) [J P F] — Tier C: leader share and dated slices. V6. Trap: online meta is not paper meta.
- `leader_matchup_stats` (P) [P] — Tier C: pairwise matchup counts. V6.
- `deck_lists_for_card` (J) [J] — Tier C: tournament deck lists (Melee and similar). V6.
- `counters_to_card` (merged P sideboard_answers, P counters_to_card) [P] — Tier C: a curated counter relation table not in the offers/wants table. V6.
- `rotation_forecast` (merged J, P, F rotation_exposure) [J P F] — Tier C: publisher announcement; unanswerable until announced. V5.
- `upcoming_cards` (J) [J] — Tier C: pre-release cards in an ingest. V6.
- `rules_version_diff` (D) [D] — Tier C: prior CR PDF versions; the red change markers are lost in text extraction. V4.
- `translate_card_terms` (P) [P] — Tier C: multilingual card text. V2. Trap: US-centric blind spot.
- `cross_market_spread` (F) [F] — Tier C: Cardmarket prices. V4. Trap: US-centric blind spot.
- `buylist_estimate` (F) [F] — Tier C: store buylist feeds. V4.
- `pack_ev` (merged F pull_rate, pack_ev, box_ev, sealed_vs_singles) [F] — Tier C: pull-rate data and sealed prices. V4.
- `leader_cost_ladder` (merged F leader_cost_ladder, F starter_deck_value) [F] — Tier C: deck lists and preconstructed contents. V4.
- `starter_buy_list` (merged F starter_buy_list, F new_player_budget_deck, P starter_buy_list) [F P] — Tier B but composition: an assistant can compose rank_cards, budget_alternatives and aspect_cover. Park until usage shows the composition fails. V6.
- `buildable_from_collection` (P) [P] — no deterministic definition of a deck without deck lists; Tier C. V5.
- `grammar_coverage` (merged D unparsed_clauses, D coverage_report) [D] — Tier B maintainer QA; belongs in CI, not the tool list. V3.
- `cluster_audit` (merged D cluster_outliers, D cluster_label_audit) [D] — maintainer QA. V2.
- `rubric_sensitivity` (merged D weight_sensitivity, D counterfactual_cost) [D] — maintainer analysis. V3.
- `counterfactual_tag` (D) [D] — maintainer analysis of the curated table. V3.
- `verify_replay` (D) [D] — replay record check; belongs in CI. V3.
- `pairing_graph_analytics` (merged D pairing_path, D pairing_degree) [D] — graph analytics with no named consumer. V3.
- `leader_pair_cover_matrix` (D) [D] — large matrix output; suggest_leader_base covers the question. V3.

### Rejected (with reason)

- `fungible_in_pair` (J, M) [J M] — duplicates find_pairings and find_trios slot alternatives (#3 scope).
- `set_contents` (J, D) [J D] — duplicates cards_by_facet with an expansion value.
- `event_format_pack` (J) [J] — composition of list_sets, ban_list and data_version.
- `timing_walkthrough` (J, P) [J P] — LLM reasoning over rule text; unanswerable deterministically.
- `ruling_conflicts` (D) [D] — interpretive; unanswerable deterministically.
- `draw_odds` (merged P draw_odds, opening_hand_sim, mulligan_advice, resource_curve_odds) [P] — duplicative of code execution and general LLM arithmetic; no card data needed beyond the list.
- `deck_tech_outline` (P) [P] — composite of other tools plus matchup data not held.
- `what_beats_leader` (P) [P] — not deterministic from rules text and play stats.
- `price_spike_causes` (merged F price_spike_causes, F event_demand_forecast) [F] — causal and predictive claims; not deterministic.
- `reprint_risk` (merged F reprint_risk, F card_investment_profile) [F] — a prediction and a composite; not deterministic.
- `cross_game_capital_compare` (F) [F] — other games' data not held; low coverage.
- `grading_tools` (merged F graded_candidates, grading_cost_breakeven, pop_report_lookup, J grading_value_delta) [F J] — no pop-report or slab price source; tier C and low value.
- `liquidity_score` (F) [F] — TCGCSV carries no listing counts.
- `net_proceeds_after_fees` (F) [F] — fee arithmetic, duplicative of general LLM ability; fee rates drift.
- `bulk_threshold` (F) [F] — a price filter on search_cards and rank_cards.
- `event_prize_value` (merged F tournament_prize_value, P event_prize_pool_values) [F P] — needs prize lists not held; low value.
- `authenticity_hints` (merged J authenticity_hints, F card_authenticity_hints) [J F] — an authenticity claim cannot be verified from metadata; get_printings already exposes set and number.
- `insurance_and_storage` (merged F insurance_schedule, F sleeve_and_storage_inventory) [F] — low fit, privacy, and mault owns collection value.
- `faq_cards` (J) [J] — curated prose that duplicates a general LLM ability and the data tools.
- `tool_catalogue` (merged J, D tool_catalogue, M server_capabilities) [J D M] — duplicates MCP tools/list.
- `explain_difference_from_competitor` (J) [J] — marketing text, no data.
- `completeness_report` (J) [J] — mault owns completion; cards_by_facet supplies set contents.
- `bin_rule_tools` (merged D bin_rule_candidates, P bin_rule_preview) [D P] — bin rules live in mault's database; not swu-mcp data. Tier X.
- `compact_card_formats` (merged M get_card_compact, M get_card_toon) [M] — an output format param on every tool, not a tool.
- `provenance` (merged M provenance, D data_provenance, P source_provenance, D uncertainty_report) [M D P] — belongs in every response envelope (source, dataVersion, caveats), not as a stateless lookup tool.


## Provenance

- Method: Value Chain Analysis per Liedtka and Ogilvie, Designing for Growth. Divergence ran as five blind branches; this document is the convergence phase (Score, Cluster, Deepen) over the frozen set, with no new players or tools added.
- Participants: agent-jtbd-bizdev-strategy-mentor (jtbd branch, dispatched), agent-finance-practitioner-instructor (finance branch, dispatched), agent-mcp-server-api-reverse-engineer (mcp branch, dispatched), agent-llm-last-pipeline-architect (data branch, dispatched), channel-partner deckbuilder and creator persona (player branch, role-played).
- Inputs: tmp/vca/context.md, branch-jtbd.md, branch-finance.md, branch-mcp.md, branch-data.md, branch-player.md; issues #3 (fungibility and trios scope), #5 (draft catalogue), #6 (rules scope); the four shipped tools in src/.
- Count reconciliation: the branch headers say 208 players and 352 tool ideas. Counting listed lines gives 217 players (37 J, 49 F, 39 M, 48 D, 44 P) and 360 tool lines (74 J, 63 F, 85 M including 12 resource and prompt lines, 74 D, 64 P).
- Doctrine notes: tiering follows context.md (read-only, deterministic, no model in the scoring path, LLM-ingestible compact output). Launch-stage concerns (ToS, data terms, licensing) are noted once and not used as gates.

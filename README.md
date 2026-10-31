# swu-mcp

Star Wars: Unlimited (SWU) card data, deterministic card scoring, synergy discovery and card similarity, served to AI assistants over the Model Context Protocol (MCP, stdio). Every number comes from deterministic code over pinned inputs. No model runs at query time and none decides a score.

Status: MVP (swu-mcp#7). All 49 tools below are served and an end-to-end test calls each one over real stdio. One command rebuilds every data product.

## Install

Needs Node.js 22 or newer. Site: https://lampagj.github.io/swu-mcp/.

Claude Code:

    claude mcp add swu -- npx -y github:LampaGJ/swu-mcp

Claude Desktop, in `claude_desktop_config.json`:

    {
      "mcpServers": {
        "swu": { "command": "npx", "args": ["-y", "github:LampaGJ/swu-mcp"] }
      }
    }

npm installs the repository, runs its `prepare` script (an esbuild bundle into `dist/server.js`) and starts the `swu-mcp` bin over stdio. `"private": true` only blocks `npm publish`.

### Data release

The built data (`data/runs/<date>/`, 27 MB raw) is not in git. It ships as a GitHub Release asset, `swu-mcp-data-<date>.tar.gz` (about 2 MB), pinned by `src/data-release.json` (version, URL, sha256, size, build hash). The server picks its data in this order:

1. `SWU_MCP_DATA`: a run directory you name.
2. The newest `data/runs/<date>/` when running from a checkout.
3. A per-user cache, `<cache>/swu-mcp/<dataVersion>/` (`SWU_MCP_CACHE` overrides the cache root). If it is missing, the server downloads the pinned URL, checks the sha256 and size, extracts to a temp directory and renames it into place. A mismatch fails with an error and extracts nothing. `SWU_MCP_DATA_URL` replaces the download URL for testing; the pinned hash still applies.

Progress goes to stderr; stdout is the MCP stream.

To publish new data (the maintainer's step):

    pnpm build:data
    pnpm release:data [--date <YYYY-MM-DD>]

`release:data` writes `tmp/release/swu-mcp-data-<date>.tar.gz` and the pin file, then prints the `gh release create` command. It does not run it. The archive holds `docs` (read by the rubric and glossary resources), `llm`, `features`, `scores`, `synergy`, `market`, `meta`, `rules`, `similarity` and the build records, with sorted entries and fixed times, owners and modes, so the same run gives the same bytes. Commit the pin together with the release.

### From a checkout

    claude mcp add swu-mcp -- pnpm --silent --dir "/path/to/swu-mcp" mcp

`--silent` is required: without it pnpm prints a banner to stdout, which corrupts the MCP stdio stream. The server logs the card count to stderr at start. It also serves the resource `rules://core-primer`, the verbatim core Comprehensive Rules.

Tool results are TOON, a compact table format (column names once, then one line per row), not JSON. Failures set `isError` with a plain sentence. All tools are read-only.

### Remote (for Claude mobile and other hosted clients)

Claude's connectors reach an MCP server by URL, so the stdio server is bridged to Streamable HTTP with [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy) and published over HTTPS by the maintainer's Tailscale Funnel. The bridge is a LaunchAgent, `scripts/bridge/com.swu-mcp.bridge.plist` (copy to `~/Library/LaunchAgents` and `launchctl bootstrap gui/$(id -u) <plist>`), listening on `127.0.0.1:8765` with the endpoint at `/mcp`; the public path is `/swu/mcp` on the maintainer's host. The URL has no authentication: every tool is read-only over public card data. This is the remote endpoint (D54 in docs/decisions.md); a hosted Worker was tried and not pursued.

## Read more

- [What it does](docs/public/what-it-does.md), in plain words.
- [How it was built](docs/public/how-we-built-it.md).
- [The Claude Code setup behind it](docs/public/claude-code-setup.md).
- [Verification report](docs/verification/2026-10-16.md).
- [Decisions and intentions](docs/decisions.md): the standing intent the code is reviewed against.

## Tools (48)

Cards and search

- `get_card` one logical card in full, by `cardKey` or exact title and optional subtitle.
- `search_cards` substring search over title, subtitle and text, narrowed by type, aspect, trait, keyword, set and max cost.
- `list_facet` every value of one facet (aspect, trait, keyword, type, arena, rarity, expansion, variant) with count and definition.
- `cards_by_facet` the cards that carry one facet value.
- `get_cards_batch` up to 50 cards by `cardKey` in one call, with the columns you name.
- `resolve_card_name` typo-tolerant name lookup (MiniSearch fuzzy match, edit distance as tiebreak) to ranked candidate cards.
- `get_printings` the sets a card is printed in with Premier status, variants and the canonical printing's number, rarity and image stem. The package keeps no per-printing rows.

Value

- `score_card` rubric score of one card with a one-line explanation per component and the play-calibrated score.
- `rank_cards` cards ranked by play-calibrated score, total or stat efficiency, with filters.
- `compare_cards` two to five cards side by side.
- `explain_rubric` the formula, vanilla curve, weights, T(cost) and fitted terms with their sources.

Text features

- `card_features` parsed triggers, effects, conditions, offers and wants of one card, clause by clause.
- `find_by_effect` cards that produce an effect category, or whose synergy tags offer or want a fragment.

Synergy and combos

- `find_pairings` enablers that feed a card and payoffs it feeds, with reason, `linkKind` (mechanical, trait+mechanical, trait-only), score, aspect penalty, fungible alternatives (Premier-pool cards that still link with the card through the same row) and the clause text (clipped to 160 characters) behind each offer and want. Mechanical links rank by default; a trait the pair also shares only multiplies its link by 1.1, and pairs that only share a trait come in a separate `tribal` list (5 by default, `tribalLimit`). `traits: exclude` ignores traits, `traits: include` ranks trait-only pairs with the rest. `perLink` (default 3) lists at most that many rows per distinct link before rows that repeat a link, which follow in rank order (`capped` counts them; 100 turns the cap off). An optional `leader` (cardKey or exact title) gives each partner `leaderInclusion` from the leader's tournament decklists (null when unplayed), multiplies the rank by 0.5 + leaderInclusion (0.5 when unplayed; played means 2% or more of the lists, one floor in every tool), defaults `aspects` to the leader's icons and names the population and window. An optional `base` (a Base card, cardKey or exact title; needs `leader`) adds the base's icons to those defaults and is named in the leader block; with a leader alone the block says `base not given: penalties measured against the leader's icons only`. A Leader `cardKey` with no `leader` argument stands in as the leader, with its most-played tournament base as the base, and the leader block says `defaulted: true`; `weighting: none` turns that and the inclusion weighting off, but the aspects stay the Leader card's own icons in every mode, so the cover search never picks another leader. A partner whose clause names a specific base ("While you control a Tatooine base") carries `baseLocked: "Tatooine"` and ranks after unlocked partners, unless the given base has that trait. The `reason` names the side the offer lands on (an enemy unit, your own, or either) where the rule reads differently by side. Every row carries `status: candidate`; `evidence: false` drops the text.
- `find_trios` three-card combos (chain, two enablers into one payoff, loop) built from mechanical links and ranked with a bonus for low total cost, each with the clause text behind its links and `status: candidate`. `traits: include` admits trait-only links, but every trio keeps at least one mechanical link. An optional `leader` gives each trio `leaderInclusion` per member and a `rank` that multiplies the score by the geometric mean (cube root of the product) of the member factors, so one played card cannot carry two unplayed ones, and defaults `leaderAspects` to the leader's icons. An optional `base` (needs `leader`) defaults `baseAspects` to its icons and is named in the leader block. A Leader `cardKey` defaults `leader` (and `base` to its most-played tournament base) the same way, and `weighting: none` turns it off (the cover search still uses the Leader card's icons). A trio with a `baseLocked` member follows the others and says which base it needs. A link whose offer is restricted to a trait ("Defeat a friendly Creature unit") appears only in a trio whose third card supplies that trait, as a unit or through the tokens it creates. A Pilot (Piloting attaches to a friendly Vehicle unit), an upgrade with an "Attach to ..." line and a give-token offer that names a trait or keyword ("friendly units with Hidden") feed a "while this unit is upgraded" card only when that card meets the restriction. Each slot's alternatives are Premier-pool cards that keep the slot's links with the other two members, so a substitute never bypasses a trait restriction the slot card met. With a leader-weighted rank, `minPlayed` (0-3, default 2) keeps only trios with that many members the leader's decks play (2% or more of the lists), and the leader block states it. A trio that shares two members with a better-ranked one is folded into it, and its third card is listed under that row's `variants` (title, cost, leaderInclusion). Evidence for a tag from the curated table quotes the curated clause, and `source` names the curated side. A loop whose single-target outlet would have to defeat both the token it is fed and the unit an upgrade in the loop sits on is not a loop (D49).
- `explain_synergy` link-by-link reasons why two or three cards pair, with the clipped clause text behind each tag and `status: candidate`.
- `aspect_cover` leader and base aspect combinations ranked by the penalty for a set of cards.

Fungibility and substitutes

- `fungible_substitutes` cards that fill the same role as a card, grouped by aspect, with the role's clause text for the slot card and each substitute and `status: candidate`. A card whose class holds no other member is retried with the cost band relaxed, then with magnitude ignored; `widened` names the step and those substitutes carry `match: widened`. A unit also holds a `keyword:<Keyword>` role per printed keyword (same arena, cost band and power-plus-HP band), listed first for a unit with no offers/wants tag or only a constant "while ..." condition. Substitutes are Premier-pool cards only (a Premier-legal printing). Inside an aspect group substitutes sort by play-calibrated score; give `leader` (cardKey or exact title) and each substitute carries `leaderInclusion`, with the cards that leader's tournament decklists play first.

Market and play data

- `card_price` US TCGplayer price of one card and its printings.
- `play_stats` Premier inclusion and win figures of one card from the pinned SWU Stats capture.
- `value_vs_price` play-calibrated score per dollar.

Rules

- `rules_core` verbatim text of the core Comprehensive Rules; read first for any rules question.
- `rules_search` ranked keyword search over the rules sections.
- `get_rule` one section by id, with children, parent and cross-references.
- `card_rulings` dated official rulings for one card.
- `keyword_rules` a keyword's definition and the rules sections that define it.
- `rules_version` which Comprehensive Rules the rules tools use.
- `search_rulings` card rulings filtered by text, keyword and date. No filter by rules section.

Sets and legality

- `list_sets` every expansion with kind, main set number, stated release date and Premier status, parsed from the expansion notes.
- `format_legality` Premier, Eternal and Twin Suns legality of a card with the reason. Set-based and current only: no ban list or legality history is in the data.

Similarity

- `similar_cards` cards whose rules text reads most like this card's (embedding cosine).
- `kin_cards` cards that do the same kind of thing under different labels (names, traits, keywords, aspects and numbers masked).
- `cluster` one of 32 role clusters, by id or by a member card.

Decks, collections and trades (lists arrive as `{card, count}` arguments, a cardKey or exact title; nothing is stored, unresolved names are listed)

- `deck_audit` one-call report on a decklist under a leader and base: curve against the rubric's stat curve, mean score, aspect penalty per card, orphan wants and role-cluster gaps. When the package holds the leader's tournament decklists, `leaderComparison` lists the staples the deck lacks (inclusion 0.5 or more) and the deck cards those lists rarely play (under 0.05, or never), and cluster gaps are measured against the leader's played cards instead of the whole pool; clusters of bases, leaders or tokens are skipped. Generic wants (any When Played, On Attack or When Defeated) come as one `genericWants` line, not one orphan row each. With the leader's decklists, an orphan's named feeders are the cards those lists play (2% or more) first, most played first, then by aspect penalty, and an unplayed feeder is marked `unplayed`. A cluster gap's `deckCards` counts a deck card when the clusters file places it in the cluster or it carries a tag that defines the cluster (the `norm` line states the rule). Takes the deck as a `swudb` argument, the SWUDB JSON interchange document (exports of SWUDB, melee.gg, Karabast and SWU Stats, ids like `HMW_018`), instead of `decklist`, `leader` and `base`; a `SET_NNN` id also works in any `card`, `leader` or `base` field. A document's sideboard is listed under `sideboard`, one row per card, apart from the deck counts.
- `deck_legality_check` exactly 1 leader and 1 base, 50 other cards (or the base's changed minimum), 3 copies at most, no tokens, Premier cardpool, each failure with its Comprehensive Rules section (9.2.2.a to d, 8.5.5, 1.2.3, 3.2.1.a). `counts.listedCopies` counts every listed copy, unresolved lines included. No ban or suspension ledger, no asOf date, and a sideboard (from `swudb`) is checked for its 10-card limit only. Takes the deck as a `swudb` argument, the SWUDB JSON interchange document (exports of SWUDB, melee.gg, Karabast and SWU Stats, ids like `HMW_018`), instead of `decklist`, `leader` and `base`; a `SET_NNN` id also works in any `card`, `leader` or `base` field.
- `suggest_leader_base` leader and base aspect pairs ranked by the penalty for a pile of cards.
- `playable_cards` the best cards for a leader and base, by cost, optionally filling the costs of a partial pile. Within a cost, cards that this leader's tournament decklists play most come first (`leaderInclusion`, with the population and window named), then the play-calibrated score; `rankBy: "score"`, or a data package without `meta/leader-cards.json`, ranks by score alone. In leader mode a card in 60% or more of the leader's decks is a staple: it is always listed in full, even past `perCost` and `limit`, marked `staple: true` and counted toward neither; `limit` caps the other rows, so a long page still reaches the high costs. A card in under 2% of the decks, or none, is left out unless `includeUnplayed: true`, and the `emptyCosts` line names a cost left with no played card (`no tournament-played card (>= 2%) at cost N`). With `emptyCostsOnly` only a cost where the leader's lists hold at least 0.5 mean copies is reported; `emptyCosts` names the others in one line (`under 0.5 mean copies in the leader's lists at costs 0, 9, 10`). Takes the deck as a `swudb` argument, the SWUDB JSON interchange document (exports of SWUDB, melee.gg, Karabast and SWU Stats, ids like `HMW_018`), instead of `decklist`, `leader` and `base`; a `SET_NNN` id also works in any `card`, `leader` or `base` field.
- `fungible_in_deck` same-role substitutes per deck slot, least aspect penalty first; only Premier-pool cards (a Premier-legal printing). Takes the deck as a `swudb` argument, the SWUDB JSON interchange document (exports of SWUDB, melee.gg, Karabast and SWU Stats, ids like `HMW_018`), instead of `decklist`, `leader` and `base`; a `SET_NNN` id also works in any `card`, `leader` or `base` field.
- `budget_alternatives` cheaper same-role substitutes with the saving and the score change. With a leader and base, a substitute never carries a higher aspect penalty than the card it replaces, and substitutes sort by the leader's tournament inclusion first (`leaderInclusion`); a slot with no played substitute (under 2% of the lists) says `no tournament-played substitute under the cap`. With `maxPrice`, a card already at or under it is skipped and listed in `alreadyUnderCap`. A priced card with no swap is listed in `noAlternative` (card, price, reason: `no cheaper same-slot card` or `no card within the cost band`), so every priced card sits in `slots`, `alreadyUnderCap` or `noAlternative`. A substitute has the card's type, a unit's arena and a cost within 1 of the card's, and a Premier-legal printing (a card only in rotated or unverified sets is left out). `savingPerCopy` is the best single swap on one copy; `totalSaving` sums every slot's first swap times its copies. Takes the deck as a `swudb` argument, the SWUDB JSON interchange document (exports of SWUDB, melee.gg, Karabast and SWU Stats, ids like `HMW_018`), instead of `decklist`, `leader` and `base`; a `SET_NNN` id also works in any `card`, `leader` or `base` field.
- `price_list` total US price of a deck or collection, with the top share and totals by first set, rarity, aspect or type.
- `trade_balance` two lists compared by market price, low price and rubric score.
- `owned_vs_needed` a decklist against an owned list: missing copies, cost to complete, owned substitutes. Takes the deck as a `swudb` argument, the SWUDB JSON interchange document (exports of SWUDB, melee.gg, Karabast and SWU Stats, ids like `HMW_018`), instead of `decklist`, `leader` and `base`; a `SET_NNN` id also works in any `card`, `leader` or `base` field.
- `play_value_vs_price` cards most or least played per dollar, from the SWU Stats capture.
- `score_vs_play` cards whose rubric rank and play rank disagree (the designer total by default, because the play-calibrated score is fitted to the same play data).

Meta defense (every win rate comes from swumetastats tournament data, melee.gg events, with its window, n and a 95% interval; community lists are a labelled secondary view of archetype shares)

- `meta_archetypes` the current Premier archetypes: tournament decklists from the last 90 days of the newest snapshot (placement-weighted), clustered by leader, base aspect and shared core cards, with meta share, top-8 share, the date window, the leader and base aspect's tournament match record (n and 95% interval), threats, core cards and the most-played base (`topBase`). Community lists are a separate population, and the fallback when a window holds too few tournament decks.
- `meta_threats` one archetype in depth: bases, arena split, curve, keywords, upgrade and token reliance, key units with cost, power and HP, core cards with inclusion rates, threats and its tournament record against the field and against each other large archetype (leader and base aspect matchups, with n and 95% interval). A leader with no tournament archetype in the window falls back to its largest community archetype, labelled `leaderSource` (`population: community`, `fallback: true`, `decks`) and never pooled with tournament decks; the error, naming both deck counts, appears only when neither population holds a deck. `base` with a leader cardKey profiles the archetype with that base's aspects.
- `meta_answers` cards in our aspects that answer the largest archetypes, penalty-free first, from a leader and base or a decklist: the threats each answers with clause evidence and `status: candidate`, coverage weighted by meta share, cost, copies already in the deck, and tournament deck evidence: the match win rate of comparable decks (same leader and base aspects, else same aspect set) with the card against those without it, with n, 95% interval, source and window. Opponents are not known per match, so this is not a rate against any archetype. Each answer carries `leaderInclusion` (the share of our leader's tournament decklists that play it, null when unplayed); within a coverage band, evidence class and cost band the more-played answer ranks first, and the page leaves out answers under 2% unless they are already in the deck or `includeUnplayed: true` (`capped` counts them). A conditional Saboteur gained on the card itself (Marrok) counts for sentinel-wall and shields at weight 0.5, with the condition in the evidence. `perThreat` (default 4) lists at most that many answers per primary threat before answers that repeat a threat (`capped` counts them), and `threatsCovered` counts the shown answers per threat the defended archetypes pose (staples and additions together). `minPerThreat` (0-5, default 1) reserves a page slot for the best answer of every fired threat before the rank fill, taking an answer under the 2% floor when nothing above it answers (`reserved: true`, `hiddenByFloor: true`), so a threat reads 0 only when no answer exists in the pool. The output splits into `staples` (already in the deck, or played by 50% or more of the leader's lists) and `additions` (the rest, so a builder sees what to add first; `limit` applies to these). An answer whose every offer defeats or damages all or each unit of both sides (a sweep such as Single Reactor Ignition) carries `symmetric: true` and sorts after the other answers of its coverage band when the decklist runs 30 or more units or the leader's lists average more than 30 (`symmetricSweeps` states the count). The answer relations are the committed table `data/counters.json`. A deck-evidence figure whose decks without the card number fewer than the smaller of 10% of the comparable decks and 50 decks reads `evidenceClass: thin-control` (`deckEvidence.thinControl`: the decks without this card are N of M comparable decks: not a control group) instead of ok.
- `leader_cards` the cards a leader's decklists actually play: every card in all of the leader's decks in the meta window (tournament decklists; community lists only when the leader has no tournament deck, and the output says so), with placement-weighted inclusion, mean copies, baseline inclusion across the decks whose leader and base aspects could play the card, and lift over that baseline. `sortBy` is `inclusion` (raw popularity) or `lift`; the output names the population, window and deck count, with `status: fact`.

Provenance

- `data_version` package date, rubric version, code commit and input hashes behind every score.

### Resources and prompts

- `swu://rubric` the card value rubric, `swu://glossary` the game glossary (JSON), `swu://usage-guide` which tool answers which question, `swu://rules/{section}` one Comprehensive Rules section, and `rules://core-primer`. The rubric and glossary are read from the data package's `docs/`, so an npx install serves them.
- Prompts `rules_question` (find the rule, find the ruling, answer with citations), `build_deck_for_leader` and `meta_defense` (archetypes, threats, answers checked against card text and rulings, then `deck_audit` with the swaps). The Claude Code skill `.claude/skills/swu-meta-defense` follows the same steps.

## Data pipeline

One command rebuilds every data product from mault's originals:

    pnpm build:data [--originals <dir>] [--date <YYYY-MM-DD>]

It runs these steps in order and stops at the first failure:

- `export:package` the raw card-list pages and price files to `llm/` (cards, facet indexes, name index), `docs/` and `replay.json`. It verifies every page against the manifest hashes first.
- `card-features` parses every card's text into triggers, effects, offers and wants (`features/`), and adds each base's printed location to its traits from the pinned capture in `data/pinned/base-locations/` (`pnpm tsx scripts/pinned/capture-base-locations.ts --engine <forceteki clone>` makes it; the official API ships bases with empty traits).
- `score` the deterministic rubric scores (`scores/`).
- `synergy` pairs, trios and fungibility classes (`synergy/`).
- `market` prices and play statistics (`market/`).
- `rules:fetch` the Comprehensive Rules sections, card rulings, keyword links and the core primer (`rules/`). It reads the pinned PDF under `data/originals/rules/<version>/` when one exists and downloads it otherwise.
- `similarity` similar, kin, clusters and vectors from the pinned embedding capture (`similarity/`). No model runs here; `pnpm embed:capture` is the one model call and its output is pinned in `data/pinned/embeddings/`.
- `meta` archetypes and win-rate aggregates (`meta/`) from the newest deck snapshot under `data/originals/decks/<date>/`, and the pinned tournament matchup capture under `data/originals/tournaments/<date>/` (`pnpm meta:capture-matchups`, once). Premier decks only. Card evidence rows need 10 or more decisive matches both with and without the card. Both inputs are git-ignored; their hashes go into `meta/replay.json`. The step reads no Karabast data: `meta/` ships in the data release.

Output goes to `data/runs/<date>/` (git-ignored). `build.json` there records each step's replay hash, the sha256 of every output file, the code commit and the wall time. The `buildHash` in it covers the replay hashes (code commits removed) and every output hash, and leaves out the code commit and wall times, so two builds of the same inputs have the same `buildHash`. Individual steps can still run alone, for example `pnpm score`.

Every step is a replayable transform: deterministic code, pinned inputs, byte-identical output. Model output enters only as captured, hashed input.

## The data package

    pnpm package:zip [--data <run dir>] [--out <dir>] [--no-zip]

Assembles the zip for readers (default destination: the iCloud `_temp` folder) from a built run. It is staged under `data/packages/<date>/` first. The zip is deterministic: the same build gives the same bytes. Layout:

- `README.md` the entry point: what each file is for, the image URL prefix, how files join, what to load first, honest limits.
- `llm/` everything a reader loads: `cards.toon` with `playCalibrated`, `total` and `cluster` columns; `legend.toon` (every definition, shipped once); `index/` with the facet indexes, names, `similar`, `kin`, `clusters`, `pairings` (top 10 per card), `trios` (top 200 per shape, total cost 9 or less) and `fungible` (classes with at least two members); `rules/` with the core primer and the dated card rulings.
- `optional/vectors.toon` 128-dimension int8 vectors, with the decode recipe in the zip README.
- `audit/` build records, JSON Schemas, the list of printing disagreements and the rubric derivation. A reader can skip it.
- `docs/` the card data field guide and a rubric summary.

`audit/package.json` in the zip lists the sha256 and token count of every file. Token counts use gpt-tokenizer `o200k_base`, a proxy, and are dev-only.

## Honest limits

- Pairings, trios and fungible substitutes are candidates, not facts. Sampled reviews ([round 1](docs/verification/2026-10-16.md), [round 2](docs/verification/2026-10-17-round2.md)) found card-text features wrong on about 1 card in 5. On the committed 200-pair benchmark ([pairs-v1](docs/verification/2026-10-17-pair-fixture.md)), about 79% of pairings are genuine (95% interval 72–84%), so about 1 in 5 is wrong; mechanical links alone are 75% (68–82%) and trait links 94% (80–98%), and some rows (discard, draw, ramp) are much weaker. `pnpm verify:pairs` re-measures it. About 1 pair in 5 (16,112 of 74,530) links two cards only through a shared trait; those tribal links are obvious and mostly right, so the pairing and trio tools rank mechanical links by default and list trait-only pairs apart. Against real play ([real-play benchmark](docs/verification/real-play-2026-10-17.md)), whose headline figures leave trait-only pairs out, suggested pairs appear together in 32,699 Premier decklists (December 2025 to October 2026, mostly tournament) more often than matched random partners (0.08 log-lift, card-clustered 95% interval 0.04–0.12; trait-only pairs alone 0.67), a modest margin; the pair score does not rank them by how often they are played together (#22). Confirm a pairing against both cards' text before relying on it. Copied data is exact: card fields, rulings, prices, play stats and rules sections passed a full deterministic audit against the originals with no failures.
- Meta answers are candidates. The counter table checks parsed cost, HP, power, arena and trait limits against each archetype's key units, and a removal target with a condition it cannot read never counts; parsed card text is still wrong on about 1 card in 5. The deck evidence beside each answer is association, not effect: decks that run a card may differ in pilots and in the rest of the list, and swumetastats publishes no per-match pairings, so a deck's record is against its whole field. A local-only benchmark ([method](docs/verification/meta-defense-2026-10-17.md)) checks the answers against private game outcomes; its numbers are not published.
- The play data is thin. It is online Karabast and Petranaki games in three Premier windows, not tournaments. Homeworlds (HMW) has under one week of play data and is outside the play fit.
- Prices mostly follow rarity. They are US TCGplayer prices from one import, so cheap commons dominate any value-per-dollar ranking.
- `total` is comparable only within a card type. `playCalibrated` is rank-meaningful only and is fitted to the same play data it is compared with, so a gap between score and play is partly circular.
- The Comprehensive Rules version check is manual: run `pnpm rules:check` (exit 0 current, 10 newer available, 2 error). Nothing schedules it.
- The scope is the logical cards with a printing in Jump to Lightspeed or a later set, which matches Premier legality.
- Base locks come from the location printed on each base, pinned from the forceteki engine's card data (decision D59). Every one of the 69 bases in the card table has a pinned location; no base is without one. A lock is read only from a card's own clause text: a lock in a leader or base ability is not flagged, and the cluster gaps of `deck_audit` do not look at locks. An aspect-unit lock counts the leader's, the base's and the deck's aspects as supplying a unit, although a base is not a unit.

## Commands

    pnpm install --store-dir "/Volumes/Local Files/.pnpm-store"
    pnpm typecheck
    pnpm lint
    pnpm test                 # unit tests; tests/e2e.test.ts also runs when data/runs holds a built run
    pnpm mcp                  # the stdio server
    pnpm build:data           # rebuild every data product
    pnpm meta:capture-matchups --from <d> --to <d>   # pin the tournament matchups once
    pnpm bench:meta-defense   # local only: meta answers against private game outcomes; report stays in data/runs/<date>/verify/
    pnpm package:zip          # assemble the reader zip
    pnpm release:data         # deterministic data release archive and pin
    pnpm build              # bundle dist/server.js
    pnpm fit:coefficients [--check]
    pnpm rules:check [--verify-hash]

`tests/e2e.test.ts` starts the real server over stdio, lists the tools, calls every one with valid arguments and reads `rules://core-primer`. It has an arguments entry per tool and fails if a registered tool lacks one. It skips when `data/runs` has no dated run.

## Verification

    pnpm verify:audit                # deterministic audit of every derived product
    pnpm verify:pair-fixture         # 200-pair stratified sample -> tmp/pair-fixture/packets/p1..p8.json (+ index.json)
    pnpm verify:pair-fixture:pin     # pin the captured verdicts -> data/fixtures/pairs-v1.json (committed, byte-identical on rerun)
    pnpm verify:pairs [--run <dir>]  # pairing precision and recall-of-correct vs the fixture -> <run>/verify/pair-precision.json
    pnpm bench:extract-games         # human Karabast games -> data/originals/karabast/games-<sha12>.jsonl.gz (private, git-ignored)
    pnpm bench:extract-decks [--snapshot <dir> ...]   # decklist snapshots -> data/originals/decks/decks-<sha12>.json
    pnpm bench:extract-sims          # forceteki bot-vs-bot game records -> data/originals/sims/sims-<sha12>.jsonl.gz
    pnpm bench:real-play [--run <dir>]   # real-play benchmark -> <run>/verify/real-play.json + docs/verification/real-play-<date>.md (public) + <run>/verify/real-play-full.md (local, git-ignored)

The pair fixture is a labelled benchmark: model verdicts are captured once under `tmp/pair-fixture/verdicts/` (and `adjudication/`), then pinned. `verify:pairs` only reads the pinned file.

The real-play benchmark ([2026-10-17 summary](docs/verification/real-play-2026-10-17.md)) checks the run's pairs, trios and fungible classes against 32,699 Premier decklists (two snapshots, mostly tournament decks) and, as a separate source, forceteki bot-vs-bot simulations. It reports deck co-inclusion lift and leader-stratified win-rate differences per complementarity row, each against matched random partners. A human-game analysis also runs, but its figures stay in a local git-ignored report and are not published (decision D22 in [docs/decisions.md](docs/decisions.md)).

## Layout

- `src/` the MCP server. `server.ts` is the stdio entry, `data-source.ts` resolves and downloads the data, `data-release.json` pins the release, `create-server.ts` registers the tools, `tools.ts` and `tools/` hold the handlers, `data.ts` loads and validates the package.
- `src/swu/` the flatten pipeline ported from mault. `src/scorer/`, `src/ability-grammar/`, `src/synergy/`, `src/market/`, `src/rules/`, `src/embed/` the transforms behind each step. `src/package/` the zip tables and README.
- `scripts/` one script per step, `build-data.ts`, `package-zip.ts`. `scripts/curation/`, `scripts/rubric/` and `scripts/embed/` are research scripts.
- `data/curated-rules.json` the curated ability table and `data/complementarity.json` the pair table (pinned inputs). `data/pinned/` small pinned captures with hashes. `data/runs/<date>/` and `data/packages/<date>/` generated output (git-ignored).
- `docs/` field guide, JSON Schemas, glossary, value rubric and the tool catalogue (`docs/mcp-tool-catalogue.md`).

## The mault boundary

mault owns the raw card-list cache (`~/.local/state/mault/raw/swu-cards`) and TCGplayer price conformance. It writes `/Volumes/Local Files/Projects/mault/data/swu-originals/<date>/`, which swu-mcp reads as pinned input and never writes to.

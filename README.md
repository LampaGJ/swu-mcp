# swu-mcp

Star Wars: Unlimited (SWU) card data, deterministic card scoring, synergy discovery and card similarity, served to AI assistants over the Model Context Protocol (MCP, stdio). Every number comes from deterministic code over pinned inputs. No model runs at query time and none decides a score.

Status: MVP (swu-mcp#7). All 28 tools below are served and an end-to-end test calls each one over real stdio. One command rebuilds every data product.

## Register the server

    claude mcp add swu-mcp -- pnpm --silent --dir "/Volumes/Local Files/Projects/swu-mcp" mcp

`--silent` is required: without it pnpm prints a banner to stdout, which corrupts the MCP stdio stream. The server reads the newest `data/runs/<date>/`. Set `SWU_MCP_DATA` to a run directory to use another one. It logs the card count to stderr at start. It also serves the resource `rules://core-primer`, the verbatim core Comprehensive Rules.

Tool results are TOON, a compact table format (column names once, then one line per row), not JSON. Failures set `isError` with a plain sentence. All tools are read-only.

## Tools (28)

Cards and search

- `get_card` one logical card in full, by `cardKey` or exact title and optional subtitle.
- `search_cards` substring search over title, subtitle and text, narrowed by type, aspect, trait, keyword, set and max cost.
- `list_facet` every value of one facet (aspect, trait, keyword, type, arena, rarity, expansion, variant) with count and definition.
- `cards_by_facet` the cards that carry one facet value.

Value

- `score_card` rubric score of one card with a one-line explanation per component and the play-calibrated score.
- `rank_cards` cards ranked by play-calibrated score, total or stat efficiency, with filters.
- `compare_cards` two to five cards side by side.
- `explain_rubric` the formula, vanilla curve, weights, T(cost) and fitted terms with their sources.

Text features

- `card_features` parsed triggers, effects, conditions, offers and wants of one card, clause by clause.
- `find_by_effect` cards that produce an effect category, or whose synergy tags offer or want a fragment.

Synergy and combos

- `find_pairings` enablers that feed a card and payoffs it feeds, with reason, score, aspect penalty and fungible alternatives.
- `find_trios` three-card combos (chain, two enablers into one payoff, loop) ranked with a bonus for low total cost.
- `explain_synergy` link-by-link reasons why two or three cards pair.
- `aspect_cover` leader and base aspect combinations ranked by the penalty for a set of cards.

Fungibility and substitutes

- `fungible_substitutes` cards that fill the same role as a card, grouped by aspect.

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

Similarity

- `similar_cards` cards whose rules text reads most like this card's (embedding cosine).
- `kin_cards` cards that do the same kind of thing under different labels (names, traits, keywords, aspects and numbers masked).
- `cluster` one of 32 role clusters, by id or by a member card.

Provenance

- `data_version` package date, rubric version, code commit and input hashes behind every score.

## Data pipeline

One command rebuilds every data product from mault's originals:

    pnpm build:data [--originals <dir>] [--date <YYYY-MM-DD>]

It runs these steps in order and stops at the first failure:

- `export:package` the raw card-list pages and price files to `llm/` (cards, facet indexes, name index), `docs/` and `replay.json`. It verifies every page against the manifest hashes first.
- `card-features` parses every card's text into triggers, effects, offers and wants (`features/`).
- `score` the deterministic rubric scores (`scores/`).
- `synergy` pairs, trios and fungibility classes (`synergy/`).
- `market` prices and play statistics (`market/`).
- `rules:fetch` the Comprehensive Rules sections, card rulings, keyword links and the core primer (`rules/`). It reads the pinned PDF under `data/originals/rules/<version>/` when one exists and downloads it otherwise.
- `similarity` similar, kin, clusters and vectors from the pinned embedding capture (`similarity/`). No model runs here; `pnpm embed:capture` is the one model call and its output is pinned in `data/pinned/embeddings/`.

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

- Tag precision is unmeasured. The offers and wants tags behind pairings, trios and fungible classes come from a grammar plus a hand-reviewed table, and no labelled test set measures how often they are right.
- The play data is thin. It is online Karabast and Petranaki games in three Premier windows, not tournaments. Homeworlds (HMW) has under one week of play data and is outside the play fit.
- Prices mostly follow rarity. They are US TCGplayer prices from one import, so cheap commons dominate any value-per-dollar ranking.
- `total` is comparable only within a card type. `playCalibrated` is rank-meaningful only and is fitted to the same play data it is compared with, so a gap between score and play is partly circular.
- The Comprehensive Rules version check is manual: run `pnpm rules:check` (exit 0 current, 10 newer available, 2 error). Nothing schedules it.
- The scope is the logical cards with a printing in Jump to Lightspeed or a later set, which matches Premier legality.

## Commands

    pnpm install --store-dir "/Volumes/Local Files/Projects/.pnpm-store"
    pnpm typecheck
    pnpm lint
    pnpm test                 # unit tests; tests/e2e.test.ts also runs when data/runs holds a built run
    pnpm mcp                  # the stdio server
    pnpm build:data           # rebuild every data product
    pnpm package:zip          # assemble the reader zip
    pnpm fit:coefficients [--check]
    pnpm rules:check [--verify-hash]

`tests/e2e.test.ts` starts the real server over stdio, lists the tools, calls every one with valid arguments and reads `rules://core-primer`. It has an arguments entry per tool and fails if a registered tool lacks one. It skips when `data/runs` has no dated run.

## Layout

- `src/` the MCP server. `server.ts` is the stdio entry, `create-server.ts` registers the tools, `tools.ts` and `tools/` hold the handlers, `data.ts` loads and validates the package.
- `src/swu/` the flatten pipeline ported from mault. `src/scorer/`, `src/ability-grammar/`, `src/synergy/`, `src/market/`, `src/rules/`, `src/embed/` the transforms behind each step. `src/package/` the zip tables and README.
- `scripts/` one script per step, `build-data.ts`, `package-zip.ts`. `scripts/curation/`, `scripts/rubric/` and `scripts/embed/` are research scripts.
- `data/curated-rules.json` the curated ability table and `data/complementarity.json` the pair table (pinned inputs). `data/pinned/` small pinned captures with hashes. `data/runs/<date>/` and `data/packages/<date>/` generated output (git-ignored).
- `docs/` field guide, JSON Schemas, glossary, value rubric and the tool catalogue (`docs/mcp-tool-catalogue.md`).

## The mault boundary

mault owns the raw card-list cache (`~/.local/state/mault/raw/swu-cards`) and TCGplayer price conformance. It writes `/Volumes/Local Files/Projects/mault/data/swu-originals/<date>/`, which swu-mcp reads as pinned input and never writes to.

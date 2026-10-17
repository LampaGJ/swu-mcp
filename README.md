# swu-mcp

Star Wars: Unlimited (SWU) card data, deterministic card scoring, synergy discovery and card similarity, served to AI assistants over the Model Context Protocol (MCP, stdio). Every number comes from deterministic code over pinned inputs. No model runs at query time and none decides a score.

Status: MVP (swu-mcp#7). All 45 tools below are served and an end-to-end test calls each one over real stdio. One command rebuilds every data product.

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

`release:data` writes `tmp/release/swu-mcp-data-<date>.tar.gz` and the pin file, then prints the `gh release create` command. It does not run it. The archive holds `docs` (read by the rubric and glossary resources), `llm`, `features`, `scores`, `synergy`, `market`, `rules`, `similarity` and the build records, with sorted entries and fixed times, owners and modes, so the same run gives the same bytes. Commit the pin together with the release.

### From a checkout

    claude mcp add swu-mcp -- pnpm --silent --dir "/path/to/swu-mcp" mcp

`--silent` is required: without it pnpm prints a banner to stdout, which corrupts the MCP stdio stream. The server logs the card count to stderr at start. It also serves the resource `rules://core-primer`, the verbatim core Comprehensive Rules.

Tool results are TOON, a compact table format (column names once, then one line per row), not JSON. Failures set `isError` with a plain sentence. All tools are read-only.

## Read more

- [What it does](docs/public/what-it-does.md), in plain words.
- [How it was built](docs/public/how-we-built-it.md).
- [The Claude Code setup behind it](docs/public/claude-code-setup.md).
- [Verification report](docs/verification/2026-10-16.md).

## Tools (45)

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

- `find_pairings` enablers that feed a card and payoffs it feeds, with reason, score, aspect penalty, fungible alternatives and the clause text (clipped to 160 characters) behind each offer and want. Every row carries `status: candidate`; `evidence: false` drops the text.
- `find_trios` three-card combos (chain, two enablers into one payoff, loop) ranked with a bonus for low total cost, each with the clause text behind its links and `status: candidate`.
- `explain_synergy` link-by-link reasons why two or three cards pair, with the clipped clause text behind each tag and `status: candidate`.
- `aspect_cover` leader and base aspect combinations ranked by the penalty for a set of cards.

Fungibility and substitutes

- `fungible_substitutes` cards that fill the same role as a card, grouped by aspect, with the role's clause text for the slot card and each substitute and `status: candidate`.

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

- `deck_audit` one-call report on a decklist under a leader and base: curve against the rubric's stat curve, mean score, aspect penalty per card, orphan wants and role-cluster gaps.
- `deck_legality_check` exactly 1 leader and 1 base, 50 other cards (or the base's changed minimum), 3 copies at most, no tokens, Premier cardpool, each failure with its Comprehensive Rules section (9.2.2.a to d, 8.5.5, 1.2.3, 3.2.1.a). No ban or suspension ledger, no asOf date and no sideboard check yet.
- `suggest_leader_base` leader and base aspect pairs ranked by the penalty for a pile of cards.
- `playable_cards` the best cards for a leader and base, by cost, optionally filling the costs of a partial pile.
- `fungible_in_deck` same-role substitutes per deck slot, least aspect penalty first.
- `budget_alternatives` cheaper same-role substitutes with the saving and the score change.
- `price_list` total US price of a deck or collection, with the top share and totals by first set, rarity, aspect or type.
- `trade_balance` two lists compared by market price, low price and rubric score.
- `owned_vs_needed` a decklist against an owned list: missing copies, cost to complete, owned substitutes.
- `play_value_vs_price` cards most or least played per dollar, from the SWU Stats capture.
- `score_vs_play` cards whose rubric rank and play rank disagree (the designer total by default, because the play-calibrated score is fitted to the same play data).

Provenance

- `data_version` package date, rubric version, code commit and input hashes behind every score.

### Resources and prompts

- `swu://rubric` the card value rubric, `swu://glossary` the game glossary (JSON), `swu://usage-guide` which tool answers which question, `swu://rules/{section}` one Comprehensive Rules section, and `rules://core-primer`. The rubric and glossary are read from the data package's `docs/`, so an npx install serves them.
- Prompts `rules_question` (find the rule, find the ruling, answer with citations) and `build_deck_for_leader`.

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

- Pairings, trios and fungible substitutes are candidates, not facts. Sampled reviews ([round 1](docs/verification/2026-10-16.md), [round 2](docs/verification/2026-10-17-round2.md)) found card-text features wrong on about 1 card in 5. On the committed 200-pair benchmark ([pairs-v1](docs/verification/2026-10-17-pair-fixture.md)), about 74% of pairings are genuine (95% interval 67–80%), so about 1 in 4 is wrong; some rows (discard, draw, ramp) are much weaker. `pnpm verify:pairs` re-measures it. Confirm a pairing against both cards' text before relying on it. Copied data is exact: card fields, rulings, prices, play stats and rules sections passed a full deterministic audit against the originals with no failures.
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

The pair fixture is a labelled benchmark: model verdicts are captured once under `tmp/pair-fixture/verdicts/` (and `adjudication/`), then pinned. `verify:pairs` only reads the pinned file.

## Layout

- `src/` the MCP server. `server.ts` is the stdio entry, `data-source.ts` resolves and downloads the data, `data-release.json` pins the release, `create-server.ts` registers the tools, `tools.ts` and `tools/` hold the handlers, `data.ts` loads and validates the package.
- `src/swu/` the flatten pipeline ported from mault. `src/scorer/`, `src/ability-grammar/`, `src/synergy/`, `src/market/`, `src/rules/`, `src/embed/` the transforms behind each step. `src/package/` the zip tables and README.
- `scripts/` one script per step, `build-data.ts`, `package-zip.ts`. `scripts/curation/`, `scripts/rubric/` and `scripts/embed/` are research scripts.
- `data/curated-rules.json` the curated ability table and `data/complementarity.json` the pair table (pinned inputs). `data/pinned/` small pinned captures with hashes. `data/runs/<date>/` and `data/packages/<date>/` generated output (git-ignored).
- `docs/` field guide, JSON Schemas, glossary, value rubric and the tool catalogue (`docs/mcp-tool-catalogue.md`).

## The mault boundary

mault owns the raw card-list cache (`~/.local/state/mault/raw/swu-cards`) and TCGplayer price conformance. It writes `/Volumes/Local Files/Projects/mault/data/swu-originals/<date>/`, which swu-mcp reads as pinned input and never writes to.

# swu-mcp

Star Wars: Unlimited (SWU) card data, deterministic card scoring, synergy discovery and embeddings, served to AI assistants over the Model Context Protocol (MCP).

Status: bootstrapped 2026-10-16 (swu-mcp#4). The data package pipeline, the deterministic scorer (#1) and eleven read-only MCP tools work. Embeddings capture and pairings are follow-ups (#2, #3).

## Layout

- `src/` the MCP server. `server.ts` is the stdio entry, `create-server.ts` registers the tools, `tools.ts` holds the tool handlers, `data.ts` loads and validates the package.
- `src/swu/` the flatten pipeline ported from mault (`llm-flatten.ts`, `llm-package-readme.ts`) plus the small mault helpers it needs (`canonical.ts`, `set-rotation.ts`, `raw-manifest.ts`). Each file names its mault source path.
- `scripts/export-swu-data-package.ts` builds the data package from a mault originals folder.
- `src/scorer/` the deterministic scorer (features, coefficients schema, scoring, scores-file schema). `src/tools/value.ts` the seven value tools. `scripts/fit-coefficients.ts` refits `data/rubric-coefficients.json` from the pinned captures (`pnpm fit:coefficients`, `--check` replays it); `scripts/score.ts` writes `data/runs/<date>/scores/` (`pnpm score`).
- `scripts/market.ts` (`pnpm market`) builds `data/runs/<date>/market/{prices,play,replay}.json` from mault's price originals and the pinned SWU Stats captures; `src/tools/market.ts` serves `card_price`, `play_stats` and `value_vs_price` from them.
- `pnpm rules:check` compares the pinned Comprehensive Rules (PDF size, official page links, rules articles from `admin.starwarsunlimited.com/api/articles`) with the live sources. Exit 0 current, 10 newer available, 2 network or input error. Add `--verify-hash` to also download the PDF and compare its sha256. Nothing schedules it.
- `scripts/curation/` worklist, merge and shape-check scripts for the curated ability table. `scripts/rubric/` the value-rubric fitting scripts. `scripts/embed/` the embedding experiments (Python, pinned in `requirements.txt`). All three are prototypes; their READMEs list the path caveats.
- `data/curated-rules.json` the curated ability table, v2, 195 entries (pinned input). `data/pinned/` small pinned captures with their hashes. `data/runs/<date>/` generated packages (git-ignored). `data/rubric/` generated rubric outputs (git-ignored).
- `docs/` field guide, JSON Schemas, glossary and value rubric, copied from mault.
- `tests/` Vitest tests. `tests/fixtures/llm/` is a nine-card package produced by `scripts/make-test-fixture.ts`.

## Commands

    pnpm install --store-dir "/Volumes/Local Files/Projects/.pnpm-store"
    pnpm typecheck
    pnpm test
    pnpm lint
    pnpm export:package [--originals <dir>] [--out <dir>] [--runs <dir>]
    pnpm mcp
    pnpm fit:coefficients [--check]
    pnpm score [--data <package dir>]

`pnpm export:package` verifies every raw page against the manifest hashes, rebuilds the package in `data/runs/<date>/` and writes `swu-data-<date>.zip` to `~/Library/Mobile Documents/com~apple~CloudDocs/_temp`. It writes `replay.json` with the hash of every input and output. The same originals give byte-identical `llm/` files. On 2026-10-16 it reproduced mault's `llm/cards.toon` and every `llm/index/*.toon` exactly.

## The mault boundary

mault owns the raw card-list cache (`~/.local/state/mault/raw/swu-cards`) and TCGplayer price conformance. It writes `/Volumes/Local Files/Projects/mault/data/swu-originals/<date>/` with `swu-cards/raw-pages/` and `tcgplayer-prices/`. swu-mcp reads that folder as pinned input and never writes to mault.

## MCP server

Register it with Claude Code:

    claude mcp add swu-mcp -- pnpm --silent --dir "/Volumes/Local Files/Projects/swu-mcp" mcp

`--silent` is required: without it pnpm prints a banner to stdout, which corrupts the MCP stdio stream.

The server loads `llm/cards.toon` and `llm/index/*.toon` from the newest `data/runs/<date>/`. Set `SWU_MCP_DATA` to a package directory (or its `llm/` directory) to use another one. It logs the card count to stderr at start.

Output format: tool results are TOON, not JSON. TOON states column names once for a list of uniform rows, so a list of cards costs fewer tokens than the same JSON (not measured here), and it is the format the data package already uses. Single objects render as plain `key: value` lines. Failures set `isError` with a plain sentence.

Tools (all read-only):

- `get_card` one logical card in full, by `cardKey` or by exact title with an optional subtitle (case-insensitive). A title shared by several cards returns them all.
- `search_cards` case-insensitive substring over title, subtitle and text, narrowed by optional `type`, `aspect`, `trait`, `keyword`, `set` and `maxCost`, with `limit` (default 20, at most 200). Returns the total match count and summary rows.
- `list_facet` every value of one facet (aspect, trait, keyword, type, arena, rarity, expansion, variant) with card count and definition.
- `cards_by_facet` the cards for one facet value, with `limit`.
- `score_card` rubric score of one card with a one-line explanation per component and the play-calibrated score.
- `rank_cards` cards ranked by `playCalibrated` (default), `total` or `statEfficiency`, filtered by set, aspect, type, arena, cost range, keyword and trait. `total` and `statEfficiency` compare within one type.
- `compare_cards` two to five cards side by side.
- `card_features` parsed triggers, effects, conditions, offers and wants for one card, with grammar or curated provenance per clause.
- `find_by_effect` cards producing an effect category, filtered by target side, target arena and trigger timing; or cards offering or wanting a synergy tag.
- `explain_rubric` the formula, vanilla curve, weights, T(cost) and fitted terms with their sources.
- `data_version` package date, rubric version, code commit, coefficients hash and input hashes.

The value tools read `<package>/features/` (from `pnpm card-features`) and `<package>/scores/` (from `pnpm score`) next to `llm/`, and fail with a plain message when either is missing.

The server scope is the package's logical cards: sets from Jump to Lightspeed on (see `docs/concepts/swu-card-data-fields.md`). Scoring is deterministic and will never call a model.

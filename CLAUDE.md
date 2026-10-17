# CLAUDE.md

swu-mcp serves Star Wars: Unlimited card data, deterministic card scoring and synergy discovery to AI assistants over MCP (stdio). Stack: Node >= 22, TypeScript (strict, NodeNext), pnpm, Vitest, tsx, Zod 4, `@modelcontextprotocol/sdk`, `@toon-format/toon`.

## Commands

```bash
pnpm install --store-dir "/Volumes/Local Files/.pnpm-store"
pnpm typecheck
pnpm test
pnpm lint
pnpm mcp                      # stdio MCP server (src/server.ts)
pnpm build:data [--originals <dir>] [--date <d>]   # rebuild every data product in order (export:package, card-features, score, synergy, market, rules:fetch, similarity) and write data/runs/<date>/build.json
pnpm package:zip [--data <run dir>] [--out <dir>] [--no-zip]   # assemble the lean reader zip (llm/, optional/, audit/, docs/) from a built run
pnpm export:package [--originals <dir>] [--runs <dir>] [--date <d>]   # build llm/ from mault's originals (no zip)
pnpm rules:fetch [--url <pdf>] [--pdf <file>] [--originals <dir>]   # Comprehensive Rules PDF -> data/runs/<date>/rules (sections, card rulings, keyword links, core primer)
pnpm rules:check [--data <dir>] [--verify-hash]   # is the pinned CR still the newest? exit 0 current, 10 newer, 2 error
pnpm market [--data <dir>] [--originals <dir>] [--captures <dir>]   # prices.json, play.json -> data/runs/<date>/market
pnpm embed:capture            # the one model call: Ollama nomic-embed-text -> data/pinned/embeddings/<renderVersion>-<hash12>/ (pinned, refuses to overwrite)
pnpm similarity               # deterministic: pinned vectors -> data/runs/<date>/similarity/ (similar, kin, clusters, vectors, replay)
pnpm verify:audit             # nine deterministic checks of every derived product against the originals -> data/runs/<date>/verify/audit.json (exit 1 on any failure)
pnpm verify:sample            # seeded evidence packets for semantic verification -> tmp/verify/packets/ (8 packets + index.json with the verdict schema)
pnpm verify:pair-fixture      # stratified 200-pair sample -> tmp/pair-fixture/packets (judged by haiku, adjudicated by sonnet)
pnpm verify:pair-fixture:pin --dir data/pinned/pair-fixture-v1   # pinned verdicts -> data/fixtures/pairs-v1.json (byte-identical)
pnpm verify:pairs [--run <dir>]   # pairing precision / recall against pairs-v1, per complementarity row
pnpm release:data --date <d>  # deterministic release tarball + src/data-release.json pin (see Release below)
```

## Release

The server downloads its data from a GitHub Release pinned by `src/data-release.json`. Order: `pnpm build:data --date <d>`, `pnpm verify:audit --run data/runs/<d>`, `pnpm release:data --date <d>`, commit the pin, gitleaks-scan the outgoing commits, push main, `git tag data-<d>` + `git push origin data-<d>`, then `gh release create data-<d> <tarball> --verify-tag` (gh's token lacks the workflow scope, so the tag is pushed with git). Verify with a clean `npx -y github:LampaGJ/swu-mcp` in a scratch dir with `SWU_MCP_CACHE` set. The repo is public: only the owner asks for pushes.

## Accuracy, honestly

Copied data is exact (`verify:audit`). Parsed card text is wrong on about 1 card in 5; pairings are about 74% precise on pairs-v1 (docs/verification/2026-10-17-pair-fixture.md), so pairing, trio and substitute tools return clause evidence with `status: candidate`. Any matcher change is measured with `pnpm verify:pairs` before and after; re-label only by adding a new fixture version.

## Private data

Karabast spectated human games (`/Volumes/Models/swu/human-games/`) are private player data. Raw rows and per-game extracts live only in git-ignored `data/originals/karabast/`; commit code, synthetic-fixture tests and aggregate results only. Never commit player names, player ids or game ids.

The system disk is full: work only under `/Volumes/Local Files/Projects`, and run tools that need temp space with `TMPDIR` set to `<repo>/tmp` (git-ignored).

## Layout

- `src/` library and MCP server. `src/swu/` holds the flatten pipeline (ported from mault) and package README builder.
- `scripts/export-swu-data-package.ts` builds llm/; `scripts/build-data.ts` runs every step; `scripts/package-zip.ts` and `src/package/` build the reader zip. `scripts/curation/`, `scripts/rubric/`, `scripts/embed/` are research scripts (Node `.mjs`, Python).
- `src/tools/` holds the tool groups (value, synergy, market, rules, similarity, catalog, deck), registered in `src/tools.ts`; `src/resources.ts` serves the `swu://` resources and the two prompts. The README tool list is the user-facing catalogue; `tests/e2e.test.ts` fails if a registered tool has no e2e arguments.
- `data/fixtures/pairs-v1.json` is the labelled pairing benchmark; its model verdicts are pinned in `data/pinned/pair-fixture-v1/`.
- `src/rules/` parses the Comprehensive Rules; `src/tools/rules.ts` serves them. `data/rules-core.json` is the ordered core-rule list (boosts search, feeds the primer). The CR PDF lives in git-ignored `data/originals/rules/<version>/`.
- `data/curated-rules.json` is the curated ability table (pinned input). `data/runs/<date>/` is generated output (git-ignored). `data/pinned/` holds small pinned captures.
- `docs/` field guide, JSON Schemas, glossary, value rubric. Copied from mault; edit here from now on.

## Mault boundary

mault owns the raw card-list cache (`~/.local/state/mault/raw/swu-cards`) and TCGplayer price conformance. It writes `/Volumes/Local Files/Projects/mault/data/swu-originals/<date>/`, which swu-mcp reads as pinned input. mault and mault-train are read-only from here: never write to them.

## Data doctrine (owner standing rules)

- Every data manipulation is reproducible: deterministic code, committed, replayable from a pinned input to a byte-identical output.
- Hand-edited data is illegal. If a file needed fixing by hand, the fix is a committed transform step.
- Model calls are captured once as pinned, hashed inputs, never run inline.
- Banned inside a manipulation: `Date.now()`, `Math.random()`, locale-sensitive sort keys (use `compareCodePoints`).
- Zod v4 shapes only: `z.iso.*`, `z.strictObject`, the `{ error }` param, two-arg `z.record`. Schemas are the trust boundary: parse at every foreign-data seam.
- Default to frameworks; roll your own only as a documented exception.
- Scripts that run longer than ~30 s emit pollable progress with `scripts/lib/progress.mjs` to `reports/.progress/<job>.json`.

## No model in the scoring path

Card scoring is fully deterministic. No LLM call, embedding lookup or other model output decides a score at runtime. Models may only produce captured, hashed inputs (for example curated tables) that deterministic code then reads.

## Git

Stage explicit paths, never `git add -A`, `.` or `-u`. One logical change per commit. Do not push without the owner asking.

## Code style

Comment only what the code cannot say: a non-obvious constraint, an external quirk, a surprising invariant.

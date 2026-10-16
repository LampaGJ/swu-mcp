# CLAUDE.md

swu-mcp serves Star Wars: Unlimited card data, deterministic card scoring and synergy discovery to AI assistants over MCP (stdio). Stack: Node >= 22, TypeScript (strict, NodeNext), pnpm, Vitest, tsx, Zod 4, `@modelcontextprotocol/sdk`, `@toon-format/toon`.

## Commands

```bash
pnpm install --store-dir "/Volumes/Local Files/Projects/.pnpm-store"
pnpm typecheck
pnpm test
pnpm lint
pnpm mcp                      # stdio MCP server (src/server.ts)
pnpm export:package [--originals <dir>] [--out <dir>]   # build the LLM data package from mault's originals
```

The system disk is full: work only under `/Volumes/Local Files/Projects`, and run tools that need temp space with `TMPDIR` set to `<repo>/tmp` (git-ignored).

## Layout

- `src/` library and MCP server. `src/swu/` holds the flatten pipeline (ported from mault) and package README builder.
- `scripts/export-swu-data-package.ts` builds the package. `scripts/curation/`, `scripts/rubric/`, `scripts/embed/` are research scripts (Node `.mjs`, Python).
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

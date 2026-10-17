---
type: decision
status: active
review_by: 2027-01-17
related: ["CLAUDE.md", "docs/specs/swu-mcp-agent.md"]
---

# Decisions and intentions

## TL;DR

This is the owner's standing intent for swu-mcp, one entry per decision, with the date, the reason and what the code must do to honour it. It is the yardstick for reviews: code that contradicts an entry is a defect, or the entry must be changed on purpose. Entries name the place each intent is meant to be enforced. A review checks the code, not this file's claims.

## Data integrity

**D1. No model in the scoring path** (2026-10-16). Card scores come from deterministic code over pinned inputs. No LLM call, embedding lookup or other model output decides a score at query or build time. Why: scores must be reproducible and explainable. Enforced in: `src/scorer/`, `data/rubric-coefficients.json`; CLAUDE.md "No model in the scoring path".

**D2. Every data manipulation is replayable** (2026-10-16). Same pinned input and code give byte-identical output, recorded as {inputHash, codeCommit, outputHash}. `Date.now()`, `Math.random()` and locale-sensitive sorts are banned inside manipulations. Hand-edited data is illegal: a fix is a committed transform or a versioned design table. Why: owner data doctrine. Enforced in: `scripts/build-data.ts` (build.json, buildHash), each step's replay record, `scripts/release-data.ts` (deterministic tarball).

**D3. Model output enters only as captured, hashed input** (2026-10-16). Examples are the curated ability table (`data/curated-rules.json`, sonnet-written, keyed by clauseSha256), the embedding capture (`data/pinned/embeddings/`) and the pair-fixture verdicts (`data/pinned/pair-fixture-v1/`). Why: D1 and D2.

**D4. Parse at every foreign-data seam with Zod v4** (2026-10-16). This covers mault originals, the Strapi pages, prices, the CR PDF, release downloads, Karabast extracts, decklists and model verdicts. Shapes use `z.strictObject`, `z.iso.*`, the `{ error }` param and two-arg `z.record`. Why: a parser that swallows a rename and returns empty is indistinguishable from a true empty.

**D5. mault owns the raw card-list cache and price conformance; swu-mcp only reads its hand-off** (2026-10-16). Input: `/Volumes/Local Files/Projects/mault/data/swu-originals/<date>/`. swu-mcp never writes to mault. Why: one owner per source.

## Scope and format

**D6. Logical cards only, Jump to Lightspeed (JTL) and later** (2026-10-16). Reprints and variants fold into one logical card; earlier-only cards are out. Deck data is Premier only: Eternal decks are excluded by an explicit format filter, never by query alone (owner ruling 2026-10-17). Why: matches Premier legality and keeps the package small. Enforced in: `src/swu/` flatten pipeline.

**D7. No card images; image URL stems only, with the prefix in the package README** (2026-10-16). Why: the owner does not need images; the stems keep them reachable.

**D8. Facet indexes for aspects, traits, keywords and the other facets** (2026-10-16). Why: efficient LLM lookup.

**D9. Tool output is TOON, not JSON** (2026-10-16). Failures set `isError` with a plain sentence. Why: token efficiency for LLM callers.

**D10. All tools are read-only** (2026-10-16). Decklists and collections arrive as arguments and nothing is stored. Why: a safe, public, stateless server.

## Synergy and similarity

**D11. Pairings come from an offers-to-wants graph, enabler to payoff, with friendly/enemy polarity and qualifier checks** (2026-10-16, refined in #11, #12, #14 and #15). The aim is non-obvious combos, for example a card that defeats your own unit feeding a When Defeated payoff. Enforced in: `src/ability-grammar/`, `src/synergy/qualifiers.ts`, `data/complementarity.json` (every offer tag has a row or a `feedsNothing` reason).

**D12. Trios favour low total cost** (2026-10-16). Shapes are chain, convergent and loop. Since #24, every trio needs at least one mechanical link. Enforced in: `src/synergy/trios.ts`.

**D13. Fungibility: same-role cards across aspects are substitutes** (2026-10-16). Why: flexibility in which card fills a chain slot. Enforced in: `src/synergy/fungibility.ts`.

**D14. Similarity uses local embeddings, captured once** (2026-10-16). The model is nomic-embed-text via Ollama, with vectors in a separate file. A surface-blind "kin" variant masks names, traits, keywords, aspects and numbers. Why: find cards that do the same thing under different labels. Enforced in: `src/embed/`, `scripts/similarity`.

**D15. Pairings, trios and substitutes are candidates, not facts** (2026-10-17, #15). Every result carries both cards' clause text and `status: candidate`. Tool descriptions tell the caller to confirm each link. Why: measured precision is about 74% overall and about 70% for mechanical links. Enforced in: `src/synergy/evidence.ts`, `src/tools/synergy.ts`.

**D16. Trait-only links do not inflate rankings or benchmarks** (2026-10-17, #24). Each pair carries `linkKind`. Mechanical links rank by default. A shared trait on a mechanical pair is a +10% bonus, not its own link. Trait-only pairs go in a separate tribal list capped at 5, controlled by `traits: exclude|bonus|include`. `wants:trait-X` is emitted only when the text rewards your own X units. Benchmarks headline excluding trait-only pairs. Enforced in: `src/synergy/graph.ts`, `src/tools/synergy.ts`, `src/ability-grammar/tags.ts`, `scripts/bench/real-play.ts`.

**D17. A "damage a base" effect with no side offers enemy-base damage** (2026-10-17, ruling on #15 item 2). Why: the player chooses the base and in play almost always picks the opponent's. Enforced in: `src/ability-grammar/tags.ts`; tests `tests/ability-grammar/regression-tags.test.ts`, `tests/synergy/pairing-coverage.test.ts`.

## Rules

**D18. Rules answers rest on the pinned Comprehensive Rules and dated official rulings** (2026-10-16). Version checks are manual. The core primer is served as `rules://core-primer` and gets a search boost. Why: correct, citable rules answers. Enforced in: `src/rules/`, `data/rules-core.json`, `.claude/skills/swu-rules/SKILL.md`.

## Measurement

**D19. Accuracy is measured, published and kept honest** (2026-10-16 onward). This includes a deterministic copy audit, sampled semantic reviews, and the fixed 200-pair benchmark pairs-v1. pairs-v1 was judged by haiku and every item was re-judged by sonnet. It is never edited; changes come as a new fixture version. Every matcher change is measured with `pnpm verify:pairs`. The README "Honest limits" section states the current numbers. Enforced in: `scripts/verify/`, `data/fixtures/pairs-v1.json`, `docs/verification/`.

**D20. Real play only measures what it could contain** (2026-10-17, #18). A pair counts only against sources captured after both cards were released. "Not observable" is never "unplayed". Intervals include a card-clustered bootstrap. Enforced in: `scripts/bench/availability.ts`, `scripts/bench/stats.ts`.

**D21. Play-data precedence** (2026-10-17). The order is: tournament results joined to decklists and placements, then tournament decklists, then community decklists, then casual online games, then bot simulations. Tiers are never pooled, and every output names its source and population. Enforced in: `scripts/bench/real-play.ts`, the #25 meta tools; CLAUDE.md "Play-data precedence".

**D22. Karabast spectated games are private** (2026-10-17). Raw rows and per-game extracts stay in git-ignored `data/originals/`. Only code, synthetic-fixture tests and aggregates are committed. No player names, player ids or game ids. Karabast-derived numbers, aggregates included, never ship in the public data release, tool output or committed docs; they are for local benchmark reports only (owner ruling 2026-10-17; figures already published earlier are removed going forward, history is not rewritten). Public win rates come from swumetastats tournament data. SWU Stats' own published play data (Karabast/Petranaki online games) is a third-party public source, not our capture: it stays, labelled casual, until tournament-based play stats replace it (owner ruling 2026-10-17). Why: Karabast terms treat deck contents as private to play.

## Product direction

**D23. Distribution: install from GitHub now, a URL later** (2026-10-17). Today it installs with `npx -y github:LampaGJ/swu-mcp`, and the data comes from a GitHub Release pinned by sha256 in `src/data-release.json`. The goal (#16) is that a new user points their agent at a web address. Pages is static, so the endpoint will be a Cloudflare Worker, linked from the Pages site. Enforced in: `src/data-source.ts`, `src/data-release.json`, `site/`.

**D24. Public repository hygiene** (2026-10-17). The repo is public. Lay docs live in `docs/public/`. No secrets or home paths in committed files. Every outgoing commit is gitleaks-scanned. Pushes happen only when the owner asks.

**D25. Deck tools state their limits instead of guessing** (2026-10-17, #5). They report ambiguous or unknown card names as unresolved. Legality checks cite CR sections and state the gaps: no ban list, no sideboard check, no date-specific legality. Enforced in: `src/tools/deck.ts`.

**D26. Planned features keep the same evidence rule** (2026-10-17). These are `leader_cards` (#19, lift over aspect baseline, not raw popularity), `overlooked_cards` (#20, interaction evidence × low inclusion, weighted by measured row precision) and meta defense (#25, archetypes from tournament decks, a pinned counter table, answers with evidence and source). Every suggestion shows its evidence and its data source.

**D27. The SWU strategist agent reads its tool guidance at runtime** (2026-10-17). Spec: `docs/specs/swu-mcp-agent.md`. Why: tools added later must not leave the agent stale.

## Engineering

**D28. Frameworks over custom code** (owner standing rule). Use Zod, MiniSearch, the MCP SDK, the TOON library, esbuild, Vitest and wrangler. Any hand-rolled concern must be a documented exception.

**D29. Long scripts emit pollable progress** (owner standing rule). Use `scripts/lib/progress.mjs`, writing to `reports/.progress/<job>.json`.

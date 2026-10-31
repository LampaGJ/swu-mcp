---
type: spec
status: active
title: Codebase review 2026-10-30, follow-ups
goal: A working swu-mcp whose deck-building ideas are worth having, on a pipeline that cannot silently serve or ship a broken run.
tracker: github
constraints:
  - Any matcher change is measured with `pnpm verify:pairs` before and after (CLAUDE.md:35); re-label only by adding a new fixture version.
  - Karabast-derived numbers never appear in tool output, the data release or committed docs (CLAUDE.md:43).
  - Zod v4 shapes only; parse at every foreign-data seam (CLAUDE.md:68). Hand-edited data is illegal (CLAUDE.md:65).
  - No model in the scoring path (CLAUDE.md:74).
  - Stage explicit paths; one logical change per commit; do not push without the owner asking (CLAUDE.md:78).
items:
  - id: dv-defeat-pronoun
    title: Resolve "then defeat it" to the clause's earlier target
    tier: feature
    needs: []
  - id: dv-archetype-label
    title: Archetype names say signature card, rows carry the top base
    tier: feature
    needs: []
  - id: dv-pairings-diversity
    title: find_pairings caps rows per link so partners vary
    tier: feature
    needs: []
  - id: dv-audit-orphan-feeders
    title: deck_audit names the penalty-free feeders for each orphan want
    tier: feature
    needs: []
  - id: dv-cluster-labels
    title: Pinned human labels for the 32 role clusters
    tier: feature
    needs: []
  - id: dv-answers-ranking
    title: meta_answers ranks with cost band and its own deck evidence
    tier: feature
    needs: []
  - id: dv-fungibility-arena
    title: Role signature includes the card's own arena
    tier: feature
    needs: []
  - id: dv-rebuild-measure
    title: Rebuild the data, measure pairs, record the before and after
    tier: polish
    needs: [dv-defeat-pronoun, dv-fungibility-arena]
  - id: rel-export-no-delete
    title: export:package never deletes a run directory it did not create
    tier: architecture
    needs: []
  - id: rel-serve-complete-run
    title: The server serves only a run with build.json
    tier: architecture
    needs: []
  - id: rel-lazy-envs
    title: Deck and meta tools load only the products they read
    tier: architecture
    needs: []
  - id: rel-ci-workflow
    title: CI runs typecheck, lint and tests on every push and PR
    tier: architecture
    needs: []
  - id: rel-prebuilt-dist
    title: npx installs run no build and fetch no devDependencies
    tier: architecture
    needs: []
  - id: rel-test-collection
    title: Fresh-checkout test run has no collection crashes
    tier: feature
    needs: []
  - id: rel-download-hygiene
    title: Download timeout, staging sweep and hostile-archive test
    tier: polish
    needs: []
  - id: rel-features-parse-once
    title: features.json and scores.json are parsed once per process
    tier: polish
    needs: []
  - id: seam-deck-snapshot-strict
    title: Deck snapshot step fails loudly on invalid files and tournament field renames
    tier: architecture
    needs: []
  - id: seam-fit-coefficients-gate
    title: fit-coefficients parses its capture and its output
    tier: architecture
    needs: []
  - id: seam-pair-verifier-schema
    title: One strict pair-row schema for the three verify consumers
    tier: architecture
    needs: []
  - id: seam-resolve-name-max
    title: Free-text tool arguments carry a length cap
    tier: feature
    needs: []
  - id: seam-createdat-iso
    title: Deck createdAt is z.iso.datetime
    tier: feature
    needs: []
  - id: seam-file-schemas-nonempty
    title: Product file schemas reject empty and duplicate-key content
    tier: feature
    needs: []
  - id: seam-market-emitter-gate
    title: market step parses prices, play and replay before writing
    tier: feature
    needs: []
  - id: seam-release-verify
    title: release:data re-hashes the run and requires a passing audit
    tier: feature
    needs: []
  - id: seam-rules-fetch-pin
    title: rules:fetch compares a download against a committed hash
    tier: feature
    needs: []
  - id: seam-name-normaliser
    title: One card-name normaliser shared by every resolver
    tier: feature
    needs: []
  - id: seam-progress-heartbeats
    title: Progress heartbeats in the six uninstrumented loops
    tier: polish
    needs: []
  - id: seam-pin-and-hash-types
    title: hex64 for every hash field and a bound release pin
    tier: polish
    needs: []
  - id: seam-rules-integrity
    title: Rules store checks refs, parents and keyword sections at load
    tier: polish
    needs: []
  - id: seam-cli-coerce
    title: Numeric CLI arguments use z.coerce in every script
    tier: polish
    needs: []
  - id: test-pairs-v1-replay
    title: A test replays pairs-v1 byte for byte from the pinned verdicts
    tier: feature
    needs: []
  - id: test-fixture-generators
    title: Every test fixture has a committed generator
    tier: feature
    needs: []
  - id: test-deck-branches
    title: Assertions for the untested deck-tool branches
    tier: feature
    needs: []
  - id: test-no-karabast-scope
    title: The D22 import guard covers the server entry and every build step
    tier: polish
    needs: []
  - id: maint-dedupe-helpers
    title: One costBucket, one costBand, one newest-dated-dir
    tier: polish
    needs: []
  - id: maint-release-drop-synergy
    title: release:data stops shipping the unread synergy directory
    tier: polish
    needs: []
  - id: docs-drift
    title: CLAUDE.md matches the registered prompts, build steps and e2e caveat
    tier: polish
    needs: []
---

# Codebase review 2026-10-30, follow-ups

Source: docs/verification/2026-10-30-codebase-review.md (sections A to E). Items below are the new findings; findings that extend an open issue were posted as comments on #19, #22, #28, #30, #33, #35, #37, #44 and #45 and are not repeated here.

## dv-defeat-pronoun — Resolve "then defeat it" to the clause's earlier target

**Goal**: `src/ability-grammar/grammar.ts:166` tags `defeat (it|him|her)` as `self_defeat` with no look at the clause. "No Glory, Only Results" (`04010043`, "Take control of a non-leader unit, then defeat it.") therefore offers `defeat-self` and never appears as removal in `meta_answers`, `find_pairings` or `find_by_effect`. When the clause has an earlier effect with a non-self target, the pronoun refers to that target and the effect is `defeat` of it.

**Acceptance**:
- `card_features` for `04010043` shows a `defeat` effect targeting the take-control target and `offers:defeat-any-unit` (or enemy, per the target side); no `offers:defeat-self`.
- A grammar regression test covers the sentence and a control sentence where "defeat it" has no earlier target (still `self_defeat`).
- Of the 7 defeat-it clauses in the 2026-10-17 features, only this card changes; the test lists the other six as unchanged.
- `pnpm verify:pairs` run before and after, both numbers recorded in the PR body.

**Touches**: `src/ability-grammar/grammar.ts`, `src/ability-grammar/tags.ts`, `tests/ability-grammar/regression-tags.test.ts`

**Open gaps**: none

## dv-archetype-label — Archetype names say signature card, rows carry the top base

**Goal**: `src/meta/build.ts:325` names an archetype `"<leader> / Vigilance base (<core card>)"`, which reads as if the parenthetical is the base; callers pass it to `playable_cards`, `deck_audit` and `meta_answers` and get "wrong type, not a base". The label should say what it is, and the `meta_archetypes` row should carry the most-played base so a caller can go straight to the deck tools.

**Acceptance**:
- Name reads `"<leader> / <aspect> base, signature <card>"` (or equivalent wording that cannot be read as a base title); the `(variant n)` form is unchanged.
- `meta_archetypes` rows carry `topBase` (cardKey and title) from the existing `bases` list.
- `tests/meta/build.test.ts` and `tests/meta/tools.test.ts` pin both.
- Rebuilding meta from the same input gives the same bytes apart from the renamed labels (replay record updated).

**Touches**: `src/meta/build.ts`, `src/meta/schema.ts`, `src/tools/meta.ts`, `tests/meta/`

**Open gaps**: the meta file schema changes shape, so the data package needs a rebuild (dv-rebuild-measure) before the live server shows it.

## dv-pairings-diversity — find_pairings caps rows per link so partners vary

**Goal**: `src/tools/synergy.ts:211-219` sorts by rank only; for the Cad Bane leader the top 8 of 123 rows are the same link row against Grit units. A builder wants varied reasons. Cap the rows shown per distinct `link` string (default 3, argument `perLink`), filling the remainder in rank order, and say in the note that the cap applies.

**Acceptance**:
- New optional argument `perLink` (int, 1-100, default 3); with `perLink: 100` the output equals today's.
- `find_pairings` for `08010011` with defaults shows at most 3 rows of `offers:damage-any-unit -> wants:self-damaged` in the first page and at least 3 distinct `link` values in the top 8.
- `total` still reports the uncapped count; a `capped` count says how many rows the cap deferred.
- Unit test on a synthetic graph with two link rows pins the interleaving.

**Touches**: `src/tools/synergy.ts`, `tests/synergy/tools.test.ts`, README tool list

**Open gaps**: none

## dv-audit-orphan-feeders — deck_audit names the penalty-free feeders for each orphan want

**Goal**: `src/tools/deck.ts:447-452` reports an orphan want with `feedersInCardPool: 18` and names none. Name the top three feeders the leader and base cover (penalty 0 first, then lowest penalty), by edge score, with cost, so the row is an idea rather than a count.

**Acceptance**:
- Each `orphanWants` row carries `feeders: "Title (cost); Title (cost); Title (cost)"` chosen as above, and `feedersInCardPool` stays.
- A deck-tools test with the synthetic synergy fixture pins the three names and their order.
- Output stays TOON and the row count is unchanged.

**Touches**: `src/tools/deck.ts`, `tests/deck-tools.test.ts`

**Open gaps**: none

## dv-cluster-labels — Pinned human labels for the 32 role clusters

**Goal**: `clusterGaps` labels (`src/tools/deck.ts:511`, from `similarity/clusters.json`) are raw token statistics such as "word:card(78%) word:hand(65%)". A pinned table `data/cluster-labels.json` maps cluster id to a short human role name ("card draw and hand", "experience givers", "upgrades") keyed by the cluster's member-set hash, so a re-clustering that moves members invalidates the label and the tool falls back to the token label with a note.

**Acceptance**:
- `data/cluster-labels.json` exists with 32 entries, each `{ id, membersSha256, label }`; written once by a committed script `scripts/similarity/label-clusters.ts` that emits the template and a pinned sonnet pass (D3: captured, hashed input) fills the labels.
- `deck_audit.clusterGaps` shows `label` as the human name when the hash matches and the token label plus `labelStatus: stale` otherwise.
- Test with a fixture clusters file covers both branches.

**Touches**: `src/tools/deck.ts`, `data/cluster-labels.json`, `scripts/similarity/`, `tests/deck-tools.test.ts`

**Open gaps**: the labels themselves are model output and must be captured as a pinned file, never written inline (D3).

## dv-answers-ranking — meta_answers ranks with cost band and its own deck evidence

**Goal**: `src/tools/meta.ts:440-446` sorts by penalty, coverage, threat count, cost. Display Piece tops the list with a −11.5 point difference (n=45) and Annihilator (cost 11) ranks above every 5-cost answer. Rank within coverage bands by cost band and by the sign of the deck evidence when it rests on at least `minN` decisive matches, so cheaper answers with neutral or positive evidence come first.

**Acceptance**:
- Sort key becomes: penalty, coverage rounded to 0.05, evidence class (positive or neutral or unmeasured before negative, where negative means `difference < -0.05` with both `n >= minN`), cost band (0-2, 3-4, 5-6, 7+), coverage, cardKey.
- For Cad Bane / Nevarro City the 5-cost removal events rank above Annihilator and Display Piece ranks below Lost and Forgotten.
- `tests/meta/tools.test.ts` pins an ordering with a synthetic evidence table.
- The note explains the evidence class and that it is association, not effect.

**Touches**: `src/tools/meta.ts`, `tests/meta/tools.test.ts`

**Open gaps**: band edges are a design choice; record them in the note and in `docs/decisions.md` as a new entry.

## dv-fungibility-arena — Role signature includes the card's own arena

**Goal**: `src/synergy/fungibility.ts:8-13` builds a role signature from tag, type group, timing, magnitude band, cost band and target. Marrok (3-cost Ground Sentinel) gets Padawan Starfighter (2-cost Space) as a substitute. A unit's own arena is part of its role.

**Acceptance**:
- The signature adds `arena` for units (Ground, Space, both; non-units unchanged).
- `fungible_substitutes` for `08010030` no longer lists Space units.
- `tests/synergy/fungibility.test.ts` pins a Ground and a Space card with the same tag in different classes.
- `pnpm verify:pairs` before and after (substitutes are not measured by pairs-v1, but the run is required for any matcher change).

**Touches**: `src/synergy/fungibility.ts`, `tests/synergy/fungibility.test.ts`

**Open gaps**: whether Sentinel or other keywords belong in the signature; out of scope here.

## dv-rebuild-measure — Rebuild the data, measure pairs, record the before and after

**Goal**: The grammar and signature changes alter `features.json` and the synergy graph. Rebuild `data/runs/<date>` with `pnpm build:data`, run `pnpm verify:audit` and `pnpm verify:pairs`, and record both pairs numbers beside the 2026-10-17 figures in `docs/verification/`. The release itself is #50.

**Acceptance**:
- A new `data/runs/<date>/build.json` exists and `verify:audit` exits 0.
- `docs/verification/<date>-pairs.md` records precision and recall before and after, per complementarity row.
- The live server (`pnpm mcp`) answers `meta_answers` for Cad Bane / Nevarro City with "No Glory, Only Results" among the key-unit answers.

**Touches**: `data/runs/`, `docs/verification/`

**Open gaps**: none

## rel-export-no-delete — export:package never deletes a run directory it did not create

**Goal**: `scripts/export-swu-data-package.ts:209` runs `rmSync(data/runs/<date>, { recursive: true, force: true })`, so the documented standalone command erases every other product and `build.json` for that date. Write `llm/` into a staging directory and replace only `llm/`.

**Acceptance**:
- Running `pnpm export:package --date <d>` on a finished run leaves every other product directory and `build.json` untouched (test with a scratch runs root).
- `llm/` is replaced atomically (staging then rename).
- `build:data` behaviour is unchanged; its own full-run reset, if any, is explicit and logged.

**Touches**: `scripts/export-swu-data-package.ts`, `scripts/build-data.ts`, `tests/`

**Open gaps**: none

## rel-serve-complete-run — The server serves only a run with build.json

**Goal**: `src/data.ts:74-78` picks the newest dated directory with no completeness check, so a failed `build:data` leaves a newer, partial directory that the next `pnpm mcp` serves. Pick the newest directory that holds `build.json`, and warn on stderr when a newer incomplete one is skipped.

**Acceptance**:
- `newestRun` returns the newest directory containing `build.json`; a newer directory without it is skipped with a one-line stderr warning naming it.
- `SWU_MCP_DATA` still overrides without the check (explicit choice).
- Test with a scratch `data/runs` holding a complete older and an incomplete newer run.
- `build:data` writes `build.json` last (already true, `scripts/build-data.ts:171-184`); add a test that asserts it.

**Touches**: `src/data.ts`, `src/data-source.ts`, `tests/data-source.test.ts`

**Open gaps**: #23 (symlinked entries) touches the same function; land together or sequence.

## rel-lazy-envs — Deck and meta tools load only the products they read

**Goal**: `deckEnvOf` (`src/tools/deck.ts:43-57`) loads market and the synergy context for every deck and meta call, so a missing `market/` fails `deck_audit` and `meta_archetypes` while value and synergy tools answer. Load each product lazily on first use and let a tool fail only when it reads a missing product.

**Acceptance**:
- With `market/` absent, every tool that does not read prices (`deck_audit`, `deck_legality_check`, `suggest_leader_base`, `playable_cards`, `fungible_in_deck`, the meta tools) answers; `card_price`, `price_list`, `budget_alternatives`, `value_vs_price`, `play_value_vs_price`, `trade_balance`, `owned_vs_needed` fail with the missing-file sentence.
- A test runs each of the 48 tools against a scratch package missing one product at a time and asserts which fail.
- No tool gets slower on the first call than today by more than the one-off load it already paid.

**Touches**: `src/tools/deck.ts`, `src/tools/meta.ts`, `src/tools/common.ts`, `tests/`

**Open gaps**: #31 splits `deck.ts`; do this split with it.

## rel-ci-workflow — CI runs typecheck, lint and tests on every push and PR

**Goal**: `.github/workflows/pages.yml` is the only workflow. Add `ci.yml` that runs `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test` on Node 22 for pushes to main and pull requests. Tests that need pinned data stay skipped in CI and the run reports how many skipped.

**Acceptance**:
- `.github/workflows/ci.yml` exists and the first run on main is green.
- The skipped count is printed in the job summary.
- README badge or line states that CI runs the suite without the data package.

**Touches**: `.github/workflows/ci.yml`, README.md

**Open gaps**: whether to download the pinned data release in CI for the e2e suite (adds a network step); decide after the first green run.

## rel-prebuilt-dist — npx installs run no build and fetch no devDependencies

**Goal**: `dist/` is git-ignored and `prepare` runs `scripts/bundle.mjs` on every `npx -y github:LampaGJ/swu-mcp`, from unlocked devDependencies (npm ignores `pnpm-lock.yaml`), a tree that includes `wrangler` with `workerd` and `sharp` install scripts. Commit `dist/server.js`, drop `prepare`, rebuild it as a release step, and move `wrangler` to the #16 worktree until it lands.

**Acceptance**:
- `dist/server.js` is tracked; `package.json` has no `prepare`; `pnpm build` still rebuilds it.
- A fresh `npx -y github:LampaGJ/swu-mcp` in a scratch directory (with `SWU_MCP_CACHE` set) starts the server with no devDependency install (`npm ls --all` shows none).
- `wrangler` is absent from main's `package.json`.
- A CI check fails when `dist/server.js` is older than any `src/**` change (rebuild and diff).

**Touches**: `package.json`, `.gitignore`, `dist/server.js`, `.github/workflows/ci.yml`

**Open gaps**: #16 needs `wrangler`; agree where it lives (worktree package.json or an optional dependency).

## rel-test-collection — Fresh-checkout test run has no collection crashes

**Goal**: `describe.skipIf(cond)` still runs its body at collection; `tests/rules/parse-cr.test.ts:59-61` and `tests/glossary/field-guide-counts.test.ts:39` read files inside the body and crash with ENOENT when the data is absent, taking their unconditional tests with them. `tests/rules/helpers.ts:60` calls `mkdtempSync` under a `tmp/` nothing creates.

**Acceptance**:
- Both files load their data inside `beforeAll` or a lazy getter so the skip is a skip; confirmed by running the suite in a tracked-files-only copy with `SWU_CR_TEXT=/nonexistent`.
- `writeCore` creates `tmp/` first.
- `tests/verify/sample.test.ts:177` points at the newest run, not a literal date.
- The five hard-coded absolute paths read an env var with the current default.

**Touches**: `tests/rules/parse-cr.test.ts`, `tests/glossary/field-guide-counts.test.ts`, `tests/rules/helpers.ts`, `tests/verify/sample.test.ts`, `tests/glossary/build.test.ts`, `tests/rules/primer-keywords.test.ts`

**Open gaps**: none

## rel-download-hygiene — Download timeout, staging sweep and hostile-archive test

**Goal**: `src/data-source.ts:63` fetches with no timeout; `:89` leaves `.staging-*` directories behind when killed mid-extraction; no test feeds a hostile archive. Bound the fetch, sweep old staging directories before creating one, and pin extraction safety.

**Acceptance**:
- `fetch` carries `signal: AbortSignal.timeout(...)` and the body read is bounded; a stalled server test fails within the timeout.
- Staging directories older than a few minutes under the cache root are removed before a new one is created.
- A test serves a verified-sha tarball with a `../` entry, an absolute entry and an escaping symlink and asserts nothing lands outside the cache.

**Touches**: `src/data-source.ts`, `tests/data-source.test.ts`

**Open gaps**: none

## rel-features-parse-once — features.json and scores.json are parsed once per process

**Goal**: `features.json` is parsed by `src/tools/value.ts:56`, `src/synergy/context.ts:48` and `src/tools/meta.ts:93`, each into its own cache; `value_vs_price` re-parses `scores.json` per call (`src/tools/market.ts:151`). One loader per product file, memoised on the package directory.

**Acceptance**:
- One `loadFeatures(packageDir)` and one `loadScores(packageDir)` with a per-directory cache; the three call sites use them.
- Heap after the first synergy call drops measurably from the 107 MB measured in the review (record the new number in the PR).
- Tests unchanged and green.

**Touches**: `src/data.ts` or a new `src/products.ts`, `src/tools/value.ts`, `src/synergy/context.ts`, `src/tools/meta.ts`, `src/tools/market.ts`

**Open gaps**: none

## seam-deck-snapshot-strict — Deck snapshot step fails loudly on invalid files and tournament field renames

**Goal**: `scripts/meta.ts:104-107` counts an invalid deck file and continues; `scripts/bench/extract-decks.ts:94-96` swallows every error. `placement` and `event` are `.nullish()` (`src/meta/schema.ts:30`), so a rename upstream turns every tournament deck into a community deck with exit 0 (D21). Record every rejected file with its first issue, fail when the invalid share exceeds a threshold, and fail when a snapshot that claims tournament decks yields none.

**Acceptance**:
- Each step writes `rejected.json` (path, first Zod issue) beside its output and exits non-zero when rejections exceed 1% of files.
- `scripts/meta.ts` exits non-zero when the manifest lists tournament events but zero decks resolve as tournament.
- `extract-decks.ts` catches only ZodError; other errors propagate.
- Tests with a mutated synthetic snapshot cover both failures.

**Touches**: `scripts/meta.ts`, `scripts/bench/extract-decks.ts`, `src/meta/schema.ts`, `tests/meta/`

**Open gaps**: none

## seam-fit-coefficients-gate — fit-coefficients parses its capture and its output

**Goal**: `scripts/fit-coefficients.ts:111-112` reads the pinned SWU Stats capture and the features replay with `JSON.parse(...) as`; a renamed `timesIncluded` gives NaN at line 179 and the `games <= 0` guard at 183 does not fire. The output at `:284-292` is written with no `coefficientsSchema.parse`. This is the D1 scoring input.

**Acceptance**:
- The capture is parsed with `captureRowSchema` (`src/market/build.ts:28`) and the replay with `swuCardFeaturesReplaySchema`.
- `coefficientsSchema.parse` runs on the result before `writeFileSync`.
- A test feeds a capture with a renamed field and asserts the script throws at the read.

**Touches**: `scripts/fit-coefficients.ts`, `tests/`

**Open gaps**: #54 and #55 cover the replay record of the same file; this item is the parse only.

## seam-pair-verifier-schema — One strict pair-row schema for the three verify consumers

**Goal**: `scripts/verify/pair-fixture.ts:50-52` reads `String(pair.cardA)` from a `z.record(z.string(), z.unknown())` row; a renamed column yields the single id `undefined>undefined:undefined` and precision is computed over one phantom pair. `scripts/bench/real-play.ts:~95` already has a strict row schema.

**Acceptance**:
- `pairRowSchema` lives in `src/synergy/schema.ts` (or a shared module) as `z.strictObject` with `cardA`, `cardB`, `rows` required non-empty strings.
- `pair-fixture.ts`, `pair-precision.ts` (`:81`) and `sample.ts` (`:641-645`) use it.
- A test feeds a renamed row and asserts a ZodError, not a phantom id.

**Touches**: `src/synergy/schema.ts`, `scripts/verify/pair-fixture.ts`, `scripts/verify/pair-precision.ts`, `scripts/verify/sample.ts`, `scripts/bench/real-play.ts`

**Open gaps**: none

## seam-resolve-name-max — Free-text tool arguments carry a length cap

**Goal**: `src/tools/catalog.ts:32` `text: z.string().min(1)` with no max; the edit-distance pass is linear in input length and a 60 KB input blocks the stdio server for 11.9 s. Every free-text argument gets a shared cap.

**Acceptance**:
- `resolveCardNameShape.text` is `.max(200)`; `query`, `keyword`, `section`, `title`, `subtitle` and the deck `card` strings use a shared `shortText` helper with `.max(200)` (or `.max(500)` for `query`).
- A test sends a 201-character `text` and asserts a validation error in under 50 ms.

**Touches**: `src/tools/catalog.ts`, `src/tools/common.ts`, `src/tools/rules.ts`, `src/tools/deck.ts`, `tests/`

**Open gaps**: none

## seam-createdat-iso — Deck createdAt is z.iso.datetime

**Goal**: `src/meta/schema.ts:20` has `createdAt: z.string().optional()` and `scripts/meta.ts:111` gates it with `DATED_DIR.test`, which accepts `2026-13-45`; `windowOf` then takes it as the window end and drops every real deck.

**Acceptance**:
- `createdAt: z.iso.datetime({ offset: true, local: true }).optional()` (or `z.iso.date()` on the sliced prefix if the source emits dates only; check the manifest).
- A test feeds `2026-13-45T00:00:00Z` and asserts rejection at parse.

**Touches**: `src/meta/schema.ts`, `scripts/meta.ts`, `tests/meta/`

**Open gaps**: none

## seam-file-schemas-nonempty — Product file schemas reject empty and duplicate-key content

**Goal**: `swuCardFeaturesFileSchema` accepts `[]` and duplicated `cardKey`; `scoresFileSchema` accepts `cards: []`; `metaFileSchema` accepts `archetypes: []`; `src/scorer/inputs.ts:49-52` checks features within cards but not cards within features. A truncated file scores nothing silently.

**Acceptance**:
- `.min(1)` on the three arrays and a `superRefine` asserting `cardKey` uniqueness on features and scores.
- `loadScorerInputs` asserts every card in `cards.toon` has a feature record.
- Tests with `[]` and a duplicate key assert rejection.

**Touches**: `src/schemas/card-features.ts`, `src/scorer/scores-file.ts`, `src/scorer/inputs.ts`, `src/meta/schema.ts`, `tests/`

**Open gaps**: none

## seam-market-emitter-gate — market step parses prices, play and replay before writing

**Goal**: `scripts/market.ts:68-88` writes `prices.json` and `play.json` with `JSON.stringify` and no `pricesFileSchema.parse` or `playFileSchema.parse`; `replay.json` has no schema. `priceImportFinishedAt` is `z.string().nullable()` where `z.iso.datetime({ local: true })` accepts the real value.

**Acceptance**:
- Both objects are parsed before `writeFileSync`, as `scripts/meta.ts:243` does.
- A `marketReplaySchema` exists and gates `replay.json`.
- `priceImportFinishedAt` is `z.iso.datetime({ local: true }).nullable()`.
- Existing market tests green; the replay record is unchanged in bytes.

**Touches**: `scripts/market.ts`, `src/market/build.ts`, `tests/market/`

**Open gaps**: none

## seam-release-verify — release:data re-hashes the run and requires a passing audit

**Goal**: `scripts/release-data.ts:56` trusts `build.json` and reads nothing under `verify/`, so a hand-edited run is archived and pinned with the old buildHash.

**Acceptance**:
- The script recomputes each file's sha256 against the per-file hashes `build.json` records and aborts on any difference.
- It requires `verify/audit.json` with every check passing, else aborts naming the missing or failing check.
- A test with a scratch run and one edited byte asserts the abort.

**Touches**: `scripts/release-data.ts`, `tests/`

**Open gaps**: none

## seam-rules-fetch-pin — rules:fetch compares a download against a committed hash

**Goal**: `scripts/rules-fetch.ts:35,48` falls back to a CDN download with nothing to compare against; `build:data` passes `--pdf` only when a PDF is stored. Two fresh checkouts can build different rules runs.

**Acceptance**:
- `data/pinned/rules/<version>.json` records the expected PDF sha256; a download that differs aborts with both hashes.
- `build:data` fails loudly when no PDF is stored and no pin exists, instead of downloading silently.
- `pnpm rules:check` reports pin status.

**Touches**: `scripts/rules-fetch.ts`, `scripts/build-data.ts`, `data/pinned/rules/`, `tests/rules/`

**Open gaps**: none

## seam-name-normaliser — One card-name normaliser shared by every resolver

**Goal**: `src/tools/catalog.ts:121-126` strips apostrophes, `src/tools/deck.ts:116-117` normalises them to `'`, `scripts/bench/card-map.ts:45` differs again; `getCard` returns every title match while `resolveCard` errors on ambiguity. A title typed without its apostrophe resolves in one tool and not another.

**Acceptance**:
- One `normalizeTitle` in `src/swu/canonical.ts` used by all three sites.
- A test resolves "Fetts Firespray" (no apostrophe) through `resolve_card_name` and `deck_audit` and gets the same card.

**Touches**: `src/swu/canonical.ts`, `src/tools/catalog.ts`, `src/tools/deck.ts`, `scripts/bench/card-map.ts`, `tests/`

**Open gaps**: none

## seam-progress-heartbeats — Progress heartbeats in the six uninstrumented loops

**Goal**: D29 requires `scripts/lib/progress.mjs` on anything over ~30 s. Missing in `scripts/bench/extract-decks.ts:70`, `scripts/market.ts:42`, `scripts/fit-coefficients.ts:49`, `scripts/verify/sample.ts`, inside `searchTrios` for `pnpm synergy` (`src/synergy/run.ts:82`), and the bootstrap loop at `scripts/bench/meta-defense.ts:190`.

**Acceptance**:
- Each loop ticks a named job; `reports/.progress/<job>.json` appears during a real run.
- Measured durations recorded in the PR; any loop under 30 s may be left out with a one-line note.

**Touches**: the six files above

**Open gaps**: durations unmeasured

## seam-pin-and-hash-types — hex64 for every hash field and a bound release pin

**Goal**: Hash fields are bare `z.string()` in `src/rules/check.ts:16-18`, `src/rules/schemas.ts:92-97`, `scripts/rules-fetch.ts:39`, `src/swu/raw-manifest.ts:20` where `hex64` (`src/schemas/hash.ts:3`) exists. The release pin (`src/data-release.ts:15-22`) accepts any URL host or scheme and ties `tag` and `asset` to nothing.

**Acceptance**:
- Every sha256 field uses `hex64`.
- The pin's `url` is `z.url({ protocol: /^https$/, hostname: /^github\.com$/ })` and a `.refine` ties `tag` to `data-<dataVersion>` and `asset` to `swu-mcp-data-<dataVersion>.tar.gz`.
- Tests assert each rejection.

**Touches**: the files above, `tests/data-release.test.ts`

**Open gaps**: none

## seam-rules-integrity — Rules store checks refs, parents and keyword sections at load

**Goal**: `src/rules/store.ts:89-103` and `src/tools/rules.ts:68-142` cast `byId.get(x) as RuleSection`; a dangling ref or keyword section throws a TypeError inside `get_rule` or `keyword_rules`. Current data is clean. `assertCoreIdsExist` (`src/rules/primer.ts`) is the pattern.

**Acceptance**:
- `loadRules` asserts every `refs`, `parentId` and `keywords[].sections` id exists and fails with the offending id.
- The `as RuleSection` casts are removed.
- A test with a fixture containing one dangling ref asserts the load error.

**Touches**: `src/rules/store.ts`, `src/tools/rules.ts`, `tests/rules/`

**Open gaps**: none

## seam-cli-coerce — Numeric CLI arguments use z.coerce in every script

**Goal**: `scripts/bench/real-play.ts:260`, `scripts/rules-fetch.ts:117`, `scripts/verify/pair-fixture.ts:133` use bare `Number(values.x ?? default)`; `--iterations abc` gives NaN and a loop that runs zero times. Sibling scripts use `z.coerce.number().int().min(...)`.

**Acceptance**:
- The three sites use the `z.coerce` pattern from `scripts/bench/meta-defense.ts:259-268`.
- `--iterations abc` exits non-zero naming the argument.

**Touches**: the three files

**Open gaps**: none

## test-pairs-v1-replay — A test replays pairs-v1 byte for byte from the pinned verdicts

**Goal**: CLAUDE.md promises `data/fixtures/pairs-v1.json` is byte-identical to the pinned verdicts, and `pinFixture` over `data/pinned/pair-fixture-v1` reproduces it today (checked with `cmp`), but no test says so.

**Acceptance**:
- `tests/verify/pair-fixture.test.ts` gains a case that serialises `pinFixture("data/pinned/pair-fixture-v1")` and compares it to the committed file's bytes; it runs on a clean checkout (all inputs are committed).

**Touches**: `tests/verify/pair-fixture.test.ts`

**Open gaps**: none

## test-fixture-generators — Every test fixture has a committed generator

**Goal**: `tests/synergy/real-cards-14.json` (cites a run that no longer exists), `tests/synergy/real-cards.json`, `tests/fixtures/rules/cr-slice.txt` and `tests/fixtures/rules/raw-pages/page-0001.json` have no generator. D2 says hand-made data needs a committed transform.

**Acceptance**:
- `scripts/make-test-fixture.ts` (or a sibling) regenerates each from a named pinned input with the selection criteria in code; each fixture carries a `source` field or header naming the generator and input hash.
- Regenerating from the 2026-10-17 run gives the committed bytes, or the fixture is replaced by the regenerated one in the same commit with the tests updated.

**Touches**: `scripts/make-test-fixture.ts`, the four fixtures, their tests

**Open gaps**: `real-cards-14.json` cannot be regenerated from its cited run; regenerate from 2026-10-17 and re-pin.

## test-deck-branches — Assertions for the untested deck-tool branches

**Goal**: `tests/deck-tools.test.ts` asserts `isError` at 7 sites, all on common paths. Untested: unknown fixed leader or base in `suggest_leader_base`, `playable_cards`, `fungible_in_deck`; `noCards` in `suggest_leader_base`, `fungible_in_deck`, `budget_alternatives`, `price_list`, `owned_vs_needed`; `owned_vs_needed` with one of leader and base and its `unresolved.owned` list; the "no feature record" reason; the legality base-text warning; a rotated or unverified leader in `checkSet`; `suggest_leader_base` excluding rotated leaders; `play_value_vs_price` `includeLeadersAndBases` and `minPrice`; `deck_audit` `gapLimit` and the 7+ and `-` buckets; the `withEnv` throw-to-isError path.

**Acceptance**:
- One test per branch above, each asserting the exact message or row.
- The `withEnv` test calls the registered handler, not the inner function, and asserts `isError` with a plain sentence.

**Touches**: `tests/deck-tools.test.ts`

**Open gaps**: none

## test-no-karabast-scope — The D22 import guard covers the server entry and every build step

**Goal**: `tests/meta/no-karabast.test.ts:38` walks imports from `scripts/meta.ts` and `src/tools/meta.ts` only. A future import of `scripts/bench/games.ts` from another tool group or build step would pass.

**Acceptance**:
- The guard walks from `src/server.ts` and from every step `scripts/build-data.ts` runs, plus `scripts/release-data.ts`.
- The positive control stays.

**Touches**: `tests/meta/no-karabast.test.ts`

**Open gaps**: none

## maint-dedupe-helpers — One costBucket, one costBand, one newest-dated-dir

**Goal**: `costBucket` is copied verbatim (`src/meta/build.ts:161`, `src/tools/deck.ts:380`); `costBand` disagrees on null (`src/synergy/fungibility.ts:48-49` "-", `scripts/bench/real-play.ts:122-123` "n"); newest-dated-directory has four implementations (`src/data.ts:72-80`, `src/rules/store.ts:72-80`, `scripts/bench/code-commit.ts:16-21`, `scripts/verify/audit.ts:327`).

**Acceptance**:
- One `costBucket` and one `costBand` in `src/synergy/` or `src/swu/`, imported everywhere; the null label is "-".
- One `newestDatedDir` (the `src/data.ts` one) used by all four sites; the symlink behaviour is decided with #23.
- All outputs byte-identical before and after except where the null label changed (recorded).

**Touches**: the files above

**Open gaps**: none

## maint-release-drop-synergy — release:data stops shipping the unread synergy directory

**Goal**: `SERVER_DIRS` (`scripts/release-data.ts:28`) includes `synergy` (14 MB) but no runtime path reads `<package>/synergy/`; the server rebuilds the graph from `features/features.json` (`src/synergy/context.ts:45-50`).

**Acceptance**:
- `synergy` is removed from `SERVER_DIRS` (or the server reads the prebuilt graph; pick one and record it in `docs/decisions.md`).
- README archive contents updated; the next release tarball is smaller by that amount.

**Touches**: `scripts/release-data.ts`, README.md

**Open gaps**: whether reading the prebuilt graph is faster than rebuilding; measure once.

## docs-drift — CLAUDE.md matches the registered prompts, build steps and e2e caveat

**Goal**: CLAUDE.md says "the two prompts" (`src/resources.ts:169-179` registers three), its `build:data` step list omits `meta` (`scripts/build-data.ts:136` runs it), and CLAUDE.md:52 states the e2e guarantee without the skip caveat README.md:210 gives. `scripts/smoke-stdio.mjs` is referenced nowhere.

**Acceptance**:
- The three CLAUDE.md lines corrected.
- `scripts/smoke-stdio.mjs` either documented in CLAUDE.md commands or deleted.

**Touches**: CLAUDE.md, `scripts/smoke-stdio.mjs`

**Open gaps**: none

## Non-goals

- Re-labelling pairs-v1 or changing its verdicts (D19).
- The remote endpoint (#16), leader_cards (#19) and overlooked_cards (#20).
- Any item already filed under #28, #29, #31, #33, #35, #37, #44, #45, #50, #54, #55; new evidence went to those issues as comments.
- Tag-precision work on the ability grammar beyond the one pronoun rule (#22, #42).

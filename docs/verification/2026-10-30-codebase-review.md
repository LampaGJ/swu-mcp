---
type: decision
status: active
review_by: 2026-12-30
related: ["docs/decisions.md", "CLAUDE.md"]
---

# Codebase review, 2026-10-30

What this answers: does swu-mcp work, and does it give deck-building ideas worth having? Reviewed at main `b63622c`, clean tree, against the decision log D1-D35. Six reviewers: a diff-level code review, decision-log conformance, Zod and seams, security, tests, architecture and pipeline, plus a live deck-building session against the 2026-10-17 data over MCP.

## TL;DR

The server works. Typecheck and lint pass, 863 of 864 tests pass (the one failure is the known #45 timeout), and every tool answered a realistic Cad Bane deck-building session with sourced numbers and honest limits. No critical or high security finding.

The ideas are of mixed value, and the gaps are specific. Six defects seen live would each change what a deck builder gets back. The sharpest: the grammar tags "No Glory, Only Results" (take control of a unit, then defeat it) as self-defeat, so the meta's most-played removal never appears as an answer, while an 11-cost unit does.

The platform has four high-severity reliability holes: `pnpm export:package` erases a whole run directory, the server serves a half-built run, a missing `market/` folder takes down 14 tools, and nothing runs the tests in CI.

Forty open issues already cover the 2026-10-17 red-team follow-ups. Every finding below is deduplicated against them; a `dup #n` marks new evidence for an existing issue.

## Baseline

- `pnpm typecheck` passes, `pnpm lint` passes.
- `pnpm test`: 863 passed, 1 failed (tests/verify/sample.test.ts real-data case, 5 s timeout, tracked as #45).
- No CI runs any of these. `.github/workflows/pages.yml` is the only workflow and deploys the site.
- Worktree `feat/16-remote-endpoint` holds two unlanded commits for #16 (the rules-dir fix on that branch landed on main as `eb13d09`). `git-sweep` dry-run would remove `backup/pre-land-wave3`; two other backup refs hold commits main lacks.

## A. Deck-building value (seen live, all confirmed)

**A1. "…, then defeat it" is tagged self-defeat.** `src/ability-grammar/grammar.ts:166` matches `defeat (it|him|her)` as `self_defeat` with no look at the clause's earlier target. "No Glory, Only Results" (`04010043`, "Take control of a non-leader unit, then defeat it.") carries only `offers:defeat-self`. It is in 99% of the top two archetypes' decks, yet `meta_answers` for Cad Bane / Nevarro City lists Lost and Forgotten (6), It's Worse (7), Single Reactor Ignition (8) and Annihilator (11) as key-unit answers and never this 5-cost event. Of 7 defeat-it clauses in the 2026-10-17 features, this is the only one with an earlier non-self target, so the fix is narrow: resolve the pronoun to the clause's prior target. Matcher change: measure with `pnpm verify:pairs` before and after (CLAUDE.md).

**A2. Archetype names read as if the parenthetical is the base.** `src/meta/build.ts:325` names an archetype `"<leader> / Vigilance base (Oggdo Bogdo, Bogano Brute)"`, where the parenthetical is the distinctive core card. Passing that title as `base` to `playable_cards`, `meta_answers` and `deck_audit` fails with "wrong type, not a base". `meta_threats` does list the real bases. Rename the label (for example "signature: Oggdo Bogdo") and add the top base to the `meta_archetypes` row.

**A3. `find_pairings` has no diversity.** `src/tools/synergy.ts:211-219` sorts by rank alone. For the Cad Bane leader the top 8 of 123 rows are the same link (`offers:damage-any-unit -> wants:self-damaged` against Grit units, rank 1.013). A builder wants varied reasons. Cap rows per link row, or round-robin across rows.

**A4. `deck_audit` names the gap but not the fix.** `orphanWants` (`src/tools/deck.ts:447-452`) says "wants:replay-when-played, 18 feeders in pool" and names none of them. `clusterGaps` prints raw token statistics as labels ("word:card(78%) word:hand(65%) …", `src/tools/deck.ts:511` from `similarity/clusters.json`). Name the top three penalty-free feeders per orphan, and give the 32 clusters pinned human labels.

**A5. `meta_answers` ranks by coverage, then cost, and ignores its own deck evidence.** `src/tools/meta.ts:440-446`. Display Piece tops the list with a −11.5 point win-rate difference (n=45), and Annihilator (cost 11) ranks above every 5-cost answer. Fold cost band into the sort and push rows with negative, well-measured evidence below rows with neutral or positive evidence.

**A6. Fungibility ignores the card's own arena.** The role signature (`src/synergy/fungibility.ts:8-13`) is tag, type group, timing, magnitude, cost band and target. Marrok (3-cost Ground Sentinel, `wants:upgrades-attached`) gets Padawan Starfighter (2-cost Space) as its substitute. Add the card's arena to the signature.

**A7. Leader-specific lists already exist in the meta data.** `meta_threats` core lists are "cards most played with this leader" for the top archetypes; #19 (leader card index) could expose them today for the leaders that have an archetype, with the aspect-baseline lift computed later.

Noted, not new: `find_trios` with no leader ranks a Spy-token trio into Nien Nunb (`wants:wide-board`) first, though Nien Nunb counts Pilots and upgrades. That is tag precision (#22, #42).

## B. Reliability and pipeline (high)

**B1. `pnpm export:package` deletes the whole run directory for its date.** `scripts/export-swu-data-package.ts:209` `rmSync(staging, { recursive: true, force: true })` on `data/runs/<date>`. Run alone on a finished date it erases features, scores, synergy, market, rules, similarity, meta and build.json. CLAUDE.md lists it as a standalone command.

**B2. The server serves a half-built run.** `src/data.ts:74-78` picks the newest dated directory with no check for `build.json`. A `build:data` that fails at the meta step leaves a newer directory that the next `pnpm mcp` serves, with meta tools failing. Related to #23.

**B3. One missing optional product takes down 14 tools.** `deckEnvOf` (`src/tools/deck.ts:43-57`) loads `market/` and the synergy context eagerly; `createMetaEnv` wraps it (`src/tools/meta.ts:94`). Measured: without `market/`, `deck_audit` and `meta_archetypes` fail while `score_card`, `similar_cards` and `find_pairings` answer. Load per tool need.

**B4. `data/counters.json` is read from the install root and covered by no hash.** `src/meta/counters.ts:28`; the meta replay record (`scripts/meta.ts:250`) has no counters entry, and `data_version` does not report it. Same pattern for `data/complementarity.json` (`src/synergy/context.ts:19`) and `data/rules-core.json` (`src/rules/store.ts:88`). dup #33, new evidence.

**B5. No CI.** No workflow, hook or husky step runs typecheck, lint or tests. A push with a failing suite deploys normally. Also: on a fresh checkout two test files crash at collection because `describe.skipIf` still runs its body (`tests/rules/parse-cr.test.ts:59-61`, `tests/glossary/field-guide-counts.test.ts:39`, ENOENT confirmed), `tests/rules/helpers.ts:60` calls `mkdtempSync` under a `tmp/` nobody creates, and 17 tests skip silently (5 of them the entire e2e). dup #45 for the skips; the crashes and the missing CI are new.

**B6. `npx` installs build on the user's machine from unlocked devDependencies.** `dist/` is git-ignored, so `prepare` runs `scripts/bundle.mjs` on every `npx -y github:LampaGJ/swu-mcp`; npm ignores `pnpm-lock.yaml`, so every `^` range floats, and the tree includes `wrangler` 4.151.1 (unused in src, added for #16) with `workerd` and `sharp` install scripts. Commit a prebuilt `dist/server.js` and drop `prepare`, or at least remove `wrangler` until #16 lands and ship an `npm-shrinkwrap.json`.

## C. Seams and doctrine (medium)

**C1. Deck snapshot files are dropped with only a count** (`scripts/meta.ts:104-107`, `scripts/bench/extract-decks.ts:94-96` swallows every error). `placement` and `event` are `.nullish()` (`src/meta/schema.ts:30`), so an upstream rename silently turns every tournament deck into a community deck (D21 tier order) with exit 0.

**C2. The coefficient fit reads its pinned capture unparsed.** `scripts/fit-coefficients.ts:111-112` `JSON.parse(...) as {...}`; a renamed `timesIncluded` gives NaN at line 179 and the `games <= 0` guard at 183 does not fire on NaN. The output `data/rubric-coefficients.json` is written with no `coefficientsSchema.parse` (`:284-292`). This is the D1 scoring input. Not covered by #54, #55 or #39.

**C3. `resolve_card_name` text is unbounded.** `src/tools/catalog.ts:32` `z.string().min(1)`; the edit-distance pass (`:57-66`, `:156-168`) is linear in input length. Measured 11.9 s for 60 KB on the single-threaded stdio server. `.max(200)`. Matters more once #16 ships a network endpoint.

**C4. The pair verifier turns a renamed column into one phantom pair.** `scripts/verify/pair-fixture.ts:50-52` reads `String(pair.cardA)` from a `z.record(z.string(), z.unknown())` row; confirmed output `undefined>undefined:undefined`. Precision and recall for pairs-v1 would then be computed over one fake pair with no error. A strict row schema exists at `scripts/bench/real-play.ts:~95`; share it.

**C5. Deck `createdAt` is a shape regex, not a calendar check.** `src/meta/schema.ts:20` `z.string().optional()`; `DATED_DIR.test` accepts `2026-13-45`, and `windowOf` takes the lexicographic max, so one bad date moves the meta window and drops every real deck (confirmed: `{"from":"2027-01-16","to":"2026-13-45"}`). Use `z.iso.datetime({ offset: true, local: true })`. D4 names `z.iso.*`.

**C6. File schemas accept degenerate content.** `swuCardFeaturesFileSchema` accepts `[]` and duplicate `cardKey`; `scoresFileSchema` accepts `cards: []`; `metaFileSchema` accepts `archetypes: []` (all run with `safeParse`). `src/scorer/inputs.ts:49-52` checks features within cards but not the reverse, so a truncated features file scores nothing silently. `.min(1)` plus a uniqueness refine.

**C7. `scripts/market.ts:68-88` writes `prices.json` and `play.json` with no emitter parse** though `pricesFileSchema` and `playFileSchema` exist; no one-line record of taking the emitter-gate out. `priceImportFinishedAt` is `z.string().nullable()`; `z.iso.datetime({ local: true })` accepts the real value.

**C8. `release:data` trusts `build.json`.** `scripts/release-data.ts:56` re-hashes nothing and does not require `verify/audit.json`, so a hand-edited run is archived and pinned with the old buildHash.

**C9. Five scripts default the originals to a literal `2026-10-16`** (`scripts/meta.ts:204`, `scripts/bench/extract-games.ts:87`, `extract-decks.ts:59`, `extract-sims.ts:73`, `real-play.ts:250`) while `build:data` uses the newest. One package can mix two inputs. dup #35 in spirit; the literal date is new.

**C10. `rules:fetch` falls back to a CDN download with nothing to compare against.** `scripts/rules-fetch.ts:35,48`; `build:data` passes `--pdf` only when a PDF is stored. Two fresh checkouts can build different rules runs.

**C11. Tool failures reach the client in five shapes**, and a re-thrown `ZodError` arrives as a raw JSON issue array (`src/tools/meta.ts:524`, `deck.ts:1377`, `synergy.ts:445`; SDK `createToolError(error.message)`). `rules_core` is the one success that is not TOON (`src/tools/rules.ts:175`). dup #28, inventory for its implementer.

**C12. Progress heartbeat missing** (D29) in `scripts/bench/extract-decks.ts`, `scripts/market.ts`, `scripts/fit-coefficients.ts`, `scripts/verify/sample.ts`, inside `searchTrios` for `pnpm synergy`, and the bootstrap loop of `scripts/bench/meta-defense.ts:190`.

**C13. Three name normalisers disagree on apostrophes** (`src/tools/catalog.ts:121-126` strips them, `src/tools/deck.ts:116-117` keeps them), so `resolve_card_name` matches a title that `deck_audit` reports unresolved. Plausible, from the regexes; a two-resolver test would settle it.

**C14. `features.json` is parsed three times per process** (`src/tools/value.ts:56`, `src/synergy/context.ts:48`, `src/tools/meta.ts:93`) and `value_vs_price` re-parses `scores.json` per call (`src/tools/market.ts:151`). Measured about 107 MB heap after the first synergy or deck call.

**C15. D35 is recorded as present-tense behaviour the code does not have.** Both legality readers (`src/tools/catalog.ts:73`, `src/tools/deck.ts:267-268`) read "non-Premier legal" as legal and any "rotated" as rotated; no Weekly Play inheritance exists. No current expansion note contains "non-Premier", so no card is affected today. dup #44; new: add the R3 ordering and the D35 pointer to #44's tasks, give D35 an "Enforced in" line, and fix the fixture note at `tests/meta/tools.test.ts:52` (no "Main set N", so under R4 it becomes promo-kind and the test silently stops exercising a legal card).

## D. Tests

- `pairs-v1.json` has no replay test although `pinFixture` over `data/pinned/pair-fixture-v1` reproduces it byte for byte today (confirmed with `cmp`). Add the one-line test.
- Four fixtures have no committed generator: `tests/synergy/real-cards-14.json` (cites a run that no longer exists), `tests/synergy/real-cards.json`, `tests/fixtures/rules/cr-slice.txt`, `tests/fixtures/rules/raw-pages/page-0001.json`. D2 says hand-made data needs a transform step.
- `tests/synergy/determinism.test.ts:7` is a regex lint weaker than the grammar lint (no `toLocale`, `performance.now`); no synergy, meta or similarity output is compared against a committed hash (only the scorer is). dup #37.
- Deck-tool branches with no assertion: unknown fixed leader or base in `suggest_leader_base`, `playable_cards`, `fungible_in_deck`; `noCards` in five tools; `owned_vs_needed` unresolved owned list; rotated or unverified leader in `checkSet`; the `withEnv` throw-to-isError path (`src/tools/deck.ts:566-1378`, grep for `isError` finds 7 sites in `tests/deck-tools.test.ts`).
- `tests/meta/no-karabast.test.ts:38` guards only `scripts/meta.ts` and `src/tools/meta.ts`; extend to `src/server.ts` and the other build steps. Clean today.
- `tests/verify/sample.test.ts:177` pins run `2026-10-16` while the newest is `2026-10-17`.

## E. Low and hygiene

- Download has no timeout (`src/data-source.ts:63`); interrupted extraction leaves `.staging-*` forever (`:89`); no hostile-archive test (tar v7 contained `..`, absolute and symlink entries when run by hand).
- Pin schema accepts any `url` host or scheme and ties `tag`/`asset` to nothing (`src/data-release.ts:15-22`); sha256 still guards content.
- Hash fields typed as bare strings where `hex64` exists (`src/rules/check.ts:16-18`, `src/rules/schemas.ts:92-97`, `scripts/rules-fetch.ts:39`, `src/swu/raw-manifest.ts:20`).
- `rules/store.ts:89-103` and `src/tools/rules.ts:68-142` cast `byId.get(x) as RuleSection`; no load-time check that refs, parents and keyword sections exist (clean in current data).
- `find_pairings` and `find_trios` `alternatives` are plain strings with no clause text (D15, `src/tools/synergy.ts:249`, `:319-327`).
- Numeric CLI args use bare `Number()` in three scripts; sibling scripts use `z.coerce.number().int()`.
- `costBucket` is copied verbatim (`src/meta/build.ts:161`, `src/tools/deck.ts:380`); newest-dated-directory has four implementations; `costBand` disagrees on null.
- `release:data` ships a 14 MB `synergy/` directory no runtime path reads (`src/synergy/context.ts:45-50` rebuilds from features); `scripts/smoke-stdio.mjs` is referenced nowhere.
- Docs drift: CLAUDE.md "the two prompts" (three are registered, `src/resources.ts:169-179`); CLAUDE.md `build:data` step list omits `meta`; CLAUDE.md:52 states the e2e guarantee without the skip caveat README gives.
- `WORK-STATE.md` (2026-10-17) was stale: #18 is closed; deleted on consumption.

## Clean

- Download integrity: size and sha256 checked before extraction, staging then atomic rename, override URL still bound to the pinned hash.
- No `exec`, `spawn` or shell in `src/`; the only regex built from an argument is escaped; `get_cards_batch` field names are checked against real columns; deck lists capped at 250 lines and 99 copies.
- No deprecated Zod v3 shape anywhere; every `z.record` is two-arg; every exported type is a `z.infer`.
- D1 holds: nothing on the scoring path reaches a model or embedding. D10 holds: `readOnlyHint` set, no tool writes.
- All 48 tools have in-process tests; `tests/tools.test.ts:104` pins the name list without data.
- No real network, Ollama or wall clock in tests.
- Every `src/**` module has an importer; every package script target exists; README and CLAUDE.md command names resolve.

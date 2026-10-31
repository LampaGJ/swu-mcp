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

**D13. Fungibility: same-role cards across aspects are substitutes** (2026-10-16). Why: flexibility in which card fills a chain slot. A unit's own arena (ground, space or ground+space) is part of its role signature (#66, 2026-10-30), because swapping a Ground unit for a Space unit changes the board; non-units carry no arena and keep their class ids. Enforced in: `src/synergy/fungibility.ts`.

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

## Rulings on the red-team follow-ups (2026-10-17)

**D30. Misspelled tool arguments are fuzzy-matched** (#29). An unknown argument name is matched to the closest declared parameter (for example `subtitel` to `subtitle`), applied, and reported in the result as a correction. A key with no close match is rejected with InvalidParams naming the key and the nearest valid names. Silent dropping (today's SDK behaviour) ends.

**D31. Set codes are classified from the official expansion list** (#38). The pinned card-list pages carry each expansion's code and name (for example IBH = Intro Battle: Hoth, J25 = 2025 Judge Program, C25 = 2025 Convention Exclusive). The scorer's set guard classifies every code through that list (main set, Weekly Play, promo, starter, convention, judge, organised play) and fails loudly only on a code the official list does not know.

**D32. The rubric probe scripts stay** (#39). The five scripts/rubric probes are kept and run under tsx against the promoted OLS module.

**D33. knip is adopted** (#51) to list unused exports; de-exporting follows from its baseline (#52).

**D34. Input roots keep the /Volumes paths as defaults** (#35). Each root is configurable by flag or SWU_* variable; the current /Volumes paths stay as the documented defaults.

**D35. Premier-legality rulings** (#44, owner review 2026-10-18). R1: a Weekly Play set inherits a Premier-legal parent (its cards read legal). R2: a Weekly Play set with a rotated parent reads rotated (fails deck legality and drops out of suggestions). R3: only explicit wording counts — "Premier legal" means legal; "Premier rotated" and "non-Premier legal" both mean not Premier-legal; anything else reads unverified. "non-Premier legal" must be matched before "Premier legal", which it contains. R4: the kind of set decides first — promo-kind sets are judged card by card, Weekly Play sets follow their parent.

**D36. meta_answers ranks by coverage band, then deck evidence, then cost band** (#65, spec 2026-10-30). Within one aspect penalty, answers sort by coverage in bands of 0.05, then by evidence class (ok before negative), then by cost band (0-2, 3-4, 5-6, 7+; an unknown cost last), then by exact coverage, threat count and cardKey. An answer is unmeasured unless both sides (decks with the card, decks without it) have at least `minN` decisive matches; a card with no deck evidence is unmeasured too. With `minN` on both sides it is negative when its difference is below -0.05 whatever the deck count (the decks floor protects ok claims, not negative ones; a negative with under 10 decks with the card carries `deckEvidence.thin`), and ok only when both sides also have at least 10 decks (`MIN_EVIDENCE_DECKS`); otherwise it is unmeasured and `deckEvidence.unmeasured` names the thin side. Unmeasured sorts with ok, never demoted, but is reported as `evidenceClass: unmeasured` so a thin sample is not read as a clean one ("No Glory, Only Results" read ok beside 8 decks against 999). The class reorders inside a band and never removes a row. Why: removal answers to one threat tie on coverage to four decimals, so cost alone put a 4-cost card with a 42.2% match win rate (n=45) ahead of an unmeasured 5-cost card and an 11-cost unit ahead of everything cheaper. The evidence is association, not effect, because opponents are unknown. Enforced in: `src/tools/meta.ts` (`compareAnswerRank`, `evidenceClassOf`, `thinSides`, `costBand`).

**D37. Cluster role names are a pinned model capture keyed by member-set hash** (#64, spec 2026-10-30). `data/cluster-labels.json` holds one short human name per similarity cluster (for example "Sentinel walls"), written once by a model pass that read each cluster's member cards and committed with `labelsVersion: 1` and the capture date (D3). Each entry carries `membersSha256`, the sha256 of the sorted member cardKeys joined by newlines. `deck_audit.clusterGaps` shows the human name with `labelStatus: pinned` only while that hash equals the loaded run's cluster members; a changed cluster shows its token label with `labelStatus: stale`, and a missing file shows `unlabelled`. Why: ids are assigned by size, so a re-clustering can reuse an id for different cards, and a name written for the old members would mislabel the new ones. `scripts/similarity/label-clusters.ts --check` exits 1 naming the stale ids. Enforced in: `src/embed/cluster-labels.ts` (`resolveClusterLabel`), `src/schemas/cluster-labels.ts`.

**D38. Leader-aware ranking rests on tournament decklist inclusion; lift is against aspect-eligible decks; population and window are always named** (#19, 2026-10-30). `meta/leader-cards.json` holds, per leader, the placement-weighted inclusion and mean copies of every card over all of the leader's tournament decks in the meta window (all archetypes), capped at 150 cards. Community lists stand in only for a leader with no tournament deck, and the entry is flagged `fallback`. The baseline of a card is its inclusion across every deck of the same population whose leader and base icons cover the card's aspect icons, so lift compares the leader against decks that could play the card without a penalty, not against the whole field. `playable_cards` ranks within a cost by that inclusion, then the play-calibrated score; `budget_alternatives` never offers a substitute with a higher aspect penalty than the card it replaces and lists played substitutes first. Every output names the population, deck count and window (D21), and leader_cards rows are counts, so they carry `status: fact`. Why: the ranking tools ignored the tournament decklists the server already held, and suggested Porg but never Pre Vizsla, Koska Reeves or Marrok for Cad Bane. Enforced in: `src/meta/build.ts` (`buildLeaderCards`), `src/meta/schema.ts` (`leaderCardsFileSchema`), `src/tools/meta.ts` (`leaderCards`), `src/tools/deck.ts` (`playableCards`, `budgetAlternatives`, `leaderCardsOf`).

**D39. Budget swaps stay in the card's cost neighbourhood, and a lone role class widens in two named steps** (2026-10-30). `budget_alternatives` only offers a substitute of the same type, the same arena for a unit, and a cost within 1 of the replaced card; the six-plus cost band alone let an 11-cost card stand in for a 7-cost one. It reports `savingPerCopy` (the largest saving of any one listed swap on one copy) and `totalSaving` (the sum over slots of copies times the first swap's saving), not one figure that summed copies under a per-copy name. `fungible_substitutes` retries a role whose class has no other member with the cost band relaxed to the adjacent bands, then with magnitude ignored too, keeping tag, type, timing, target and arena; it reports `widened` and tags those substitutes `match: widened`. Pair edges are unchanged (`pnpm verify:pairs` identical before and after). Why: the first figure read 314 against a dearest card of $42.79, and Marrok had no substitutes at all. Enforced in: `src/tools/deck.ts` (`sameSlotShape`, `budgetAlternatives`), `src/synergy/fungibility.ts` (`widenedSubstitutes`), `src/tools/synergy.ts` (`fungibleSubstitutes`).

**D40. meta_answers caps answers per primary threat; playable_cards in leader mode drops unplayed cards** (2026-10-30, judge findings on Cad Bane / Nevarro City). meta_answers: after the D36 sort, at most `perThreat` (default 4) answers per primary threat (the threat adding the most share x weight x fraction to the answer) stay in place and the rest follow in rank order, the same stable partition as find_pairings' `perLink`; `capped` counts the deferred rows and `threatsCovered` lists every threat the defended archetypes pose with the number of shown answers that address it (0 is a visible gap). Why: all ten shown answers addressed only key-units while shields and sentinel-wall, the biggest threats of the leading archetype, had none. playable_cards: when ranked by leader, a card with `leaderInclusion` null is dropped unless `includeUnplayed: true`, `emptyCosts` names a cost with no played card, and `emptyCostsOnly` returns an explicit row for it instead of a score-ranked card the leader's decks never play. Why: Porg (unplayed, cost 0) led cost 0 and cards under 3.5% padded the list. Enforced in: `src/tools/meta.ts` (`metaAnswers`, `primaryThreatOf`), `src/tools/deck.ts` (`playableCards`).

**D41. An unresolved title says the name may be a rotated-set card** (2026-10-30). The package holds only Jump to Lightspeed-onward cards, so the server cannot see a rotated card; a title miss now reads "not in the data: ... either a card from a rotated set (<names>) or a misspelling", with the names read from the expansion index (main sets marked rotated), never hard-coded. Enforced in: `src/tools/deck.ts` (`missDetail`, `rotatedSetNames`).

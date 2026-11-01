---
type: research
status: active
review_by: 2026-12-31
related: ["docs/specs/learned-play-policies.spec.md", "docs/decisions.md", "data/pinned/sim-vocab/2026-10-30.r6.v2.json"]
---

# Evaluator state encoding (stateVersion 1)

TL;DR: the learned evaluator (#125 to #128) sees the game through one viewer-relative view, `RawStateView`, and one pure encoder, `encodeState`, both in src/sims/state.ts. The opponent side has no hand and no library field, so a leak fails to parse. Both sides' base and leader identities are encoded. Card identities go through a pinned, append-only vocabulary: r6 holds the 1,600 cards of the data release, and its revision 2 (data/pinned/sim-vocab/2026-10-30.r6.v2.json, 2,435 keys) adds the older engine cards that tournament decks still play. The extractor, `extractStateView` in src/sims/state-view.ts, reads named live engine fields. Over 1,000 rung 1 games it costs less than `Game.getState`, never overflows the unit cap, and overflows the hand cap in 9 of 136,828 states. With revision 2, no card reference encodes as unknown (0 of 8,012,351), against 15.8% with r6.

## Layout

- Version and caps: `STATE_VERSION` 1 (src/sims/state.ts:15), 16 unit slots per side (`U`, src/sims/state.ts:17), 12 hand slots (`H`, src/sims/state.ts:19), 50 scalars (src/sims/state.ts:58). The derivations are in #124: about 2 units per round over the median 7-round game plus 2 for tokens; 4 cards after the opening resource step plus 2 draws in each of four regroups.
- Identity: per side the base and the leader vocabulary index (`IDENTITY_NAMES`, src/sims/state.ts:77), added by the coordinator ruling of 2026-11-01 before any dataset depends on the layout. Leader deployment and exhaustion stay among the scalars, and a deployed leader also fills a unit slot with `isLeaderUnit`.
- The layout object is hashed into `STATE_LAYOUT_SHA256` 74c8292c3f21 (src/sims/state.ts:95), and a test recomputes it, so a layout edit without a version bump fails.
- Order is canonical everywhere, never engine zone order: units by arena, cardKey, power, damage, then upgrade keys; hand by cardKey; histograms by index.
- Hidden information: the opponent schema is `z.strictObject(sideShape)` with no hand or library (src/sims/state.ts:146), so an `opp.hand` key is an unrecognized-key error.
- A decision between phases (forceteki's `currentPhase` is null there) encodes as an all-zero phase one-hot.
- Out of version 1, so the omission is visible: captured card identities, the mechanical edges and the `playCalibrated` sum (docs/research/sim-bot-policy-ladder.md:159).

## Vocabulary

- `pnpm sims:vocab --data data/runs/2026-10-30` builds r6 from the run whose build.json `buildHash` equals src/data-release.json (scripts/sims/build-vocab.ts:46) and from the engine's `KeywordName` at the pinned forceteki commit (scripts/sims/build-vocab.ts:60). A rerun reports "identical to the pinned vocabulary"; different bytes are refused (scripts/sims/build-vocab.ts:112).
- `--parent data/pinned/sim-vocab/2026-10-30.r6.json --revision 2 --bridge-originals <mault originals>` builds revision 2: r6's keys first, then the #109 bridge's printing keys of the 835 engine cards the store lacks (scripts/sims/build-vocab.ts:73). The file is named `<dataVersion>.v<n>.json` (`vocabFileName`, src/sims/vocab.ts:108) rather than r7, because r7 is the name the next data release would take.
- Indices: 0 pad, 1 unknown, 2 hidden, cards from 3. Tokens alias by (type, title) to one key, inherited by every child version. Keys and keywords of a version are a prefix of the next one (`assertChildOf`, src/sims/vocab.ts:70).
- r6: contentSha256 `553389481fbf88d9bcd9214a99145f1fb6b0fe3ee2c4203078652258321a8c1c`, replay outputHash `69b1d0f1efd44ce4b23d42a80af539cb7e68dfa941dea2d4979adb7131234f41`.
- Revision 2: contentSha256 `4254d5928c4a50926cdb2d5fb3c43ea57696527ddeaa7c7fde9d08932d8ad2fc`, replay outputHash `b5d1ce31d31d1afd97de1c383366e438ea5854d9315bb8127b4f647db4108e91`. Both name engine commit 445792e6185c.

## Extractor

- `extractStateView(game, viewerSeat, keys)` (src/sims/state-view.ts:64) reads `hasTheForce`, `creditTokenCount`, initiative, resources, zone counts, arena units with their upgrades, shields and captured cards. It never calls `Game.getState`, which builds the whole summary and advances the per-viewer chat and animation cursors.
- Card resolution (`cardKeyOf`, src/sims/state-view.ts:56): the release store's cardKey by normalised title and subtitle, the rule the bot tables use (src/sims/policies/tables.ts:234); else the bridge's printing key; else `~internalName`. Tokens resolve by title.
- The view is parsed on both sides of the seam: the extractor parses before it returns, and `encodeState` parses again.

## Measured on 1,000 games

Command: `node --import tsx scripts/sims/state-view-cost.ts --games 1000 --vocab data/pinned/sim-vocab/2026-10-30.r6.v2.json --compare data/pinned/sim-vocab/2026-10-30.r6.json` (rung 1 both seats, 12 decks from data/originals/decks/2026-10-17 by code point, seeds `svcost-0` to `svcost-999`, extraction before every decision, scripts/sims/state-view-cost.ts:122). The report is local (reports/sims/state-view-cost-v2.json).

- Games and decisions: 1,000 games, 136,828 decision states, no extraction failure. Three games (seeds svcost-223, svcost-487, svcost-619) end in a driver error, "Cannot read properties of undefined (reading willDefeat)", that replays without any extraction, so it is a rung 1 or engine fault outside this encoder.
- Cost per decision, milliseconds: `extractStateView` p50 0.164, p95 0.257; `encodeState` p50 0.063, p95 0.084; `Game.getState` on the same decisions p50 0.272, p95 0.491. The extractor's p50 is below the 0.5 ms the engine spends per prompt (docs/research/forceteki-simulation.md:62), so no field is named as slow.
- Units per side: at most 10 against a cap of 16; no state overflows the unit slots.
- Hand: at most 14 cards; 9 states overflow the 12 hand slots (0.0066%, under the 0.1% trigger for a new version).
- Unknown cards, base and leader included: with revision 2, 0 of 8,012,351 card references; with r6, 1,264,381 (15.8%). No engine card stays unresolved (`~`), and no keyword is unknown.
- Captured cards: 715 states with a capture for viewer seat 1 and 1,110 for seat 2 read without error. This shows the field reads for both seats; it is not the scripted capture #124 asked for.

## Open questions

- Open question: does `capturedCount` match a scripted capture for both seats? The 1,000 games show only that it reads.
- Open question: Battle Droid and Clone Trooper tokens have no card in the r6 store; none appeared in these 1,000 games, so their identity is unmeasured.

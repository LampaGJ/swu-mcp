# Rubric analysis scripts (prototype)

Moved from mault-handoff `issue-322-rubric/` (swu-mcp#4). Two path changes were made: generated files (`cards.json`, `printings.json`, `*.out.json`) go to `data/rubric/` (git-ignored), and the pinned captures are read from `data/pinned/gt/`. `load.mjs` now reads the uncompressed pages from a mault originals folder (default 2026-10-16).

Run in this order: `load.mjs`, `fit-units.mjs`, `fit-effects.mjs`, `fit-other.mjs`, `score.mjs`, `play-model.mjs`. Rubric: `docs/research/swu-card-value-rubric.md`.

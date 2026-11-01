# Pinned captures

Inputs to `scripts/rubric/`, copied byte for byte from `~/Projects/mault-handoff/issue-322-rubric/` on 2026-10-16. Each is small (under 5 MB), so it is committed.

sha256, then file:

    92abdce8e9334bba2a8391687ba2f35d3656bfb32d1b8a5849730450f9886da3  gt/swustats-premier-w0-55.json
    757e28024d28152e864a56074193a67be6462ac9242e6f1729811506ca5d6cc2  gt/swustats-premier-w29-55.json
    bd1be9d04318ff9c95cfcd1e28db7c6c32deafd3f8cf5eda3134cad7d131a21a  gt/swustats-premier-w43-55.json
    5b14b16223f6f622ecfe37ce5844394500f1ba1cd4bb647edb4c60712190d396  gt/tcg-prices-import43.tsv

`gt/swustats-premier-*.json` are SWU Stats Premier inclusion captures by game window. `gt/tcg-prices-import43.tsv` is the TCGplayer price import 43 export. `articles/` holds the official strategy articles the rubric cites, as text.

## base-locations/

`forceteki-<hash12>.json` holds the printed location of every base our card table holds (`cardKey`, `title`, the engine's source string `location`, and the display name `locationName` that the features step merges into the base's traits, D59). The official API ships every base with empty traits, so the location comes from the forceteki engine's card data (`test/json/Card/*.json`), read once by `scripts/pinned/capture-base-locations.ts` (`--engine <clone>`; the clone is never written to). `<name>.manifest.json` records the file sha256, the engine commit, the engine card-data hash, the sha256 of the card table it was mapped against, and the engine bases the table does not hold. A second capture of the same source rewrites nothing; a different source has a different card-data hash and so a new file, and `pnpm card-features` then needs `--base-locations <file>` to say which to use. Re-capture only when the engine's card data changes or the card table gains a base.

## sim-ladder-v1/

One gate record per bot-ladder step (#114, D79), written by `scripts/sims/ladder.ts`: the candidate and baseline policies with their params hashes, the engine pin, the sha256 of every table the rungs read, the six-deck panel with each list's sha256, the seed range and its purpose (tuning, evaluation or deck check), the sign test, Wilson shares, per-deck shares, the pass verdict, non-decisive and fallback counts and a sha256 over every game's trace. No field holds a wall-clock time, so the same code, inputs and seeds rewrite the same bytes. The results are bot play, never human win rates; `docs/verification/2026-10-31-bot-ladder.md` reads them.

## sim-models/

The inventory of the models already trained on /Volumes/Models/swu (#123, D93), written by `pnpm sims:inventory --parity` and `pnpm sims:feature-map`: `manifest.json` holds each model file's sha256, size, format, objective, feature layout, producer and the enums provenance, d22, verdict, reason and parity; `feature-map.json` tiers the old harness's 595 feature columns; `README.md` lists them. Weights and metrics are never here: every entry is D22 quarantined (D52), and recorded metrics go to the git-ignored data/originals/sims/model-inventory/.

## sim-vocab/

The evaluator's card and keyword vocabulary per data release (#124, D94), written by `pnpm sims:vocab`: `<dataVersion>.json` from the release's cards.toon and the engine's `KeywordName`, `<dataVersion>.v<n>.json` for a revision that appends the #109 bridge's printing keys of engine cards outside the release, each with a `.replay.json`. A pinned vocabulary is never overwritten; a later one only appends (indices stay stable).

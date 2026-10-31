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

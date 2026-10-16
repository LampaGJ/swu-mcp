# Pinned embedding captures

Each directory `<renderVersion>-<inputHash12>/` holds one capture of model output, taken once by `pnpm embed:capture` and never recomputed by tools or transforms:

- `ability.f32`, `abstract.f32`: 1,609 x 768 little-endian float32 rows, in `index.json` key order. About 4.9 MB each, so they are committed.
- `index.json`: render version, dims, card keys.
- `replay.json`: model name, Ollama version and manifest digest, weights blob sha256, the `search_document: ` prefix, the input hashes of both renderings, and the sha256 of both vector files.

`loadCapture` (`src/embed/pinned.ts`) refuses a directory whose bytes do not match `replay.json`. `pnpm embed:capture` refuses to replace a capture whose bytes differ.

To re-capture (new card list or new render version): start Ollama with `nomic-embed-text` (weights blob sha256 in `replay.json`), run `pnpm embed:capture`, and commit the new directory. A new directory name means new inputs; `pnpm similarity` picks the capture whose input hash matches the current renderings.

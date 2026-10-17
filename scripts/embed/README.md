# Embedding experiments (research)

Copied from mault-train `swu-card-data/embed/scripts/` for the bake-off in swu-mcp#2. The Python scripts now find each other through their own directory and read and write the work directory in `EMBED_WORK` (default `<repo>/tmp/embed-work`, git-ignored; it needs `cards.json`, `vec/`, `reports/.progress/`). `needs.py` still reads `mault-train/swu-card-data/features/out/cards-does-needs.json` (issue I9). Which needs variant (`needs.py` or `needs2.py`) produced the published results is not recorded.

The three token-size scripts (`dec`, `tok` and `sizes`, all Node `.mjs`) are removed: they imported `gpt-tokenizer` and `@toon-format/toon` from a mault-train path and could not run here. They were last present at the parent of the commit that removed them (the G21 parent commit).

The shipped pipeline is TypeScript, not these scripts: `src/embed/render.ts` (renderings, byte-identical to `render.py` and `abstract.py`), `pnpm embed:capture` and `pnpm similarity`.

Python deps: `requirements.txt`. Run with `python -I` from an isolated venv.

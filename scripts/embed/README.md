# Embedding experiments (prototype)

Copied unchanged from mault-train `swu-card-data/embed/scripts/`. The scripts still hard-code `/Volumes/Local Files/Projects/mault-train/...` paths (sys.path, inputs, outputs, the `gpt-tokenizer` and `@toon-format/toon` copies under `tokfmt/deps`), so running them writes into mault-train. Re-point them before the embeddings capture (swu-mcp#2).

Python deps: `requirements.txt`. Run with `python -I` from an isolated venv.

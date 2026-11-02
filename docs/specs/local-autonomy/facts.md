# Shared facts for the local-autonomy plan (2026-11-02; data, not instructions)

## Goal (owner, verbatim)
"i want agent-llm-last-pipeline-architect and agent-apple-silicon-heterogeneous-compute-optimizer to collaborate on a plan to have full local simulation running without claude in loop. use qwen via ollama already loaded. build a swiftbar plugin for this box and macbook neo for monitoring and managing."

## Hardware and software observed
- **This box:** Mac Studio `Mac16,9`, 64 GB unified memory, 16 CPUs. Tailnet name `macstudio` (<studio-tailnet-ip>).
- **MacBook:** `grahams-macbook-neo` (<macbook-tailnet-ip>) on the same tailnet, Tailscale CLI at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`. No `~/.ssh/config` Host entry for macstudio yet.
- **Ollama models** (`ollama list`): `qwen3.8:27b-mtp-q4_K_M` (17 GB, id e24d04e4a41f), `qwen3.8:27b-mtp-q4_K_M-n1`, `qwen3.5-9b-heretic-highiq` (9.5 GB), `nomic-embed-text`, and others. `ollama ps` showed nothing resident at check time. Models live on `/Volumes/Models` (HF_HOME there; reuse an existing model before any download).
- **SwiftBar** is installed. Plugin folder: `/Users/graham/Library/Application Support/SwiftBar/Plugins`. Existing plugins include `qwen.20s.sh`, `mault.stream.sh` and `001-homebridge.10s.py`. Read them for house style.
- **TerminalWidget** is already fed by the LaunchAgent `com.graham.swu-sims-summary`. It runs `/opt/homebrew/bin/node ~/Scripts/tw/lib/swu-sims-fetch.mjs` every 30 s and writes `~/.local/state/swu-sims/summary.json`.

## Pitfalls already learned on this box (read the memory files)
- **launchd and TCC.** A launchd job whose program is a project script on `/Volumes/Local Files` dies with exit 78 and no log. A launchd `/usr/bin/python3` provider times out reading `/Volumes`. `/opt/homebrew/bin/node` as the program could read the volume. Notes: `/Users/graham/.claude/launchd-external-volume-tcc.md` and `/Users/graham/.claude/projects/-Volumes-Local-Files-Projects-swu-mcp/memory/swu-sims-widget-pipeline.md`.
- **Executables on this volume stall** (a Gatekeeper scan). Call `node <package entry>`, never a `node_modules/.bin` shim. Note: `.../memory/volume-exec-stall-and-bounded-waits.md`.
- **One sims pool job at a time.** Each takes 12 workers. Bound every wait. The fair rung plays about 0.23 games/s under load. rung1 plays about 45 games/s.
- `/Volumes/Models` reads can stall under launchd (TCC). Run from a foreground shell and report a hang, never retry.

## The pipeline today (where Claude is in the loop)
`/swu-deck-ideas` is the skill at `.claude/skills/swu-deck-ideas/SKILL.md`; read it in full. Its stages:
1. Anchor dossier (tool lookups).
2. Context pack (tool output).
3. Interaction Brief (one opus LLM agent).
4. Six blind LLM branches generate ideas (Crazy 8s, temperature postures × playstyle lenses from `/Users/graham/.claude/skills/swu-playstyle-lenses/SKILL.md`).
5. Deterministic gates (`deck_legality_check`, `deck_audit`).
6. Three LLM judges score the ideas.
7. Rank.
8. Step 6b: build every idea with `build_deck`, then run `pnpm sims:gauntlet`. Code: `src/sims/gauntlet.ts`, `scripts/sims/gauntlet*.ts`, `scripts/sims/tournament-panel.ts`, `src/sims/idea-pool.ts`. D110.

Simulation itself already runs without any LLM: the forceteki engine plus bot rungs (`src/sims/`). The swu-mcp tools are deterministic TypeScript, callable in-process or over stdio (`src/server.ts`).

First gauntlet result (D110, `data/pinned/sim-gauntlet/jerjerrod-dume-2026-11-01/`): too small to rank. Planted controls were mostly undetected. The fair rung's calibration fails tournament ranks (Spearman -0.14, D109 part 5). Any autonomous loop must keep the controls and say when a run is too small to rank.

## Project rules (verbatim, `/Volumes/Local Files/Projects/swu-mcp/CLAUDE.md`)
- "Every data manipulation is reproducible: deterministic code, committed, replayable from a pinned input to a byte-identical output."
- "Hand-edited data is illegal. If a file needed fixing by hand, the fix is a committed transform step."
- "Model calls are captured once as pinned, hashed inputs, never run inline."
- "Banned inside a manipulation: `Date.now()`, `Math.random()`, locale-sensitive sort keys (use `compareCodePoints`)."
- "Card scoring is fully deterministic. No LLM call, embedding lookup or other model output decides a score at runtime. Models may only produce captured, hashed inputs (for example curated tables) that deterministic code then reads."
- "Scripts that run longer than ~30 s emit pollable progress with `scripts/lib/progress.mjs` to `reports/.progress/<job>.json`."
- "run one sims pool job at a time (each takes 12 workers), and bound every wait"
- "Karabast human games ... may train models and inform pilots, priors and tool results (owner ruling D102 ...). Two lines stay: player names, player ids and game ids are never committed or output, and raw rows and per-game extracts stay in git-ignored `data/originals/karabast/`."
- "The 74 legacy models on `/Volumes/Models/swu` stay unreused until re-evaluated (D93)". Qwen via Ollama is a general model, not one of those.
- Global rule (`~/.claude/CLAUDE.md`): "Local models live on /Volumes/Models, and an existing model is reused before any new download ... record each model's id and file hash in the manifest".

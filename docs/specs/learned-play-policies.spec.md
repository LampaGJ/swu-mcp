---
type: spec
status: active
title: Learned play policies for deck simulation
goal: A deck-testing simulation whose bots play better than the heuristic rungs, trained from branch-sampled decision values on the forceteki engine, with every model captured once, pinned and evaluated on the ladder, reusing the models already on /Volumes/Models before training any new one.
tracker: github
review_by: 2026-12-31
related: ["docs/research/forceteki-simulation.md", "docs/research/sim-bot-policy-ladder.md", "docs/research/sim-evidence-strategy.md", "docs/research/tcg-simulation-practices.md", "docs/research/learned-play-policies.md", "docs/decisions.md"]
constraints:
  - No model output decides a score at query time; models enter only as captured, hashed inputs (CLAUDE.md:66, docs/decisions.md D1, D3).
  - Every manipulation is replayable from pinned input to byte-identical output (CLAUDE.md:64); every dataset and weight file carries a sha256 manifest and a replay record.
  - Local models live on /Volumes/Models; an existing model is reused before any new download; a new download over about 500 MB needs a measured reason; the README names the model reused and any rejected (user CLAUDE.md, "Local models").
  - Bot play is the last tier and is never pooled with tournament data; every number names its population and the policy rung (docs/decisions.md D21).
  - Karabast human games are private; a model trained on them is Karabast-derived and needs an owner ruling before any of its outputs ship (docs/decisions.md D22).
  - Scripts over about 30 s emit pollable progress (CLAUDE.md:70).
items:
  - id: sim-models-inventory
    title: Inventory, pin and re-evaluate the models already trained on /Volumes/Models/swu
    tier: architecture
    needs: []
  - id: state-encoder
    title: Versioned structured state encoding and card vocabulary for the evaluator
    tier: architecture
    needs: []
  - id: branch-sampler
    title: Branch-sampled decision values from seeded games, pinned as a dataset
    tier: architecture
    needs: []
  - id: value-net-training
    title: Train the evaluator on branch values and outcomes, capture it once
    tier: feature
    needs: [sim-models-inventory, state-encoder, branch-sampler]
  - id: inference-sidecar
    title: Evaluator inference inside the game loop under a throughput gate
    tier: feature
    needs: [value-net-training]
  - id: rung3-search
    title: Rung 3 and 4 play: lookahead over snapshots with the evaluator, determinized over seeds
    tier: feature
    needs: [inference-sidecar]
  - id: ladder-eval
    title: Ladder evaluation with held-out opponents, both seats, paired seeds and the four gates
    tier: feature
    needs: [rung3-search]
  - id: self-play-iteration
    title: Self-play iteration loop with a stop rule and deterministic seeds
    tier: feature
    needs: [ladder-eval]
  - id: compute-plan
    title: Apple-silicon compute plan for sampling and training, measured
    tier: polish
    needs: [inference-sidecar]
  - id: llm-annotator
    title: Offline decision-log annotation with a local LLM already on the volume
    tier: polish
    needs: [ladder-eval]
  - id: sim-d-entries
    title: Decision-log entries for learned evaluators, model storage and the human-trained ruling
    tier: polish
    needs: [value-net-training]
---

# Learned play policies for deck simulation

Why: the owner's premise is that with enough iterations at each decision branch for each matchup, a model can learn what works without a clever bot. That holds under three conditions recorded in the conversation of 2026-10-30 and in docs/research/sim-bot-policy-ladder.md: the rollout policy still shapes the values, hidden information needs determinization across seeds, and the iteration count is a compute budget that intelligence lowers. This spec turns that into pinned datasets, captured models and a ladder that proves each rung beats the last. It builds on epic #104's engine and driver items (#109 to #118) and on the prior training program found at /Volumes/Models/swu (four XGBoost win-probability models, twelve custom random-forest models from three iterative runs, an MLX model, 64 recorded training runs, a 173,010-game matchup matrix).

## sim-models-inventory — Inventory, pin and re-evaluate the models already trained on /Volumes/Models/swu

**Goal**: The memory rule says reuse before training. /Volumes/Models/swu holds models/bootstrap-trained, filtered-trained, strict-trained (xgboost-model.json each) and human-trained (xgboost, rf-filtered-100k.json, mlx-model.npz), iterative-training/models (twelve custom JSON random forests, 50 trees, depth 12, from three runs), manifests/training-runs.jsonl (64 runs; the last reports accuracy 0.6105 and Brier 0.2375 on binary_win). The four XGBoost files declare 500 unnamed features and no extractor code is on the volume; the older harness at /Volumes/Models/swu-data/simulation may hold it and matchup-matrix.json. Establish what each predicts, from which features and which data, and whether any serves as the rung-4 evaluator baseline.

**Acceptance**:
- docs/research/existing-models-inventory.md lists every model file with sha256, size, format, objective, feature schema (read from training-data samples), training data provenance (bot games vs human games), the training run id and its metrics, and the project or script that produced it (or "unknown, not in mault-train").
- data/pinned/sim-models/manifest.json records sha256 for every reused file; nothing is copied into the repo.
- Each XGBoost model is loaded and scored on 1,000 held-out positions from a fresh rung-2 self-play batch (new driver, docs/research/forceteki-simulation.md), reporting accuracy, Brier and log loss, and the feature mapping used; models whose feature schema cannot be reconstructed are marked "unreusable" with the reason.
- The human-trained models are flagged for the D22 ruling (sim-d-entries) and excluded from any shipped output until ruled.

**Touches**: docs/research/existing-models-inventory.md, data/pinned/sim-models/manifest.json, scripts/sims/ (a read-only scorer)

**Open gaps**: the producing project is unknown (mault-train does not reference /Volumes/Models/swu); the feature schema of the XGBoost models must be recovered from training-data samples.

## state-encoder — Versioned structured state encoding and card vocabulary for the evaluator

**Goal**: One Zod v4 schema for the evaluator's input: base damage both sides, resources, cards in hand count, board units with power, HP, damage, keywords, arena, upgrades, the leader's state, initiative, round, and card identities through a pinned vocabulary keyed by cardKey per data release. The same encoder serves training and inference, so a drift is a schema error, not a silent miscount.

**Acceptance**:
- src/sims/state.ts exports the schema and `encodeState(gameState)`; a fixture game state encodes byte-identically on two runs.
- data/pinned/sim-vocab/<dataVersion>.json maps cardKey to index with sha256; unknown cards map to a reserved index and are counted.
- A test asserts every card in the data release's cards.toon is in the vocabulary.

**Touches**: src/sims/state.ts, data/pinned/sim-vocab/, tests/sims/

**Open gaps**: whether the engine's game-state object exposes enough (docs/research/forceteki-simulation.md names the prompt and state structures); fallback is the driver's own tracked state.

## branch-sampler — Branch-sampled decision values from seeded games, pinned as a dataset

**Goal**: At sampled decision points of recorded rung-2 games, branch every legal action across K determinized seeds (re-dealing hidden information) and N continuations played by the current best rung, and record the mean outcome per action. This is the owner's "enough iterations at each branch": the dataset is the supervision for the evaluator and the policy.

**Acceptance**:
- scripts/sims/sample-branches.ts takes a game-record batch, a sampling rate, K and N, a seed, and the rung to play continuations; writes data/originals/sims/branches/<date>/branches.jsonl.gz plus a manifest (sha256, counts, engine commit, replay record {inputHash, codeCommit, outputHash}); progress heartbeat.
- A re-run with the same inputs and seed is byte-identical.
- The record per decision carries: seed, k, phase, actor, the encoded state, legalActions with per-action mean value and n, the chosen action in the source game, and rngCursor.
- A 10,000-decision sample is produced and its wall time and games-per-second reported.

**Touches**: scripts/sims/sample-branches.ts, scripts/sims/branch-probe.ts (branch probe), src/sims/search-leaf.ts, data/originals/sims/branches/

**Open gaps**: the restore mismatch seen at one of three probe points (docs/research/forceteki-simulation.md) must be root-caused or worked around by treating the restored state as the branch root; depends on #110 and #113 landing.

## value-net-training — Train the evaluator on branch values and outcomes, capture it once

**Goal**: Fit an evaluator on the branch dataset: first the reuse path (retrain the existing XGBoost recipe on the new features, since it is proven on this hardware), then a small MLP in MLX or PyTorch-MPS if it beats XGBoost on held-out Brier. Training is a committed script with pinned inputs; weights are captured once under /Volumes/Models/swu/swu-mcp/<version>/ with a manifest, never trained inline.

**Acceptance**:
- scripts/sims/train-evaluator.ts (or .py under scripts/sims/py with requirements pinned) reads only pinned inputs, writes weights plus training-run.json (hashes, hyperparameters, seed, metrics on a held-out seed range).
- Two runs with the same seed give identical weights (or, for MLX, metrics identical to four decimals and the determinism caveat recorded).
- The evaluator beats the best reused model from sim-models-inventory on held-out Brier, or the inventory model is adopted and the reason recorded.
- README names the model reused and any rejected, with the measured reason.

**Touches**: scripts/sims/train-evaluator.*, /Volumes/Models/swu/swu-mcp/, docs/research/learned-play-policies.md

**Open gaps**: XGBoost in Node (which package) versus Python; the learned-play-policies research names comparable projects' dataset sizes.

## inference-sidecar — Evaluator inference inside the game loop under a throughput gate

**Goal**: Run the evaluator from the driver at every decision without losing the batch throughput: an XGBoost JSON model evaluated in-process, or ONNX Runtime for the MLP, or an IPC sidecar for MLX. The gate is measured, not assumed.

**Acceptance**:
- The driver takes `--evaluator <manifest>` and scores legal actions per decision.
- Measured: games per second on 16 workers with the evaluator versus rung 2, p50 ms per decision; the gate is at least 15 games per second or a documented batch-only mode.
- Per-seed traces stay identical across worker counts with the evaluator on.

**Touches**: scripts/sims/run-batch.ts, src/sims/policy.ts, src/sims/session.ts, scripts/sims/evaluator.ts

**Open gaps**: the optimizer's report on the batch runner (in progress on 2026-10-30) decides worker count and memory settings.

## rung3-search — Rung 3 and 4 play: lookahead over snapshots with the evaluator, determinized over seeds

**Goal**: Rung 3 scores each legal action by snapshot, apply, evaluate, rollback; rung 4 extends to a shallow search with the evaluator as the leaf value and determinization over K re-deals of hidden information. The decision log records the search's values so a match replays and branches.

**Acceptance**:
- Policy rungs 3 and 4 are selectable in the driver; the decision record carries the per-action values and the number of determinizations.
- Snapshot cost per decision is measured (the spike measured 3 to 6 ms per rollback) and the games-per-second cost of each rung reported.
- A seeded match replays byte for byte under rung 3 and 4.

**Touches**: src/sims/policy.ts, src/sims/session.ts, src/sims/search-leaf.ts, scripts/sims/run-batch.ts

**Open gaps**: undo must be enabled for snapshots; the ladder doc notes takeSnapshot returns -1 with undo off, and that undo mode must not change rung 0 to 2 traces.

## ladder-eval — Ladder evaluation with held-out opponents, both seats, paired seeds and the four gates

**Goal**: Prove each rung beats the one below: seeded round-robin over a deck panel, each seed played twice with seats swapped, mirrors included, an exact sign test on discordant pairs, Bradley-Terry or Elo over rungs 0 to 4 and the reused models, with opponent decks held out from training. Nothing is shown by a tool until the four gates pass (replay, health, ladder, calibration against meta/winrates.json).

**Acceptance**:
- scripts/sims/ladder.ts writes data/runs/<date>/sims/ladder.json with per-rung records, intervals, the sign-test p-value and the Bradley-Terry ratings, plus a replay record.
- The held-out opponent set is pinned and disjoint from the training panel; the report says so.
- The calibration check compares each rung's per-archetype win share against tournament win rates from meta/winrates.json and reports rank agreement, never pooling them.

**Touches**: scripts/sims/ladder.ts, data/runs/<date>/sims/, docs/verification/

**Open gaps**: gate thresholds are the owner's (#118).

## self-play-iteration — Self-play iteration loop with a stop rule and deterministic seeds

**Goal**: Generate games with the best rung, re-sample branches, retrain, re-evaluate on the ladder, repeat; each iteration has its own seed range, pinned dataset and captured model, and stops when the ladder gain falls below a documented threshold for two iterations.

**Acceptance**:
- scripts/sims/iterate.ts runs N iterations and writes manifests/iterations.jsonl (dataset hashes, model hashes, ladder result per iteration), mirroring the prior program's manifests/training-runs.jsonl.
- Iteration k is reproducible from its recorded seeds and inputs.
- The stop rule fires in a test with synthetic ladder results.

**Touches**: scripts/sims/iterate.ts, /Volumes/Models/swu/swu-mcp/

**Open gaps**: wall time per iteration on this machine is measured in compute-plan.

## compute-plan — Apple-silicon compute plan for sampling and training, measured

**Goal**: Decide worker counts, memory limits, MLX versus PyTorch-MPS versus XGBoost CPU for each step, from measurements on the M4 Max, and record the budget for a first useful model (games, hours).

**Acceptance**:
- docs/research/sim-compute-plan.md with measured games per second per worker count, peak RSS, training throughput per framework, and the hours for the first iteration; every number from a command listed in the doc.
- The batch runner's chosen settings are committed with the measured reason.

**Touches**: docs/research/sim-compute-plan.md, scripts/sims/run-batch.ts

**Open gaps**: the optimizer's report (tmp/sims-opt/REPORT.md) is the input.

## llm-annotator — Offline decision-log annotation with a local LLM already on the volume

**Goal**: Rung 5 of the ladder: a local LLM explains or labels recorded decisions offline (never in the game loop), using a model already present (mlx-community/Qwen3.6-35B-A3B-4bit or gemma-4-31b-it-4bit in the Hugging Face cache; qwen3.8:27b in Ollama), captured once with a hash per annotated record.

**Acceptance**:
- scripts/sims/annotate.ts reads a decision-log sample and writes annotations with the model id, file hash, prompt hash and record sha256 under data/pinned/sim-annotations/.
- A second run on the same input is byte-identical, or the nondeterminism is recorded and the capture is treated as the pinned truth.
- README names the model used and the ones rejected with the reason.

**Touches**: scripts/sims/annotate.ts, data/pinned/sim-annotations/

**Open gaps**: what the annotations are for (training labels, explanations shown to a builder, or both) is an owner choice.

## sim-d-entries — Decision-log entries for learned evaluators, model storage and the human-trained ruling

**Goal**: Record in docs/decisions.md: learned evaluators enter only as captured, hashed weights (D1/D3); weights live under /Volumes/Models/swu/swu-mcp/<version>/ with manifests in the repo; the ladder and four gates precede any shown number; and an owner ruling on the human-trained models (Karabast-derived under D22: usable for private benchmarking only, or not at all).

**Acceptance**:
- Three entries added with Enforced in lines; README "Honest limits" states that simulated results are bot play with the rung named.

**Touches**: docs/decisions.md, README.md

**Open gaps**: the D22 ruling is the owner's.

## Non-goals

- The simulate_matchup tool, opponent sampler, record schemas, run-games step and branching probe: filed under #104 as #109 to #118.
- An LLM inside the game loop (D1, D3).
- Downloading new models over about 500 MB without a measured reason.
- Training on Karabast human games unless the owner rules otherwise (D22).
- Changing the heuristic rungs 1 and 2 themselves (#114).

---
type: research
status: draft
review_by: 2026-12-31
related: ["docs/specs/learned-play-policies.spec.md", "data/pinned/sim-models/manifest.json"]
---

# Existing models on /Volumes/Models/swu

TL;DR: four XGBoost files, a set of JSON random forests and one MLX file, all from the older harness at /Volumes/Models/swu-data/simulation. Each is D22 quarantined until its training decks and rollout policy are proven free of Karabast data, so none enters a shipped output and no metric of any of them is committed. Hashes and provenance: data/pinned/sim-models/manifest.json. Metrics: the git-ignored data/originals/sims/model-inventory/ (or the `--report` directory a worktree run names).

- Produced by `pnpm sims:feature-map` (runs the harness's `getAllFeatureNames()` in a scratch copy) and `pnpm sims:inventory --parity` (walks, hashes, classifies, checks each loader against its original runtime). Nothing is copied into the repo or written under /Volumes/Models.
- Loaders: src/sims/xgb.ts (float32, left when x < split, missing along default_left; parity with Booster.predict within 1e-6) and src/sims/forest.ts (left when x <= threshold; exact parity with the harness's RandomForest). MLX is hashed only.
- Features: 500 core plus 95 plugin columns; two names repeat, so columns are keyed by index; tiers in feature-map.json, `unavailable` by default.
- Loader parity, as enums in the manifest's `parity` field: every binary_win forest the walk reaches with a known layout passes exact parity with the harness's `RandomForest` on 64 vectors, half on thresholds (`passed`). The four XGBoost files are `not-run`: no xgboost runtime exists on this machine and the 2026-11-01 run allowed no download, so `scripts/sims/py/requirements.txt` documents the .venv that `pnpm sims:inventory --parity` uses once it exists. Their verdict stays `not-scored` until then, and the schema refuses `reusable` without `passed` (src/sims/model-manifest.ts:73).
- D22: only `bot-games` provenance (clean rollout, deck sources proven in PROVEN_DECK_DIRS with a citation) may be `clear`; human-games, human-inferred, bot-games-human-rollout and bot-games-unproven-decks are quarantined.

## Inventory (generated; do not edit between the markers)

<!-- inventory:begin -->
- `/tmp/baseline-large.json`: other, q_value, layout unknown, provenance unknown, D22 quarantined, verdict missing (file-missing), parity not-applicable, sha256 none
- `/tmp/baseline-model.json`: other, binary_win, layout unknown, provenance unknown, D22 quarantined, verdict missing (file-missing), parity not-applicable, sha256 none
- `/tmp/baseline-qvalue-model.json`: other, q_value, layout unknown, provenance unknown, D22 quarantined, verdict missing (file-missing), parity not-applicable, sha256 none
- `/tmp/feature-check.json`: other, binary_win, layout unknown, provenance bot-games-unproven-decks, D22 quarantined, verdict missing (file-missing), parity not-applicable, sha256 none
- `/tmp/position-value-large.json`: other, q_value, layout unknown, provenance unknown, D22 quarantined, verdict missing (file-missing), parity not-applicable, sha256 none
- `/tmp/position-value-model.json`: other, binary_win, layout unknown, provenance unknown, D22 quarantined, verdict missing (file-missing), parity not-applicable, sha256 none
- `/tmp/position-value-qvalue-model.json`: other, q_value, layout unknown, provenance unknown, D22 quarantined, verdict missing (file-missing), parity not-applicable, sha256 none
- `ablation/phase0/model-ablation-optimized-v2.json`: rf-json, binary_win, layout phase3-583, provenance bot-games-unproven-decks, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `d735b75dde7c`
- `ablation/phase0/model-ablation-optimized.json`: rf-json, binary_win, layout phase3-583, provenance bot-games-unproven-decks, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `9b0ae5654f2c`
- `ablation/phase0/model-all.json`: rf-json, binary_win, layout phase3-583, provenance bot-games-unproven-decks, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `007c2daa28a5`
- `ablation/phase0/model-baseline-all.json`: rf-json, binary_win, layout phase3-583, provenance bot-games-unproven-decks, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `c9977eaa031b`
- `ablation/phase2/sweep-100t-16d-opt-ml20.json`: rf-json, binary_win, layout phase3-583, provenance bot-games-unproven-decks, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `c9c091b76e2d`
- `ablation/phase2/sweep-200t-16d-all-qvalue.json`: rf-json, q_value, layout phase3-583, provenance bot-games-unproven-decks, D22 quarantined, verdict not-scored (different-target), parity not-run, sha256 `a34079fc054e`
- `ablation/phase2/sweep-200t-16d-all.json`: rf-json, binary_win, layout phase3-583, provenance bot-games-unproven-decks, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `d6ae69a4495e`
- `ablation/phase2/sweep-200t-16d-opt-lossprev.json`: rf-json, loss_prevention, layout phase3-583, provenance bot-games-unproven-decks, D22 quarantined, verdict not-scored (different-target), parity not-run, sha256 `4972003aa385`
- `ablation/phase2/sweep-200t-16d-opt-qvalue.json`: rf-json, q_value, layout phase3-583, provenance bot-games-unproven-decks, D22 quarantined, verdict not-scored (different-target), parity not-run, sha256 `f92d9747de5e`
- `ablation/phase2/sweep-200t-16d-opt.json`: rf-json, binary_win, layout phase3-583, provenance bot-games-unproven-decks, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `f40b074a0b4d`
- `ablation/phase2/sweep-200t-20d-opt.json`: rf-json, binary_win, layout phase3-583, provenance bot-games-unproven-decks, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `ae081bd3a7dd`
- `ablation/phase4/model-ability.json`: rf-json, binary_win, layout phase3-583, provenance unknown, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `daf79d6921ea`
- `ablation/phase4/model-attack.json`: rf-json, binary_win, layout phase3-583, provenance unknown, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `6072a25d69b9`
- `ablation/phase4/model-play.json`: rf-json, binary_win, layout phase3-583, provenance unknown, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `0de123610973`
- `ablation/phase4/model-resource.json`: rf-json, binary_win, layout phase3-583, provenance unknown, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `4966f26512d6`
- `iterative-training/checkpoint.json`: checkpoint-json, unknown, layout unknown, provenance unknown, D22 quarantined, verdict not-scored (format-not-scorable), parity not-applicable, sha256 `870b5f28da16`
- `iterative-training/models/model-iter-1-2026-02-11T10-53-45.json`: rf-json, binary_win, layout core500+plugins, provenance bot-games-human-rollout, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `438082a8e3af`
- `iterative-training/models/model-iter-1-2026-02-11T12-39-07.json`: rf-json, binary_win, layout core500+plugins, provenance bot-games-unproven-decks, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `2233f3c13a83`
- `iterative-training/models/model-iter-1-2026-02-11T18-26-03.json`: rf-json, binary_win, layout core500+plugins, provenance bot-games-human-rollout, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `113a07911fb9`
- `iterative-training/models/model-iter-2-2026-02-11T11-12-01.json`: rf-json, binary_win, layout core500+plugins, provenance bot-games-human-rollout, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `e005f0847fd8`
- `iterative-training/models/model-iter-2-2026-02-11T12-52-10.json`: rf-json, binary_win, layout core500+plugins, provenance bot-games-unproven-decks, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `eb0b12ecb874`
- `iterative-training/models/model-iter-2-2026-02-11T18-35-00.json`: rf-json, binary_win, layout core500+plugins, provenance bot-games-human-rollout, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `2d531defdb15`
- `iterative-training/models/model-iter-3-2026-02-11T11-38-03.json`: rf-json, binary_win, layout core500+plugins, provenance bot-games-human-rollout, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `c2fa68ad2e3e`
- `iterative-training/models/model-iter-3-2026-02-11T18-46-47.json`: rf-json, binary_win, layout core500+plugins, provenance bot-games-human-rollout, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `c99a218fed0d`
- `iterative-training/models/model-iter-4-2026-02-11T11-52-23.json`: rf-json, binary_win, layout core500+plugins, provenance bot-games-human-rollout, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `bb872ee78231`
- `iterative-training/models/model-iter-4-2026-02-11T19-06-35.json`: rf-json, binary_win, layout core500+plugins, provenance bot-games-human-rollout, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `d71c990c05bc`
- `iterative-training/models/model-iter-5-2026-02-11T12-11-05.json`: rf-json, binary_win, layout core500+plugins, provenance bot-games-human-rollout, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `e3dc2c12e34d`
- `iterative-training/models/model-iter-5-2026-02-11T19-31-04.json`: rf-json, binary_win, layout core500+plugins, provenance bot-games-human-rollout, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `3895c1f4615a`
- `models/bootstrap-trained/training-summary.json`: summary-json, unknown, layout unknown, provenance human-inferred, D22 quarantined, verdict not-scored (format-not-scorable), parity not-applicable, sha256 `d898c8d6c153`
- `models/bootstrap-trained/xgboost-model.json`: xgboost-json, binary_win, layout core500, provenance human-inferred, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity not-run, sha256 `849992a49c25`
- `models/filtered-trained/training-summary.json`: summary-json, unknown, layout unknown, provenance human-inferred, D22 quarantined, verdict not-scored (format-not-scorable), parity not-applicable, sha256 `db3bca5b96e8`
- `models/filtered-trained/xgboost-model.json`: xgboost-json, binary_win, layout core500, provenance human-inferred, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity not-run, sha256 `cc4018bdc7ca`
- `models/human-trained/mlx-model.npz`: mlx-npz, unknown, layout unknown, provenance human-games, D22 quarantined, verdict not-scored (format-not-scorable), parity not-applicable, sha256 `4290cf20d8f0`
- `models/human-trained/rf-filtered-100k.json`: rf-json, binary_win, layout core500, provenance human-games, D22 quarantined, verdict unreusable (constant-prediction), parity not-run, sha256 `7f7efe5b3142`
- `models/human-trained/training-summary.json`: summary-json, unknown, layout unknown, provenance human-games, D22 quarantined, verdict not-scored (format-not-scorable), parity not-applicable, sha256 `ba7823dcd0db`
- `models/human-trained/xgboost-model.json`: xgboost-json, binary_win, layout core500, provenance human-games, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity not-run, sha256 `5a51edd226a6`
- `models/strict-trained/training-summary.json`: summary-json, unknown, layout unknown, provenance human-inferred, D22 quarantined, verdict not-scored (format-not-scorable), parity not-applicable, sha256 `ba5f3bf99bd6`
- `models/strict-trained/xgboost-model.json`: xgboost-json, binary_win, layout core500, provenance human-inferred, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity not-run, sha256 `04c9d2aedf92`
- `phase4-router-v2/model-ability.json`: rf-json, binary_win, layout phase3-583, provenance bot-games-unproven-decks, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `234497c3d58f`
- `phase4-router-v2/model-attack.json`: rf-json, binary_win, layout phase3-583, provenance bot-games-unproven-decks, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `7dc17e3f8782`
- `phase4-router-v2/model-play.json`: rf-json, binary_win, layout phase3-583, provenance bot-games-unproven-decks, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `d357c56c0819`
- `phase4-router-v2/model-resource.json`: rf-json, binary_win, layout phase3-583, provenance bot-games-unproven-decks, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `14a9d1f9a433`
- `phase4-router-v2/model-unified.json`: rf-json, binary_win, layout phase3-583, provenance bot-games-unproven-decks, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `ced0564e4e03`
- `phase4-router/model-ability.json`: rf-json, binary_win, layout phase3-583, provenance unknown, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `4a0e2ecd2166`
- `phase4-router/model-attack.json`: rf-json, binary_win, layout phase3-583, provenance unknown, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `4133855c8cba`
- `phase4-router/model-play.json`: rf-json, binary_win, layout phase3-583, provenance unknown, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `cf0fad578eab`
- `phase4-router/model-resource.json`: rf-json, binary_win, layout phase3-583, provenance unknown, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `0557c0400706`
- `phase4-router/model-unified.json`: rf-json, binary_win, layout phase3-583, provenance unknown, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `1d3d7fc40166`
- `phase5-v2/model-binary-win-seed42.json`: rf-json, binary_win, layout phase3-583, provenance unknown, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `eb2889851e57`
- `phase5-v2/model-binary-win-v2only.json`: rf-json, binary_win, layout phase3-583, provenance bot-games-unproven-decks, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `0226f8a31092`
- `phase5-v2/model-binary-win.json`: rf-json, binary_win, layout phase3-583, provenance unknown, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `9802f2d18df4`
- `phase5-v2/model-loss-prevention.json`: rf-json, loss_prevention, layout phase3-583, provenance unknown, D22 quarantined, verdict not-scored (different-target), parity not-run, sha256 `526dc61f3ded`
- `phase5-v2/model-q-value.json`: rf-json, q_value, layout phase3-583, provenance unknown, D22 quarantined, verdict not-scored (different-target), parity not-run, sha256 `f7e938ffc27c`
- `phase5-v3/model-binary-win.json`: rf-json, binary_win, layout phase3-583, provenance unknown, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `ce536a9904ae`
- `phase5-v3/model-loss-prevention.json`: rf-json, loss_prevention, layout phase3-583, provenance unknown, D22 quarantined, verdict not-scored (different-target), parity not-run, sha256 `95d0b07caf6e`
- `phase5-v3/model-q-value.json`: rf-json, q_value, layout phase3-583, provenance unknown, D22 quarantined, verdict not-scored (different-target), parity not-run, sha256 `8b0268adece6`
- `phase5-v4/model-binary-win.json`: rf-json, binary_win, layout phase3-583, provenance unknown, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `2076c5839d0b`
- `phase5-v4/model-loss-prevention.json`: rf-json, loss_prevention, layout phase3-583, provenance unknown, D22 quarantined, verdict not-scored (different-target), parity not-run, sha256 `cb1417d7cd00`
- `phase5-v4/model-q-value.json`: rf-json, q_value, layout phase3-583, provenance unknown, D22 quarantined, verdict not-scored (different-target), parity not-run, sha256 `9dcb56d7d354`
- `phase6-hard/model-binary-win.json`: rf-json, binary_win, layout phase3-583, provenance unknown, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `675b6347cc27`
- `phase6-hard/model-loss-prevention.json`: rf-json, loss_prevention, layout phase3-583, provenance unknown, D22 quarantined, verdict not-scored (different-target), parity not-run, sha256 `15976496d2c2`
- `phase6-hard/model-q-value.json`: rf-json, q_value, layout phase3-583, provenance unknown, D22 quarantined, verdict not-scored (different-target), parity not-run, sha256 `4e7f38bc01e7`
- `phase6-strategic/model-binary-win.json`: rf-json, binary_win, layout phase3-583, provenance bot-games-unproven-decks, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `8afd0eaf86b5`
- `phase6-strategic/model-loss-prevention.json`: rf-json, loss_prevention, layout phase3-583, provenance bot-games-unproven-decks, D22 quarantined, verdict not-scored (different-target), parity not-run, sha256 `c9fd2874b274`
- `phase6-strategic/model-q-value.json`: rf-json, q_value, layout phase3-583, provenance bot-games-unproven-decks, D22 quarantined, verdict not-scored (different-target), parity not-run, sha256 `00bee962de3c`
- `phase7-validation/baseline-model.json`: rf-json, binary_win, layout core500+plugins, provenance bot-games-unproven-decks, D22 quarantined, verdict not-scored (awaiting-fresh-batch), parity passed, sha256 `90875df21646`
- `phase7-validation/position-value-model.json`: rf-json, q_value, layout core500+plugins, provenance bot-games-unproven-decks, D22 quarantined, verdict not-scored (different-target), parity not-run, sha256 `8255a4a51c68`
<!-- inventory:end -->

## Fresh-batch scoring (Phase B)

Method, seed range and verdicts only; every number stays in the local report.

Status: carried forward to #126 (decided 2026-11-01). Four reasons:

- #111, the committed run-games step, has not landed. The batch runner (`scripts/sims/run-batch.ts`) could stand in for it, but scoring is only one of three blockers.
- Loader parity comes before any score (Approach 6 of #123), and the four XGBoost files cannot pass it on this machine without a download.
- Phase B can change only `verdict` and `reason` enums. D52 already rules that no Karabast-trained model enters a committed comparison, and every entry is quarantined (no deck source is proven), so #126's committed baseline is the constant model whatever Phase B finds.
- #126 needs held-out positions inside `evaluationSeedRange` (seeds 9,000,000 to 9,001,999, reserved in the manifest) with #124's encoder and extractor anyway. Scoring the old models on those same positions, with the column tiers of feature-map.json, costs one batch instead of two.

The method stays as #123 wrote it: 200 games, five action-phase decisions per game, `exact` columns from `extractStateView` (src/sims/state-view.ts), NaN for `unavailable` XGBoost columns plus a 0-fill sensitivity row, the gain-share rule at 0.5, and metrics in a git-ignored scores.json only.

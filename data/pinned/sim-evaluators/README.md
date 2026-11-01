# Captured evaluators

Each `<version>.json` pins one evaluator trained by `pnpm sims:train-evaluator --config data/pinned/sim-evaluators/<version>.config.json` (#126). The weights live on the models volume under `swu-mcp/<version>/` (evaluator.json, training-run.json, the train config, the Python lock, and the MLP or XGBoost file when one is chosen); the manifest holds each file's sha256, the test metrics, both bootstrap intervals against the constant model and the replay record. A capture is written once: a rerun with different bytes is refused, and a new capture takes a new version. Dense weights under 1 MB are also committed here as `<version>.evaluator.json`, byte-identical to the volume's evaluator.json, so #127 runs without the volume. `<version>.md` is the generated report.

Every model already on the volume, listed in data/pinned/sim-models/manifest.json (#123), is named in `<version>.md` as rejected, with its path, file hash and #123's reason. All of them are quarantined under D52 and D93, so the constant model is the baseline and no metric of any of them appears here.

Every number is bot play (D21), labelled with the continuation rung of the dataset it was trained on. No model trained on Karabast human games, and no number from one, appears here (D22). An evaluator is used only by the sim scripts; nothing under `src/` loads it (D1).

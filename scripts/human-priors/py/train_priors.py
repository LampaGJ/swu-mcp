"""Human-play prior models (#181, D104): deterministic CPU training on the tables scripts/human-priors/featurize.ts wrote.

Three scikit-learn logistic regressions on standardised columns, every split by game (fold 0 held out, never by row):
  action type  multinomial over attack, play, ability, pass, claim at main-action decisions
  attack       binary chosen-or-not over the rebuilt legal attack options; ranked within each decision
  value        the acting side's game result from the public state, forfeit games left out
Weights (JSON) and a copy of the card-play prior go to --out (under /Volumes/Models, never the repo); metrics to --metrics.
Runs from the venv built from scripts/sims/py/requirements-train.lock (see scripts/sims/py/requirements-train.txt).

Usage: OMP_NUM_THREADS=1 tmp/venv-train/bin/python -I scripts/human-priors/py/train_priors.py --tables <dir> --out <dir> --metrics <file>
"""
import os

for _k in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ.setdefault(_k, "1")

import argparse
import hashlib
import json
import shutil

import numpy as np
import sklearn
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss, roc_auc_score

HELD_OUT = 0
C = 1.0
MAX_ITER = 2000


def load(tables, name, dtype, cols=None):
    a = np.fromfile(os.path.join(tables, name), dtype=dtype)
    return a.reshape(-1, cols) if cols else a


def standardise(x_train):
    mean = x_train.mean(axis=0)
    scale = x_train.std(axis=0)
    scale[scale == 0] = 1.0
    return mean, scale


def fit(x, y, mean, scale):
    model = LogisticRegression(C=C, max_iter=MAX_ITER, solver="lbfgs", random_state=0)
    model.fit((x - mean) / scale, y)
    return model


def export(model, mean, scale, features, classes=None):
    return {
        "features": list(features),
        "mean": [float(v) for v in mean],
        "scale": [float(v) for v in scale],
        "coef": [[float(v) for v in row] for row in model.coef_],
        "intercept": [float(v) for v in model.intercept_],
        "classes": classes,
    }


def r4(x):
    return round(float(x), 4)


def action_type(tables, meta):
    x = load(tables, "state.f32", "<f4", len(meta["state"]["columns"])).astype(np.float64)
    y = load(tables, "state-y.i8", "i1").astype(np.int64)
    fold = load(tables, "state-fold.i8", "i1")
    keep = y >= 0
    tr, te = keep & (fold != HELD_OUT), keep & (fold == HELD_OUT)
    mean, scale = standardise(x[tr])
    model = fit(x[tr], y[tr], mean, scale)
    p = model.predict_proba((x[te] - mean) / scale)
    freq = np.bincount(y[tr], minlength=len(meta["classes"])) / tr.sum()
    base = np.tile(freq, (te.sum(), 1))
    labels = list(range(len(meta["classes"])))
    metrics = {
        "trainRows": int(tr.sum()),
        "testRows": int(te.sum()),
        "accuracy": r4((p.argmax(axis=1) == y[te]).mean()),
        "logLoss": r4(log_loss(y[te], p, labels=labels)),
        "baseline": {"name": "training class frequencies", "accuracy": r4((freq.argmax() == y[te]).mean()), "logLoss": r4(log_loss(y[te], base, labels=labels))},
        "testClassShares": {c: r4((y[te] == i).mean()) for i, c in enumerate(meta["classes"])},
    }
    return export(model, mean, scale, meta["state"]["columns"], meta["classes"]), metrics


def heuristic(x, cols):
    """A fixed combat rule akin to rung 1's: a free kill (best target first), then a favourable trade, then the base."""
    c = {n: i for i, n in enumerate(cols)}
    kf, tr, gain, base, ap, chump, tcost = (x[:, c[k]] for k in ("killFree", "trade", "costGain", "toBase", "aPower", "chump", "tCost"))
    return 1000 * kf + 10 * tcost * kf + 500 * tr * (gain > 0) + 100 * base * (ap > 0) - 1000 * chump


def ranks(scores, group, chosen):
    out = []
    for g in np.unique(group):
        idx = np.nonzero(group == g)[0]
        s = scores[idx]
        order = sorted(range(len(idx)), key=lambda i: (-s[i], i))
        pos = [order.index(i) for i in range(len(idx)) if chosen[idx[i]] == 1]
        out.append((pos[0], len(idx)))
    return out


def attack(tables, meta):
    cols = meta["options"]["columns"]
    x = load(tables, "opt.f32", "<f4", len(cols)).astype(np.float64)
    group = load(tables, "opt-group.i32", "<i4")
    chosen = load(tables, "opt-chosen.i8", "i1").astype(np.int64)
    fold = load(tables, "opt-fold.i8", "i1")
    tr, te = fold != HELD_OUT, fold == HELD_OUT
    mean, scale = standardise(x[tr])
    model = fit(x[tr], chosen[tr], mean, scale)
    s_model = model.decision_function((x[te] - mean) / scale)
    s_heur = heuristic(x[te], cols)
    rm = ranks(s_model, group[te], chosen[te])
    rh = ranks(s_heur, group[te], chosen[te])
    n = len(rm)

    def top(rs, k):
        return r4(sum(1 for r, _ in rs if r < k) / max(1, n))

    metrics = {
        "trainOptions": int(tr.sum()),
        "trainDecisions": int(len(np.unique(group[tr]))),
        "testDecisions": n,
        "meanOptions": r4(np.mean([m for _, m in rm])) if n else 0,
        "model": {"top1": top(rm, 1), "top3": top(rm, 3)},
        "heuristic": {"name": "free kill, then favourable trade, then base (rung-1-like)", "top1": top(rh, 1), "top3": top(rh, 3)},
        "uniform": {"top1": r4(np.mean([1 / m for _, m in rm])) if n else 0, "top3": r4(np.mean([min(1, 3 / m) for _, m in rm])) if n else 0},
    }
    return export(model, mean, scale, cols), metrics


def value(tables, meta):
    x = load(tables, "state.f32", "<f4", len(meta["state"]["columns"])).astype(np.float64)
    won = load(tables, "state-won.i8", "i1").astype(np.int64)
    fold = load(tables, "state-fold.i8", "i1")
    forfeit = load(tables, "state-forfeit.i8", "i1")
    keep = (won >= 0) & (forfeit == 0)
    tr, te = keep & (fold != HELD_OUT), keep & (fold == HELD_OUT)
    mean, scale = standardise(x[tr])
    model = fit(x[tr], won[tr], mean, scale)
    p = model.predict_proba((x[te] - mean) / scale)[:, 1]
    rate = won[tr].mean()
    rnd = x[te][:, meta["state"]["columns"].index("round")]
    by_round = {}
    for name, lo, hi in (("rounds 0-2", -1, 2), ("rounds 3-5", 3, 5), ("rounds 6+", 6, 10**6)):
        m = (rnd >= lo) & (rnd <= hi)
        if m.sum() > 0 and len(np.unique(won[te][m])) == 2:
            by_round[name] = {"rows": int(m.sum()), "auc": r4(roc_auc_score(won[te][m], p[m]))}
    metrics = {
        "trainRows": int(tr.sum()),
        "testRows": int(te.sum()),
        "auc": r4(roc_auc_score(won[te], p)),
        "logLoss": r4(log_loss(won[te], p, labels=[0, 1])),
        "brier": r4(np.mean((p - won[te]) ** 2)),
        "baseline": {"name": "constant training win rate", "logLoss": r4(log_loss(won[te], np.full(te.sum(), rate), labels=[0, 1])), "brier": r4(np.mean((rate - won[te]) ** 2))},
        "byRound": by_round,
        "forfeitGamesExcluded": True,
    }
    return export(model, mean, scale, meta["state"]["columns"]), metrics


def sha256_file(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tables", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--metrics", required=True)
    args = ap.parse_args()
    with open(os.path.join(args.tables, "meta.json")) as f:
        meta = json.load(f)
    t_model, t_metrics = action_type(args.tables, meta)
    a_model, a_metrics = attack(args.tables, meta)
    v_model, v_metrics = value(args.tables, meta)
    os.makedirs(args.out, exist_ok=True)
    models = {"schemaVersion": 1, "heldOutFold": HELD_OUT, "split": "by game (fold = first 8 hex digits of the hashed game key mod 5)", "actionType": t_model, "attack": a_model, "value": v_model}
    models_path = os.path.join(args.out, "models.json")
    with open(models_path, "w") as f:
        f.write(json.dumps(models, sort_keys=True, separators=(",", ":")) + "\n")
    prior_path = os.path.join(args.out, "card-prior.json")
    shutil.copyfile(os.path.join(args.tables, "card-prior.json"), prior_path)
    manifest = {
        "kind": "human-prior-models",
        "schemaVersion": 1,
        "tables": {"decisionsOutputHash": meta["decisions"]["outputHash"], "codeCommit": meta["codeCommit"], "vocabSha256": meta["vocab"]["contentSha256"]},
        "trainer": {"sklearn": sklearn.__version__, "numpy": np.__version__, "C": C, "maxIter": MAX_ITER, "solver": "lbfgs"},
        "files": {"models.json": sha256_file(models_path), "card-prior.json": sha256_file(prior_path)},
    }
    with open(os.path.join(args.out, "manifest.json"), "w") as f:
        f.write(json.dumps(manifest, sort_keys=True, indent=1) + "\n")
    metrics = {"actionType": t_metrics, "attack": a_metrics, "value": v_metrics, "cardPrior": meta["cardPriorEval"], "coverage": meta["coverage"], "models": manifest["files"]}
    os.makedirs(os.path.dirname(os.path.abspath(args.metrics)), exist_ok=True)
    with open(args.metrics, "w") as f:
        f.write(json.dumps(metrics, sort_keys=True, indent=1) + "\n")
    print(json.dumps(metrics, sort_keys=True, indent=1))


if __name__ == "__main__":
    main()

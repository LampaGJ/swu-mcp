"""Trains the evaluator candidates (constant, logistic, MLX MLP, optional XGBoost) from the pre-flattened rows that
scripts/sims/train-evaluator.ts writes. Deterministic: no clock enters an output that is hashed, every order is
fixed, BLAS and OpenMP run one thread. Wall times and peak RSS go to run-report.json, which no hash covers.

Usage: python train_evaluator.py --rows rows.jsonl --config resolved.json --out DIR
"""
import os

for _k in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ[_k] = "1"

import argparse, base64, datetime, hashlib, importlib, json, math, platform, resource, subprocess, time  # noqa: E401,E402
import numpy as np  # noqa: E402
from scipy import sparse  # noqa: E402
from scipy.stats import spearmanr  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402

SPLITS = ("train", "validation", "test")
PROGRESS = "reports/.progress/train-evaluator-py"


def b64(a):
    return base64.b64encode(np.ascontiguousarray(a, dtype="<f4").tobytes()).decode("ascii")


def dump(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps(obj, sort_keys=True, separators=(",", ":")))


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-z))


class Heartbeat:
    """The scripts/lib/progress.mjs contract: latest snapshot in <job>.json, history in <job>.jsonl."""

    def __init__(self, total):
        os.makedirs(os.path.dirname(PROGRESS), exist_ok=True)
        self.total, self.start = total, time.time()

    def tick(self, done, **extra):
        now = time.time()
        rate = done / max(now - self.start, 0.001)
        snap = {"ts": datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat(), "job": "train-evaluator-py", "done": done, "total": self.total,
                "pct": round(100.0 * done / self.total, 1), "rate_per_s": round(rate, 4), "eta_s": round((self.total - done) / rate) if rate > 0 else None,
                "elapsed_s": round(now - self.start), **extra}
        line = json.dumps(snap)
        with open(PROGRESS + ".json", "w", encoding="utf-8") as f:
            f.write(line + "\n")
        with open(PROGRESS + ".jsonl", "a", encoding="utf-8") as f:
            f.write(line + "\n")


def load(path, width):
    acc = {s: {"id": [], "seed": [], "kind": [], "decision": [], "action": [], "y": [], "w": [], "i": [], "v": [], "ptr": [0]} for s in SPLITS}
    with open(path, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            d = acc[r["split"]]
            if not 0.0 <= r["y"] <= 1.0 or r["w"] <= 0 or len(r["i"]) != len(r["v"]):
                raise ValueError(f"row {r['id']}: label, weight or index/value length out of range")
            if r["i"] and (min(r["i"]) < 0 or max(r["i"]) >= width):
                raise ValueError(f"row {r['id']}: column outside width {width}")
            for k in ("id", "seed", "kind", "decision", "action", "y", "w"):
                d[k].append(r[k])
            d["i"].extend(r["i"])
            d["v"].extend(r["v"])
            d["ptr"].append(len(d["i"]))
    out = {}
    for s, d in acc.items():
        X = sparse.csr_matrix((np.array(d["v"], dtype=np.float64), np.array(d["i"], dtype=np.int64), np.array(d["ptr"], dtype=np.int64)), shape=(len(d["id"]), width))
        out[s] = {k: d[k] for k in ("id", "seed", "kind", "decision", "action")}
        out[s].update({"X": X, "y": np.array(d["y"], dtype=np.float64), "w": np.array(d["w"], dtype=np.float64)})
        out[s]["branch"] = np.array([k == "branch" for k in d["kind"]], dtype=bool)
    return out


def row_weights(part, wo):
    return np.where(part["branch"], part["w"], part["w"] * wo)


def rms_scale(X):
    ms = np.asarray(X.multiply(X).mean(axis=0)).ravel()
    s = np.ones_like(ms)
    s[ms > 0] = 1.0 / np.sqrt(ms[ms > 0])
    return s.astype(np.float32).astype(np.float64)


def forward(layers, scale, X):
    h = X.multiply(scale.reshape(1, -1)).tocsr()
    for li, (Wm, b) in enumerate(layers):
        h = np.asarray(h @ Wm) + b
        if li < len(layers) - 1:
            h = np.maximum(h, 0.0)
    return np.asarray(h).ravel()


def metrics(p, y, w):
    n = int(len(y))
    if n == 0:
        return {"brier": None, "logLoss": None, "ece": None, "n": 0}
    W = w.sum()
    q = np.clip(p, 1e-12, 1 - 1e-12)
    brier = float((w * (p - y) ** 2).sum() / W)
    ll = float(-(w * (y * np.log(q) + (1 - y) * np.log(1 - q))).sum() / W)
    bins = np.minimum((p * 10).astype(int), 9)
    ece = 0.0
    for b in range(10):
        m = bins == b
        if m.any():
            wb = w[m].sum()
            ece += wb / W * abs((w[m] * p[m]).sum() / wb - (w[m] * y[m]).sum() / wb)
    return {"brier": round(brier, 6), "logLoss": round(ll, 6), "ece": round(float(ece), 6), "n": n}


def split_metrics(p, part):
    b = part["branch"]
    return {"branch": metrics(p[b], part["y"][b], part["w"][b]), "outcome": metrics(p[~b], part["y"][~b], part["w"][~b])}


def rank_agreement(p, part):
    groups = {}
    for i in np.flatnonzero(part["branch"]):
        a = groups.setdefault(part["decision"][i], {}).setdefault(part["action"][i], [0.0, 0.0, 0.0])
        a[0] += part["w"][i] * p[i]
        a[1] += part["w"][i] * part["y"][i]
        a[2] += part["w"][i]
    top1, rho = [], []
    for dec in sorted(groups):
        acts = sorted(groups[dec])
        if len(acts) < 2:
            continue
        pred = np.array([groups[dec][a][0] / groups[dec][a][2] for a in acts])
        lab = np.array([groups[dec][a][1] / groups[dec][a][2] for a in acts])
        top1.append(int(np.argmax(pred) == np.argmax(lab)))
        if len(acts) >= 3 and np.ptp(lab) > 0 and np.ptp(pred) > 0:
            rho.append(float(spearmanr(pred, lab)[0]))
    return {"top1": round(float(np.mean(top1)), 6) if top1 else None, "spearman": round(float(np.mean(rho)), 6) if rho else None,
            "decisions": len(top1), "spearmanDecisions": len(rho)}


def dense_file(kind, cfg, scale, layers):
    return {"formatVersion": 1, "kind": kind, "featureLayoutSha256": cfg["featureLayoutSha256"], "featureWidth": cfg["featureWidth"], "scale": b64(scale), "activation": "relu",
            "layers": [{"in": int(Wm.shape[0]), "out": int(Wm.shape[1]), "weight": b64(Wm), "bias": b64(b)} for Wm, b in layers]}


def as32(layers):
    """Rounds to the float32 values that are exported, so every metric is computed on the captured weights."""
    return [(np.asarray(Wm, dtype=np.float32).astype(np.float64), np.asarray(b, dtype=np.float32).astype(np.float64)) for Wm, b in layers]


def fit_logistic(part, wo, C, cfg, scale):
    w = row_weights(part, wo)
    keep = w > 0
    X = part["X"][keep].multiply(scale.reshape(1, -1)).tocsr()
    y, w = part["y"][keep], w[keep]
    # Soft labels: each row becomes a positive weighted y and a negative weighted 1 - y.
    Xd = sparse.vstack([X, X]).tocsr()
    yd = np.concatenate([np.ones(len(y)), np.zeros(len(y))])
    wd = np.concatenate([w * y, w * (1 - y)])
    m = LogisticRegression(C=C, solver="lbfgs", tol=cfg["tol"], max_iter=cfg["maxIter"])
    m.fit(Xd[wd > 0], yd[wd > 0], sample_weight=wd[wd > 0])
    return as32([(m.coef_.reshape(-1, 1), m.intercept_.reshape(1))]), int(m.n_iter_[0])


def fit_mlp(tr, va, wo, cfg, seed, scale, beat):
    import mlx.core as mx
    import mlx.nn as nn
    import mlx.optimizers as optim
    mx.set_default_device(mx.gpu if cfg["device"] == "gpu" else mx.cpu)
    mx.random.seed(seed)
    sizes = [tr["X"].shape[1], *cfg["hidden"], 1]
    lin = [nn.Linear(a, b) for a, b in zip(sizes[:-1], sizes[1:])]
    parts = []
    for l in lin[:-1]:
        parts += [l, nn.ReLU()]
    model = nn.Sequential(*parts, lin[-1])
    mx.eval(model.parameters())
    opt = optim.AdamW(learning_rate=cfg["learningRate"], betas=list(cfg["betas"]), weight_decay=cfg["weightDecay"])

    def loss_fn(m, x, y, w):
        z = m(x).squeeze(-1)
        return (w * nn.losses.binary_cross_entropy(z, y, with_logits=True, reduction="none")).sum() / w.sum()

    grad = nn.value_and_grad(model, loss_fn)
    W = row_weights(tr, wo)
    rows = np.flatnonzero(W > 0)
    Xs = tr["X"].multiply(scale.reshape(1, -1)).tocsr()
    export = lambda: as32([(np.array(l.weight).T, np.array(l.bias)) for l in lin])  # noqa: E731
    best, best_layers, best_epoch, since, epochs = math.inf, None, 0, 0, 0
    for epoch in range(cfg["maxEpochs"]):
        epochs = epoch + 1
        order = sorted(rows, key=lambda r: hashlib.sha256(f"{seed}|{epoch}|{tr['id'][r]}".encode()).hexdigest())
        for s in range(0, len(order), cfg["batchSize"]):
            idx = order[s:s + cfg["batchSize"]]
            x = mx.array(Xs[idx].toarray().astype(np.float32))
            _, g = grad(model, x, mx.array(tr["y"][idx].astype(np.float32)), mx.array(W[idx].astype(np.float32)))
            opt.update(model, g)
            mx.eval(model.parameters(), opt.state)
        layers = export()
        vl = split_metrics(sigmoid(forward(layers, scale, va["X"])), va)["branch"]["logLoss"]
        beat(epoch=epochs, validationLogLoss=vl)
        if vl is not None and vl < best - 1e-9:
            best, best_layers, best_epoch, since = vl, layers, epochs, 0
        else:
            since += 1
        if since >= cfg["patience"]:
            break
    return best_layers, epochs, best_epoch


def environment():
    def ver(name):
        try:
            return str(importlib.import_module(name).__version__)
        except Exception:
            return None
    metal = None
    try:
        import mlx.core as mx
        info = mx.metal.device_info() if hasattr(mx, "metal") and hasattr(mx.metal, "device_info") else mx.device_info()
        metal = str(info.get("architecture"))
    except Exception:
        pass
    chip = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True).stdout.strip() or None
    return {"chip": chip, "macos": platform.mac_ver()[0] or None, "python": platform.python_version(), "numpy": np.__version__, "metal": metal,
            **{k: ver(m) for k, m in (("scipy", "scipy"), ("sklearn", "sklearn"), ("mlx", "mlx.core"), ("xgboost", "xgboost"))}}


def main():
    ap = argparse.ArgumentParser()
    for flag in ("--rows", "--config", "--out"):
        ap.add_argument(flag, required=True)
    a = ap.parse_args()
    with open(a.config, encoding="utf-8") as f:
        cfg = json.load(f)
    os.makedirs(a.out, exist_ok=True)
    seed, width = cfg["seed"], cfg["featureWidth"]
    data = load(a.rows, width)
    tr, va, te = (data[s] for s in SPLITS)
    scales = {"rms": rms_scale(tr["X"]), "none": np.ones(width)}
    grid = [(sc, wo, C) for sc in cfg["scalingGrid"] for wo in cfg["outcomeWeightGrid"] for C in cfg["logistic"]["cGrid"]]
    hb = Heartbeat(len(grid) + 2 + cfg["mlp"]["maxEpochs"] + int(cfg["xgboost"]["enabled"]) + 3)
    step = 0
    wall, cands, preds = {}, [], {}

    def advance(**extra):
        nonlocal step
        step += 1
        hb.tick(step, **extra)

    def finish(kind, hp, file_obj, predict, t0):
        path = os.path.join(a.out, f"evaluator-{kind}.json")
        dump(path, file_obj)
        p_va, p_te = predict(va), predict(te)
        preds[kind] = p_te
        cands.append({"kind": kind, "hyperparameters": hp, "evaluatorFile": f"evaluator-{kind}.json", "evaluatorSha256": sha(path),
                      "validation": split_metrics(p_va, va), "test": split_metrics(p_te, te), "rankAgreement": rank_agreement(p_te, te)})
        wall[kind] = round(time.time() - t0, 3)
        advance(phase=kind)
        return cands[-1]

    t0 = time.time()
    b = tr["branch"]
    p0 = float((tr["w"][b] * tr["y"][b]).sum() / tr["w"][b].sum())
    q0 = min(max(p0, 1e-6), 1 - 1e-6)
    const_layers = as32([(np.zeros((width, 1)), np.array([math.log(q0 / (1 - q0))]))])
    ones = scales["none"]
    finish("constant", {"winRate": round(p0, 6), "fitOn": "train branch rows"}, dense_file("constant", cfg, ones, const_layers),
           lambda part: sigmoid(forward(const_layers, ones, part["X"])), t0)

    t0, best, search = time.time(), (math.inf, None, None, None, None, None), []
    for sc, wo, C in grid:
        layers, iters = fit_logistic(tr, wo, C, cfg["logistic"], scales[sc])
        vl = split_metrics(sigmoid(forward(layers, scales[sc], va["X"])), va)["branch"]["logLoss"]
        search.append({"scaling": sc, "outcomeWeight": wo, "C": C, "iterations": iters, "validationBranchLogLoss": vl})
        if vl is not None and vl < best[0] - 1e-12:
            best = (vl, sc, wo, C, layers, iters)
        advance(phase="logistic-grid", scaling=sc, outcomeWeight=wo, C=C, validationLogLoss=vl, iterations=iters)
    _, scaling, wo, C, lg, lg_iters = best
    scale = scales[scaling]
    lg_c = finish("logistic", {"scaling": scaling, "C": C, "outcomeWeight": wo, "iterations": lg_iters}, dense_file("logistic", cfg, scale, lg),
                  lambda part: sigmoid(forward(lg, scale, part["X"])), t0)

    t0 = time.time()
    mlp, epochs, best_epoch = fit_mlp(tr, va, wo, cfg["mlp"], seed, scale, lambda **e: advance(phase="mlp", **e))
    import mlx.core as mx
    mx.save_safetensors(os.path.join(a.out, "train-weights.safetensors"),
                        {f"layer{i}.{n}": mx.array(t.astype(np.float32)) for i, (Wm, bb) in enumerate(mlp) for n, t in (("weight", Wm), ("bias", bb))})
    mlp_c = finish("mlp", {"hidden": cfg["mlp"]["hidden"], "epochs": epochs, "bestEpoch": best_epoch, "scaling": scaling, "outcomeWeight": wo, "device": cfg["mlp"]["device"]},
                   dense_file("mlp", cfg, scale, mlp), lambda part: sigmoid(forward(mlp, scale, part["X"])), t0)

    xc = cfg["xgboost"]
    gain = lg_c["validation"]["branch"]["logLoss"] - mlp_c["validation"]["branch"]["logLoss"]
    if not xc["enabled"]:
        xgb_status = {"trained": False, "reason": "disabled in the config"}
    elif gain >= xc["minMlpGain"]:
        xgb_status = {"trained": False, "reason": f"MLP validation branch log loss is {round(gain, 6)} below logistic, at least {xc['minMlpGain']}"}
    else:
        xgb_status = {"trained": True, "reason": f"MLP validation branch log loss is {round(gain, 6)} below logistic, less than {xc['minMlpGain']}"}
        import xgboost as xgb
        t0 = time.time()
        w = row_weights(tr, wo)
        keep = w > 0
        booster = xgb.train({"objective": "binary:logistic", "tree_method": "hist", "max_depth": xc["maxDepth"], "eta": xc["eta"], "min_child_weight": xc["minChildWeight"],
                             "lambda": xc["lambda"], "subsample": 1.0, "colsample_bytree": 1.0, "nthread": 1, "seed": seed},
                            xgb.DMatrix(tr["X"][keep], label=tr["y"][keep], weight=w[keep], nthread=1), num_boost_round=xc["rounds"])
        model_path = os.path.join(a.out, "xgboost.json")
        booster.save_model(model_path)
        file_obj = {"formatVersion": 1, "kind": "xgboost", "featureLayoutSha256": cfg["featureLayoutSha256"], "featureWidth": width, "model": {"file": "xgboost.json", "sha256": sha(model_path)}}
        finish("xgboost", {"rounds": xc["rounds"], "maxDepth": xc["maxDepth"], "eta": xc["eta"], "outcomeWeight": wo}, file_obj,
               lambda part: sigmoid(booster.predict(xgb.DMatrix(part["X"], nthread=1), output_margin=True).astype(np.float64)), t0)

    games = sorted(set(tr["seed"]), key=lambda g: hashlib.sha256(f"{seed}|lc|{g}".encode()).hexdigest())
    curve = []
    for frac in (0.25, 0.5, 1.0):
        chosen_games = set(games[: max(1, int(len(games) * frac))])
        m = np.array([s in chosen_games for s in tr["seed"]])
        sub = {k: tr[k][m] for k in ("X", "y", "w", "branch")}
        layers, _ = fit_logistic(sub, wo, C, cfg["logistic"], scale)
        bm = split_metrics(sigmoid(forward(layers, scale, te["X"])), te)["branch"]
        curve.append({"fraction": frac, "games": len(chosen_games), "brier": bm["brier"], "logLoss": bm["logLoss"]})
        advance(phase="learning-curve", fraction=frac)

    order = {"logistic": 0, "mlp": 1, "xgboost": 2}
    ll = lambda c: c["validation"]["branch"]["logLoss"] if c["validation"]["branch"]["logLoss"] is not None else math.inf  # noqa: E731
    chosen = min((c for c in cands if c["kind"] != "constant"), key=lambda c: (ll(c), order[c["kind"]]))["kind"]

    def count(part):
        nb = int(part["branch"].sum())
        return {"rows": len(part["id"]), "branchRows": nb, "outcomeRows": len(part["id"]) - nb, "games": len(set(part["seed"]))}

    dump(os.path.join(a.out, "training-run.json"), {"formatVersion": 1, "evaluatorVersion": cfg["evaluatorVersion"], "seed": seed, "device": cfg["mlp"]["device"],
         "featureLayoutSha256": cfg["featureLayoutSha256"], "featureWidth": width, "environment": environment(),
         "counts": {s: count(data[s]) for s in SPLITS}, "logisticSearch": search, "candidates": cands, "xgboost": xgb_status,
         "learningCurve": curve, "chosen": chosen})
    with open(os.path.join(a.out, "test-predictions.jsonl"), "w", encoding="utf-8") as f:
        for i in range(len(te["id"])):
            f.write(json.dumps({"id": te["id"][i], "seed": te["seed"][i], "kind": te["kind"][i], "y": float(te["y"][i]), "w": float(te["w"][i]),
                                "p": {k: float(v[i]) for k, v in sorted(preds.items())}}, sort_keys=True, separators=(",", ":")) + "\n")
    dump(os.path.join(a.out, "run-report.json"), {"wallSeconds": wall, "peakRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss})


if __name__ == "__main__":
    main()

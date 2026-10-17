import sys, os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import json, base64, numpy as np
from render import S
from evalset import EVALS, metrics, N
def unit(X): return X / np.linalg.norm(X, axis=1, keepdims=True)
def sims(X):
    X = unit(X); M = X @ X.T; np.fill_diagonal(M, -np.inf); return M
def top10(M): return np.argsort(-M, axis=1, kind="stable")[:, :10]
def overlap(a, b): return float(np.mean([len(set(x) & set(y)) / 10 for x, y in zip(a, b)]))
def quant(X, bits):
    s = np.percentile(np.abs(X), 99.9) / (127 if bits == 8 else 7)
    lo, hi = (-127, 127) if bits == 8 else (-8, 7)
    q = np.clip(np.round(X / s), lo, hi).astype(np.int8)
    return q, float(s)
def cells(q, bits):
    out = []
    for row in q:
        if bits == 8: b = row.astype(np.int8).tobytes()
        else:
            u = (row + 8).astype(np.uint8)
            if len(u) % 2: u = np.append(u, 8)
            b = ((u[0::2] << 4) | u[1::2]).astype(np.uint8).tobytes()
        out.append(base64.urlsafe_b64encode(b).decode().rstrip("="))
    return out
res = []; samples = {}
for model in ("minilm", "nomic", "qwen3"):
    for rend in ("full", "ability"):
        try: X = np.load(f"{S}/vec/{model}-{rend}.npy")
        except FileNotFoundError: continue
        Mf = sims(X); Tf = top10(Mf); D = X.shape[1]
        dimsl = [d for d in (32, 64, 128, 256) if d < D] + [D]
        if model == "minilm": dimsl = [D]
        for d in dimsl:
            Xd = unit(X[:, :d])
            variants = {"f32": Xd}
            for bits in (8, 4):
                q, s = quant(Xd, bits); samples[f"{model}-{rend}-{d}-int{bits}"] = cells(q[:60], bits)
                variants[f"int{bits}"] = unit(q.astype(np.float32) * s)
                variants[f"int{bits}_scale"] = s
            for enc in ("f32", "int8", "int4"):
                M = sims(variants[enc]); r = {"model": model, "rendering": rend, "dims": d, "enc": enc, "top10_overlap_vs_full": round(overlap(top10(M), Tf), 4)}
                if enc != "f32": r["scale"] = variants[enc + "_scale"]
                for k, ev in EVALS.items(): r[k] = metrics(M, ev)
                res.append(r)
json.dump(res, open(f"{S}/results.json", "w"), indent=1)
for r in res:
    print(r["model"], r["rendering"], r["dims"], r["enc"], "ov", r["top10_overlap_vs_full"], *[f"{k[:2]}:{v['recall@10']}/{v['P@10']}/{v['MRR']}" for k, v in r.items() if k in EVALS])

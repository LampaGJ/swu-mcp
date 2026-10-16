import sys; sys.path.insert(0, "/Volumes/Local Files/Projects/mault-train/swu-card-data/embed/scripts")
import json, re, numpy as np
from rank_bm25 import BM25Okapi
from render import S, load
from evalset import EVALS, metrics, N, norm
cards = load()
abst = json.load(open(S + "/render_abstract.json"))["texts"]
def unit(X): return X / np.linalg.norm(X, axis=1, keepdims=True)
def sims(X):
    X = unit(X); M = X @ X.T; np.fill_diagonal(M, -np.inf); return M
def top(M, k=10): return np.argsort(-M, axis=1, kind="stable")[:, :k]
def overlap(a, b): return float(np.mean([len(set(x) & set(y)) / len(x) for x, y in zip(a, b)]))
sets = {f: [set(filter(None, (c.get(f) or "").split("|"))) for c in cards] for f in ("traits", "keywords", "aspects")}
sets["any"] = [sets["traits"][i] | sets["keywords"][i] | sets["aspects"][i] for i in range(N)]
def share(T):
    out = {}
    for f, ss in sets.items():
        v = [np.mean([bool(ss[q] & ss[n]) for n in T[q]]) for q in range(N) if ss[q]]
        out[f] = round(float(np.mean(v)), 3)
    return out
def rand_share():
    out = {}
    for f, ss in sets.items():
        v = [np.mean([bool(ss[q] & ss[n]) for n in range(N) if n != q]) for q in range(N) if ss[q]]
        out[f] = round(float(np.mean(v)), 3)
    return out
# design matrix
def design():
    cols = []; names = []
    def onehot(vals, prefix):
        for v in sorted({x for s in vals for x in s}):
            cols.append([1.0 if v in s else 0.0 for s in vals]); names.append(prefix + v)
    onehot(sets["traits"], "t:"); onehot(sets["keywords"], "k:"); onehot(sets["aspects"], "a:")
    onehot([{c["type"]} for c in cards], "type:"); onehot([{c.get("arenas") or ""} for c in cards], "arena:")
    onehot([{str(c.get("cost"))} for c in cards], "cost:")
    for f in ("cost", "power", "hp"):
        x = np.array([c[f] if isinstance(c.get(f), (int, float)) else 0 for c in cards], float)
        has = np.array([isinstance(c.get(f), (int, float)) for c in cards], float)
        cols += [x, x * x, has]; names += [f, f + "^2", "has_" + f]
    X = np.array(cols).T; X = np.hstack([np.ones((N, 1)), X]); return X, names
X, names = design()
def residual(V):
    B, *_ = np.linalg.lstsq(X, V, rcond=None)
    return V - X @ B
V = {m + "-" + r: np.load(f"{S}/vec/{m}-{r}.npy") for m in ("minilm", "nomic", "qwen3") for r in ("full", "ability", "abstract") if __import__("os").path.exists(f"{S}/vec/{m}-{r}.npy")}
variants = {
 "nomic-full(plain)": V["nomic-full"], "nomic-abstract(a)": V["nomic-abstract"], "nomic-full-resid(b)": residual(V["nomic-full"]), "nomic-ability-resid(b)": residual(V["nomic-ability"]),
 "minilm-full(plain)": V["minilm-full"], "minilm-abstract(a)": V["minilm-abstract"], "minilm-full-resid(b)": residual(V["minilm-full"]),
 "nomic-ability(plain)": V["nomic-ability"],
}
M = {k: sims(v) for k, v in variants.items()}
tok = [re.findall(r"\w+", t.lower()) for t in abst]
bm = BM25Okapi(tok)
B = np.array([bm.get_scores(t) for t in tok]); np.fill_diagonal(B, -np.inf); M["BM25(abstract)"] = B
tags = np.array([[len(sets["any"][i] & sets["any"][j]) / max(1, len(sets["any"][i] | sets["any"][j])) for j in range(N)] for i in range(N)]); np.fill_diagonal(tags, -np.inf); M["tag-Jaccard"] = tags
# extra eval: identical abstract text, different title
g = {}
for i, t in enumerate(abst):
    if len(t) > 30: g.setdefault(t, []).append(i)
EV = dict(EVALS); EV["d_abs_twins"] = {i: set(a) - {i} for a in g.values() if len(a) > 1 and len({cards[i]["title"] for i in a}) > 1 for i in a}
print("random share", rand_share())
ref = {"nomic": "nomic-full(plain)", "minilm": "minilm-full(plain)"}
rows = []
for k, Mk in M.items():
    T = top(Mk); fam = "nomic" if k.startswith("nomic") else "minilm" if k.startswith("minilm") else "nomic"
    r = {"variant": k, "overlap_vs_plain_full": round(overlap(T, top(M[ref[fam]])), 3), "share": share(T)}
    for e, ev in EV.items(): r[e] = metrics(Mk, ev)
    rows.append(r); print(json.dumps(r))
json.dump(rows, open(S + "/blind-results.json", "w"), indent=1)
# examples
hmw = [i for i, c in enumerate(cards) if c["expansion"] == "HMW"]
pick = []
for ty in ("Leader", "Unit", "Event", "Upgrade"): pick += [i for i in hmw if cards[i]["type"] == ty][:2]
pick += [i for i in hmw if cards[i]["type"] == "Unit"][2:4]
def show(i, j=None): 
    return f'{cards[i]["title"]} [{cards[i]["type"]}; {cards[i].get("traits") or "-"}; {cards[i].get("keywords") or "-"}] {abst[i][:160]}'
with open(S + "/blind-examples.txt", "w") as f:
    for q in pick:
        f.write("\n### QUERY " + show(q) + "\n")
        for name in ("nomic-abstract(a)", "nomic-full-resid(b)", "BM25(abstract)", "nomic-full(plain)"):
            f.write("  -- " + name + "\n")
            for n in top(M[name][q:q+1], 5)[0]: f.write("     " + show(n) + "\n")
print("pick", [cards[i]["cardKey"] for i in pick])

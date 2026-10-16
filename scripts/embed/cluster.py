import sys; sys.path.insert(0, "/Volumes/Local Files/Projects/mault-train/swu-card-data/embed/scripts")
import json, re, math, base64, numpy as np
from collections import Counter
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score
from render import S, load
cards = load(); N = len(cards)
unit = lambda X: X / np.linalg.norm(X, axis=1, keepdims=True)
V = unit(np.load(S + "/vec/nomic-ability.npy"))
sil = {}
for k in (8, 12, 16, 24, 32, 48, 64):
    lab = KMeans(k, random_state=0, n_init=10).fit_predict(V); sil[k] = round(float(silhouette_score(V, lab, metric="cosine")), 4)
print("silhouette", sil)
K = int(sys.argv[1]) if len(sys.argv) > 1 else max(sil, key=sil.get)
km = KMeans(K, random_state=0, n_init=10).fit(V); lab = km.labels_
STOP = set("a an the of to or and in on is if you your this that it its for with from at by as be are was can may then each other another".split())
def feats(c):
    f = {("type", c["type"])}
    if c.get("arenas"): f |= {("arena", a) for a in c["arenas"].split("|")}
    for k, n in (("aspects", "aspect"), ("keywords", "kw"), ("traits", "trait")): f |= {(n, x) for x in (c.get(k) or "").split("|") if x}
    t = " ".join(filter(None, [c.get("text"), c.get("deployBox"), c.get("epicAction")])).lower()
    f |= {("word", w) for w in set(re.findall(r"[a-z]{4,}", t)) if w not in STOP}
    return f
F = [feats(c) for c in cards]; glob = Counter(x for f in F for x in f)
labels = {}; sizes = Counter(lab.tolist())
for cl in range(K):
    idx = [i for i in range(N) if lab[i] == cl]; cnt = Counter(x for i in idx for x in F[i])
    sc = []
    for x, n in cnt.items():
        p = n / len(idx); q = glob[x] / N
        if n >= 3 and p >= 0.3 and p > q: sc.append((p * math.log2(p / q), x, p))
    sc.sort(key=lambda s: (-s[0], s[1])); chosen = []; fam = Counter()
    for s, x, p in sc:
        if fam[x[0]] >= 2: continue
        fam[x[0]] += 1; chosen.append(f"{x[0]}:{x[1]}({int(round(p*100))}%)")
        if len(chosen) == 5: break
    labels[cl] = " ".join(chosen)
order = sorted(sizes, key=lambda c: -sizes[c])
print("K", K, "sizes", [sizes[c] for c in order])
for c in order[:10]: print(c, sizes[c], labels[c], "| e.g.", ", ".join(cards[i]["title"] for i in [j for j in range(N) if lab[j] == c][:4]))
json.dump({"k": K, "silhouette": sil, "labels": {str(c): labels[c] for c in labels}, "assign": {cards[i]["cardKey"]: int(lab[i]) for i in range(N)}}, open(S + "/clusters.json", "w"), indent=1)
# similar + vec data
Vq = unit(np.load(S + "/vec/nomic-ability.npy")); M = Vq @ Vq.T; np.fill_diagonal(M, -1)
top = np.argsort(-M, axis=1, kind="stable")[:, :10]
sim = [{"cardKey": cards[i]["cardKey"], "neighbours": "|".join(f"{cards[j]['cardKey']}:{M[i,j]:.2f}" for j in top[i])} for i in range(N)]
json.dump(sim, open(S + "/out-similar.json", "w"))
def cell(X, d, bits):
    Xd = unit(X[:, :d]); s = np.percentile(np.abs(Xd), 99.9) / (127 if bits == 8 else 7)
    q = np.clip(np.round(Xd / s), -127 if bits == 8 else -8, 127 if bits == 8 else 7).astype(np.int8)
    out = []
    for r in q:
        if bits == 8: b = r.tobytes()
        else: u = (r + 8).astype(np.uint8); b = ((u[0::2] << 4) | u[1::2]).astype(np.uint8).tobytes()
        out.append(base64.urlsafe_b64encode(b).decode().rstrip("="))
    return out, float(s)
vecs = {}
for d, bits in ((64, 8), (128, 8), (128, 4), (256, 4)):
    c, s = cell(Vq, d, bits); vecs[f"{d}-int{bits}"] = {"scale": s, "cells": c}
json.dump(vecs, open(S + "/out-vecs.json", "w"))
print({k: (round(v["scale"], 5), v["cells"][1]) for k, v in vecs.items()})
base = [{"cardKey": c["cardKey"]} for c in cards]
json.dump([{"cardKey": cards[i]["cardKey"], "cluster": int(lab[i]), "clusterLabel": labels[int(lab[i])]} for i in range(N)], open(S + "/out-clusterbycard.json", "w"))

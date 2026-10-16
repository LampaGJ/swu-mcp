import sys; sys.path.insert(0, "/Volumes/Local Files/Projects/mault-train/swu-card-data/embed/scripts")
import re, numpy as np
from render import load
cards = load(); N = len(cards)
norm = lambda s: re.sub(r"\s+", " ", (s or "").lower()).strip()
# a. near-duplicates
g = {}
for i, c in enumerate(cards):
    k = norm((c.get("text") or "") + "|" + (c.get("deployBox") or "") + "|" + (c.get("epicAction") or ""))
    if len(k) > 30: g.setdefault(k, []).append(i)
dup = [a for a in g.values() if len(a) > 1 and len({cards[i]["title"] for i in a}) > 1]
EVAL_A = {i: set(a) - {i} for a in dup for i in a}
# b1. same type + same keyword set
kg = {}
for i, c in enumerate(cards):
    if c.get("keywords"): kg.setdefault((c["type"], tuple(sorted(c["keywords"].split("|")))), []).append(i)
EVAL_B1 = {i: set(a) - {i} for a in kg.values() if len(a) >= 3 for i in a}
# b2. same type + same leading trigger
def trig(c):
    t = (c.get("text") or "").strip()
    m = re.match(r"^(When Played|On Attack|When Defeated|Action|Smuggle|Bounty|Coordinate|Restore|Raid|Ambush|Shielded|Hidden|Grit|Overwhelm|Sentinel|Saboteur|Exploit|Piloting|Epic Action|When Played/On Attack)\b", t)
    return m.group(1) if m else None
tg = {}
for i, c in enumerate(cards):
    t = trig(c)
    if t and c["type"] in ("Unit", "Event", "Upgrade"): tg.setdefault((c["type"], t), []).append(i)
EVAL_B2 = {i: set(a) - {i} for a in tg.values() if len(a) >= 3 for i in a}
# c. trait reference
traits = {}
for i, c in enumerate(cards):
    for t in (c.get("traits") or "").split("|"):
        if t: traits.setdefault(t, set()).add(i)
EVAL_C = {}
for i, c in enumerate(cards):
    txt = " ".join(filter(None, [c.get("text"), c.get("deployBox"), c.get("epicAction")]))
    ref = set()
    for t, members in traits.items():
        if re.search(r"\b" + re.escape(t) + r"\b (unit|units|card|cards|upgrade|upgrades|token)", txt) and len(members) <= 120:
            ref |= members
    ref.discard(i)
    if ref: EVAL_C[i] = ref
EVALS = {"a_dupes": EVAL_A, "b1_keywords": EVAL_B1, "b2_trigger": EVAL_B2, "c_traitref": EVAL_C}
def baseline(ev): return float(np.mean([len(r) / (N - 1) for r in ev.values()]))
def metrics(S, ev, k=10):
    # S: NxN similarity with diagonal -inf
    top = np.argsort(-S, axis=1, kind="stable")[:, :k]
    rec, prec, mrr = [], [], []
    for q, rel in ev.items():
        hits = [j in rel for j in top[q]]
        rec.append(sum(hits) / min(len(rel), k)); prec.append(sum(hits) / k)
        full = np.argsort(-S[q], kind="stable")
        r = next((n for n, j in enumerate(full[:N]) if j in rel), None)
        mrr.append(1 / (r + 1) if r is not None else 0)
    return {"recall@10": round(float(np.mean(rec)), 4), "P@10": round(float(np.mean(prec)), 4), "MRR": round(float(np.mean(mrr)), 4)}
if __name__ == "__main__":
    for k, v in EVALS.items(): print(k, "queries", len(v), "random P@10 baseline", round(baseline(v), 4))

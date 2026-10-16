import sys, os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import json, re, urllib.request, numpy as np
from render import S, load
cards = load(); N = len(cards)
COND = re.compile(r"(When (?:a|an|another|you|this unit is|an opponent)[^:.]*:|When Defeated|If (?:you|a friendly|an enemy|another)[^,.:]*|[Ff]or each [^.:]*|While (?:you|a friendly)[^,.:]*|Coordinate|Bounty)")
def parts(c):
    t = re.sub(r"\([^)]*\)", "", " ".join(filter(None, [c.get("text"), c.get("deployBox"), c.get("epicAction")])))
    needs = [m.group(0).strip(" :") for m in COND.finditer(t)]
    does = COND.sub(" ", t); does = re.sub(r"\s+", " ", does).strip(" :.")
    return " ; ".join(needs), does
ND = [parts(c) for c in cards]; needs = [n for n, _ in ND]; does = [d for _, d in ND]
def emb(texts, prefix):
    out = []
    for s in range(0, len(texts), 32):
        body = json.dumps({"model": "nomic-embed-text", "input": [prefix + t for t in texts[s:s+32]], "keep_alive": "2m"}).encode()
        out += json.load(urllib.request.urlopen(urllib.request.Request("http://localhost:11434/api/embed", body, {"Content-Type": "application/json"}), timeout=600))["embeddings"]
    return np.array(out, dtype=np.float32)
hd = [i for i in range(N) if len(does[i]) > 15]; hn = [i for i in range(N) if needs[i]]
print(len(hd), len(hn))
unit = lambda X: X / np.linalg.norm(X, axis=1, keepdims=True)
Q = unit(emb([needs[i] for i in hn], "search_query: ")); Dm = unit(emb([does[i] for i in hd], "search_document: "))
P = unit(np.load(S + "/vec/nomic-ability.npy")); comp = Dm @ Q.T
res = []
for a, ia in enumerate(hd):
    for b, ib in enumerate(hn):
        if cards[ia]["title"] == cards[ib]["title"] or does[ia] == does[ib]: continue
        sim = float(P[ia] @ P[ib]); c = float(comp[a, b]); res.append((c * (1 - sim), c, sim, ia, ib))
res.sort(key=lambda r: -r[0]); seen = set(); out = []; used = {}
for r in res:
    key = (needs[r[4]], does[r[3]])
    if key in seen or used.get(r[3], 0) >= 2 or used.get(r[4], 0) >= 2: continue
    seen.add(key); used[r[3]] = used.get(r[3], 0) + 1; used[r[4]] = used.get(r[4], 0) + 1; out.append(r)
    if len(out) == 20: break
with open(S + "/top-pairs-standin.txt", "w") as f:
    for n, (s, c, sim, ia, ib) in enumerate(out, 1):
        f.write(f"{n}. score={s:.3f} comp={c:.3f} sim={sim:.3f}\n  A {cards[ia]['title']} [{cards[ia]['type']}] does: {does[ia][:170]}\n  B {cards[ib]['title']} [{cards[ib]['type']}] needs: {needs[ib][:170]}\n")
print(open(S + "/top-pairs-standin.txt").read())

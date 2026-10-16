import sys, os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import json, re, urllib.request, hashlib, numpy as np
from render import S, load
cards = load(); N = len(cards)
dn = {d["cardKey"]: d for d in json.load(open("/Volumes/Local Files/Projects/mault-train/swu-card-data/features/out/cards-does-needs.json"))}
def strip_does(d):
    t = re.sub(r"^.*?\)\. ", "", d["does"], count=1)
    return "" if "No classified effects" in t else t
def strip_needs(d):
    return "" if "no classified needs" in d["needs"] else d["needs"].replace(d["title"], "This card", 1)
does = [strip_does(dn[c["cardKey"]]) for c in cards]; needs = [strip_needs(dn[c["cardKey"]]) for c in cards]
def emb(texts, prefix):
    out = []
    for s in range(0, len(texts), 32):
        body = json.dumps({"model": "nomic-embed-text", "input": [prefix + t for t in texts[s:s+32]], "keep_alive": "2m"}).encode()
        out += json.load(urllib.request.urlopen(urllib.request.Request("http://localhost:11434/api/embed", body, {"Content-Type": "application/json"}), timeout=600))["embeddings"]
    return np.array(out, dtype=np.float32)
hd = [i for i in range(N) if does[i]]; hn = [i for i in range(N) if needs[i]]
print("cards with does", len(hd), "with needs", len(hn)); print("distinct needs", len(set(needs[i] for i in hn)), "distinct does", len(set(does[i] for i in hd)))
Q = emb([needs[i] for i in hn], "search_query: "); Dm = emb([does[i] for i in hd], "search_document: ")
unit = lambda X: X / np.linalg.norm(X, axis=1, keepdims=True)
Q, Dm = unit(Q), unit(Dm)
np.save(S + "/vec/nomic-needs-query.npy", Q); np.save(S + "/vec/nomic-does-doc.npy", Dm)
P = unit(np.load(S + "/vec/nomic-ability.npy"))
comp = Dm @ Q.T   # rows: A (does), cols: B (needs)
res = []
for a, ia in enumerate(hd):
    for b, ib in enumerate(hn):
        if cards[ia]["title"] == cards[ib]["title"]: continue
        sim = float(P[ia] @ P[ib]); c = float(comp[a, b])
        res.append((c * (1 - sim), c, sim, ia, ib))
res.sort(key=lambda r: -r[0])
seen = set(); out = []
for r in res:
    key = (needs[r[4]], does[r[3]])  # dedupe by identical does/needs text pair
    if key in seen: continue
    seen.add(key); out.append(r)
    if len(out) == 20: break
snip = lambda i: (cards[i]["text"] or "")[:170].replace("\n", " ")
with open(S + "/top-pairs.txt", "w") as f:
    for n, (s, c, sim, ia, ib) in enumerate(out, 1):
        f.write(f"{n}. score={s:.3f} comp={c:.3f} sim={sim:.3f}\n  A (does) {cards[ia]['title']} [{cards[ia]['type']}]: {snip(ia)}\n     does: {does[ia][:150]}\n  B (needs) {cards[ib]['title']} [{cards[ib]['type']}]: {snip(ib)}\n     needs: {needs[ib][:150]}\n")
print(open(S + "/top-pairs.txt").read())
print("comp distribution", np.percentile(comp, [50, 90, 99]).round(3))

import sys, os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from render import S, load
cards = load(); N = len(cards)
V = np.load(S + "/vec/qwen3-ability.npy"); V /= np.linalg.norm(V, axis=1, keepdims=True); M = V @ V.T; np.fill_diagonal(M, -1)
hmw = [i for i, c in enumerate(cards) if c["expansion"] == "HMW"]; pick = []
for ty in ("Leader", "Unit", "Event", "Upgrade"): pick += [i for i in hmw if cards[i]["type"] == ty][:2]
for q in pick:
    c = cards[q]; print(f'## {c["title"]} [{c["type"]}] {(c["text"] or c["epicAction"] or "")[:110]!r}')
    for j in np.argsort(-M[q], kind="stable")[:10]:
        d = cards[j]; print(f'   {M[q,j]:.2f} {d["title"]} [{d["type"]}] {(d["text"] or d["epicAction"] or "")[:95]!r}')

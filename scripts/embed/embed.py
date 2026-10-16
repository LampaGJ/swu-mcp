import sys; sys.path.insert(0, "/Volumes/Local Files/Projects/mault-train/swu-card-data/embed/scripts")
import sys, json, time, resource, os, hashlib
import numpy as np
from render import S, sha
model, rendering = sys.argv[1], sys.argv[2]
R = json.load(open(f"{S}/render_{rendering}.json")); texts = R["texts"]; N = len(texts)
job = f"embed-{model}-{rendering}"
def hb(done, **k):
    json.dump({"ts": time.time(), "done": done, "total": N, "pct": round(100*done/N, 1), **k}, open(f"{S}/reports/.progress/{job}.json", "w"))
IDS = {
 "nomic": {"id": "ollama nomic-embed-text:latest", "digest": "ollama id 0a109f422b47; blob sha256 970aa74c0a90ef7482477cf803618e776e173c007bf957f635f1015bfcfef0e6"},
 "qwen3": {"id": "mlx-community/Qwen3-Embedding-4B-4bit-DWQ", "digest": "hf snapshot b5d88f1fe49b50d2ac01b4692ca2d387f14f9c72"},
 "minilm": {"id": "sentence-transformers/all-MiniLM-L6-v2", "digest": "hf snapshot c9745ed1d9f207416be6d2e6f8de32d1f16199bf"},
}
if model == "nomic":
    import urllib.request
    def enc(batch):
        body = json.dumps({"model": "nomic-embed-text", "input": ["search_document: " + t for t in batch], "keep_alive": "5m"}).encode()
        r = urllib.request.urlopen(urllib.request.Request("http://localhost:11434/api/embed", body, {"Content-Type": "application/json"}), timeout=600)
        return np.array(json.load(r)["embeddings"], dtype=np.float32)
    BS = 32
elif model == "minilm":
    from sentence_transformers import SentenceTransformer
    m = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2", device="cpu")
    def enc(batch): return m.encode(batch, batch_size=len(batch), normalize_embeddings=False).astype(np.float32)
    BS = 32
else:
    import mlx.core as mx
    from mlx_lm import load
    m, tok = load("mlx-community/Qwen3-Embedding-4B-4bit-DWQ")
    EOS = tok.eos_token_id if False else 151643
    def enc(batch):
        ids = [tok.encode(t)[:1024] + [EOS] for t in batch]
        L = max(map(len, ids))
        arr = mx.array([i + [EOS]*(L-len(i)) for i in ids])
        h = m.model(arr)
        last = mx.array([len(i)-1 for i in ids])
        out = h[mx.arange(len(ids)), last].astype(mx.float32)
        mx.eval(out)
        return np.array(out)
    BS = 16
def run(tx, label):
    order = np.argsort([len(t) for t in tx], kind="stable") if model == "qwen3" else np.arange(len(tx))
    out = [None]*len(tx); t0 = time.time()
    for s in range(0, len(tx), BS):
        idx = order[s:s+BS]; v = enc([tx[i] for i in idx])
        for j, i in enumerate(idx): out[i] = v[j]
        if label == "main": hb(min(s+BS, len(tx)), rate_per_s=round((s+BS)/(time.time()-t0+1e-9), 2))
    return np.stack(out), time.time()-t0
V, secs = run(texts, "main")
peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e9
sub = texts[:50]
a, _ = run(sub, "x"); b, _ = run(sub, "y")
det = {"repeat_vs_repeat_max_abs_diff": float(np.abs(a-b).max()), "main_vs_subset_max_abs_diff": float(np.abs(V[:50]-a).max()), "bit_identical_repeat": bool((a==b).all())}
V = np.ascontiguousarray(V, dtype=np.float32)
np.save(f"{S}/vec/{model}-{rendering}.npy", V)
rec = {"model": IDS[model]["id"], "digest": IDS[model]["digest"], "renderVersion": R["renderVersion"], "rendering": rendering, "prefix": "search_document: " if model == "nomic" else "", "dims": int(V.shape[1]), "inputHash": sha("\n".join(texts).encode()), "outputHash": sha(V.tobytes()), "seconds": round(secs, 1), "peakRssGB_proc": round(peak, 2), "determinism": det}
json.dump(rec, open(f"{S}/vec/{model}-{rendering}.json", "w"), indent=1)
print(json.dumps(rec, indent=1))

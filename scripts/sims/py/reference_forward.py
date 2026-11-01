"""Float64 NumPy reference forward pass for a dense evaluator.json (#127 parity).

Reads the exported float32 weights, upcasts them to float64, and scores sparse rows (one JSON object per line with
"indices" and "values"); the same pass in MLX float32 on the GPU is reported beside it when MLX imports, never gated,
because MLX accumulates in float32. Prints one JSON object: {"numpy": [...], "mlx": [...] | null, "mlxError": ...}.

Usage: python -I scripts/sims/py/reference_forward.py --weights <evaluator.json> --rows <rows.jsonl>
"""
import argparse
import base64
import json

import numpy as np


def floats(b64, n):
    a = np.frombuffer(base64.b64decode(b64), dtype="<f4")
    if a.size != n:
        raise SystemExit(f"expected {n} floats, got {a.size}")
    return a


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", required=True)
    ap.add_argument("--rows", required=True)
    args = ap.parse_args()
    with open(args.weights, encoding="utf8") as f:
        w = json.load(f)
    if w["kind"] not in ("constant", "logistic", "mlp"):
        raise SystemExit(f"dense evaluators only, got {w['kind']}")
    width = w["featureWidth"]
    scale32 = floats(w["scale"], width)
    layers32 = [(floats(l["weight"], l["in"] * l["out"]).reshape(l["in"], l["out"]), floats(l["bias"], l["out"])) for l in w["layers"]]
    rows = []
    with open(args.rows, encoding="utf8") as f:
        for line in f:
            r = json.loads(line)
            x = np.zeros(width, dtype=np.float64)
            x[np.asarray(r["indices"], dtype=np.int64)] = np.asarray(r["values"], dtype=np.float64)
            rows.append(x)
    X = np.stack(rows)

    def forward(X, scale, layers, relu):
        h = X * scale
        for i, (W, b) in enumerate(layers):
            h = h @ W + b
            if i < len(layers) - 1:
                h = relu(h)
        return h[:, 0]

    ref = forward(X, scale32.astype(np.float64), [(W.astype(np.float64), b.astype(np.float64)) for W, b in layers32], lambda h: np.maximum(h, 0.0))
    out = {"numpy": [float(v) for v in ref], "mlx": None, "mlxError": None}
    try:
        import mlx.core as mx

        Xm = mx.array(X.astype(np.float32))
        got = forward(Xm, mx.array(scale32), [(mx.array(W), mx.array(b)) for W, b in layers32], lambda h: mx.maximum(h, 0.0))
        mx.eval(got)
        out["mlx"] = [float(v) for v in np.array(got, dtype=np.float64)]
    except Exception as e:  # noqa: BLE001 - MLX is reported, not gated
        out["mlxError"] = str(e)[:200]
    print(json.dumps(out))


if __name__ == "__main__":
    main()

"""Booster.predict on parity vectors, for scripts/sims/model-parity.ts.

Usage: .venv/bin/python -I scripts/sims/py/xgb_parity.py <model.json> <vectors.json> <model sha256>
Prints one JSON object on stdout: modelSha256, xgboostVersion, vectors, booster. Single-threaded for determinism.
"""

import json
import sys

import numpy as np
import xgboost as xgb


def main() -> None:
    model_file, vectors_file, sha256 = sys.argv[1:4]
    with open(vectors_file, encoding="utf8") as f:
        vectors = json.load(f)
    booster = xgb.Booster(params={"nthread": 1}, model_file=model_file)
    matrix = np.array([[np.nan if v is None else v for v in row] for row in vectors], dtype=np.float32)
    predictions = booster.predict(xgb.DMatrix(matrix, missing=np.nan, nthread=1))
    print(json.dumps({"modelSha256": sha256, "xgboostVersion": xgb.__version__, "vectors": vectors, "booster": [float(p) for p in predictions]}))


if __name__ == "__main__":
    main()

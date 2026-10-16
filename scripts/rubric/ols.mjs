// @pocTriage: becomes the regression helper of the committed #322 scoring script (or is replaced by a stats library after a framework search)
// Ordinary least squares with HC1 heteroskedasticity-robust standard errors, plus a seeded
// RNG for bootstraps. Pure functions, deterministic.

export function invert(A) {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw new Error(`singular matrix at column ${c}`);
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f !== 0) for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row) => row.slice(n));
}

// X: array of rows (each an array of numbers, include intercept column yourself); y: array.
export function ols(X, y, names) {
  const n = X.length, k = X[0].length;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    const r = X[i];
    for (let a = 0; a < k; a++) {
      Xty[a] += r[a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += r[a] * r[b];
    }
  }
  const inv = invert(XtX);
  const beta = inv.map((row) => row.reduce((s, v, j) => s + v * Xty[j], 0));
  const resid = X.map((r, i) => y[i] - r.reduce((s, v, j) => s + v * beta[j], 0));
  const meat = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < n; i++) {
    const e2 = resid[i] ** 2, r = X[i];
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) meat[a][b] += r[a] * r[b] * e2;
  }
  const mul = (A, B) => A.map((row) => B[0].map((_, j) => row.reduce((s, v, t) => s + v * B[t][j], 0)));
  const V = mul(mul(inv, meat), inv).map((row) => row.map((v) => (v * n) / (n - k)));
  const ybar = y.reduce((s, v) => s + v, 0) / n;
  const sst = y.reduce((s, v) => s + (v - ybar) ** 2, 0);
  const sse = resid.reduce((s, v) => s + v * v, 0);
  const coefs = beta.map((b, j) => ({ name: names?.[j] ?? `x${j}`, b, se: Math.sqrt(V[j][j]), lo: b - 1.96 * Math.sqrt(V[j][j]), hi: b + 1.96 * Math.sqrt(V[j][j]) }));
  return { coefs, V, beta, resid, n, k, r2: 1 - sse / sst, rmse: Math.sqrt(sse / (n - k)) };
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const fmt = (c, d = 2) => `${c.b.toFixed(d)} [${c.lo.toFixed(d)}, ${c.hi.toFixed(d)}]`;

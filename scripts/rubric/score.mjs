// @pocTriage: becomes the scoring + validation step of the committed #322 SWU scoring script (pinned fits + pinned swustats/price captures in, scores + validation report out)
// Scores JTL+ cards from the fitted residuals, calibrates a cost-dependent playability term
// T(cost) against SWU Stats Premier inclusion (and TCGplayer Standard price), and validates.
// Inputs: cards.json, printings.json, fit-effects.out.json, fit-other.out.json,
//         gt/swustats-premier-w29-55.json (pinned capture), gt/tcg-prices-import43.tsv (pinned DB export)
import { readFileSync, writeFileSync } from 'node:fs';
import { ols, fmt, mulberry32 } from './ols.mjs';

const DIR = decodeURIComponent(new URL('../../data/rubric/', import.meta.url).pathname);
const WINDOW = process.argv[2] ?? 'w29-55';
const J = (f) => JSON.parse(readFileSync(DIR + f, 'utf8'));
const cards = J('cards.json');
const printings = J('printings.json');
const fu = J('fit-effects.out.json');
const fo = J('fit-other.out.json');
const units = J('fit-units.out.json');
const STAT_PER_RESOURCE = 2 / (units.M2.coefs[1].b + units.M2.coefs[2].b); // from M2 power/hp prices
const out = { script: 'score.mjs', window: WINDOW, statPerResource: STAT_PER_RESOURCE };
const log = console.log;

const ident = (p) => [p.title, p.subtitle, p.type].join('|');
const bySerial = new Map(cards.map((c) => [c.serialCode, c]));

// ---- base score V0 in stat points (positive = more than the design norm for its cost) ----
const V0 = new Map();
const put = (rows, f, type) => rows.forEach((r) => bySerial.get(r.serialCode) && V0.set(r.serialCode, { v: f(r.resid), type }));
put(fu.residuals, (e) => e, 'Unit');
put(fo.E1_events.residuals, (e) => -e * STAT_PER_RESOURCE, 'Event');
put(fo.U1_upgrades.residuals, (e) => -e * STAT_PER_RESOURCE, 'Upgrade');
put(fo.L1_leaders.residuals, (e) => e, 'Leader');
put(fo.B1.residuals, (e) => e, 'Base');

// ---- ground truth joins ----
const sw = J(`../pinned/gt/swustats-premier-${WINDOW}.json`);
const uidToIdent = new Map(printings.filter((p) => p.cardUid).map((p) => [p.cardUid, ident(p)]));
const inc = new Map();
for (const r of sw) {
  const k = uidToIdent.get(r.cardUid);
  if (!k) continue;
  const a = inc.get(k) ?? { inc: 0, incWin: 0, played: 0, resourced: 0 };
  a.inc += r.timesIncluded; a.incWin += r.timesIncludedInWins; a.played += r.timesPlayed; a.resourced += r.timesResourced;
  inc.set(k, a);
}
const games = [...inc.entries()].filter(([k]) => k.endsWith('|Leader')).reduce((s, [, a]) => s + a.inc, 0);
out.playerGames = games;
const price = new Map();
for (const line of readFileSync(DIR + '../pinned/gt/tcg-prices-import43.tsv', 'utf8').split('\n')) {
  const [card_id, variant, pn] = line.split('\t');
  if (variant === 'standard' && pn) price.set(card_id, +pn);
}

const pop = cards.filter((c) => c.jtlPlus && V0.has(c.serialCode));
const rows = pop.map((c) => {
  const a = inc.get(ident(c)) ?? { inc: 0, incWin: 0, played: 0, resourced: 0 };
  return { c, v: V0.get(c.serialCode).v, type: V0.get(c.serialCode).type, incRate: a.inc / games, inc: a.inc, winPct: a.inc ? a.incWin / a.inc : null, price: price.get(c.serialCode) ?? null };
});
log(`JTL+ scored cards: ${rows.length}; SWU Stats ${WINDOW} player-games=${games}; with inclusion>0: ${rows.filter((r) => r.inc > 0).length}; with Standard price: ${rows.filter((r) => r.price != null).length}`);

const rank = (a) => { const s = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); for (let i = 0; i < s.length;) { let j = i; while (j + 1 < s.length && s[j + 1][0] === s[i][0]) j++; for (let k = i; k <= j; k++) r[s[k][1]] = (i + j) / 2; i = j + 1; } return r; };
const pearson = (x, y) => { const n = x.length, mx = x.reduce((a, b) => a + b) / n, my = y.reduce((a, b) => a + b) / n; let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };
const spearman = (x, y) => pearson(rank(x), rank(y));
const ciR = (r, n) => { const z = Math.atanh(r), se = 1 / Math.sqrt(n - 3); return [Math.tanh(z - 1.96 * se), Math.tanh(z + 1.96 * se)]; };

// ---- V1: Spearman of V0 with inclusion, win%, price, per type ----
out.validation = {};
for (const type of ['Unit', 'Event', 'Upgrade', 'Leader', 'Base']) {
  const R = rows.filter((r) => r.type === type);
  const res = { n: R.length };
  const a = R.map((r) => r.v);
  res.incl = spearman(a, R.map((r) => r.incRate)); res.inclCI = ciR(res.incl, R.length);
  const W = R.filter((r) => r.inc >= 500);
  if (W.length > 10) { res.win = spearman(W.map((r) => r.v), W.map((r) => r.winPct)); res.winN = W.length; res.winCI = ciR(res.win, W.length); }
  const P = R.filter((r) => r.price != null && r.price > 0);
  if (P.length > 10) { res.price = spearman(P.map((r) => r.v), P.map((r) => r.price)); res.priceN = P.length; res.priceCI = ciR(res.price, P.length); }
  out.validation[type] = res;
  log(`${type.padEnd(8)} n=${R.length} rho(V0,inclusion)=${res.incl.toFixed(3)} [${res.inclCI.map((x) => x.toFixed(2)).join(',')}]` + (res.win != null ? `  rho(V0,win%|inc>=500)=${res.win.toFixed(3)} n=${res.winN}` : '') + (res.price != null ? `  rho(V0,price)=${res.price.toFixed(3)} n=${res.priceN}` : ''));
}

// ---- T(cost) calibration: units+events+upgrades, outcome log inclusion share ----
// y = log((inc+1)/games); X = V0 + cost dummies(0..7+, base 2) + type + set FE + aspect-combo FE + rarity FE.
function calibrate(R, yf, label) {
  const costs = [0, 1, 3, 4, 5, 6, 7]; // baseline cost 2; 7 = 7+
  const types = ['Event', 'Upgrade'];
  const sets = ['LOF', 'SEC', 'LAW', 'ASH', 'HMW'];
  const combos = [...new Set(R.map((r) => r.c.aspects.slice().sort().join('+')))].sort();
  const comboKeep = combos.filter((k) => R.filter((r) => r.c.aspects.slice().sort().join('+') === k).length >= 8).slice(1);
  const rar = ['Uncommon', 'Rare', 'Legendary', 'Special'];
  const names = ['intercept', 'V0', ...costs.map((c) => `cost${c}${c === 7 ? '+' : ''}`), ...types.map((t) => `type:${t}`), ...sets.map((s) => `set:${s}`), ...comboKeep.map((k) => `asp:${k}`), ...rar.map((r) => `rar:${r}`)];
  const row = (r) => {
    const cc = Math.min(r.c.cost ?? 0, 7);
    const setOf = ['JTL', 'LOF', 'SEC', 'LAW', 'ASH', 'HMW'].includes(r.c.set) ? r.c.set : 'JTL';
    return [1, r.v, ...costs.map((c) => +(cc === c)), ...types.map((t) => +(r.type === t)), ...sets.map((s) => +(setOf === s)), ...comboKeep.map((k) => +(r.c.aspects.slice().sort().join('+') === k)), ...rar.map((x) => +(r.c.rarity === x))];
  };
  const X = R.map(row), y = R.map(yf);
  const fit = ols(X, y, names);
  const bV = fit.coefs[1];
  // T(c) in stat points = beta_cost(c) / beta_V0; seeded bootstrap for CI.
  const rnd = mulberry32(3220);
  const boots = costs.map(() => []);
  for (let b = 0; b < 300; b++) {
    const idx = R.map(() => Math.floor(rnd() * R.length));
    try { const f = ols(idx.map((i) => X[i]), idx.map((i) => y[i]), names); costs.forEach((_, j) => boots[j].push(f.beta[2 + j] / f.beta[1])); } catch { /* singular resample */ }
  }
  const T = costs.map((c, j) => { const s = boots[j].sort((a, b) => a - b); return { cost: c, beta: fit.coefs[2 + j], T: fit.beta[2 + j] / fit.beta[1], lo: s[Math.floor(0.025 * s.length)], hi: s[Math.floor(0.975 * s.length)], boots: s.length }; });
  log(`\nT(cost) calibration on ${label}: n=${fit.n} r2=${fit.r2.toFixed(3)} beta(V0)=${fmt(bV, 3)}`);
  for (const t of T) log(`  cost ${String(t.cost).padEnd(2)} beta=${fmt(t.beta, 3)}  T=${t.T.toFixed(2)} stat pts [${t.lo.toFixed(2)}, ${t.hi.toFixed(2)}] (${t.boots} boots)`);
  return { n: fit.n, r2: fit.r2, bV, T, coefs: fit.coefs };
}
const playable = rows.filter((r) => ['Unit', 'Event', 'Upgrade'].includes(r.type));
out.T_inclusion = calibrate(playable, (r) => Math.log((r.inc + 1) / games), 'log inclusion share (SWU Stats Premier ' + WINDOW + ')');
const priced = playable.filter((r) => r.price != null && r.price > 0);
out.T_price = calibrate(priced, (r) => Math.log(r.price), 'log TCGplayer Standard price (import 43)');

// ---- scores with and without T; T default = smoothed inclusion calibration (clipped to its CI sign) ----
const Tmap = Object.fromEntries(out.T_inclusion.T.map((t) => [t.cost, t.T]));
Tmap[2] = 0;
const Tof = (c) => Tmap[Math.min(c ?? 0, 7)] ?? 0;
const scored = rows.map((r) => ({ title: r.c.title, subtitle: r.c.subtitle, set: r.c.set, serialCode: r.c.serialCode, type: r.type, cost: r.c.cost, V0: r.v, T: ['Unit', 'Event', 'Upgrade'].includes(r.type) ? Tof(r.c.cost) : 0, incRate: r.incRate, price: r.price }));
for (const s of scored) s.V1 = s.V0 + s.T;
out.examples = [1, 2, 3, 5, 7].map((cost) => {
  const pool = scored.filter((s) => s.type === 'Unit' && s.cost === cost).sort((a, b) => b.incRate - a.incRate);
  return pool[0];
});
log('\nExamples (most-included JTL+ unit at each cost):');
for (const e of out.examples) log(`  ${e.title}${e.subtitle ? ', ' + e.subtitle : ''} (${e.set} ${e.serialCode}) cost ${e.cost}: V0=${e.V0.toFixed(2)} T=${e.T.toFixed(2)} V1=${e.V1.toFixed(2)} inclusion=${(100 * e.incRate).toFixed(2)}% price=${e.price}`);
// Rank correlation with inclusion, with and without T, across all playable JTL+ cards.
const pl = scored.filter((s) => ['Unit', 'Event', 'Upgrade'].includes(s.type));
out.rhoInclusion = { V0: spearman(pl.map((s) => s.V0), pl.map((s) => s.incRate)), V1: spearman(pl.map((s) => s.V1), pl.map((s) => s.incRate)), n: pl.length };
log(`\nrho with inclusion, all playable JTL+ (n=${pl.length}): V0=${out.rhoInclusion.V0.toFixed(3)}  V1(with T)=${out.rhoInclusion.V1.toFixed(3)}`);
// Top/bottom units by V1 for the doc
const U = scored.filter((s) => s.type === 'Unit').sort((a, b) => b.V1 - a.V1);
out.topUnits = U.slice(0, 10); out.bottomUnits = U.slice(-5);
log('Top units V1:', U.slice(0, 10).map((s) => `${s.title} ${s.set} c${s.cost} V0=${s.V0.toFixed(1)} V1=${s.V1.toFixed(1)} inc=${(100 * s.incRate).toFixed(1)}%`).join(' | '));
writeFileSync(DIR + `score.${WINDOW}.out.json`, JSON.stringify(out, null, 1));
writeFileSync(DIR + `scores.jtl.${WINDOW}.json`, JSON.stringify(scored));

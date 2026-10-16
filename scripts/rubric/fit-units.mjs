// @pocTriage: becomes the curve-and-price fitting step of the committed #322 SWU scoring script (pinned cards.json in, coefficients JSON out)
// Fits, over canonical units (cards.json from load.mjs):
//  M0 vanilla curve: total stats ~ cost x arena on keyword-less, text-less units
//  M1 stats model : power+hp ~ cost dummies + arena + unique + aspects + keywords + effects + set
//  M2 cost model  : cost ~ power + hp + same controls  (power-vs-HP weight)
//  M3 creep       : per-set intercepts from M1 and from vanilla-only fits
import { readFileSync, writeFileSync } from 'node:fs';
import { ols, fmt, mulberry32 } from './ols.mjs';
import { effectFeatures, keywordFeatures, EFFECTS } from './features.mjs';

const DIR = decodeURIComponent(new URL('../../data/rubric/', import.meta.url).pathname);
const POP = process.argv[2] ?? 'all';
const MAIN_ALL = ['SOR', 'SHD', 'TWI', 'JTL', 'LOF', 'SEC', 'LAW', 'ASH', 'HMW'];
const JTL = ['JTL', 'LOF', 'SEC', 'LAW', 'ASH', 'HMW'];
const MAIN = POP === 'jtl' ? JTL : MAIN_ALL;
// JTL+ mode: a reprint whose canonical set is pre-JTL is fitted in its first JTL+ main set.
const popSet = (c) => (POP !== 'jtl' || JTL.includes(c.set) ? c.set : JTL.find((s) => c.allSets.some((a) => a === s || a === s + 'P')));
const cards = JSON.parse(readFileSync(DIR + 'cards.json', 'utf8'));
const units = cards.filter((c) => c.type === 'Unit' && c.arenas.length === 1 && c.cost != null && c.cost >= 1 && (POP === 'jtl' ? c.jtlPlus : true) && MAIN.includes(popSet(c))).map((c) => ({ ...c, set: popSet(c) }));
const out = { script: 'fit-units.mjs', nUnits: units.length };
const log = (...a) => console.log(...a);

// ---------- M0 vanilla ----------
const isVanilla = (c) => c.keywords.length === 0 && c.text.trim() === '';
const van = units.filter(isVanilla);
{
  const rows = van.map((c) => [1, c.cost, c.arenas[0] === 'Space' ? 1 : 0, c.unique ? 1 : 0]);
  const names = ['intercept', 'cost', 'space', 'unique'];
  for (const [label, y] of [['total', van.map((c) => c.power + c.hp)], ['power', van.map((c) => c.power)], ['hp', van.map((c) => c.hp)]]) {
    const r = ols(rows, y, names);
    out[`M0_${label}`] = { n: r.n, r2: r.r2, rmse: r.rmse, coefs: r.coefs };
    log(`M0 vanilla ${label} n=${r.n} r2=${r.r2.toFixed(3)} rmse=${r.rmse.toFixed(2)} ::`, r.coefs.map((c) => `${c.name}=${fmt(c)}`).join('  '));
  }
  // Mean total by cost x arena, all vanilla
  const cell = {};
  for (const c of van) (cell[`${c.arenas[0]} ${c.cost}`] ??= []).push(c.power + c.hp);
  out.M0_cells = Object.fromEntries(Object.entries(cell).sort().map(([k, v]) => [k, { n: v.length, mean: v.reduce((s, x) => s + x, 0) / v.length }]));
  log('M0 cells', JSON.stringify(out.M0_cells));
}

// ---------- feature matrix for all units ----------
const KW = ['Sentinel', 'Ambush', 'Overwhelm', 'Saboteur', 'Shielded', 'Grit', 'Raid', 'Restore', 'Hidden', 'Smuggle', 'Bounty', 'Exploit', 'Coordinate', 'Piloting', 'Plot', 'Support', 'Fortify'];
const EFF = Object.keys(EFFECTS).filter((e) => e !== 'selfKeywordConditional');
const TIM = ['t:whenPlayed', 't:onAttack', 't:whenDefeated', 't:action', 't:whenAttackEnds', 't:triggered', 't:constant', 't:whenPlayedOnAttack'];
const featurize = (c) => {
  const kf = keywordFeatures(c);
  const ef = effectFeatures(c.text);
  const f = {};
  for (const k of KW) {
    const v = kf[k];
    f[`kw:${k}`] = v && v.printed ? 1 : 0;
    f[`kwCond:${k}`] = v && !v.printed ? 1 : 0;
  }
  // Numeric keywords: extra slope per point above 1 for printed Raid/Restore/Exploit.
  for (const k of ['Raid', 'Restore', 'Exploit']) f[`kwN:${k}`] = kf[k]?.printed ? kf[k].n - 1 : 0;
  for (const e of EFF) f[`fx:${e}`] = ef.eff[e] ? 1 : 0;
  for (const t of TIM) f[t] = ef.timing[t] ? 1 : 0;
  f.unmatchedLines = ef.abilityLines - ef.matchedLines;
  f.aspectCount = c.aspects.length;
  f.multiAspect = c.aspects.filter((a) => a !== 'Heroism' && a !== 'Villainy').length >= 2 ? 1 : 0;
  f.space = c.arenas[0] === 'Space' ? 1 : 0;
  f.unique = c.unique ? 1 : 0;
  f.leaderOnly = 0;
  return { f, ef, kf };
};
const feats = units.map((c) => featurize(c).f);
// Drop columns with fewer than 5 non-zero rows (unidentifiable) but record them.
const allCols = Object.keys(feats[0]);
const support = Object.fromEntries(allCols.map((k) => [k, feats.filter((f) => f[k]).length]));
const cols = allCols.filter((k) => support[k] >= 5);
out.droppedForSupport = allCols.filter((k) => support[k] < 5).map((k) => `${k}(${support[k]})`);
log('dropped (<5 cards):', out.droppedForSupport.join(' '));

const costDum = [2, 3, 4, 5, 6, 7, 8]; // cost 1 is baseline; 8 means 8+
const setDum = MAIN.slice(1);
const design = (withSets) => {
  const names = ['intercept', ...costDum.map((d) => `cost${d}${d === 8 ? '+' : ''}`), ...cols, ...(withSets ? setDum.map((s) => `set:${s}`) : [])];
  const X = units.map((c, i) => [1, ...costDum.map((d) => (d === 8 ? (c.cost >= 8 ? 1 : 0) : c.cost === d ? 1 : 0)), ...cols.map((k) => feats[i][k]), ...(withSets ? setDum.map((s) => (c.set === s ? 1 : 0)) : [])]);
  return { X, names };
};

// ---------- M1 stats model ----------
{
  const { X, names } = design(true);
  const y = units.map((c) => c.power + c.hp);
  const r = ols(X, y, names);
  out.M1 = { n: r.n, k: r.k, r2: r.r2, rmse: r.rmse, coefs: r.coefs.map((c) => ({ ...c, support: support[c.name] ?? null })) };
  log(`\nM1 stats model n=${r.n} k=${r.k} r2=${r.r2.toFixed(3)} rmse=${r.rmse.toFixed(2)}`);
  for (const c of r.coefs) log(`  ${c.name.padEnd(26)} ${fmt(c)}${support[c.name] != null ? `  n=${support[c.name]}` : ''}`);
  // Implied vanilla-equivalent curve at SOR, ground, non-unique, 1 aspect, no text
  const asp = r.coefs.find((c) => c.name === 'aspectCount')?.b ?? 0;
  const b0 = r.beta[0] + asp;
  out.M1_curve = [1, 2, 3, 4, 5, 6, 7, 8].map((cost) => ({ cost, E: b0 + (cost === 1 ? 0 : r.beta[names.indexOf(`cost${cost}${cost === 8 ? '+' : ''}`)]) }));
  log('  implied E(total) SOR ground 1-aspect:', out.M1_curve.map((e) => `${e.cost}:${e.E.toFixed(2)}`).join(' '));
}

// ---------- M1b power and hp separately (where do keywords take their price from?) ----------
for (const [label, yf] of [['power', (c) => c.power], ['hp', (c) => c.hp]]) {
  const { X, names } = design(true);
  const r = ols(X, units.map(yf), names);
  out[`M1_${label}`] = { n: r.n, r2: r.r2, coefs: r.coefs };
}

// ---------- M2 cost model ----------
{
  const { X: X0, names: n0 } = design(true);
  // replace cost dummies with power, hp
  const names = ['intercept', 'power', 'hp', ...n0.slice(1 + costDum.length)];
  const X = units.map((c, i) => [1, c.power, c.hp, ...X0[i].slice(1 + costDum.length)]);
  const y = units.map((c) => c.cost);
  const r = ols(X, y, names);
  out.M2 = { n: r.n, r2: r.r2, rmse: r.rmse, coefs: r.coefs };
  const bp = r.coefs[1], bh = r.coefs[2];
  log(`\nM2 cost model n=${r.n} r2=${r.r2.toFixed(3)} rmse=${r.rmse.toFixed(2)} power=${fmt(bp, 3)} hp=${fmt(bh, 3)}`);
  // Bootstrap the power/hp ratio (seeded).
  const rnd = mulberry32(322);
  const ratios = [];
  for (let b = 0; b < 400; b++) {
    const idx = units.map(() => Math.floor(rnd() * units.length));
    try {
      const rb = ols(idx.map((i) => X[i]), idx.map((i) => y[i]), names);
      ratios.push(rb.beta[1] / rb.beta[2]);
    } catch { /* singular resample: skip */ }
  }
  ratios.sort((a, b) => a - b);
  out.M2_ratio = { point: bp.b / bh.b, lo: ratios[Math.floor(0.025 * ratios.length)], hi: ratios[Math.floor(0.975 * ratios.length)], boots: ratios.length };
  log(`  power/hp value ratio = ${out.M2_ratio.point.toFixed(2)} [${out.M2_ratio.lo.toFixed(2)}, ${out.M2_ratio.hi.toFixed(2)}] (${ratios.length} seeded bootstraps)`);
  log('  M2 keyword/effect prices in resources:');
  for (const c of r.coefs.slice(3)) log(`    ${c.name.padEnd(26)} ${fmt(c)}`);
}

// ---------- M3 power creep ----------
{
  // (a) vanilla only: total ~ cost + space + unique + set
  const vm = van;
  const names = ['intercept', 'cost', 'space', 'unique', ...setDum.map((s) => `set:${s}`)];
  const X = vm.map((c) => [1, c.cost, c.arenas[0] === 'Space' ? 1 : 0, c.unique ? 1 : 0, ...setDum.map((s) => (c.set === s ? 1 : 0))]);
  const r = ols(X, vm.map((c) => c.power + c.hp), names);
  out.M3_vanilla = { n: r.n, coefs: r.coefs };
  log(`\nM3a vanilla creep n=${r.n}:`, r.coefs.filter((c) => c.name.startsWith('set:')).map((c) => `${c.name}=${fmt(c)}`).join('  '));
  // (b) per-set mean surplus (power+hp - 2*cost) all units, descriptive
  const per = {};
  for (const c of units) (per[c.set] ??= []).push(c.power + c.hp - 2 * c.cost);
  out.M3_surplus = Object.fromEntries(MAIN.map((s) => { const v = per[s]; const m = v.reduce((a, b) => a + b, 0) / v.length; const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)); return [s, { n: v.length, mean: m, lo: m - 1.96 * sd / Math.sqrt(v.length), hi: m + 1.96 * sd / Math.sqrt(v.length) }]; }));
  log('M3b raw surplus (P+H-2C) per set:', Object.entries(out.M3_surplus).map(([s, v]) => `${s}=${v.mean.toFixed(2)}[${v.lo.toFixed(2)},${v.hi.toFixed(2)}]n${v.n}`).join(' '));
  // (c) year blocks from M1-style model with block dummies
  const blockOf = (s) => (['SOR', 'SHD', 'TWI'].includes(s) ? 0 : ['JTL', 'LOF', 'SEC'].includes(s) ? 1 : 2);
  const { X: X1, names: n1 } = design(false);
  const yrs = POP === 'jtl' ? [2] : [1, 2];
  const Xb = units.map((c, i) => [...X1[i], ...yrs.map((y) => (blockOf(c.set) === y ? 1 : 0))]);
  const rb = ols(Xb, units.map((c) => c.power + c.hp), [...n1, ...yrs.map((y) => `year${y + 1}`)]);
  out.M3_blocks = rb.coefs.slice(-yrs.length);
  log('M3c year-block effect (controls as M1):', out.M3_blocks.map((c) => `${c.name}=${fmt(c)}`).join('  '));
}

writeFileSync(DIR + 'fit-units' + (POP === 'jtl' ? '.jtl' : '') + '.out.json', JSON.stringify(out, null, 1));

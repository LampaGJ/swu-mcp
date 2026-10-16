// @pocTriage: becomes the play-rate-calibrated weighting step of the committed #322 SWU scoring script
// Supervised check: which rubric components predict Premier play? Fits
//   y = log((inclusions+1)/playerGames)  (SWU Stats, pinned capture)
// on JTL+ units/events/upgrades with: stat surplus (power, hp vs vanilla curve M0), cost dummies
// (the T(cost) term), keywords, effect magnitudes, timing, type, and fixed effects for set and
// aspect combination (popularity confounders). Leave-one-set-out CV gives held-out Spearman.
// Usage: node play-model.mjs [w29-55] [rarity|norarity]
import { readFileSync, writeFileSync } from 'node:fs';
import { ols, fmt, mulberry32 } from './ols.mjs';
import { effectFeatures, keywordFeatures, EFFECTS } from './features.mjs';

const DIR = decodeURIComponent(new URL('../../data/rubric/', import.meta.url).pathname);
const WINDOW = process.argv[2] ?? 'w29-55';
const RAR = (process.argv[3] ?? 'norarity') === 'rarity';
const J = (f) => JSON.parse(readFileSync(DIR + f, 'utf8'));
const cards = J('cards.json'), printings = J('printings.json'), fu = J('fit-units.out.json');
const ident = (p) => [p.title, p.subtitle, p.type].join('|');
const sw = J(`../pinned/gt/swustats-premier-${WINDOW}.json`);
const uidToIdent = new Map(printings.filter((p) => p.cardUid).map((p) => [p.cardUid, ident(p)]));
const inc = new Map();
for (const r of sw) { const k = uidToIdent.get(r.cardUid); if (k) inc.set(k, (inc.get(k) ?? 0) + r.timesIncluded); }
const games = [...inc.entries()].filter(([k]) => k.endsWith('|Leader')).reduce((s, [, v]) => s + v, 0);

// Vanilla curve M0 (fit-units.mjs, all sets): E_power, E_hp by cost and arena.
const m0 = (lab) => Object.fromEntries(fu[`M0_${lab}`].coefs.map((c) => [c.name, c.b]));
const P0 = m0('power'), H0 = m0('hp');
const Epow = (c) => P0.intercept + P0.cost * c.cost + P0.space * (c.arenas[0] === 'Space') + P0.unique * c.unique;
const Ehp = (c) => H0.intercept + H0.cost * c.cost + H0.space * (c.arenas[0] === 'Space') + H0.unique * c.unique;

const SETS = ['JTL', 'LOF', 'SEC', 'LAW', 'ASH', 'HMW'];
const pop = cards.filter((c) => c.jtlPlus && ['Unit', 'Event', 'Upgrade'].includes(c.type) && c.cost != null)
  .map((c) => ({ ...c, set: SETS.includes(c.set) ? c.set : SETS.find((s) => c.allSets.some((a) => a === s || a === s + 'P')) ?? 'JTL' }))
  .filter((c) => c.set !== 'HMW'); // HMW released 2026-10-09: <1 week of data in the window
const KW = ['Sentinel', 'Ambush', 'Overwhelm', 'Saboteur', 'Shielded', 'Grit', 'Raid', 'Restore', 'Hidden', 'Smuggle', 'Bounty', 'Exploit', 'Coordinate', 'Piloting', 'Plot', 'Support', 'Fortify'];
const MAG = new Set(['dmgUnit', 'dmgBase', 'dmgEach', 'draw', 'heal', 'search', 'giveExperience', 'giveShield', 'giveAdvantage', 'giveWeakness', 'tokenUnit', 'credit', 'buffTemp', 'buffStatic', 'debuff']);
const feat = (c) => {
  const f = {};
  const isU = c.type === 'Unit' && c.arenas.length === 1;
  f.powerSurplus = isU ? c.power - Epow(c) : 0;
  f.hpSurplus = isU ? c.hp - Ehp(c) : 0;
  f.upgradeStats = c.type === 'Upgrade' ? (c.upgradePower ?? 0) + (c.upgradeHp ?? 0) : 0;
  for (let k = 0; k <= 7; k++) if (k !== 2) f[`cost${k}${k === 7 ? '+' : ''}`] = +(Math.min(c.cost, 7) === k);
  f['type:Event'] = +(c.type === 'Event'); f['type:Upgrade'] = +(c.type === 'Upgrade');
  f.space = +(c.arenas[0] === 'Space'); f.unique = +c.unique;
  const kf = keywordFeatures(c);
  for (const k of KW) f[`kw:${k}`] = kf[k] ? (kf[k].printed ? 1 : 0.5) : 0;
  const ef = effectFeatures(c.text);
  for (const e of Object.keys(EFFECTS)) f[`fx:${e}`] = MAG.has(e) ? Math.min(ef.eff[e] ?? 0, 8) : ef.eff[e] ? 1 : 0;
  for (const t of ['t:whenPlayed', 't:onAttack', 't:whenDefeated', 't:action', 't:whenAttackEnds', 't:triggered', 't:constant']) f[t] = ef.timing[t] ? 1 : 0;
  f.unmatchedLines = ef.abilityLines - ef.matchedLines;
  for (const s of SETS.slice(1, 5)) f[`set:${s}`] = +(c.set === s);
  const asp = c.aspects.slice().sort().join('+');
  f[`asp:${asp}`] = 1;
  if (RAR) for (const r of ['Uncommon', 'Rare', 'Legendary', 'Special']) f[`rar:${r}`] = +(c.rarity === r);
  return f;
};
const F = pop.map(feat);
const keys = [...new Set(F.flatMap((f) => Object.keys(f)))];
const support = Object.fromEntries(keys.map((k) => [k, F.filter((f) => f[k]).length]));
const aspKeys = keys.filter((k) => k.startsWith('asp:') && support[k] >= 8).sort();
const cols = keys.filter((k) => (!k.startsWith('asp:') && support[k] >= 5) || aspKeys.slice(1).includes(k));
const X = F.map((f) => [1, ...cols.map((k) => f[k] ?? 0)]);
const names = ['intercept', ...cols];
const y = pop.map((c) => Math.log(((inc.get(ident(c)) ?? 0) + 1) / games));
const fit = ols(X, y, names);
console.log(`play model (${WINDOW}, ${RAR ? 'with' : 'without'} rarity FE) n=${fit.n} k=${fit.k} r2=${fit.r2.toFixed(3)} games=${games}`);
for (const c of fit.coefs) if (!c.name.startsWith('asp:')) console.log(`  ${c.name.padEnd(22)} ${fmt(c, 3)}  n=${support[c.name] ?? '-'}`);

// T(cost) in stat points: cost-dummy coefficient / mean of power & hp surplus coefficients.
const B = Object.fromEntries(fit.coefs.map((c) => [c.name, c]));
const perStat = (B.powerSurplus.b + B.hpSurplus.b) / 2;
const Tcost = [0, 1, 3, 4, 5, 6, 7].map((k) => ({ cost: k, logIncl: B[`cost${k}${k === 7 ? '+' : ''}`] }));
console.log(`  per stat point (mean of power/hp surplus) = ${perStat.toFixed(3)} log-inclusion`);

// Leave-one-set-out held-out Spearman: full model vs cost+FE-only baseline.
const rank = (a) => { const s = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); for (let i = 0; i < s.length;) { let j = i; while (j + 1 < s.length && s[j + 1][0] === s[i][0]) j++; for (let k = i; k <= j; k++) r[s[k][1]] = (i + j) / 2; i = j + 1; } return r; };
const pear = (x, y) => { const n = x.length, mx = x.reduce((a, b) => a + b) / n, my = y.reduce((a, b) => a + b) / n; let a = 0, b = 0, d = 0; for (let i = 0; i < n; i++) { a += (x[i] - mx) * (y[i] - my); b += (x[i] - mx) ** 2; d += (y[i] - my) ** 2; } return a / Math.sqrt(b * d); };
const sp = (x, y) => pear(rank(x), rank(y));
const baseCols = names.map((n, j) => (n === 'intercept' || /^cost|^type:|^asp:|^rar:/.test(n) ? j : -1)).filter((j) => j >= 0);
const cv = [];
for (const s of SETS.slice(0, 5)) {
  const tr = pop.map((c, i) => (c.set !== s ? i : -1)).filter((i) => i >= 0), te = pop.map((c, i) => (c.set === s ? i : -1)).filter((i) => i >= 0);
  const live = (idx) => names.map((_, j) => j).filter((j) => j === 0 || idx.some((i) => X[i][j] !== 0));
  const run = (colsIdx) => {
    const ci = colsIdx.filter((j) => live(tr).includes(j) && !names[j].startsWith('set:'));
    const f = ols(tr.map((i) => ci.map((j) => X[i][j])), tr.map((i) => y[i]), ci.map((j) => names[j]));
    const pred = te.map((i) => ci.reduce((acc, j, t) => acc + X[i][j] * f.beta[t], 0));
    return sp(pred, te.map((i) => y[i]));
  };
  const full = run(names.map((_, j) => j)), base = run(baseCols);
  cv.push({ heldOut: s, n: te.length, full, base });
  console.log(`  LOSO held-out ${s} n=${te.length}: rho full=${full.toFixed(3)} baseline(cost+type+aspect${RAR ? '+rarity' : ''})=${base.toFixed(3)}`);
}
writeFileSync(DIR + `play-model.${WINDOW}.${RAR ? 'rarity' : 'norarity'}.out.json`, JSON.stringify({ script: 'play-model.mjs', window: WINDOW, rarity: RAR, n: fit.n, r2: fit.r2, games, coefs: fit.coefs.map((c) => ({ ...c, support: support[c.name] ?? null })), perStat, Tcost, cv }, null, 1));

// ---- T(cost) in stat points with seeded bootstrap CI, and per-card scores with / without T ----
{
  const rnd = mulberry32(3221);
  const ci = names.map((n, j) => j);
  const tIdx = Tcost.map((t) => names.indexOf(`cost${t.cost}${t.cost === 7 ? '+' : ''}`));
  const pI = names.indexOf('powerSurplus'), hI = names.indexOf('hpSurplus');
  const boots = tIdx.map(() => []);
  const ratio = [];
  for (let b = 0; b < 300; b++) {
    const idx = pop.map(() => Math.floor(rnd() * pop.length));
    try {
      const f = ols(idx.map((i) => X[i]), idx.map((i) => y[i]), names);
      const ps = (f.beta[pI] + f.beta[hI]) / 2;
      tIdx.forEach((j, t) => j >= 0 && boots[t].push(f.beta[j] / ps));
      ratio.push(f.beta[pI] / f.beta[hI]);
    } catch { /* singular resample */ }
  }
  const q = (a, p) => a.slice().sort((x, z) => x - z)[Math.floor(p * a.length)];
  const T = Tcost.map((t, k) => (tIdx[k] < 0 ? { cost: t.cost, T: null } : { cost: t.cost, T: t.logIncl.b / perStat, lo: q(boots[k], 0.025), hi: q(boots[k], 0.975), boots: boots[k].length }));
  console.log('\n  T(cost) in stat points (relative to cost 2), seeded bootstrap 95% CI:');
  for (const t of T) if (t.T != null) console.log(`    cost ${t.cost}${t.cost === 7 ? '+' : ''}: ${t.T.toFixed(2)} [${t.lo.toFixed(2)}, ${t.hi.toFixed(2)}] (${t.boots} boots)`);
  // Scores: sum of component terms, excluding context fixed effects (set, aspect, rarity) and intercept.
  const comp = names.map((n, j) => (n === 'intercept' || /^set:|^asp:|^rar:/.test(n) ? -1 : j)).filter((j) => j >= 0);
  const isCost = (n) => /^cost/.test(n);
  const scores = pop.map((c, i) => {
    const withT = comp.reduce((s, j) => s + X[i][j] * fit.beta[j], 0) / perStat;
    const noT = comp.filter((j) => !isCost(names[j])).reduce((s, j) => s + X[i][j] * fit.beta[j], 0) / perStat;
    return { title: c.title, subtitle: c.subtitle, set: c.set, serialCode: c.serialCode, type: c.type, cost: c.cost, rarity: c.rarity, withT, noT, incRate: (inc.get(ident(c)) ?? 0) / games };
  });
  const rhoT = sp(scores.map((s) => s.withT), scores.map((s) => s.incRate));
  const rhoN = sp(scores.map((s) => s.noT), scores.map((s) => s.incRate));
  console.log(`  in-sample rho with inclusion: with T=${rhoT.toFixed(3)} without T=${rhoN.toFixed(3)}  power/hp play ratio=${(fit.coefs[names.indexOf('powerSurplus')].b / fit.coefs[names.indexOf('hpSurplus')].b).toFixed(2)} [${q(ratio, 0.025).toFixed(2)}, ${q(ratio, 0.975).toFixed(2)}]`);
  const ex = [1, 2, 3, 5, 7].map((k) => scores.filter((s) => s.type === 'Unit' && s.cost === k && s.rarity === 'Common').sort((a, b) => b.incRate - a.incRate)[0]);
  console.log('  examples (most-included Common unit per cost):');
  for (const e of ex) console.log(`    ${e.title}${e.subtitle ? ', ' + e.subtitle : ''} (${e.set} ${e.serialCode}) cost ${e.cost}: noT=${e.noT.toFixed(2)} withT=${e.withT.toFixed(2)} inclusion=${(100 * e.incRate).toFixed(2)}%`);
  const top = scores.slice().sort((a, b) => b.withT - a.withT);
  console.log('  top 10 withT:', top.slice(0, 10).map((s) => `${s.title} (${s.type} ${s.set} c${s.cost}) ${s.withT.toFixed(1)}`).join(' | '));
  writeFileSync(DIR + `play-scores.${WINDOW}.${RAR ? 'rarity' : 'norarity'}.json`, JSON.stringify({ T, rhoT, rhoN, examples: ex, scores }, null, 1));
}

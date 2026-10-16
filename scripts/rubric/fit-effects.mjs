// @pocTriage: becomes the effect-magnitude pricing step of the committed #322 SWU scoring script
// Effect prices with magnitudes and timing splits, on units (stats model, like M1 in fit-units.mjs).
// Each magnitude effect enters as N (damage points, cards drawn, tokens' stats ...), split by
// timing class for the high-support effects. Output in stat points per unit of magnitude.
import { readFileSync, writeFileSync } from 'node:fs';
import { ols, fmt } from './ols.mjs';
import { effectFeatures, keywordFeatures, EFFECTS } from './features.mjs';

const DIR = decodeURIComponent(new URL('../../data/rubric/', import.meta.url).pathname);
const POP = process.argv[2] ?? 'all';
const MAIN_ALL = ['SOR', 'SHD', 'TWI', 'JTL', 'LOF', 'SEC', 'LAW', 'ASH', 'HMW'];
const JTL = ['JTL', 'LOF', 'SEC', 'LAW', 'ASH', 'HMW'];
const MAIN = POP === 'jtl' ? JTL : MAIN_ALL;
// JTL+ mode: a reprint whose canonical set is pre-JTL is fitted in its first JTL+ main set.
const popSet = (c) => (POP !== 'jtl' || JTL.includes(c.set) ? c.set : JTL.find((s) => c.allSets.some((a) => a === s || a === s + 'P')));
const units = JSON.parse(readFileSync(DIR + 'cards.json', 'utf8')).filter((c) => c.type === 'Unit' && c.arenas.length === 1 && c.cost >= 1 && (POP === 'jtl' ? c.jtlPlus : true) && MAIN.includes(popSet(c))).map((c) => ({ ...c, set: popSet(c) }));

const KW = ['Sentinel', 'Ambush', 'Overwhelm', 'Saboteur', 'Shielded', 'Grit', 'Raid', 'Restore', 'Hidden', 'Smuggle', 'Bounty', 'Exploit', 'Coordinate', 'Plot', 'Support'];
const MAG = ['dmgUnit', 'dmgBase', 'dmgEach', 'draw', 'heal', 'search', 'giveExperience', 'giveShield', 'giveAdvantage', 'giveWeakness', 'tokenUnit', 'credit', 'buffTemp', 'buffStatic', 'debuff'];
const SPLIT = ['dmgUnit', 'draw', 'heal', 'giveExperience', 'giveShield', 'exhaust', 'defeatUnit'];
const TCLASS = (t) => (t === 'whenPlayed' ? 'WP' : t === 'onAttack' || t === 'whenPlayedOnAttack' ? 'OA' : t === 'whenDefeated' ? 'WD' : 'other');
const BIN = Object.keys(EFFECTS).filter((e) => !MAG.includes(e) && !SPLIT.includes(e) && e !== 'selfKeywordConditional');

// Per-line magnitude by timing: re-run effectFeatures line by line.
function lineFeatures(text) {
  const per = {};
  for (const line of (text ?? '').split(/\n+/)) {
    const f = effectFeatures(line);
    const t = Object.keys(f.timing).find((k) => k.startsWith('t:'))?.slice(2);
    for (const [e, v] of Object.entries(f.eff)) {
      const key = SPLIT.includes(e) ? `${e}@${TCLASS(t)}` : e;
      per[key] = (per[key] ?? 0) + (MAG.includes(e) ? v : 1);
    }
  }
  return per;
}

const rows = units.map((c) => {
  const kf = keywordFeatures(c), ef = effectFeatures(c.text), lf = lineFeatures(c.text);
  const f = {};
  for (const k of KW) { f[`kw:${k}`] = kf[k]?.printed ? 1 : 0; f[`kwCond:${k}`] = kf[k] && !kf[k].printed ? 1 : 0; }
  f['kwCond:Piloting'] = kf.Piloting ? 1 : 0;
  for (const k of ['Raid', 'Restore', 'Exploit']) f[`kwN:${k}`] = kf[k]?.printed ? kf[k].n - 1 : 0;
  for (const e of MAG) if (!SPLIT.includes(e)) f[`mag:${e}`] = lf[e] ?? 0;
  for (const e of SPLIT) for (const t of ['WP', 'OA', 'WD', 'other']) f[`${MAG.includes(e) ? 'mag' : 'fx'}:${e}@${t}`] = lf[`${e}@${t}`] ?? 0;
  for (const e of BIN) f[`fx:${e}`] = ef.eff[e] ? 1 : 0;
  f.abilityLines = ef.abilityLines;
  f.unmatchedLines = ef.abilityLines - ef.matchedLines;
  f.aspectCount = c.aspects.length;
  f.space = c.arenas[0] === 'Space' ? 1 : 0;
  f.unique = c.unique ? 1 : 0;
  return f;
});
const all = Object.keys(rows[0]);
const support = Object.fromEntries(all.map((k) => [k, rows.filter((r) => r[k]).length]));
const cols = all.filter((k) => support[k] >= 5);
const costD = [2, 3, 4, 5, 6, 7, 8], setD = MAIN.slice(1);
const names = ['intercept', ...costD.map((d) => `cost${d}`), ...cols, ...setD.map((s) => `set:${s}`)];
const X = units.map((c, i) => [1, ...costD.map((d) => (d === 8 ? +(c.cost >= 8) : +(c.cost === d))), ...cols.map((k) => rows[i][k]), ...setD.map((s) => +(c.set === s))]);
const r = ols(X, units.map((c) => c.power + c.hp), names);
console.log(`M4 effects-with-magnitude stats model n=${r.n} k=${r.k} r2=${r.r2.toFixed(3)} rmse=${r.rmse.toFixed(2)}`);
console.log('dropped (<5):', all.filter((k) => support[k] < 5).map((k) => `${k}(${support[k]})`).join(' '));
for (const c of r.coefs) console.log(`  ${c.name.padEnd(28)} ${fmt(c)}${support[c.name] != null ? `  n=${support[c.name]}` : ''}`);
writeFileSync(DIR + 'fit-effects' + (POP === 'jtl' ? '.jtl' : '') + '.out.json', JSON.stringify({ script: 'fit-effects.mjs', n: r.n, r2: r.r2, rmse: r.rmse, residuals: units.map((c, i) => ({ serialCode: c.serialCode, title: c.title, resid: r.resid[i] })), coefs: r.coefs.map((c) => ({ ...c, support: support[c.name] ?? null })) }, null, 1));

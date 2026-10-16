// @pocTriage: becomes the event/upgrade/leader/base pricing step of the committed #322 SWU scoring script
// Revealed prices for non-unit card types.
//  E1 events  : cost ~ effect magnitudes/indicators (an event's whole cost is its effect)
//  U1 upgrades: cost ~ upgradePower + upgradeHp + granted keywords + effects
//  L1 leaders : leader-unit power+hp ~ deploy threshold (epic action "control N or more resources")
//  B1 bases   : HP by rarity / text / epic action
// Usage: node fit-other.mjs [all|jtl]
import { readFileSync, writeFileSync } from 'node:fs';
import { ols, fmt } from './ols.mjs';
import { effectFeatures, EFFECTS, clean } from './features.mjs';

const DIR = decodeURIComponent(new URL('../../data/rubric/', import.meta.url).pathname);
const POP = process.argv[2] ?? 'all';
const MAIN = ['SOR', 'SHD', 'TWI', 'JTL', 'LOF', 'SEC', 'LAW', 'ASH', 'HMW'];
const all = JSON.parse(readFileSync(DIR + 'cards.json', 'utf8'));
const inPop = (c) => (POP === 'jtl' ? c.jtlPlus : MAIN.includes(c.set) || c.jtlPlus);
const out = { script: 'fit-other.mjs', pop: POP };
const log = console.log;

const MAGS = new Set(['dmgUnit', 'dmgBase', 'dmgEach', 'draw', 'heal', 'search', 'giveExperience', 'giveShield', 'giveAdvantage', 'giveWeakness', 'tokenUnit', 'credit', 'buffTemp', 'buffStatic', 'debuff']);
function design(cards, extra) {
  const rows = cards.map((c) => {
    const ef = effectFeatures(c.text);
    const f = {};
    for (const e of Object.keys(EFFECTS)) if (e !== 'selfKeywordConditional') f[MAGS.has(e) ? `mag:${e}` : `fx:${e}`] = MAGS.has(e) ? ef.eff[e] ?? 0 : ef.eff[e] ? 1 : 0;
    f.abilityLines = ef.abilityLines;
    f.unmatchedLines = ef.abilityLines - ef.matchedLines;
    f.aspectCount = c.aspects.length;
    f.unique = c.unique ? 1 : 0;
    Object.assign(f, extra(c));
    return f;
  });
  const keys = Object.keys(rows[0]);
  const support = Object.fromEntries(keys.map((k) => [k, rows.filter((r) => r[k]).length]));
  const cols = keys.filter((k) => support[k] >= 4);
  return { X: rows.map((r) => [1, ...cols.map((k) => r[k])]), names: ['intercept', ...cols], support };
}
function report(tag, cards, y, extra) {
  const { X, names, support } = design(cards, extra);
  const r = ols(X, y, names);
  out[tag] = { n: r.n, r2: r.r2, rmse: r.rmse, residuals: cards.map((c, i) => ({ serialCode: c.serialCode, title: c.title, resid: r.resid[i] })), coefs: r.coefs.map((c) => ({ ...c, support: support[c.name] ?? null })) };
  log(`\n${tag} n=${r.n} r2=${r.r2.toFixed(3)} rmse=${r.rmse.toFixed(2)}`);
  for (const c of r.coefs) log(`  ${c.name.padEnd(24)} ${fmt(c)}${support[c.name] != null ? `  n=${support[c.name]}` : ''}`);
}

// E1 events
const events = all.filter((c) => c.type === 'Event' && inPop(c) && c.cost != null);
report('E1_events', events, events.map((c) => c.cost), (c) => ({
  plot: /^Plot/m.test(c.text) ? 1 : 0,
  smuggle: /Smuggle \[/.test(c.text) ? 1 : 0,
  multiAspect: c.aspects.filter((a) => a !== 'Heroism' && a !== 'Villainy').length >= 2 ? 1 : 0,
}));

// U1 upgrades (non-token)
const ups = all.filter((c) => c.type === 'Upgrade' && inPop(c) && c.cost != null);
report('U1_upgrades', ups, ups.map((c) => c.cost), (c) => ({
  upgradePower: c.upgradePower ?? 0,
  upgradeHp: c.upgradeHp ?? 0,
  fortify: c.keywords.includes('Fortify') || /^Fortify/m.test(c.text) ? 1 : 0,
  grantsKeyword: /Attached unit gains (?:Sentinel|Ambush|Raid|Overwhelm|Saboteur|Restore|Grit|Hidden|Shielded)/i.test(clean(c.text)) ? 1 : 0,
  grantsAbility: /Attached unit gains:? ["“]/i.test(c.text) ? 1 : 0,
  restricted: /^Attach to a(?:n)? (?:non-|friendly|unit with|ground|space|[A-Z])/m.test(c.text) ? 1 : 0,
}));

// L1 leaders
const leaders = all.filter((c) => c.type === 'Leader' && inPop(c));
const deployN = (c) => +((c.epicAction.match(/control\s+(\d+)\s+or\s+more\s+resources/) ?? [])[1] ?? NaN);
const lrows = leaders.filter((c) => Number.isFinite(deployN(c)) && c.power != null && c.hp != null);
{
  const X = lrows.map((c) => [1, deployN(c), c.arenas.includes('Space') ? 1 : 0]);
  const r = ols(X, lrows.map((c) => c.power + c.hp), ['intercept', 'deployN', 'spaceLeader']);
  out.L1_leaders = { n: r.n, r2: r.r2, rmse: r.rmse, coefs: r.coefs, residuals: lrows.map((c, i) => ({ serialCode: c.serialCode, title: c.title, resid: r.resid[i] })) };
  log(`\nL1 leader unit stats ~ deploy threshold n=${r.n} r2=${r.r2.toFixed(3)} rmse=${r.rmse.toFixed(2)}`, r.coefs.map((c) => `${c.name}=${fmt(c)}`).join('  '));
  const byN = {};
  for (const c of lrows) (byN[deployN(c)] ??= []).push(c.power + c.hp);
  out.L1_byN = Object.fromEntries(Object.entries(byN).map(([n, v]) => [n, { n: v.length, mean: v.reduce((a, b) => a + b, 0) / v.length }]));
  log('  stats by deploy N:', JSON.stringify(out.L1_byN));
  out.L1_noThreshold = leaders.filter((c) => !Number.isFinite(deployN(c))).map((c) => `${c.set} ${c.title}: ${c.epicAction.slice(0, 80)}`);
  log('  leaders without a numeric deploy threshold:', out.L1_noThreshold.length, out.L1_noThreshold.slice(0, 8));
  const leaderActionCost = leaders.map((c) => (c.text.match(/Action \[([^\]]*)\]/) ?? [])[1] ?? '(none)');
  const cnt = {};
  for (const a of leaderActionCost) cnt[a] = (cnt[a] ?? 0) + 1;
  out.L1_actionCosts = cnt;
  log('  leader-side Action costs:', JSON.stringify(cnt));
}

// B1 bases
const bases = all.filter((c) => c.type === 'Base' && inPop(c));
{
  const g = {};
  for (const b of bases) {
    const k = `${b.rarity}|text=${clean(b.text).trim() ? 1 : 0}|epic=${b.epicAction.trim() ? 1 : 0}`;
    (g[k] ??= []).push(b.hp);
  }
  out.B1_groups = Object.fromEntries(Object.entries(g).sort().map(([k, v]) => [k, { n: v.length, mean: v.reduce((a, b) => a + b, 0) / v.length, min: Math.min(...v), max: Math.max(...v) }]));
  log('\nB1 base HP groups:', JSON.stringify(out.B1_groups, null, 0));
  const X = bases.map((b) => [1, clean(b.text).trim() || b.epicAction.trim() ? 1 : 0, b.rarity === 'Rare' ? 1 : 0]);
  const r = ols(X, bases.map((b) => b.hp), ['intercept', 'hasAbility', 'rare']);
  out.B1 = { n: r.n, r2: r.r2, coefs: r.coefs, residuals: bases.map((c, i) => ({ serialCode: c.serialCode, title: c.title, resid: r.resid[i] })) };
  log('  base hp ~ text/epic:', r.coefs.map((c) => `${c.name}=${fmt(c)}`).join('  '));
}
writeFileSync(DIR + `fit-other${POP === 'jtl' ? '.jtl' : ''}.out.json`, JSON.stringify(out, null, 1));

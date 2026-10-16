// @pocTriage: becomes the snapshot->canonical-card flattening step of the committed #322 SWU scoring script (zod-parsed snapshot in, canonical cards out, replay record)
// Flatten the raw SWU card-list snapshot into one row per printing (printings.json)
// and one row per logical card (cards.json). Deterministic: sorted output, no clock.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SNAP = process.argv[2] ?? '/Volumes/Local Files/Projects/mault/data/swu-originals/2026-10-16/swu-cards/raw-pages';
const OUT = decodeURIComponent(new URL('../../data/rubric/', import.meta.url).pathname);
mkdirSync(OUT, { recursive: true });
// Release order from packages/shared/src/adapters/swu/set-rotation.ts:12-22
const RELEASE = { SOR: 1, SHD: 2, TWI: 3, JTL: 4, LOF: 5, SEC: 6, LAW: 7, ASH: 8, HMW: 9 };
const rel = (s) => RELEASE[s] ?? 99;

const names = (r) => (r?.data ?? []).map((d) => d.attributes?.name).filter(Boolean);
const one = (r) => r?.data?.attributes?.name ?? null;

const printings = [];
for (const f of readdirSync(SNAP).filter((n) => /^page-\d+\.json$/.test(n)).sort()) {
  const j = JSON.parse(readFileSync(join(SNAP, f), 'utf8'));
  for (const d of j.data) {
    const a = d.attributes;
    printings.push({
      id: d.id,
      serialCode: a.serialCode,
      cardUid: a.cardUid ?? null,
      title: a.title,
      subtitle: a.subtitle ?? '',
      cost: a.cost,
      power: a.power,
      hp: a.hp,
      upgradePower: a.upgradePower,
      upgradeHp: a.upgradeHp,
      unique: !!a.unique,
      type: one(a.type),
      type2: one(a.type2),
      rarity: one(a.rarity),
      set: a.expansion?.data?.attributes?.code ?? null,
      aspects: names(a.aspects),
      aspectDuplicates: names(a.aspectDuplicates),
      traits: names(a.traits),
      arenas: names(a.arenas),
      keywords: names(a.keywords),
      variantTypes: names(a.variantTypes),
      variantOf: a.variantOf?.data?.id ?? null,
      reprintOf: a.reprintOf?.data?.id ?? null,
      text: a.text ?? '',
      deployBox: a.deployBox ?? '',
      epicAction: a.epicAction ?? '',
    });
  }
}
printings.sort((x, y) => x.id - y.id);
writeFileSync(join(OUT, 'printings.json'), JSON.stringify(printings));

// Owner rule: canonical printing = neither variantOf nor reprintOf. A logical card whose
// rows are all reprints/variants (orphan chain) falls back to earliest release order,
// then lowest serialCode. Logical identity for the orphan check = title|subtitle|type.
const ident = (p) => [p.title, p.subtitle, p.type].join('|');
const canon = printings.filter((p) => p.variantOf == null && p.reprintOf == null);
const have = new Set(canon.map(ident));
const orphans = new Map();
for (const p of printings) {
  if (have.has(ident(p))) continue;
  const prev = orphans.get(ident(p));
  if (!prev || rel(p.set) < rel(prev.set) || (rel(p.set) === rel(prev.set) && p.serialCode < prev.serialCode)) orphans.set(ident(p), p);
}
const ordered = [...canon, ...orphans.values()].sort((x, y) => rel(x.set) - rel(y.set) || (x.serialCode < y.serialCode ? -1 : 1));
// Second pass: the API leaves some reprints unlinked (e.g. ASH Consortium StarViper = SOR 0101112,
// no reprintOf) and IBH repeats cards inside one product. Collapse identical gameplay identity,
// keeping the first row in release order (so a reprint counts only in its original set).
const gameplay = (p) => [ident(p), p.cost, p.power, p.hp, p.upgradePower, p.upgradeHp, p.aspects.join('+'), p.text.replace(/\s+/g, ' ').trim()].join('|');
const seen = new Map();
const unlinked = [];
for (const p of ordered) {
  if (seen.has(gameplay(p))) { seen.get(gameplay(p)).alsoIn.push(p.set); unlinked.push(`${p.set}:${p.serialCode} ${p.title}`); continue; }
  seen.set(gameplay(p), { ...p, alsoIn: [] });
}
// Owner scope (2026-10-16): score only logical cards with any printing in JTL or later, or in
// those sets' Weekly Play sets (current Premier pool, set-rotation.ts:9). Linked by title|subtitle|type.
const JTL_PLUS = new Set(['JTL', 'JTLP', 'LOF', 'LOFP', 'SEC', 'SECP', 'LAW', 'LAWP', 'ASH', 'ASHP', 'HMW', 'HMWP']);
const setsByIdent = new Map();
for (const p of printings) (setsByIdent.get(ident(p)) ?? setsByIdent.set(ident(p), new Set()).get(ident(p))).add(p.set);
const cards = [...seen.values()].map((c) => ({ ...c, allSets: [...setsByIdent.get(ident(c))].sort(), jtlPlus: [...setsByIdent.get(ident(c))].some((s) => JTL_PLUS.has(s)) }));
console.log('jtlPlus cards:', cards.filter((c) => c.jtlPlus).length, 'of', cards.length, '; jtlPlus with canonical set before JTL:', cards.filter((c) => c.jtlPlus && rel(c.set) < 4).map((c) => `${c.set} ${c.title}`).join(', '));
writeFileSync(join(OUT, 'cards.json'), JSON.stringify(cards));
console.log('collapsed unlinked reprints/duplicates:', unlinked.length, unlinked.filter((u) => !/^IBH|^TS26|^IC27/.test(u)).slice(0, 40));

const count = (arr, f) => arr.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
console.log({ printings: printings.length, canonical: canon.length, orphanFallback: orphans.size, cards: cards.length });
console.log('dup identities among canonical:', canon.length - new Set(canon.map(ident)).size);
console.log('sets(cards):', count(cards, (c) => c.set));
console.log('types:', count(cards, (c) => c.type + (c.type2 ? '/' + c.type2 : '')));
console.log('variantTypes of canonical:', count(canon, (c) => c.variantTypes.join('+')));

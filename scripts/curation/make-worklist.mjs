// Deterministic worklist of unclassified clauses for curated-entry authoring.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
const [featuresPath, outDir, batches] = [process.argv[2], process.argv[3], Number(process.argv[4] ?? 4)];
const cards = JSON.parse(fs.readFileSync(featuresPath, "utf8"));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const items = [];
const effectCats = new Set(), conditionCats = new Set(), offers = new Set(), wants = new Set(), triggers = new Set();
for (const c of cards) {
  for (const t of c.offers ?? []) offers.add(t);
  for (const t of c.wants ?? []) wants.add(t);
  for (const [, paras] of Object.entries(c.faces ?? {})) for (const p of paras) {
    for (const t of p.triggers ?? []) triggers.add(t.trigger);
    for (const cl of p.clauses ?? []) {
      for (const e of cl.effects ?? []) effectCats.add(e.cat);
      for (const e of cl.conditions ?? []) conditionCats.add(e.cat);
    }
  }
  if (!(c.unclassified ?? []).length) continue;
  const faces = {};
  for (const [face, paras] of Object.entries(c.faces ?? {})) faces[face] = paras.map((p) => ({
    triggers: (p.triggers ?? []).map((t) => t.text),
    clauses: (p.clauses ?? []).map((cl) => ({ path: cl.path, text: cl.text, source: cl.source, effects: cl.effects, conditions: cl.conditions, structure: cl.structure })),
  }));
  items.push({
    cardKey: c.cardKey, title: c.title, subtitle: c.subtitle, type: c.type, structured: c.structured, keywords: c.keywords,
    currentOffers: c.offers ?? [], currentWants: c.wants ?? [],
    unclassified: c.unclassified.map((u) => ({ face: u.face, path: u.path, sourceClause: u.text, clauseSha256: crypto.createHash("sha256").update(u.text).digest("hex") })),
    parsedFaces: faces,
  });
}
items.sort((a, b) => cmp(a.cardKey, b.cardKey));
const vocab = {
  effectCats: [...effectCats].sort(cmp), conditionCats: [...conditionCats].sort(cmp), triggers: [...triggers].sort(cmp),
  offers: [...offers].sort(cmp), wants: [...wants].sort(cmp),
};
fs.writeFileSync(path.join(outDir, "vocab.json"), JSON.stringify(vocab, null, 1));
const per = Math.ceil(items.length / batches);
for (let i = 0; i < batches; i++) fs.writeFileSync(path.join(outDir, `worklist-${i + 1}.json`), JSON.stringify(items.slice(i * per, (i + 1) * per), null, 1));
console.log(JSON.stringify({ cards: items.length, clauses: items.reduce((n, x) => n + x.unclassified.length, 0), perBatch: per, vocab: Object.fromEntries(Object.entries(vocab).map(([k, v]) => [k, v.length])) }));

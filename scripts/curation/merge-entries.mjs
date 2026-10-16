// Deterministic merge of curator batches into curated-rules.json (tableVersion bump).
import fs from "node:fs";
import crypto from "node:crypto";
const [basePath, glossaryPath, outPath, ...batchPaths] = process.argv.slice(2);
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const base = JSON.parse(fs.readFileSync(basePath, "utf8"));
const glossary = JSON.parse(fs.readFileSync(glossaryPath, "utf8"));
const traitByLower = new Map(glossary.facets.trait.map((t) => [t.value.toLowerCase().replace(/\s+/g, "-"), t.value]));
const unknownTraits = new Set();
const fixTag = (tag) => {
  const m = /^(wants:trait-|offers:is-trait-)(.+)$/.exec(tag);
  if (!m) return tag;
  const canon = traitByLower.get(m[2].toLowerCase().replace(/\s+/g, "-"));
  if (!canon) { unknownTraits.add(m[2]); return tag; }
  return m[1] + canon;
};
const seen = new Set(base.entries.map((e) => `${e.cardKey}|${e.face}|${e.clauseSha256}`));
const added = [];
for (const p of batchPaths) {
  for (const e of JSON.parse(fs.readFileSync(p, "utf8")).entries) {
    if (sha(e.sourceClause) !== e.clauseSha256) throw new Error(`hash mismatch ${e.cardKey} ${e.face}`);
    const key = `${e.cardKey}|${e.face}|${e.clauseSha256}`;
    if (seen.has(key)) throw new Error(`duplicate ${key}`);
    seen.add(key);
    const f = e.features ?? {};
    added.push({ ...e, features: { ...f, offers: [...new Set((f.offers ?? []).map(fixTag))].sort(cmp), wants: [...new Set((f.wants ?? []).map(fixTag))].sort(cmp) } });
  }
}
added.sort((a, b) => cmp(a.cardKey, b.cardKey) || cmp(a.face, b.face) || cmp(a.clauseSha256, b.clauseSha256));
let next = base.entries.length + 1;
const withIds = added.map(({ id, ...rest }) => ({ id: `cur-${String(next++).padStart(4, "0")}`, ...rest }));
const out = { ...base, tableVersion: base.tableVersion + 1, entries: [...base.entries, ...withIds] };
fs.writeFileSync(outPath, JSON.stringify(out, null, 1) + "\n");
const conf = withIds.reduce((m, e) => ((m[e.confidence ?? "unset"] = (m[e.confidence ?? "unset"] ?? 0) + 1), m), {});
const newVocab = withIds.flatMap((e) => (e.newVocab ?? []).map((v) => `${e.cardKey} ${e.title}: ${v}`));
console.log(JSON.stringify({ base: base.entries.length, added: withIds.length, total: out.entries.length, tableVersion: out.tableVersion, confidence: conf, unknownTraits: [...unknownTraits].sort(cmp), newVocabCount: newVocab.length, outSha256: sha(fs.readFileSync(outPath)) }, null, 1));
fs.writeFileSync(outPath.replace(/\.json$/, ".new-vocab.txt"), newVocab.join("\n") + "\n");

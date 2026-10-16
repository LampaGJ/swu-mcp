// For each effect/condition/structure cat, required keys = keys present on every grammar occurrence; flag curated entries missing them.
import fs from "node:fs";
const [featuresPath, tablePath] = process.argv.slice(2);
const cards = JSON.parse(fs.readFileSync(featuresPath, "utf8"));
const req = {};
const note = (kind, o) => { const k = `${kind}:${o.cat}`; const keys = new Set(Object.keys(o)); req[k] = req[k] ? new Set([...req[k]].filter((x) => keys.has(x))) : keys; };
for (const c of cards) for (const paras of Object.values(c.faces ?? {})) for (const p of paras) for (const cl of p.clauses ?? []) {
  if (cl.source !== "grammar") continue;
  for (const e of cl.effects ?? []) note("effects", e);
  for (const e of cl.conditions ?? []) note("conditions", e);
  for (const e of cl.structure ?? []) note("structure", e);
}
const table = JSON.parse(fs.readFileSync(tablePath, "utf8"));
const problems = [];
for (const e of table.entries) for (const kind of ["effects", "conditions", "structure"]) for (const o of e.features?.[kind] ?? []) {
  const need = req[`${kind}:${o.cat}`];
  if (!need) continue;
  const missing = [...need].filter((k) => !(k in o) && k !== "rule");
  if (missing.length) problems.push(`${e.id} ${e.title} ${kind}.${o.cat} missing ${missing.join(",")}`);
}
console.log(problems.length + " problems"); console.log(problems.join("\n"));
console.log("required keys per cat used by grammar:"); for (const [k, v] of Object.entries(req).sort()) if (v.size > 2) console.log(" ", k, [...v].join(","));

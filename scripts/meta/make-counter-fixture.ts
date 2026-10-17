/**
 * Regenerates tests/meta/counter-cards.json: the feature records of every example card named in data/counters.json,
 * copied verbatim from a built run and filtered by cardKey, so the counter tests run on real parsed cards.
 * Usage: tsx scripts/meta/make-counter-fixture.ts [run dir]
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { readJson, resolveDataDir } from "../../src/data.js";
import { loadCounterTable } from "../../src/meta/counters.js";
import { REPO_ROOT } from "../../src/paths.js";
import { compareCodePoints } from "../../src/swu/canonical.js";

const run = path.resolve(process.argv[2] ?? resolveDataDir());
const table = loadCounterTable();
const keys = [...new Set(table.relations.map((r) => r.example.cardKey))].sort(compareCodePoints);
const features = readJson(path.join(run, "features/features.json")) as { cardKey: string }[];
const cards = keys.map((key) => {
  const card = features.find((c) => c.cardKey === key);
  if (card === undefined) throw new Error(`example cardKey ${key} is not in ${run}/features/features.json`);
  return card;
});
const out = path.join(REPO_ROOT, "tests/meta/counter-cards.json");
writeFileSync(
  out,
  `${JSON.stringify({ source: `${path.basename(run)}/features/features.json, the example cards of data/counters.json v${table.tableVersion}; copied verbatim, filtered by cardKey`, cards }, null, 1)}\n`,
);
console.log(`${cards.length} cards -> ${path.relative(REPO_ROOT, out)}`);

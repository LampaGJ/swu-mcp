/**
 * Regenerates tests/fixtures/llm/ from a built data package: a handful of real cards, with facet
 * indexes rebuilt by the same code the package uses. Usage: tsx scripts/make-test-fixture.ts [package dir]
 */
import { decode } from "@toon-format/toon";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataDir } from "../src/data.js";
import { buildFacetIndexes, buildNameIndex, encodeToonTable, swuGlossarySchema, type FlatRow } from "../src/swu/llm-flatten.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEYS = ["0101030", "0101033", "0101070", "0101074", "0101165", "04010001", "04010087", "09010004", "09010218"];

const source = path.resolve(process.argv[2] ?? resolveDataDir());
const llm = path.join(source, "llm");
const all = (decode(readFileSync(path.join(llm, "cards.toon"), "utf8")) as { cards: FlatRow[] }).cards;
const picked = KEYS.map((key) => {
  const row = all.find((card) => card.cardKey === key);
  if (row === undefined) throw new Error(`cardKey ${key} not in ${llm}`);
  return row;
});
const glossary = swuGlossarySchema.parse(JSON.parse(readFileSync(path.join(REPO_ROOT, "docs/concepts/swu-glossary.json"), "utf8")));

const out = path.join(REPO_ROOT, "tests/fixtures/llm");
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "index"), { recursive: true });
writeFileSync(path.join(out, "cards.toon"), encodeToonTable("cards", picked));
writeFileSync(path.join(out, "index/names.toon"), encodeToonTable("names", buildNameIndex(picked)));
for (const index of buildFacetIndexes(picked, glossary))
  writeFileSync(path.join(out, "index", `${index.facet}.toon`), encodeToonTable(index.facet, index.rows));
console.log(`fixture: ${picked.length} cards -> ${out}`);

/**
 * Regenerates tests/fixtures/{llm,features,scores,market}/ from a built data package: a handful of real cards, with facet
 * indexes rebuilt by the same code the package uses, their feature vectors, and scores from the committed coefficients.
 * Usage: tsx scripts/make-test-fixture.ts [package dir]
 */
import { decode } from "@toon-format/toon";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveDataDir } from "../src/data.js";
import { playFileSchema, pricesFileSchema } from "../src/market/build.js";
import { runScoring } from "../src/scorer/run.js";
import { swuCardFeaturesFileSchema } from "../src/schemas/card-features.js";
import { buildFacetIndexes, buildNameIndex, encodeToonTable, swuGlossarySchema, type FlatRow } from "../src/swu/llm-flatten.js";
import { REPO_ROOT } from "../src/paths.js";

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

const features = swuCardFeaturesFileSchema.parse(JSON.parse(readFileSync(path.join(source, "features/features.json"), "utf8")));
const fixtureRoot = path.join(REPO_ROOT, "tests/fixtures");
mkdirSync(path.join(fixtureRoot, "features"), { recursive: true });
const pickedFeatures = KEYS.map((key) => {
  const card = features.find((candidate) => candidate.cardKey === key);
  if (card === undefined) throw new Error(`cardKey ${key} not in features.json`);
  return card;
});
writeFileSync(path.join(fixtureRoot, "features/features.json"), `${JSON.stringify(pickedFeatures, null, 1)}\n`);
copyFileSync(path.join(source, "features/replay.json"), path.join(fixtureRoot, "features/replay.json"));
const scoring = runScoring(fixtureRoot, readFileSync(path.join(REPO_ROOT, "data/rubric-coefficients.json"), "utf8"), "fixture");
mkdirSync(path.join(fixtureRoot, "scores"), { recursive: true });
writeFileSync(path.join(fixtureRoot, "scores/scores.json"), scoring.scoresText);
writeFileSync(path.join(fixtureRoot, "scores/replay.json"), scoring.replayText);
console.log(`fixture: features and scores for ${KEYS.length} cards -> ${fixtureRoot}`);

const marketOut = path.join(fixtureRoot, "market");
mkdirSync(marketOut, { recursive: true });
const keep = new Set(KEYS);
const prices = pricesFileSchema.parse(JSON.parse(readFileSync(path.join(source, "market/prices.json"), "utf8")));
const play = playFileSchema.parse(JSON.parse(readFileSync(path.join(source, "market/play.json"), "utf8")));
writeFileSync(path.join(marketOut, "prices.json"), `${JSON.stringify({ ...prices, cards: prices.cards.filter((c) => keep.has(c.cardKey)) })}\n`);
writeFileSync(path.join(marketOut, "play.json"), `${JSON.stringify({ ...play, cards: play.cards.filter((c) => keep.has(c.cardKey)) })}\n`);
console.log(`fixture: market slice -> ${marketOut}`);

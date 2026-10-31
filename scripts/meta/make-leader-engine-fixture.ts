/**
 * Regenerates tests/synergy/leader-engine-cards.json: the feature records of the cards the leader-engine tests read
 * (The Warrior, Deft Duelist and the partners and substitutes of decision D60), copied verbatim from a built run and
 * filtered by cardKey, so the tests run on real parsed cards.
 * Usage: tsx scripts/meta/make-leader-engine-fixture.ts [run dir]
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { readJson, resolveDataDir } from "../../src/data.js";
import { REPO_ROOT } from "../../src/paths.js";
import { compareCodePoints } from "../../src/swu/canonical.js";

const KEYS = [
  "09010018", // The Warrior, Deft Duelist: plays a unit with 3 or less power from hand and gives it Ambush
  "09010225", // Boba Fett, Family Found: keys on a friendly unit with Ambush
  "05010105", // Oppo Rancisis: copies keywords from the board
  "05010190", // Anakin Skywalker, Force Prodigy: a 1-drop
  "06010188", // Darth Traya, Lord of Betrayal: readies a non-unit leader
  "09010117", // Chewbacca, Resourceful Wookiee
  "09010212", // The Chieftain, Here Since the Oceans Dried
  "09010254", // a Raid unit of the reference deck
  "09010024", // Origin Tree
  "09010028", // Jundland Wastes
].sort(compareCodePoints);

const run = path.resolve(process.argv[2] ?? resolveDataDir());
const features = readJson(path.join(run, "features/features.json")) as { cardKey: string }[];
const cards = KEYS.map((key) => {
  const card = features.find((c) => c.cardKey === key);
  if (card === undefined) throw new Error(`cardKey ${key} is not in ${run}/features/features.json`);
  return card;
});
const out = path.join(REPO_ROOT, "tests/synergy/leader-engine-cards.json");
writeFileSync(out, `${JSON.stringify({ source: `${path.basename(run)}/features/features.json; copied verbatim, filtered by cardKey`, cards }, null, 1)}\n`);
console.log(`${cards.length} cards -> ${path.relative(REPO_ROOT, out)}`);

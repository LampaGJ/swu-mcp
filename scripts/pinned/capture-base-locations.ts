/**
 * @displayName Base location capture script
 * @strategicPurpose The one place the engine's card files are read for base locations (#150, D59). The official
 * API ships bases with empty traits, so the location a clause names is captured once, hashed and pinned.
 * @tacticalObjective Reads <engine>/test/json/Card/*.json (never written to), maps each base to our cardKey by
 * printing, and writes data/pinned/base-locations/forceteki-<hash12>.json plus a .manifest.json carrying the file
 * sha256, the engine commit, the engine card-data hash and the card table's sha256. Refuses to replace a file
 * whose bytes differ; a changed source has a different card-data hash and so a new file name.
 *
 * Usage: tsx scripts/pinned/capture-base-locations.ts --engine <forceteki clone> [--data <package dir>] [--out <dir>]
 *   --data  default: the newest run under data/runs (its llm/cards.toon is the card table)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadStore, resolveDataDir } from "../../src/data.js";
import { REPO_ROOT } from "../../src/paths.js";
import { baseLocationsFileSchema, baseLocationsManifestSchema } from "../../src/schemas/base-locations.js";
import { hex64 } from "../../src/schemas/hash.js";
import { captureBaseLocations } from "../../src/swu/base-locations-capture.js";
import { compareCodePoints, sha256Hex } from "../../src/swu/canonical.js";

const json = (value: unknown): string => `${JSON.stringify(value, null, 1)}\n`;

function main(): void {
  const { values } = parseArgs({ options: { engine: { type: "string" }, data: { type: "string" }, out: { type: "string" } } });
  if (values.engine === undefined) throw new Error("give --engine <path to the forceteki clone>");
  const engine = path.resolve(values.engine);
  const outDir = path.resolve(values.out ?? path.join(REPO_ROOT, "data/pinned/base-locations"));
  const dataDir = path.resolve(values.data ?? resolveDataDir());

  const cardDataHash = hex64.parse(readFileSync(path.join(engine, "test/json/card-data-hash.txt"), "utf8").trim());
  const engineCommit = z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .parse(execFileSync("git", ["-C", engine, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  const cardsDir = path.join(engine, "test/json/Card");
  const files = readdirSync(cardsDir)
    .filter((f) => f.endsWith(".json"))
    .sort(compareCodePoints);
  const engineCards = files.map((f) => JSON.parse(readFileSync(path.join(cardsDir, f), "utf8")) as unknown);

  const store = loadStore(dataDir);
  const llm = existsSync(path.join(dataDir, "llm")) ? path.join(dataDir, "llm") : dataDir;
  const cardTableSha256 = sha256Hex(readFileSync(path.join(llm, "cards.toon")));
  const result = captureBaseLocations(engineCards, store);

  const text = json(baseLocationsFileSchema.parse({ source: "forceteki", cardDataHash, rows: result.rows }));
  const name = `forceteki-${cardDataHash.slice(0, 12)}.json`;
  const manifest = baseLocationsManifestSchema.parse({
    file: name,
    sha256: sha256Hex(text),
    source: "forceteki",
    engineCommit,
    cardDataHash,
    cardTableSha256,
    engineBases: result.engineBases,
    mappedBases: result.rows.length,
    engineBasesNotInCardTable: result.engineBasesNotInCardTable,
  });
  const manifestName = name.replace(/\.json$/, ".manifest.json");
  mkdirSync(outDir, { recursive: true });
  for (const [fileName, content] of [
    [name, text],
    [manifestName, json(manifest)],
  ] as const) {
    const target = path.join(outDir, fileName);
    if (existsSync(target) && readFileSync(target, "utf8") !== content) {
      throw new Error(`${target} exists with different bytes: a changed source has a new card-data hash and so a new file name; investigate, do not overwrite`);
    }
    writeFileSync(target, content);
  }
  console.log(JSON.stringify({ outDir, ...manifest }, null, 1));
}

main();

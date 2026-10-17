/**
 * Seeded evidence packet of the pairings only, for re-measuring pairing accuracy after a matcher change
 * (LampaGJ/swu-mcp#12). It reuses the packet builder of sample.ts, so a pair is presented exactly as in the
 * full #9 sample (original card text, tags with their `why`, row definitions) and the verdict schema is the same.
 *
 * Usage: tsx scripts/verify/sample-pairs.ts [--originals <dir>] [--run <dir>] [--out <dir>] [--seed <s>] [--date <YYYY-MM-DD>]
 *   --seed  default: verify-pairs-2
 *   --out   default: <repo>/tmp/verify-pairs-2
 * Output: <out>/pairings.json and <out>/index.json. The same seed and inputs give byte-identical files.
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildIndex, buildPackets, loadInputs, serialize } from "./sample.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ORIGINALS_ROOT = "/Volumes/Local Files/Projects/mault/data/swu-originals";

function newestDatedDir(root: string): string {
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
    .map((d) => d.name)
    .sort();
  const newest = dirs.at(-1);
  if (newest === undefined) throw new Error(`no dated directory under ${root}`);
  return path.join(root, newest);
}

function main(): void {
  const { values } = parseArgs({ options: { originals: { type: "string" }, run: { type: "string" }, out: { type: "string" }, seed: { type: "string" }, date: { type: "string" } } });
  const originalsDir = path.resolve(values.originals ?? newestDatedDir(DEFAULT_ORIGINALS_ROOT));
  const date = values.date ?? path.basename(originalsDir);
  const runDir = path.resolve(values.run ?? path.join(REPO_ROOT, "data/runs", date));
  const outDir = path.resolve(values.out ?? path.join(REPO_ROOT, "tmp/verify-pairs-2"));
  const seed = values.seed ?? "verify-pairs-2";
  const packet = buildPackets(loadInputs({ originalsDir, runDir }), seed).find((p) => p.packet === "pairings");
  if (packet === undefined) throw new Error("sample.ts produced no pairings packet");
  mkdirSync(outDir, { recursive: true });
  const text = serialize(packet);
  writeFileSync(path.join(outDir, "pairings.json"), text);
  writeFileSync(path.join(outDir, "index.json"), serialize(buildIndex([packet], seed, new Map([[packet.packet, Buffer.byteLength(text)]]))));
  console.log(`pairings: ${packet.itemCount} items, ${Buffer.byteLength(text)} bytes, seed ${seed}, wrote ${outDir}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();

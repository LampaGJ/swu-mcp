/**
 * @displayName Data release builder
 * @strategicPurpose Manipulation node (LampaGJ/swu-mcp#8): the built run data/runs/<date>/ in, one deterministic
 * tar.gz out (the GitHub Release asset) plus the committed pin src/data-release.json, so the server can verify what
 * it downloads. Same run in, same bytes out.
 * @tacticalObjective Archives only what the server reads (llm, features, scores, synergy, market, rules, similarity)
 * plus the build records (build.json, replay.json, README.md). Entries are sorted by code point; mtime, owner and mode
 * are fixed by tar's portable mode and a fixed mtime; the gzip header carries no time and a fixed OS byte.
 * Prints the `gh release create` command and never runs it.
 *
 * Usage: pnpm release:data [--date <YYYY-MM-DD>] [--data <run dir>] [--out <dir>]
 *   --date  default: newest dated dir under data/runs
 *   --out   default: tmp/release
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import * as tar from "tar";
import { dataReleaseSchema, DATA_RELEASE_PATH } from "../src/data-release.js";
import { REPO_ROOT } from "../src/paths.js";
import { resolveDataDir } from "../src/data.js";
import { buildRecordSchema } from "./lib/build-record.js";
import { compareCodePoints } from "../src/swu/canonical.js";

const REPO = "LampaGJ/swu-mcp";
const SERVER_DIRS = ["docs", "features", "llm", "market", "rules", "scores", "similarity", "synergy"];
const RECORD_FILES = ["README.md", "build.json", "replay.json"];
const FIXED_MTIME = new Date(0);

function walk(root: string, relative: string): string[] {
  const entries = readdirSync(path.join(root, relative), { withFileTypes: true });
  return entries.flatMap((entry) => {
    const child = `${relative}/${entry.name}`;
    return entry.isDirectory() ? walk(root, child) : entry.isFile() ? [child] : [];
  });
}

export function archiveFiles(runDir: string): string[] {
  const files = [...RECORD_FILES, ...SERVER_DIRS.flatMap((dir) => walk(runDir, dir))];
  for (const file of files) statSync(path.join(runDir, file));
  return files.sort(compareCodePoints);
}

/** tar with fixed metadata, then gzip with node's zero mtime and the OS byte pinned to 3 (unix). */
export function buildArchive(runDir: string, files: string[], tarPath: string): Buffer {
  tar.create({ sync: true, file: tarPath, cwd: runDir, portable: true, mtime: FIXED_MTIME, noDirRecurse: true }, files);
  const gz = Buffer.from(gzipSync(readFileSync(tarPath), { level: 9 }));
  gz[9] = 3;
  return gz;
}

const { values } = parseArgs({ options: { date: { type: "string" }, data: { type: "string" }, out: { type: "string" } } });
const runDir = path.resolve(values.data ?? (values.date === undefined ? resolveDataDir({}) : path.join(REPO_ROOT, "data/runs", values.date)));
const build = buildRecordSchema.parse(JSON.parse(readFileSync(path.join(runDir, "build.json"), "utf8")));
const date = build.date;
const outDir = path.resolve(values.out ?? path.join(REPO_ROOT, "tmp/release"));
mkdirSync(outDir, { recursive: true });

const asset = `swu-mcp-data-${date}.tar.gz`;
const tarPath = path.join(outDir, `swu-mcp-data-${date}.tar`);
const files = archiveFiles(runDir);
const archive = buildArchive(runDir, files, tarPath);
rmSync(tarPath);
const assetPath = path.join(outDir, asset);
writeFileSync(assetPath, archive);

const tag = `data-${date}`;
const pin = dataReleaseSchema.parse({
  dataVersion: date,
  tag,
  asset,
  url: `https://github.com/${REPO}/releases/download/${tag}/${asset}`,
  sha256: createHash("sha256").update(archive).digest("hex"),
  bytes: archive.length,
  buildHash: build.buildHash,
});
writeFileSync(DATA_RELEASE_PATH, `${JSON.stringify(pin, null, 2)}\n`);

console.log(`files ${files.length}, sha256 ${pin.sha256}, ${pin.bytes} bytes`);
console.log(`asset ${assetPath}`);
console.log(`pin   ${DATA_RELEASE_PATH}`);
console.log("Commit the pin, then publish the asset (not run by this script):");
console.log(`  gh release create ${tag} "${assetPath}" -R ${REPO} --title "Data ${date}" --notes "Built data for swu-mcp, build hash ${build.buildHash}"`);

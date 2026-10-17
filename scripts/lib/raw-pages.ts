/**
 * @displayName Raw page loader
 * @strategicPurpose Consumer gate for the mault raw card pages: market and the card map read the pages the package
 * was built from, and a page whose bytes drifted from the manifest must fail loudly instead of flowing into outputs.
 * @tacticalObjective Checks the manifest bytes against the package's pinned sha256, then every page's byteLength and
 * sha256 against its manifest entry, then parses and flattens the pages in numeric order.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { flattenPrinting, newFlattenIssues, type FlatRow } from "../../src/swu/llm-flatten.js";
import { swuRawCacheManifestSchema } from "../../src/swu/raw-manifest.js";

const pageSchema = z.object({ data: z.array(z.looseObject({ attributes: z.record(z.string(), z.unknown()) })) });
const replayInputsSchema = z.looseObject({ inputs: z.looseObject({ rawManifestSha256: z.string() }) });

const sha256Bytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The raw manifest sha256 a package's replay.json says it was built from. */
export function packageRawManifestSha256(replayFile: string): string {
  return replayInputsSchema.parse(JSON.parse(readFileSync(replayFile, "utf8"))).inputs.rawManifestSha256;
}

export function loadRawPrintings(pagesDir: string, expectedManifestSha256: string): { printings: FlatRow[]; rawManifestSha256: string } {
  const manifestBytes = readFileSync(path.join(pagesDir, "manifest.json"));
  const rawManifestSha256 = sha256Bytes(manifestBytes);
  if (rawManifestSha256 !== expectedManifestSha256) {
    throw new Error(`${pagesDir}/manifest.json differs from the raw manifest the package was built from`);
  }
  const manifest = swuRawCacheManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  if (!manifest.complete) throw new Error(`raw run in ${pagesDir} is not complete`);
  if (manifest.pageCount !== manifest.pages.length) throw new Error("manifest pageCount disagrees with its pages");

  const issues = newFlattenIssues();
  const printings: FlatRow[] = [];
  for (const entry of [...manifest.pages].sort((a, b) => a.page - b.page)) {
    const name = `page-${String(entry.page).padStart(4, "0")}.json`;
    const body = readFileSync(path.join(pagesDir, name));
    if (body.length !== entry.byteLength) throw new Error(`${name}: byteLength ${body.length} != manifest ${entry.byteLength}`);
    const digest = sha256Bytes(body);
    if (digest !== entry.sha256) throw new Error(`${name}: sha256 ${digest} != manifest ${entry.sha256}`);
    for (const record of pageSchema.parse(JSON.parse(body.toString("utf8"))).data) printings.push(flattenPrinting(record, issues));
  }
  return { printings, rawManifestSha256 };
}

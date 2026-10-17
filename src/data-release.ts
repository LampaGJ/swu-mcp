import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { hex64 } from "./schemas/hash.js";
import { REPO_ROOT } from "./paths.js";

/**
 * @displayName Data release pin
 * @strategicPurpose Seam gate for the committed pin src/data-release.json: the one place that says which GitHub
 * Release asset holds the data this code version expects, and the hash and size it must have.
 * @tacticalObjective Parses the pin with Zod; written by scripts/release-data.ts, read by src/data-source.ts.
 */
export const dataReleaseSchema = z.strictObject({
  dataVersion: z.iso.date(),
  tag: z.string().min(1),
  asset: z.string().min(1),
  url: z.url(),
  sha256: hex64,
  bytes: z.number().int().positive(),
  buildHash: hex64,
});
export type DataRelease = z.infer<typeof dataReleaseSchema>;

export const DATA_RELEASE_PATH = path.join(REPO_ROOT, "src/data-release.json");

export function loadDataRelease(file = DATA_RELEASE_PATH): DataRelease {
  return dataReleaseSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

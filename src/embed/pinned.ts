import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createHash } from "node:crypto";

/**
 * @displayName Pinned embedding capture
 * @strategicPurpose Seam for the captured model output: vectors enter the deterministic pipeline only
 * through this parser, after their bytes are checked against the hashes in replay.json.
 * @tacticalObjective Schemas for index.json and replay.json, and a loader that returns the two float32
 * matrices (ability and abstract, one row per card in index order).
 */

export const sha256Bytes = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const captureIndexSchema = z.strictObject({
  renderVersion: z.number().int().positive(),
  dims: z.number().int().positive(),
  count: z.number().int().positive(),
  layout: z.string(),
  keys: z.array(z.string().min(1)),
});
export type CaptureIndex = z.infer<typeof captureIndexSchema>;

export const captureReplaySchema = z.strictObject({
  model: z.string().min(1),
  ollamaVersion: z.string().min(1),
  ollamaDigest: hex64,
  weightsBlobSha256: hex64,
  prefix: z.string(),
  endpoint: z.string(),
  batchSize: z.number().int().positive(),
  renderVersion: z.number().int().positive(),
  dims: z.number().int().positive(),
  count: z.number().int().positive(),
  inputHash: hex64,
  inputHashes: z.strictObject({ ability: hex64, abstract: hex64, keys: hex64 }),
  outputHash: z.strictObject({ "ability.f32": hex64, "abstract.f32": hex64 }),
});
export type CaptureReplay = z.infer<typeof captureReplaySchema>;

export interface Capture {
  dir: string;
  index: CaptureIndex;
  replay: CaptureReplay;
  ability: Float32Array;
  abstract: Float32Array;
}

export const CAPTURE_ROOT = "data/pinned/embeddings";

export const captureDirName = (renderVersion: number, inputHash: string): string => `${renderVersion}-${inputHash.slice(0, 12)}`;

export function floatsToBytes(values: Float32Array): Buffer {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => out.writeFloatLE(value, i * 4));
  return out;
}

export function bytesToFloats(bytes: Buffer): Float32Array {
  if (bytes.length % 4 !== 0) throw new Error(`float32 file has ${bytes.length} bytes, not a multiple of 4`);
  const out = new Float32Array(bytes.length / 4);
  for (let i = 0; i < out.length; i += 1) out[i] = bytes.readFloatLE(i * 4);
  return out;
}

/** Reads a capture directory and refuses it unless every file matches the hashes pinned in replay.json. */
export function loadCapture(dir: string): Capture {
  const readJson = (name: string): unknown => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
  const index = captureIndexSchema.parse(readJson("index.json"));
  const replay = captureReplaySchema.parse(readJson("replay.json"));
  const files: Record<string, Buffer> = {};
  for (const name of ["ability.f32", "abstract.f32"] as const) {
    const file = path.join(dir, name);
    if (!existsSync(file)) throw new Error(`${file} is missing; re-capture with "pnpm embed:capture" (see data/pinned/embeddings/README.md)`);
    files[name] = readFileSync(file);
    const actual = sha256Bytes(files[name]);
    if (actual !== replay.outputHash[name]) throw new Error(`${file} hashes to ${actual}, replay.json pins ${replay.outputHash[name]}`);
    if (files[name].length !== index.count * index.dims * 4) throw new Error(`${file} is ${files[name].length} bytes, expected ${index.count * index.dims * 4}`);
  }
  if (index.keys.length !== index.count) throw new Error("index.json keys length differs from count");
  return { dir, index, replay, ability: bytesToFloats(files["ability.f32"]), abstract: bytesToFloats(files["abstract.f32"]) };
}

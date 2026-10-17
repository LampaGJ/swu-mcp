/**
 * @displayName Embedding capture script
 * @strategicPurpose The one place a model runs: it embeds the pinned renderings once and writes the
 * vectors as a hashed capture. Everything downstream (pnpm similarity, the MCP tools) only reads it.
 * @tacticalObjective Renders the "ability" and "abstract" texts from the data package, calls Ollama
 * (nomic-embed-text, prefix "search_document: "), and writes data/pinned/embeddings/<renderVersion>-<inputHash12>/
 * {ability.f32, abstract.f32, index.json, replay.json}. Refuses to replace an existing capture whose bytes differ.
 *
 * Usage: pnpm embed:capture [--data <package dir>] [--ollama <url>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadStore, resolveDataDir } from "../src/data.js";
import {
  captureDirName,
  CAPTURE_ROOT,
  captureIndexSchema,
  captureReplaySchema,
  floatsToBytes,
  sha256Bytes,
  type CaptureIndex,
  type CaptureReplay,
} from "../src/embed/pinned.js";
import { inputHashOf, parseRenderCards, renderAll } from "../src/embed/render.js";
import { progress } from "./lib/progress.mjs";
import { REPO_ROOT } from "../src/paths.js";

const MODEL = "nomic-embed-text";
const PREFIX = "search_document: ";
const BATCH = 32;
const DIMS = 768;

const embedResponse = z.object({ embeddings: z.array(z.array(z.number())) });
const showResponse = z.object({ modelfile: z.string() });
const tagsResponse = z.object({ models: z.array(z.object({ name: z.string(), digest: z.string() })) });
const versionResponse = z.object({ version: z.string() });

async function post(base: string, route: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${route} answered ${response.status}: ${await response.text()}`);
  return response.json();
}

async function get(base: string, route: string): Promise<unknown> {
  const response = await fetch(`${base}${route}`);
  if (!response.ok) throw new Error(`${route} answered ${response.status}`);
  return response.json();
}

async function embedAll(base: string, texts: readonly string[], job: string): Promise<Float32Array> {
  const p = progress(job, { total: texts.length, everyMs: 2000 });
  const out = new Float32Array(texts.length * DIMS);
  for (let start = 0; start < texts.length; start += BATCH) {
    const batch = texts.slice(start, start + BATCH);
    const { embeddings } = embedResponse.parse(
      await post(base, "/api/embed", { model: MODEL, input: batch.map((text) => PREFIX + text), keep_alive: "5m" }),
    );
    if (embeddings.length !== batch.length) throw new Error(`asked for ${batch.length} embeddings, got ${embeddings.length}`);
    embeddings.forEach((vector, i) => {
      if (vector.length !== DIMS) throw new Error(`expected ${DIMS} dimensions, got ${vector.length}`);
      out.set(vector, (start + i) * DIMS);
    });
    p.tick(start + batch.length);
  }
  p.done();
  return out;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { data: { type: "string" }, ollama: { type: "string" } } });
  const base = values.ollama ?? "http://localhost:11434";
  const store = loadStore(values.data === undefined ? resolveDataDir() : path.resolve(values.data));
  const renderings = renderAll(parseRenderCards(store.cards));
  const hashes = inputHashOf(renderings);
  const dir = path.join(REPO_ROOT, CAPTURE_ROOT, captureDirName(renderings.renderVersion, hashes.inputHash));

  const tags = tagsResponse.parse(await get(base, "/api/tags"));
  const tag = tags.models.find((model) => model.name === `${MODEL}:latest`);
  if (tag === undefined) throw new Error(`Ollama does not list ${MODEL}:latest`);
  const modelfile = showResponse.parse(await post(base, "/api/show", { model: MODEL })).modelfile;
  const blob = /^FROM .*sha256-([0-9a-f]{64})$/m.exec(modelfile)?.[1];
  if (blob === undefined) throw new Error("could not read the weights blob digest from the Ollama modelfile");

  const ability = await embedAll(base, renderings.ability, "embed-ability");
  const abstract = await embedAll(base, renderings.abstract, "embed-abstract");
  const abilityBytes = floatsToBytes(ability);
  const abstractBytes = floatsToBytes(abstract);

  const index: CaptureIndex = captureIndexSchema.parse({
    renderVersion: renderings.renderVersion,
    dims: DIMS,
    count: renderings.keys.length,
    layout: "row-major little-endian float32, one row per key in keys order",
    keys: renderings.keys,
  });
  const replay: CaptureReplay = captureReplaySchema.parse({
    model: MODEL,
    ollamaVersion: versionResponse.parse(await get(base, "/api/version")).version,
    ollamaDigest: tag.digest,
    weightsBlobSha256: blob,
    prefix: PREFIX,
    endpoint: "/api/embed",
    batchSize: BATCH,
    renderVersion: renderings.renderVersion,
    dims: DIMS,
    count: renderings.keys.length,
    inputHash: hashes.inputHash,
    inputHashes: { ability: hashes.ability, abstract: hashes.abstract, keys: hashes.keys },
    outputHash: { "ability.f32": sha256Bytes(abilityBytes), "abstract.f32": sha256Bytes(abstractBytes) },
  });
  const files: [string, Buffer | string][] = [
    ["ability.f32", abilityBytes],
    ["abstract.f32", abstractBytes],
    ["index.json", `${JSON.stringify(index)}\n`],
    ["replay.json", `${JSON.stringify(replay, null, 1)}\n`],
  ];

  if (existsSync(dir)) {
    for (const [name, content] of files) {
      const file = path.join(dir, name);
      const wanted = Buffer.isBuffer(content) ? content : Buffer.from(content);
      if (!existsSync(file) || !readFileSync(file).equals(wanted)) {
        throw new Error(
          `${file} already exists with different bytes; a pinned capture is never overwritten. Pick a new renderVersion or remove the capture deliberately.`,
        );
      }
    }
    console.log(JSON.stringify({ dir, status: "identical to the existing capture", replay }, null, 1));
    return;
  }
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of files) writeFileSync(path.join(dir, name), content);
  console.log(JSON.stringify({ dir, status: "captured", replay }, null, 1));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

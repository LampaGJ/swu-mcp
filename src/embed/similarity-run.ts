import { z } from "zod";
import { sha256Hex } from "../swu/canonical.js";
import { labelClusters } from "./labels.js";
import { kmeans, neighboursOf, quantiseInt8, toBase64Url, unitRows } from "./math.js";
import { clustersFileSchema, neighboursFileSchema, similarityReplaySchema, vectorsFileSchema } from "./files.js";
import { sha256Bytes, type Capture } from "./pinned.js";
import { renderAll, type RenderCard } from "./render.js";

/**
 * @displayName Similarity run
 * @strategicPurpose Manipulation node: pinned vectors in; similar, kin, clusters and compact vectors out.
 * Declared effect: expands (cards become neighbour lists, labelled groups and a quantised vector table).
 * @tacticalObjective Pure function of the cards and the capture; `pnpm similarity` writes the returned files.
 */

export const PARAMS = {
  similarLimit: 10,
  similarMinCosine: 0.75,
  kinLimit: 10,
  k: 32,
  seed: 20261016,
  restarts: 10,
  maxIter: 100,
  mrlDims: 128,
} as const;

export interface SimilarityRun {
  files: Record<string, string>;
  replay: z.infer<typeof similarityReplaySchema>;
  clusterSizes: number[];
}

const r3 = (x: number): number => Number(x.toFixed(3));

function neighbourFile(
  edge: "similar" | "kin",
  rendering: "ability" | "abstract",
  vectors: Float32Array,
  capture: Capture,
  cards: readonly RenderCard[],
  texts: readonly string[],
  params: typeof PARAMS,
) {
  const { count, dims } = capture.index;
  const unit = unitRows(vectors, count, dims);
  const out: Record<string, [string, number][]> = {};
  const hasText = (i: number): boolean => texts[i] !== `${cards[i].type} with no ability text.`;
  const limit = edge === "similar" ? params.similarLimit : params.kinLimit;
  const minCosine = edge === "similar" ? params.similarMinCosine : null;
  cards.forEach((card, i) => {
    if (!hasText(i)) return;
    const found = neighboursOf(unit, dims, count, i, (other) => cards[other].title !== card.title && hasText(other));
    out[card.cardKey] = found
      .filter((n) => minCosine === null || n.cosine >= minCosine)
      .slice(0, limit)
      .map((n) => [cards[n.index].cardKey, r3(n.cosine)]);
  });
  return neighboursFileSchema.parse({
    edge,
    meaning:
      edge === "similar"
        ? "cosine on the ability-text embedding; same-title cards dropped; textless cards have no entry"
        : "cosine on the surface-blind embedding (names, traits, keywords, aspects, arenas and numbers masked); ignores shared labels and stats; same-title cards dropped; textless cards have no entry",
    rendering,
    renderVersion: capture.index.renderVersion,
    limit,
    minCosine,
    cards: out,
  });
}

export function buildSimilarityRun(
  cards: readonly RenderCard[],
  capture: Capture,
  captureName: string,
  codeCommit: string,
  onProgress?: (phase: string, done: number) => void,
): SimilarityRun {
  const renderings = renderAll(cards);
  if (renderings.keys.join("\n") !== capture.index.keys.join("\n"))
    throw new Error("the card list differs from the capture's keys; re-run pnpm embed:capture");
  const { count, dims } = capture.index;

  onProgress?.("similar", 0);
  const similar = neighbourFile("similar", "ability", capture.ability, capture, cards, renderings.ability, PARAMS);
  onProgress?.("kin", 1);
  const kin = neighbourFile("kin", "abstract", capture.abstract, capture, cards, renderings.abstract, PARAMS);

  onProgress?.("kmeans", 2);
  const unit = unitRows(capture.ability, count, dims);
  const result = kmeans(unit, count, dims, { k: PARAMS.k, seed: PARAMS.seed, restarts: PARAMS.restarts, maxIter: PARAMS.maxIter }, (done) =>
    onProgress?.("kmeans", 2 + done),
  );
  const raw = Array.from(result.assign);
  const members = Array.from({ length: PARAMS.k }, (_, c) => raw.flatMap((a, i) => (a === c ? [i] : [])));
  const order = members
    .map((_, c) => c)
    .sort((a, b) => members[b].length - members[a].length || (members[a][0] ?? 0) - (members[b][0] ?? 0));
  const renumber = new Map(order.map((old, id) => [old, id]));
  const stable = raw.map((a) => renumber.get(a) ?? -1);
  const labels = labelClusters(cards, stable, PARAMS.k);
  const clusters = clustersFileSchema.parse({
    renderVersion: capture.index.renderVersion,
    k: PARAMS.k,
    seed: PARAMS.seed,
    restarts: PARAMS.restarts,
    maxIter: PARAMS.maxIter,
    inertia: Number(result.inertia.toFixed(6)),
    clusters: order.map((old, id) => ({
      id,
      size: members[old].length,
      label: labels[id],
      members: members[old].map((i) => cards[i].cardKey),
    })),
  });

  const q = quantiseInt8(capture.ability, count, dims, PARAMS.mrlDims);
  const vectors = vectorsFileSchema.parse({
    renderVersion: capture.index.renderVersion,
    rendering: "ability",
    model: capture.replay.model,
    fullDims: dims,
    dims: PARAMS.mrlDims,
    dtype: "int8",
    scale: q.scale,
    decode: `Per card: base64url (no padding) of ${PARAMS.mrlDims} signed bytes. value[i] = int8[i] * scale. The vector is the first ${PARAMS.mrlDims} of the ${dims} nomic-embed-text dimensions (Matryoshka truncation), renormalised to unit length before quantising. Compare with a dot product divided by the two vector lengths.`,
    cards: Object.fromEntries(
      cards.map((card, i) => [card.cardKey, toBase64Url(new Uint8Array(q.rows.buffer, i * PARAMS.mrlDims, PARAMS.mrlDims))]),
    ),
  });

  const files: Record<string, string> = {
    "similar.json": `${JSON.stringify(similar)}\n`,
    "kin.json": `${JSON.stringify(kin)}\n`,
    "clusters.json": `${JSON.stringify(clusters)}\n`,
    "vectors.json": `${JSON.stringify(vectors)}\n`,
  };
  const replay = similarityReplaySchema.parse({
    codeCommit,
    renderVersion: capture.index.renderVersion,
    capture: captureName,
    inputHash: {
      capture: capture.replay.inputHash,
      "ability.f32": capture.replay.outputHash["ability.f32"],
      "abstract.f32": capture.replay.outputHash["abstract.f32"],
      cards: sha256Hex(capture.index.keys.join("\n")),
    },
    params: PARAMS,
    outputHash: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, sha256Bytes(Buffer.from(content))])),
  });
  return { files, replay, clusterSizes: order.map((old) => members[old].length) };
}

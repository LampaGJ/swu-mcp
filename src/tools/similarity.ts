import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { packageDirOf, type CardRow, type CardStore } from "../data.js";
import {
  clustersFileSchema,
  neighboursFileSchema,
  similarityReplaySchema,
  type ClustersFile,
  type NeighboursFile,
  type SimilarityReplay,
} from "../embed/files.js";
import type { ToolResult } from "../tools.js";
import { ok, fail } from "./common.js";

/**
 * @displayName Similarity tools
 * @strategicPurpose MCP read-only tools over the captured-embedding run: similar_cards (what the cards say),
 * kin_cards (the same mechanics under different labels) and cluster (counted role groups). Edge types stay
 * separate and every answer names its edge, so a reader never mistakes one for the other.
 * @tacticalObjective Loads <package>/similarity once per store and answers in compact TOON. Every number is
 * read from files written by `pnpm similarity`; no model runs at query time.
 */

export interface SimilarityData {
  similar: NeighboursFile;
  kin: NeighboursFile;
  clusters: ClustersFile;
  clusterOf: Map<string, number>;
  replay: SimilarityReplay;
}

const cache = new WeakMap<CardStore, SimilarityData>();

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function similarityData(store: CardStore): SimilarityData {
  const hit = cache.get(store);
  if (hit !== undefined) return hit;
  const dir = path.join(packageDirOf(store), "similarity");
  for (const needed of ["similar.json", "kin.json", "clusters.json", "replay.json"]) {
    if (!existsSync(path.join(dir, needed)))
      throw new Error(`${path.join(dir, needed)} is missing; run "pnpm similarity" (needs the capture from "pnpm embed:capture")`);
  }
  const clusters = clustersFileSchema.parse(readJson(path.join(dir, "clusters.json")));
  const data: SimilarityData = {
    similar: neighboursFileSchema.parse(readJson(path.join(dir, "similar.json"))),
    kin: neighboursFileSchema.parse(readJson(path.join(dir, "kin.json"))),
    clusters,
    clusterOf: new Map(clusters.clusters.flatMap((cluster) => cluster.members.map((key) => [key, cluster.id] as const))),
    replay: similarityReplaySchema.parse(readJson(path.join(dir, "replay.json"))),
  };
  cache.set(store, data);
  return data;
}

function guarded(
  handler: (store: CardStore, data: SimilarityData, input: unknown) => ToolResult,
): (store: CardStore, input: unknown) => ToolResult {
  return (store, input) => {
    let data: SimilarityData;
    try {
      data = similarityData(store);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    return handler(store, data, input);
  };
}

const limit = z.number().int().min(1).max(10).default(10);
const dataVersion = (data: SimilarityData): string => `${data.replay.capture}/${data.replay.outputHash["similar.json"].slice(0, 12)}`;

const brief = (card: CardRow): Record<string, unknown> => ({
  cardKey: card.cardKey,
  title: card.title,
  subtitle: card.subtitle ?? null,
  type: card.type,
  cost: card.cost ?? null,
});

function neighbourTool(edge: "similar" | "kin") {
  return guarded((store, data, input) => {
    const args = z.object({ cardKey: z.string().min(1), limit }).parse(input);
    const card = store.byKey.get(args.cardKey);
    if (card === undefined) return fail(`no card with cardKey ${args.cardKey}`);
    const file = edge === "similar" ? data.similar : data.kin;
    const row = file.cards[args.cardKey];
    if (row === undefined) return fail(`${card.title} has no ability text to compare, so it has no ${edge} neighbours`);
    const neighbours = row.slice(0, args.limit).flatMap(([key, cosine]) => {
      const other = store.byKey.get(key);
      return other === undefined ? [] : [{ ...brief(other), cosine }];
    });
    return ok({
      edge,
      meaning: file.meaning,
      card: brief(card),
      cluster: data.clusterOf.get(args.cardKey) ?? null,
      found: neighbours.length,
      neighbours,
      dataVersion: dataVersion(data),
    });
  });
}

export const similarCardsShape = {
  cardKey: z.string().min(1).describe("Exact cardKey, for example 0101033"),
  limit: limit.describe("How many neighbours, 1 to 10"),
};

export const kinCardsShape = similarCardsShape;

export const clusterShape = {
  clusterId: z.number().int().min(0).optional().describe("Cluster id from this tool, 0 is the largest"),
  cardKey: z.string().min(1).optional().describe("Exact cardKey; returns the cluster that card belongs to"),
  members: z.number().int().min(0).max(200).default(40).describe("How many member cards to list"),
};

export const similarCardsHandler = neighbourTool("similar");
export const kinCardsHandler = neighbourTool("kin");

export const clusterHandler = guarded((store, data, input) => {
  const args = z.object(clusterShape).parse(input);
  let id = args.clusterId;
  if (id === undefined) {
    if (args.cardKey === undefined) return fail("give clusterId or cardKey");
    if (!store.byKey.has(args.cardKey)) return fail(`no card with cardKey ${args.cardKey}`);
    id = data.clusterOf.get(args.cardKey);
    if (id === undefined) return fail(`card ${args.cardKey} is not in any cluster`);
  }
  const cluster = data.clusters.clusters.find((candidate) => candidate.id === id);
  if (cluster === undefined) return fail(`no cluster ${id}; ids run 0 to ${data.clusters.k - 1}`);
  const shown = cluster.members.slice(0, args.members).flatMap((key) => {
    const card = store.byKey.get(key);
    return card === undefined ? [] : [brief(card)];
  });
  return ok({
    edge: "cluster",
    meaning: "k-means group on the ability-text embedding; the label counts what members share, it is not generated",
    clusterId: cluster.id,
    label: cluster.label,
    size: cluster.size,
    shown: shown.length,
    members: shown,
    dataVersion: dataVersion(data),
  });
});

export const SIMILARITY_TOOLS = {
  similar_cards: {
    title: "Similar cards",
    description:
      "Edge type: similar. The 10 or fewer cards whose rules text reads most like this card's (cosine on a captured text embedding, 0.75 or higher, same-title cards dropped). Shares traits and keywords freely; use kin_cards for mechanics under different labels.",
    shape: similarCardsShape,
    handler: similarCardsHandler,
  },
  kin_cards: {
    title: "Kin cards",
    description:
      "Edge type: kin. Surface-blind: ignores traits, keywords, aspects, stats. Cards whose ability does the same kind of thing after names, traits, keywords, aspects, arenas and numbers are masked out of the text. Cards with no ability text have no kin.",
    shape: kinCardsShape,
    handler: kinCardsHandler,
  },
  cluster: {
    title: "Role cluster",
    description:
      "Edge type: cluster. One of 32 k-means groups of the ability-text embedding, by clusterId or by the cardKey it contains: a counted label (shared type, keyword, trait and rules words with coverage percent), its size and its member cards.",
    shape: clusterShape,
    handler: clusterHandler,
  },
} as const;

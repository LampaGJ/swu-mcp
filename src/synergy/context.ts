import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../paths.js";
import { coverCombos, type CoverCombo } from "./cover.js";
import { buildFungibility, type FungibilityIndex } from "./fungibility.js";
import { buildPairGraph, type PairGraph } from "./graph.js";
import { complementarityTableSchema, synergyCardsSchema, type ComplementarityTable, type SynergyCard } from "./schema.js";
import { searchTrios, type TrioSearchOptions, type TrioSearchResult } from "./trios.js";

/**
 * @displayName SWU synergy context
 * @strategicPurpose Holds the pair graph, role classes and aspect-cover combinations the MCP
 * synergy tools answer from, built by the same pure functions as the `pnpm synergy` run so a tool
 * answer and a run output cannot disagree.
 * @tacticalObjective Built from `<dataDir>/features/features.json` and the committed
 * `data/complementarity.json`; the trio search is lazy because it is the slow part.
 */

export const DEFAULT_TABLE_PATH = path.join(REPO_ROOT, "data/complementarity.json");

export interface SynergyContext {
  cards: readonly SynergyCard[];
  graph: PairGraph;
  fungibility: FungibilityIndex;
  combos: readonly CoverCombo[];
  trios(options?: TrioSearchOptions): TrioSearchResult;
}

export function createSynergyContext(cards: readonly SynergyCard[], table: ComplementarityTable): SynergyContext {
  const graph = buildPairGraph(cards, table);
  const combos = coverCombos(cards);
  let full: TrioSearchResult | undefined;
  return {
    cards,
    graph,
    combos,
    fungibility: buildFungibility(cards),
    trios: (options) => {
      if (options === undefined) return (full ??= searchTrios(graph, combos));
      return searchTrios(graph, combos, options);
    },
  };
}

export function loadSynergyContext(dataDir: string, tablePath = DEFAULT_TABLE_PATH): SynergyContext {
  const featuresPath = path.join(dataDir, "features/features.json");
  if (!existsSync(featuresPath)) throw new Error(`no ${featuresPath}; run "pnpm card-features" first`);
  const cards = synergyCardsSchema.parse(JSON.parse(readFileSync(featuresPath, "utf8")));
  const table = complementarityTableSchema.parse(JSON.parse(readFileSync(tablePath, "utf8")));
  return createSynergyContext(cards, table);
}

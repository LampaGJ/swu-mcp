import { encode } from "@toon-format/toon";
import { z } from "zod";
import { canonicalJson, compareCodePoints, sha256Hex } from "../swu/canonical.js";
import { coverCombos } from "./cover.js";
import { buildFungibility, fungibilityStats } from "./fungibility.js";
import { buildPairGraph, edgeOrder } from "./graph.js";
import { cardLabel } from "./order.js";
import {
  complementarityTableSchema,
  replaySchema,
  synergyCardsSchema,
  TRIO_SHAPES,
  type ComplementarityTable,
  type PairEdge,
  type SynergyCard,
  type SynergyReplay,
  type TrioRecord,
} from "./schema.js";
import { searchTrios } from "./trios.js";

/**
 * @displayName SWU synergy run
 * @strategicPurpose The manipulation node that turns card features plus the committed
 * complementarity table into pairs, trios and fungibility classes with a replay record, so any later
 * commit can prove it reproduces the same bytes (LampaGJ/swu-mcp#3, ported from mault#325).
 * @tacticalObjective Consumer gate: parses the feature file and the table. Emitter gate: parses
 * every pair row, trio row and the replay record before returning. No clock, no randomness: the
 * outputs are a pure function of the arguments.
 */

const PAIR_EXAMPLES = 15;
const REPORT_TOP = 10;

const pairRowSchema = z.strictObject({
  cardA: z.string(),
  cardB: z.string(),
  reason: z.string(),
  rows: z.string(),
  source: z.literal("rule"),
  link: z.number(),
  nonObvious: z.number(),
  score: z.number(),
});
const trioRowSchema = z.strictObject({
  cardA: z.string(),
  cardB: z.string(),
  cardC: z.string(),
  shape: z.enum(TRIO_SHAPES),
  totalCost: z.number(),
  aspectPair: z.string(),
  penalty: z.number(),
  reasons: z.string(),
  score: z.number(),
});

export interface SynergyRun {
  files: Record<string, string>;
  replay: SynergyReplay;
  report: Record<string, unknown>;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 1)}\n`;

export function pairReason(e: PairEdge): string {
  return e.rows.map((r) => `${r.row}: ${r.reason}`).join(" | ");
}

/** Offer tags on the cards that no row feeds and no table note explains; empty when every offer is a decision. */
export function uncoveredOffers(cards: readonly SynergyCard[], table: ComplementarityTable): string[] {
  const covered = new Set([...table.rows.flatMap((r) => Object.keys(r.offers)), ...(table.feedsNothing ?? []).map((n) => n.tag)]);
  const seen = new Set(cards.flatMap((c) => c.tags.offers.map((t) => t.tag)));
  return [...seen].filter((t) => !covered.has(t) && !t.startsWith("offers:is-trait-")).sort(compareCodePoints);
}

export function buildSynergyRun(featuresText: string, tableText: string, codeCommit: string): SynergyRun {
  const cards = synergyCardsSchema.parse(JSON.parse(featuresText));
  const table = complementarityTableSchema.parse(JSON.parse(tableText));
  const graph = buildPairGraph(cards, table);
  const combos = coverCombos(cards);
  const trioRun = searchTrios(graph, combos);
  const fung = buildFungibility(cards);
  const byKey = graph.byKey;

  const pairRows = z.array(pairRowSchema).parse(
    graph.edges.map((e) => ({
      cardA: e.a,
      cardB: e.b,
      reason: pairReason(e),
      rows: e.rows.map((r) => r.row).join("|"),
      source: "rule",
      link: e.link,
      nonObvious: e.nonObvious.factor,
      score: e.score,
    })),
  );
  const trioList: TrioRecord[] = TRIO_SHAPES.flatMap((s) => trioRun.trios[s]);
  const trioRows = z.array(trioRowSchema).parse(
    trioList.map((t) => ({
      cardA: t.cardA,
      cardB: t.cardB,
      cardC: t.cardC,
      shape: t.shape,
      totalCost: t.totalCost,
      aspectPair: t.aspectPair,
      penalty: t.penalty,
      reasons: t.reasons,
      score: t.score,
    })),
  );

  const picked: PairEdge[] = [];
  const usedRows = new Map<string, number>();
  const usedCards = new Set<string>();
  for (const e of graph.edges.filter((x) => !x.traitOnly && x.nonObvious.aspects === 1).sort(edgeOrder)) {
    const r = e.rows[0].baseId;
    if ((usedRows.get(r) ?? 0) >= 2 || usedCards.has(e.a) || usedCards.has(e.b)) continue;
    picked.push(e);
    usedRows.set(r, (usedRows.get(r) ?? 0) + 1);
    usedCards.add(e.a);
    usedCards.add(e.b);
    if (picked.length === PAIR_EXAMPLES) break;
  }
  const describe = (c: SynergyCard): string => `${cardLabel(c)} [${c.type} ${c.structured.cost ?? "-"} ${c.structured.aspects.join("/")}]`;
  const trioView = (t: TrioRecord) => ({
    ...t,
    members: [t.cardA, t.cardB, t.cardC].map((k) => {
      const c = byKey.get(k) as SynergyCard;
      return `${cardLabel(c)} [${c.type} cost ${c.structured.cost ?? "-"} ${c.structured.aspectIcons.join("/") || "neutral"}]`;
    }),
  });
  const diverse = (list: TrioRecord[]) => {
    const out: TrioRecord[] = [];
    for (const t of list) {
      const m = [t.cardA, t.cardB, t.cardC];
      if (out.some((q) => [q.cardA, q.cardB, q.cardC].filter((k) => m.includes(k)).length >= 2)) continue;
      out.push(t);
      if (out.length === REPORT_TOP) break;
    }
    return out.map(trioView);
  };

  const stats = fungibilityStats(fung);
  const report = {
    pairs: graph.edges.length,
    pairsExcludingTraitOnly: graph.edges.filter((e) => !e.traitOnly).length,
    pairCountsPerRow: graph.rowCounts,
    offersWithoutRowOrNote: uncoveredOffers(cards, table),
    exampleChecks: graph.exampleChecks,
    examplePairs: picked.map((e) => ({
      a: describe(byKey.get(e.a) as SynergyCard),
      b: describe(byKey.get(e.b) as SynergyCard),
      score: e.score,
      rows: e.rows.map((r) => `${r.row}: ${r.offer} -> ${r.want}`),
      reason: e.rows[0].reason,
    })),
    trioGraph: { edges: trioRun.graph.edges, fanout: trioRun.graph.fanout, nodes: trioRun.graph.nodes },
    trioCounts: trioRun.counts,
    leaderBaseCombinations: combos.length,
    topTrios: Object.fromEntries(TRIO_SHAPES.map((s) => [s, diverse(trioRun.trios[s])])),
    fungibility: stats,
  };

  const fungibilityFile = {
    stats,
    classes: fung.classes.map((c) => ({
      id: c.id,
      tag: c.tag,
      side: c.side,
      typeGroup: c.typeGroup,
      timing: c.timing,
      magnitude: c.magnitude,
      costBand: c.costBand,
      target: c.target,
      size: c.members.length,
      members: c.members,
    })),
  };

  const files: Record<string, string> = {
    "pairs.toon": `${encode({ pairings: pairRows })}\n`,
    "trios.toon": `${encode({ trios: trioRows })}\n`,
    "fungibility.json": json(fungibilityFile),
    "report.json": json(report),
  };
  const outputHash = Object.fromEntries(
    Object.keys(files)
      .sort(compareCodePoints)
      .map((n) => [n, sha256Hex(files[n])]),
  );
  const replay = replaySchema.parse({
    inputHash: { "features.json": sha256Hex(featuresText), "complementarity.json": sha256Hex(tableText) },
    codeCommit,
    complementarityTableVersion: table.tableVersion,
    outputHash,
  });
  files["replay.json"] = json(JSON.parse(canonicalJson(replay)));
  return { files, replay, report };
}

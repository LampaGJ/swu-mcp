import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { pairingRows } from "../../src/package/tables.js";
import { createSynergyContext } from "../../src/synergy/context.js";
import { coverCombos } from "../../src/synergy/cover.js";
import { buildPairGraph, edgeScore, TRAIT_BONUS } from "../../src/synergy/graph.js";
import { buildSynergyRun } from "../../src/synergy/run.js";
import { searchTrios } from "../../src/synergy/trios.js";
import { findPairings, findTrios, SYNERGY_TOOLS } from "../../src/tools/synergy.js";
import type { ToolResult } from "../../src/tools.js";
import { COMMITTED_TABLE, mk } from "./fixtures.js";

// LampaGJ/swu-mcp#24: a shared trait is a tribal link, not a mechanical one.

const body = (result: ToolResult): Record<string, any> => {
  expect(result.isError).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
};

const trooper = mk("1", "Death Trooper", {
  offers: ["offers:damage-friendly-unit", "offers:is-trait-Imperial"],
  traits: ["Imperial"],
  aspects: ["Vigilance"],
});
const squad = mk("2", "The Elite Squad", {
  wants: ["wants:damage-friendly", "wants:trait-Imperial"],
  traits: ["Imperial"],
  aspects: ["Aggression"],
});
const pinger = mk("3", "Pinger", { offers: ["offers:damage-friendly-unit"], traits: ["Rebel"], aspects: ["Command"] });
const fans = Array.from({ length: 7 }, (_, i) =>
  mk(`F${i}`, `Imperial Fan ${i}`, { offers: ["offers:is-trait-Imperial"], traits: ["Imperial"], aspects: ["Cunning"] }),
);
const cards = [
  mk("L", "Leader", { type: "Leader", icons: ["Command", "Heroism"] }),
  mk("Z", "Base", { type: "Base", icons: ["Command"] }),
  trooper,
  squad,
  pinger,
  ...fans,
];
const graph = buildPairGraph(cards, COMMITTED_TABLE);

describe("link kind", () => {
  it("classifies every pair as mechanical, trait-only or trait+mechanical", () => {
    expect(graph.edgeByKey.get("3>2")?.linkKind).toBe("mechanical");
    expect(graph.edgeByKey.get("F0>2")?.linkKind).toBe("trait-only");
    expect(graph.edgeByKey.get("F0>2")?.traitOnly).toBe(true);
    expect(graph.edgeByKey.get("1>2")?.linkKind).toBe("trait+mechanical");
  });

  it("does not count the trait as its own link on a mechanical pair: it adds a small bonus", () => {
    const mixed = graph.edgeByKey.get("1>2");
    const plain = graph.edgeByKey.get("3>2");
    expect(TRAIT_BONUS).toBeGreaterThan(0);
    expect(TRAIT_BONUS).toBeLessThanOrEqual(0.15);
    expect(mixed?.link).toBe(Math.round(0.9 * (1 + TRAIT_BONUS) * 1000) / 1000);
    expect(plain?.link).toBe(0.9);
    expect(graph.edgeByKey.get("F0>2")?.link).toBe(0.35);
  });

  it("scores a pair per traits mode: exclude drops the bonus, include counts the trait row as a link", () => {
    const mixed = graph.edgeByKey.get("1>2")!;
    const f = mixed.nonObvious.factor;
    expect(edgeScore(mixed, "bonus")).toBe(mixed.score);
    expect(edgeScore(mixed, "exclude")).toBe(Math.round(0.9 * f * 1000) / 1000);
    expect(edgeScore(mixed, "include")).toBe(Math.round(1.25 * f * 1000) / 1000);
    const tribal = graph.edgeByKey.get("F0>2")!;
    expect(edgeScore(tribal, "exclude")).toBe(0);
  });
});

describe("find_pairings traits parameter", () => {
  const ctx = createSynergyContext(cards, COMMITTED_TABLE);

  it("defaults to bonus: mechanical links ranked, trait-only pairs in a separate tribal list capped at 5", () => {
    const out = body(findPairings(ctx, { cardKey: "2", evidence: false, withAlternatives: false }));
    expect(out.traits).toBe("bonus");
    expect(out.pairings.map((p: any) => p.linkKind).sort()).toEqual(["mechanical", "trait+mechanical"]);
    expect(out.tribal.total).toBe(7);
    expect(out.tribal.pairings).toHaveLength(5);
    expect(out.tribal.pairings.every((p: any) => p.linkKind === "trait-only")).toBe(true);
    const capped = body(findPairings(ctx, { cardKey: "2", evidence: false, withAlternatives: false, tribalLimit: 2 }));
    expect(capped.tribal.pairings).toHaveLength(2);
  });

  it("exclude ranks without the trait bonus and lists no tribal pairs", () => {
    const out = body(findPairings(ctx, { cardKey: "2", traits: "exclude", evidence: false, withAlternatives: false }));
    expect(out.tribal).toBeUndefined();
    const mixed = out.pairings.find((p: any) => p.cardKey === "1");
    expect(mixed.score).toBe(edgeScore(ctx.graph.edgeByKey.get("1>2")!, "exclude"));
  });

  it("include ranks trait-only pairs together with mechanical ones", () => {
    const out = body(findPairings(ctx, { cardKey: "2", traits: "include", evidence: false, withAlternatives: false, limit: 20 }));
    expect(out.tribal).toBeUndefined();
    expect(out.total).toBe(9);
    expect(out.pairings.filter((p: any) => p.linkKind === "trait-only")).toHaveLength(7);
  });

  it("documents the parameter in the tool description", () => {
    expect(SYNERGY_TOOLS.find_pairings.description).toMatch(/tribal/);
    expect(SYNERGY_TOOLS.find_trios.description).toMatch(/mechanical/);
  });
});

describe("trios and traits", () => {
  const a = mk("A", "Alpha", { offers: ["offers:damage-friendly-unit"], aspects: ["Command"], cost: 1 });
  const b = mk("B", "Bravo", {
    wants: ["wants:damage-friendly"],
    offers: ["offers:is-trait-Imperial"],
    traits: ["Imperial"],
    aspects: ["Command"],
    cost: 1,
  });
  const c = mk("C", "Charlie", {
    wants: ["wants:trait-Imperial"],
    offers: ["offers:is-trait-Imperial"],
    traits: ["Imperial"],
    aspects: ["Command"],
    cost: 1,
  });
  const d = mk("D", "Delta", { wants: ["wants:trait-Imperial"], aspects: ["Command"], cost: 1 });
  const leader = mk("L", "Leader", { type: "Leader", icons: ["Command", "Heroism"] });
  const base = mk("Z", "Base", { type: "Base", icons: ["Command"] });
  const trioCards = [a, b, c, d, leader, base];
  const g = buildPairGraph(trioCards, COMMITTED_TABLE);
  const keysOf = (r: ReturnType<typeof searchTrios>) =>
    Object.values(r.trios)
      .flat()
      .map((t) => `${t.cardA}|${t.cardB}|${t.cardC}`);

  it("uses no trait-only link by default", () => {
    const r = searchTrios(g, coverCombos(trioCards));
    expect(keysOf(r)).toEqual([]);
  });

  it("admits trait-only links with traits include, but every trio keeps at least one mechanical link", () => {
    const r = searchTrios(g, coverCombos(trioCards), { traits: "include" });
    const keys = keysOf(r);
    expect(keys).toContain("A|B|C");
    expect(keys.some((k) => k.split("|").every((x) => ["B", "C", "D"].includes(x)))).toBe(false);
  });

  it("find_trios takes the same traits parameter", () => {
    const ctx = createSynergyContext(trioCards, COMMITTED_TABLE);
    expect(body(findTrios(ctx, { evidence: false, withAlternatives: false })).trios ?? []).toEqual([]);
    const out = body(findTrios(ctx, { traits: "include", evidence: false, withAlternatives: false }));
    expect(out.trios.map((t: any) => t.cardKeys)).toContain("A|B|C");
  });
});

describe("run output and package index", () => {
  it("writes a linkKind column and per-kind pair counts", () => {
    const run = buildSynergyRun(JSON.stringify(cards), JSON.stringify(COMMITTED_TABLE), "test");
    const pairs = (decode(run.files["pairs.toon"]) as { pairings: { cardA: string; cardB: string; linkKind: string }[] }).pairings;
    expect(pairs.find((p) => p.cardA === "1" && p.cardB === "2")?.linkKind).toBe("trait+mechanical");
    expect(pairs.find((p) => p.cardA === "F0")?.linkKind).toBe("trait-only");
    expect(run.report.pairsByLinkKind).toEqual({ mechanical: 1, "trait+mechanical": 1, "trait-only": 7 });
  });

  it("labels a trait+mechanical partner cell with its mechanical row", () => {
    const { rows } = pairingRows(graph, 5);
    const cell = rows.find((r) => r.cardKey === "2")?.pairs as string;
    expect(cell).toContain("<1 ping-own-damage-payoff");
    expect(cell).not.toContain("trait-reference");
  });
});

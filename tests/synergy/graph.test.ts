import { describe, expect, it } from "vitest";
import { buildPairGraph, expandRows } from "../../src/synergy/graph.js";
import { COMMITTED_TABLE, mk, table } from "./fixtures.js";

const alwaysTwo = mk("A1", "Always Two", { offers: ["offers:defeat-friendly-unit"], aspects: ["Command"], traits: ["Droid"] });
const commando = mk("A2", "Desperate Commando", {
  offers: ["offers:has-when-defeated"],
  wants: ["wants:self-defeated"],
  aspects: ["Aggression"],
  traits: ["Rebel"],
});
const thrawn = mk("A3", "Grand Admiral Thrawn", {
  type: "Leader",
  wants: ["wants:when-defeated-cards"],
  aspects: ["Cunning"],
  traits: ["Imperial"],
});
const deathTrooper = mk("B1", "Death Trooper", { offers: ["offers:damage-friendly-unit"], aspects: ["Vigilance"], traits: ["Imperial"] });
const eliteSquad = mk("B2", "The Elite Squad", { wants: ["wants:damage-friendly"], aspects: ["Aggression"], traits: ["Imperial"] });

describe("pair graph", () => {
  const graph = buildPairGraph([alwaysTwo, commando, thrawn, deathTrooper, eliteSquad], COMMITTED_TABLE);

  it("matches the three documented example pairs to their rows", () => {
    expect(graph.exampleChecks).toHaveLength(3);
    expect(graph.exampleChecks.every((c) => c.matches)).toBe(true);
    expect(graph.edgeByKey.get("A1>A2")?.rows.map((r) => r.row)).toContain("sac-outlet-when-defeated");
    expect(graph.edgeByKey.get("A2>A3")?.rows.map((r) => r.row)).toContain("when-defeated-doubler");
    expect(graph.edgeByKey.get("B1>B2")?.rows.map((r) => r.row)).toContain("ping-own-damage-payoff");
  });

  it("scores link strength times non-obviousness", () => {
    const e = graph.edgeByKey.get("A1>A2");
    expect(e?.link).toBe(1);
    expect(e?.nonObvious).toMatchObject({ aspects: 1, traits: 1 });
    expect(e?.score).toBe(Math.round((e?.link ?? 0) * (e?.nonObvious.factor ?? 0) * 1000) / 1000);
    expect(e?.nonObvious.factor).toBeGreaterThanOrEqual(1.75);
    expect(e?.nonObvious.factor).toBeLessThanOrEqual(2.25);
  });

  it("weights a row by the strongest offer and want tag that hit", () => {
    expect(graph.edgeByKey.get("B1>B2")?.link).toBe(0.9);
  });

  it("is directed and never links a card to itself", () => {
    expect(graph.edgeByKey.has("A2>A1")).toBe(false);
    expect([...graph.edgeByKey.values()].every((e) => e.a !== e.b)).toBe(true);
  });

  it("does not link two printings that share a title", () => {
    const twin = mk("A1b", "Always Two", { wants: ["wants:self-defeated"] });
    const g = buildPairGraph([alwaysTwo, twin], COMMITTED_TABLE);
    expect(g.edges).toHaveLength(0);
  });

  it("is sorted and reproducible", () => {
    const again = buildPairGraph([alwaysTwo, commando, thrawn, deathTrooper, eliteSquad], COMMITTED_TABLE);
    expect(JSON.stringify(again.edges)).toBe(JSON.stringify(graph.edges));
    const keys = graph.edges.map((e) => `${e.a}>${e.b}`);
    expect(keys).toEqual([...keys].sort());
  });

  it("counts pairs per base row", () => {
    expect(graph.rowCounts["sac-outlet-when-defeated"]).toBeGreaterThanOrEqual(1);
  });
});

describe("trait family", () => {
  const rebel = mk("T1", "Rebel Fan", { wants: ["wants:trait-Rebel"], traits: ["Fringe"] });
  const rebelUnit = mk("T2", "Rebel Grunt", { offers: ["offers:is-trait-Rebel"], traits: ["Rebel"] });

  it("expands one row per trait found on the cards", () => {
    const rows = expandRows([rebel, rebelUnit], COMMITTED_TABLE).filter((r) => r.baseId === "trait-reference");
    expect(rows.map((r) => r.id)).toEqual(["trait-reference:Fringe", "trait-reference:Rebel"]);
  });

  it("marks a trait-only link", () => {
    const g = buildPairGraph([rebel, rebelUnit], COMMITTED_TABLE);
    const e = g.edgeByKey.get("T2>T1");
    expect(e?.traitOnly).toBe(true);
    expect(e?.link).toBe(0.35);
  });
});

describe("table gate", () => {
  it("rejects array wants on a non-trait row", () => {
    const bad = { ...COMMITTED_TABLE, rows: [{ ...COMMITTED_TABLE.rows[0], wants: ["wants:x"] }] };
    expect(() => buildPairGraph([alwaysTwo], bad)).toThrow(/array wants/);
  });

  it("builds from a custom table", () => {
    const t = table([{ id: "r", offers: { "offers:x": 1 }, wants: { "wants:y": 1 } }]);
    const g = buildPairGraph([mk("1", "One", { offers: ["offers:x"] }), mk("2", "Two", { wants: ["wants:y"] })], t);
    expect(g.edges.map((e) => `${e.a}>${e.b}`)).toEqual(["1>2"]);
  });
});

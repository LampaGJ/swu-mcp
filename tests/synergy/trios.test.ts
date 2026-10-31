import { describe, expect, it } from "vitest";
import { coverCombos } from "../../src/synergy/cover.js";
import { buildPairGraph } from "../../src/synergy/graph.js";
import { trioLinks } from "../../src/synergy/slots.js";
import { searchTrios } from "../../src/synergy/trios.js";
import { COMMITTED_TABLE, mk, table } from "./fixtures.js";

const leader = mk("L", "Leader", { type: "Leader", icons: ["Command", "Heroism"], offers: ["offers:y"], wants: ["wants:x"] });
const base = mk("Z", "Base", { type: "Base", icons: ["Command"] });

function run(cards: ReturnType<typeof mk>[], rows: Parameters<typeof table>[0], options = {}) {
  const all = [leader, base, ...cards];
  const graph = buildPairGraph(all, table(rows));
  return { graph, result: searchTrios(graph, coverCombos(all), options) };
}

const chainRows: Parameters<typeof table>[0] = [
  { id: "r1", offers: { "offers:x": 1 }, wants: { "wants:x": 1 } },
  { id: "r2", offers: { "offers:y": 1 }, wants: { "wants:y": 1 } },
];

describe("trio shapes", () => {
  it("finds a chain A -> B -> C", () => {
    const a = mk("1", "Alpha", { offers: ["offers:x"], aspects: ["Command"] });
    const b = mk("2", "Bravo", { wants: ["wants:x"], offers: ["offers:y"], aspects: ["Command"] });
    const c = mk("3", "Charlie", { wants: ["wants:y"], aspects: ["Command"] });
    const { result } = run([a, b, c], chainRows);
    expect(result.trios.chain.map((t) => [t.cardA, t.cardB, t.cardC])).toEqual([["1", "2", "3"]]);
    expect(result.counts).toMatchObject({ chain: 1, convergent: 0, loop: 0 });
    expect(result.trios.chain[0]).toMatchObject({ totalCost: 6, penalty: 0, shape: "chain" });
  });

  it("finds two enablers feeding one payoff on different wants", () => {
    const a = mk("1", "Alpha", { offers: ["offers:x"] });
    const b = mk("2", "Bravo", { offers: ["offers:y"] });
    const c = mk("3", "Charlie", { wants: ["wants:x", "wants:y"] });
    const { result } = run([a, b, c], chainRows);
    expect(result.trios["convergent-different-wants"]).toHaveLength(1);
    expect(result.trios["convergent-different-wants"][0]).toMatchObject({ cardA: "1", cardB: "2", cardC: "3" });
    expect(result.trios["convergent-same-want"]).toHaveLength(0);
  });

  it("finds two enablers feeding one payoff on the same want", () => {
    const a = mk("1", "Alpha", { offers: ["offers:x"] });
    const b = mk("2", "Bravo", { offers: ["offers:x"] });
    const c = mk("3", "Charlie", { wants: ["wants:x"] });
    const { result } = run([a, b, c], chainRows);
    expect(result.trios["convergent-same-want"]).toHaveLength(1);
    expect(result.counts["convergent-same-want"]).toBe(1);
  });

  it("finds a loop once, with the smallest key first", () => {
    const rows: Parameters<typeof table>[0] = [
      { id: "r1", offers: { "offers:x": 1 }, wants: { "wants:x": 1 } },
      { id: "r2", offers: { "offers:y": 1 }, wants: { "wants:y": 1 } },
      { id: "r3", offers: { "offers:z": 1 }, wants: { "wants:z": 1 } },
    ];
    const a = mk("1", "Alpha", { offers: ["offers:x"], wants: ["wants:z"] });
    const b = mk("2", "Bravo", { wants: ["wants:x"], offers: ["offers:y"] });
    const c = mk("3", "Charlie", { wants: ["wants:y"], offers: ["offers:z"] });
    const { result, graph } = run([a, b, c], rows);
    expect(result.trios.loop.map((t) => [t.cardA, t.cardB, t.cardC])).toEqual([["1", "2", "3"]]);
    expect(result.counts.loop).toBe(1);
    expect(trioLinks(graph, result.trios.loop[0]).map((e) => `${e.a}>${e.b}`)).toEqual(["1>2", "2>3", "3>1"]);
  });
});

describe("trio membership", () => {
  it("never uses a leader or base as a member, even when the pair graph links it", () => {
    const a = mk("1", "Alpha", { offers: ["offers:x"] });
    const c = mk("3", "Charlie", { wants: ["wants:y"] });
    const { result, graph } = run([a, c], chainRows);
    expect(graph.edgeByKey.has("1>L")).toBe(true);
    expect(graph.edgeByKey.has("L>3")).toBe(true);
    expect(Object.values(result.trios).flat()).toHaveLength(0);
  });

  it("skips trait-only links and repeated titles", () => {
    const cards = [mk("1", "Same", { offers: ["offers:is-trait-A"], traits: ["A"] }), mk("2", "Other", { wants: ["wants:trait-A"] })];
    const graph = buildPairGraph(cards, COMMITTED_TABLE);
    expect(graph.edges[0].traitOnly).toBe(true);
    expect(searchTrios(graph, coverCombos(cards)).graph.edges).toBe(0);
    const twins = [
      mk("1", "Same", { offers: ["offers:x"] }),
      mk("2", "Mid", { wants: ["wants:x"], offers: ["offers:y"] }),
      mk("3", "Same", { wants: ["wants:y"] }),
    ];
    const g2 = buildPairGraph(twins, table(chainRows));
    expect(searchTrios(g2, coverCombos(twins)).counts.chain).toBe(0);
  });
});

describe("trio ranking", () => {
  const rows = chainRows;
  const mkChain = (prefix: string, cost: number, aspect: string) => [
    mk(`${prefix}1`, `${prefix} Alpha`, { offers: ["offers:x"], cost, aspects: [aspect] }),
    mk(`${prefix}2`, `${prefix} Bravo`, { wants: ["wants:x"], offers: ["offers:y"], cost, aspects: [aspect] }),
    mk(`${prefix}3`, `${prefix} Charlie`, { wants: ["wants:y"], cost, aspects: [aspect] }),
  ];

  it("ranks the cheap, covered chain above the expensive, uncovered one", () => {
    const cheap = mkChain("c", 2, "Command");
    const dear = mkChain("d", 5, "Cunning");
    const { result } = run([...cheap, ...dear], rows, { keep: 100 });
    const first = result.trios.chain.find((t) => t.cardA === "c1" && t.cardB === "c2" && t.cardC === "c3");
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(first.allCostLe3).toBe(true);
    const second = result.trios.chain.find((t) => t.cardA === "d1" && t.cardB === "d2" && t.cardC === "d3");
    expect(second?.penalty).toBe(6);
    expect(first.score).toBeGreaterThan(second?.score ?? Infinity);
  });

  it("applies the accept filter without changing the counts", () => {
    const cards = [...mkChain("c", 2, "Command"), ...mkChain("d", 5, "Command")];
    const all = run(cards, rows).result;
    const cheapOnly = run(cards, rows, { accept: (_k: unknown, cost: number) => cost <= 9 }).result;
    expect(cheapOnly.counts.chain).toBe(all.counts.chain);
    expect(cheapOnly.trios.chain.every((t) => t.totalCost <= 9)).toBe(true);
    expect(cheapOnly.trios.chain.length).toBeLessThan(all.trios.chain.length);
  });

  it("is deterministic", () => {
    const cards = [...mkChain("c", 2, "Command"), ...mkChain("d", 5, "Cunning")];
    expect(JSON.stringify(run(cards, rows).result)).toBe(JSON.stringify(run(cards, rows).result));
  });
});

describe("loop playability (#134)", () => {
  // Evil is Everywhere + Thermal Detonator + Gar Saxon: the outlet defeats one unit, but the fodder link hands it Gar's token
  // while the Detonator link needs Gar himself (the Detonator's host) defeated.
  const outlet = (quant: string, text: string) =>
    mk("1", "Outlet", {
      type: "Event",
      offers: ["offers:defeat-friendly-unit"],
      wants: ["wants:sac-fodder"],
      why: { "offers:defeat-friendly-unit": `text: ${text}`, "wants:sac-fodder": "defeats your own units" },
      abilities: [{ repeat: "once", text, effect: { cat: "defeat", target: { side: "friendly", kind: "unit", quant, text: "a unit" } } }],
    });
  const detonator = mk("2", "Detonator", {
    type: "Upgrade",
    offers: ["offers:upgrade-to-attach"],
    wants: ["wants:self-defeated"],
    why: { "offers:upgrade-to-attach": "is an upgrade or Pilot", "wants:self-defeated": "text: When Defeated" },
  });
  const saxon = mk("3", "Saxon", {
    offers: ["offers:create-token-units"],
    wants: ["wants:upgrades-attached"],
    why: { "offers:create-token-units": "text: You may create a Mandalorian token.", "wants:upgrades-attached": "When you play an upgrade on this unit" },
    abilities: [{ repeat: "once", text: "You may create a Mandalorian token.", effect: { cat: "create_token", token: "Mandalorian" } }],
  });
  const token = mk("T", "Mandalorian", { type: "Token Unit", traits: ["Mandalorian"] });
  const search = (cards: ReturnType<typeof mk>[]) => {
    const graph = buildPairGraph(cards, COMMITTED_TABLE);
    return { graph, result: searchTrios(graph, coverCombos(cards)) };
  };

  it("links the three cards into a cycle at the pair level", () => {
    const { graph } = search([outlet("one", "Defeat a unit."), detonator, saxon, token]);
    expect(["1>2", "2>3", "3>1"].every((k) => graph.edgeByKey.has(k))).toBe(true);
  });

  it("drops the loop when a single-subject outlet must defeat both the supplied token and the upgrade's host", () => {
    const { result } = search([outlet("one", "Defeat a unit."), detonator, saxon, token]);
    expect(result.trios.loop).toEqual([]);
    expect(result.counts.loop).toBe(0);
    const chains = result.trios.chain.map((t) => `${t.cardA}|${t.cardB}|${t.cardC}`);
    expect(chains).toContain("2|3|1");
    expect(chains).toContain("1|2|3");
  });

  it("keeps the loop when the outlet defeats any number of units", () => {
    const { result } = search([outlet("any_number", "Defeat any number of friendly units."), detonator, saxon, token]);
    expect(result.trios.loop.map((t) => `${t.cardA}|${t.cardB}|${t.cardC}`)).toEqual(["1|2|3"]);
  });
});

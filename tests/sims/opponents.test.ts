import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  REST_OF_FIELD,
  assignArchetype,
  buildPool,
  deckPanel,
  engineUnmappedCards,
  namedDraw,
  poolReport,
  populationLabel,
  readSnapshotEntries,
  sampleProportional,
  sampleStratified,
  stratifiedPlan,
  tournamentArchetypes,
  type ArchetypeInfo,
  type OpponentPool,
} from "../../src/sims/opponents.js";
import { cardKeyOf, counts, entryOf, metaOf } from "./fixtures.js";

/** Three archetypes (shares .5 .3 .2), twelve lists each, placements spread so the weights differ. */
function syntheticPool(extra: (ReturnType<typeof entryOf>)[] = [], unmappedCards?: Parameters<typeof buildPool>[0]["unmappedCards"]): OpponentPool {
  const meta = metaOf([
    { id: "a1", leader: "LA", share: 0.5, core: ["a1", "a2", "a3"] },
    { id: "a2", leader: "LB", share: 0.3, core: ["b1", "b2", "b3"] },
    { id: "a3", leader: "LC", share: 0.2, core: ["c1", "c2", "c3"] },
  ]);
  const entries = [
    ...[
      ["LA", ["a1", "a2", "a3"]],
      ["LB", ["b1", "b2", "b3"]],
      ["LC", ["c1", "c2", "c3"]],
    ].flatMap(([leader, cards]) =>
      Array.from({ length: 12 }, (_, i) => entryOf({ leader: leader as string, cards: cards as string[], placement: i + 1, field: 12, event: `${leader}-${i}` })),
    ),
    ...extra,
  ];
  return buildPool({ meta, entries, counts, cardKeyOf, unmappedCards });
}

describe("determinism", () => {
  it("gives the same draws for the same seed and different draws for another", () => {
    const pool = syntheticPool();
    const sources = (seed: string) => sampleProportional(pool, { seed, n: 200 }).draws.map((d) => d.source);
    expect(sources("seed-1")).toEqual(sources("seed-1"));
    expect(sources("seed-2")).not.toEqual(sources("seed-1"));
    const plan = stratifiedPlan(pool, { top: 2, perStratum: 20 });
    const stratified = (seed: string) => sampleStratified(pool, plan, { seed }).draws.map((d) => d.list.key);
    expect(stratified("seed-1")).toEqual(stratified("seed-1"));
    expect(stratified("seed-2")).not.toEqual(stratified("seed-1"));
  });

  it("records the sampler, seed, draw index, archetype and list in the header source", () => {
    const pool = syntheticPool();
    const draw = sampleProportional(pool, { seed: "s", n: 3 }).draws[2];
    expect(draw.source).toBe(`opponents-v1 seed=s mode=proportional draw=2 archetype=${draw.archetypeId} list=${draw.list.key}`);
  });

  it("keeps a stratum's draws when another stratum's size changes", () => {
    const pool = syntheticPool();
    const first = sampleStratified(pool, stratifiedPlan(pool, { top: 2, perStratum: 10, restOfField: 5 }), { seed: "s" });
    const second = sampleStratified(pool, stratifiedPlan(pool, { top: 2, perStratum: 10, restOfField: 40 }), { seed: "s" });
    const of = (r: typeof first, stratum: string) => r.draws.filter((d) => d.stratum === stratum).map((d) => d.list.key);
    expect(of(second, "a1")).toEqual(of(first, "a1"));
  });
});

describe("proportional draw", () => {
  it("tracks archetype share within sampling error on a large synthetic draw", () => {
    const pool = syntheticPool();
    const n = 60000;
    const { draws } = sampleProportional(pool, { seed: "freq", n });
    for (const [id, share] of [["a1", 0.5], ["a2", 0.3], ["a3", 0.2]] as const) {
      const freq = draws.filter((d) => d.archetypeId === id).length / n;
      const sigma = Math.sqrt((share * (1 - share)) / n);
      expect(Math.abs(freq - share)).toBeLessThan(5 * sigma);
    }
  });

  it("draws lists of one archetype in proportion to their placement weight", () => {
    const pool = syntheticPool();
    const n = 60000;
    const { draws } = sampleProportional(pool, { seed: "weight", n });
    const lists = pool.byArchetype.get("a1") ?? [];
    const total = lists.reduce((s, l) => s + l.weight, 0);
    const inArchetype = draws.filter((d) => d.archetypeId === "a1");
    for (const l of lists) {
      const p = l.weight / total;
      const freq = inArchetype.filter((d) => d.list.key === l.key).length / inArchetype.length;
      expect(Math.abs(freq - p)).toBeLessThan(5 * Math.sqrt((p * (1 - p)) / inArchetype.length));
    }
    const winner = lists.find((l) => l.placement === 1);
    const last = lists.find((l) => l.placement === 12);
    expect(winner?.weight).toBeCloseTo(2, 10);
    expect(last?.weight).toBeCloseTo(1 + 1 / 12, 10);
  });

  it("labels the population with its window, weighting and the number of lists drawn", () => {
    const pool = syntheticPool();
    const result = sampleProportional(pool, { seed: "s", n: 7 });
    expect(result.population).toEqual(populationLabel(pool.window, 7));
    expect(result.population.text).toBe("melee tournament decklists, 2026-07-20 to 2026-10-17, placement-weighted archetype share (n = 7 lists drawn)");
  });
});

describe("stratified plan and draw", () => {
  it("makes the top archetypes strata and the rest one stratum, weighted by normalised share", () => {
    const pool = syntheticPool();
    const plan = stratifiedPlan(pool, { top: 2, perStratum: 100, restOfField: 30 });
    expect(plan.map((s) => s.id)).toEqual(["a1", "a2", REST_OF_FIELD]);
    expect(plan.map((s) => s.n)).toEqual([100, 100, 30]);
    expect(plan.map((s) => s.weight)).toEqual([0.5, 0.3, 0.2].map((x) => expect.closeTo(x, 10)));
    expect(plan.reduce((s, p) => s + p.weight, 0)).toBeCloseTo(1, 10);
    expect(plan[2].archetypeIds).toEqual(["a3"]);
  });

  it("normalises weights when shares do not sum to one", () => {
    const meta = metaOf([
      { id: "x1", leader: "LA", share: 0.06, core: ["a1"] },
      { id: "x2", leader: "LB", share: 0.03, core: ["b1"] },
      { id: "x3", leader: "LC", share: 0.01, core: ["c1"] },
    ]);
    const pool = buildPool({ meta, entries: [], counts, cardKeyOf });
    const plan = stratifiedPlan(pool, { top: 1 });
    expect(plan[0].weight).toBeCloseTo(0.6, 10);
    expect(plan[1].weight).toBeCloseTo(0.4, 10);
  });

  it("draws exactly n per stratum, each only from its own archetypes, rest-of-field by share", () => {
    const pool = syntheticPool();
    const plan = stratifiedPlan(pool, { top: 1, perStratum: 50, restOfField: 20000 });
    const { draws } = sampleStratified(pool, plan, { seed: "strata" });
    const inStratum = (id: string) => draws.filter((d) => d.stratum === id);
    expect(inStratum("a1")).toHaveLength(50);
    expect(inStratum("a1").every((d) => d.archetypeId === "a1")).toBe(true);
    const rest = inStratum(REST_OF_FIELD);
    expect(rest).toHaveLength(20000);
    expect(new Set(rest.map((d) => d.archetypeId))).toEqual(new Set(["a2", "a3"]));
    const p = 0.3 / 0.5;
    const freq = rest.filter((d) => d.archetypeId === "a2").length / rest.length;
    expect(Math.abs(freq - p)).toBeLessThan(5 * Math.sqrt((p * (1 - p)) / rest.length));
  });
});

describe("id bridge failures", () => {
  const unmappedList = entryOf({ leader: "LA", cards: ["a1", "a2", "J24_005"], placement: 1, field: 12, event: "bad", name: "Wrecker list", key: "melee-bad" });
  const bridge = (id: string) => id === "J24_005";
  const unmappedCards = (deck: { leader: { id: string }; base: { id: string }; deck: { id: string }[] }) =>
    [deck.leader.id, deck.base.id, ...deck.deck.map((e) => e.id)].filter(bridge);

  it("counts and names the lists by archetype, and counts the weight they hold", () => {
    const pool = syntheticPool([unmappedList], unmappedCards);
    const report = poolReport(pool);
    expect(report.unmappedLists).toBe(1);
    const a1 = report.archetypes.find((a) => a.id === "a1");
    expect(a1?.unmappedLists).toBe(1);
    expect(a1?.unmapped).toEqual([{ key: "melee-bad", name: "Wrecker list", ids: ["J24_005"] }]);
    expect(report.archetypes.find((a) => a.id === "a2")?.unmappedLists).toBe(0);
    expect(report.unmappedWeightShare).toBeGreaterThan(0);
    expect(report.lists).toBe(37);
  });

  it("sets a drawn unmapped list aside, redraws from the same archetype and reports every one", () => {
    const heavy = entryOf({ leader: "LA", cards: ["a1", "a2", "J24_005"], placement: 1, field: 1, event: "heavy", key: "melee-heavy" });
    const pool = syntheticPool([heavy], unmappedCards);
    const result = sampleProportional(pool, { seed: "redraw", n: 3000 });
    expect(result.draws).toHaveLength(3000);
    expect(result.draws.every((d) => d.unmapped.length === 0)).toBe(true);
    expect(result.skippedUnmapped.length).toBeGreaterThan(0);
    expect(result.skippedUnmapped.every((s) => s.key === "melee-heavy" && s.unmapped.join() === "J24_005" && s.archetypeId === "a1")).toBe(true);
    const a1Draws = result.draws.filter((d) => d.archetypeId === "a1").length / result.draws.length;
    expect(Math.abs(a1Draws - 0.5)).toBeLessThan(0.05);
  });

  it("keeps the flagged list when asked to keep unmapped lists", () => {
    const heavy = entryOf({ leader: "LA", cards: ["a1", "J24_005"], placement: 1, field: 1, event: "heavy", key: "melee-heavy" });
    const pool = syntheticPool([heavy], unmappedCards);
    const kept = sampleProportional(pool, { seed: "keep", n: 2000, unmapped: "keep" });
    expect(kept.skippedUnmapped).toEqual([]);
    expect(kept.draws.some((d) => d.unmapped.join() === "J24_005")).toBe(true);
  });

  it("names an archetype with no buildable list instead of drawing from it", () => {
    const meta = metaOf([
      { id: "p1", leader: "LA", share: 0.7, core: ["a1"] },
      { id: "p2", leader: "LB", share: 0.3, core: ["b1"] },
    ]);
    const entries = [entryOf({ leader: "LA", cards: ["a1"] }), entryOf({ leader: "LB", cards: ["b1", "J24_005"] })];
    const pool = buildPool({ meta, entries, counts, cardKeyOf, unmappedCards });
    const result = sampleProportional(pool, { seed: "s", n: 50 });
    expect(result.unplayableArchetypes).toEqual(["p2"]);
    expect(result.draws.every((d) => d.archetypeId === "p1")).toBe(true);
  });

  it("checks ids against the engine set-code map when one is given", () => {
    const check = engineUnmappedCards(new Set(["L1", "B1", "c1"]));
    expect(check({ leader: { id: "L1", count: 1 }, base: { id: "B1", count: 1 }, deck: [{ id: "c1", count: 3 }, { id: "J24_005", count: 1 }, { id: "J24_005", count: 2 }] })).toEqual(["J24_005"]);
  });

  it("reports lists with no archetype by name and reason", () => {
    const orphan = entryOf({ leader: "LZ", cards: ["z1"], key: "melee-orphan", name: "Orphan" });
    const pool = syntheticPool([orphan]);
    const report = poolReport(pool);
    expect(report.unassigned.count).toBe(1);
    expect(report.unassigned.byReason).toEqual({ "no-archetype": 1 });
    expect(report.unassigned.lists[0]).toMatchObject({ key: "melee-orphan", name: "Orphan", reason: "no-archetype" });
  });
});

describe("deck panel", () => {
  it("takes the highest-placing list of each of the top archetypes, a bigger event's winner first", () => {
    const small = entryOf({ leader: "LA", cards: ["a1", "a2", "a3"], placement: 1, field: 20, event: "small", key: "melee-small" });
    const big = entryOf({ leader: "LA", cards: ["a1", "a2", "a3"], placement: 1, field: 500, event: "big", key: "melee-big" });
    const pool = syntheticPool([small, big]);
    const panel = deckPanel(pool, { top: 2 });
    expect(panel.map((p) => p.archetypeId)).toEqual(["a1", "a2"]);
    expect(panel[0].list?.key).toBe("melee-big");
    expect(panel[1].list?.placement).toBe(1);
  });

  it("skips an unbuildable winner, naming it", () => {
    const winner = entryOf({ leader: "LA", cards: ["a1", "J24_005"], placement: 1, field: 900, event: "huge", key: "melee-huge", name: "Huge winner" });
    const pool = syntheticPool([winner], (d) => d.deck.map((e) => e.id).filter((id) => id === "J24_005"));
    const first = deckPanel(pool, { top: 1 })[0];
    expect(first.list?.key).not.toBe("melee-huge");
    expect(first.skippedUnmapped).toEqual([{ key: "melee-huge", name: "Huge winner", unmapped: ["J24_005"] }]);
  });
});

describe("named list", () => {
  it("returns the list the caller names and fails on an unknown name", () => {
    const pool = syntheticPool();
    const key = (pool.byArchetype.get("a2") ?? [])[0].key;
    const draw = namedDraw(pool, key);
    expect(draw.list.key).toBe(key);
    expect(draw.archetypeId).toBe("a2");
    expect(draw.source).toContain("mode=named");
    expect(() => namedDraw(pool, "melee-missing")).toThrow(/no list named/);
  });
});

describe("archetype assignment", () => {
  const archetypes = tournamentArchetypes(
    metaOf([
      { id: "v1", leader: "LA", share: 0.2, core: ["x1", "x2", "x3"], baseAspects: ["Vigilance"] },
      { id: "v2", leader: "LA", share: 0.1, core: ["y1", "y2", "y3"], baseAspects: ["Vigilance"] },
      { id: "c1", leader: "LA", share: 0.05, core: ["x1", "x2", "x3"], baseAspects: ["Command"] },
    ]),
  );
  const byLeader = new Map<string, ArchetypeInfo[]>([["K-LA", archetypes]]);
  const keys = (...ids: string[]) => new Set(ids.map((i) => `K-${i}`));

  it("picks the archetype whose core the list covers best", () => {
    expect(assignArchetype(byLeader, "K-LA", { key: null, aspects: "Vigilance" }, keys("y1", "y2", "y3", "q"))).toBe("v2");
    expect(assignArchetype(byLeader, "K-LA", { key: null, aspects: "Vigilance" }, keys("x1", "x2", "q"))).toBe("v1");
  });

  it("keeps a list in the archetypes of its own base aspect", () => {
    expect(assignArchetype(byLeader, "K-LA", { key: null, aspects: "Command" }, keys("x1", "x2", "x3"))).toBe("c1");
  });

  it("returns null for a leader with no archetype", () => {
    expect(assignArchetype(byLeader, "K-NOPE", { key: null, aspects: null }, keys("x1"))).toBeNull();
  });
});

describe("reading a snapshot", () => {
  const root = path.resolve("tmp");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "opp-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const file = (name: string, source: string, createdAt: string, extra: Record<string, unknown> = {}) =>
    writeFileSync(
      path.join(dir, name),
      JSON.stringify({
        metadata: { source, via: "t", format: "premier", createdAt, name: `deck ${name}`, event: { id: 7, name: "Event", players: 40 }, placement: 3, author: "never read", ...extra },
        leader: { id: "L1", count: 1 },
        base: { id: "B1", count: 1 },
        deck: [{ id: "c1", count: 3 }],
      }),
    );

  it("reads only melee tournament lists inside the window and counts every other file by reason", () => {
    file("melee-in.json", "melee", "2026-09-01T10:00:00.000Z");
    file("melee-old.json", "melee", "2026-01-01T10:00:00.000Z");
    file("melee-eternal.json", "melee", "2026-09-01T10:00:00.000Z", { format: "eternal" });
    file("melee-noplace.json", "melee", "2026-09-01T10:00:00.000Z", { placement: null });
    file("swudb-1.json", "swudb", "2026-09-01T10:00:00.000Z");
    file("karabast-1.json", "karabast", "2026-09-01T10:00:00.000Z");
    writeFileSync(path.join(dir, "manifest.json"), "{}");
    const { entries, counts: read } = readSnapshotEntries(dir, { from: "2026-07-20", to: "2026-10-17" });
    expect(entries.map((e) => e.key)).toEqual(["melee-in"]);
    expect(entries[0]).toMatchObject({ placement: 3, name: "deck melee-in.json", event: { key: "t:7", players: 40 } });
    expect(JSON.stringify(entries)).not.toContain("never read");
    expect(read).toMatchObject({ files: 6, melee: 3, nonMelee: 2, nonPremier: 1, outOfWindow: 1, noPlacement: 1 });
  });

  it("refuses a directory of Karabast data", () => {
    const karabast = path.join(dir, "karabast-games");
    mkdirSync(karabast);
    expect(() => readSnapshotEntries(karabast, { from: "2026-07-20", to: "2026-10-17" })).toThrow(/Karabast/);
  });

  it("rejects an archetypes file that is not the strict meta schema", () => {
    const bad = path.join(dir, "archetypes.json");
    writeFileSync(bad, JSON.stringify({ schemaVersion: 1, archetypes: [] }));
    return import("../../src/sims/opponents.js").then(({ loadOpponentPool }) => {
      expect(() => loadOpponentPool({ archetypesFile: bad, decksDir: dir, cardKeyOf })).toThrow();
    });
  });
});

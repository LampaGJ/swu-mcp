import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { createSynergyContext } from "../../src/synergy/context.js";
import type { ToolResult } from "../../src/tools.js";
import { findTrios } from "../../src/tools/synergy.js";
import { mk, table } from "./fixtures.js";

function body(result: ToolResult): Record<string, any> {
  expect(result.isError, result.content[0].text.slice(0, 300)).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

const line = (...keys: string[]) => keys.map((card) => ({ card, count: 1 }));
const keysOf = (out: Record<string, any>): string[] => (out.trios as Record<string, any>[]).map((t) => t.cardKeys);
const call = (ctx: ReturnType<typeof createSynergyContext>, extra: Record<string, unknown> = {}) =>
  body(findTrios(ctx, { evidence: false, withAlternatives: false, limit: 10, traits: "exclude", ...extra }));

/** One chain per tag pair: a feeder offers the first tag, a middle card wants it and offers the second, an end card wants that. */
const chain = (tag: string, costs: [number, number, number], at = tag) => [
  mk(`${at}A`, `${at} feeder`, { aspects: ["Command"], cost: costs[0], offers: [`offers:${tag}1`] }),
  mk(`${at}B`, `${at} middle`, { aspects: ["Command"], cost: costs[1], wants: [`wants:${tag}1`], offers: [`offers:${tag}2`] }),
  mk(`${at}C`, `${at} payoff`, { aspects: ["Command"], cost: costs[2], wants: [`wants:${tag}2`] }),
];
const rowsFor = (...tags: string[]) =>
  table(tags.flatMap((t) => [1, 2].map((n) => ({ id: `${t}${n}`, offers: { [`offers:${t}${n}`]: 1 }, wants: { [`wants:${t}${n}`]: 1 } }))));

describe("find_trios anchors to the given decklist (#159, D71)", () => {
  const cards = [...chain("p", [0, 0, 1]), ...chain("q", [2, 2, 2]), ...chain("r", [3, 3, 3])];
  const ctx = createSynergyContext(cards, rowsFor("p", "q", "r"));

  it("ranks by score alone without a decklist, cheapest first", () => {
    expect(keysOf(call(ctx))).toEqual(["pA|pB|pC", "qA|qB|qC", "rA|rB|rC"]);
  });

  it("puts the trios that hold deck cards first, the ones holding more of them before the ones holding fewer", () => {
    const out = call(ctx, { decklist: line("qC", "rA", "rB") });
    expect(keysOf(out)).toEqual(["rA|rB|rC", "qA|qB|qC", "pA|pB|pC"]);
    expect((out.trios as Record<string, any>[]).map((t) => t.deckMembers)).toEqual([2, 1, 0]);
  });

  it("reports no deckMembers without a decklist", () => {
    expect(call(ctx).trios[0]).not.toHaveProperty("deckMembers");
  });

  it("finds a trio that holds a deck card though 100 better-scored trios of one shape crowd it out of the plain search", () => {
    const crowd = Array.from({ length: 6 }, (_, i) => mk(`xA${i}`, `x feeder ${i}`, { aspects: ["Command"], cost: 0, offers: ["offers:x1"] }));
    const mids = Array.from({ length: 5 }, (_, i) => mk(`xB${i}`, `x middle ${i}`, { aspects: ["Command"], cost: 0, wants: ["wants:x1"], offers: ["offers:x2"] }));
    const ends = Array.from({ length: 5 }, (_, i) => mk(`xC${i}`, `x payoff ${i}`, { aspects: ["Command"], cost: 0, wants: ["wants:x2"] }));
    const wide = createSynergyContext([...crowd, ...mids, ...ends, ...chain("r", [3, 3, 3])], rowsFor("x", "r"));
    expect(wide.trios({ accept: () => true }).trios.chain.some((t) => t.cardA === "rA")).toBe(false);
    expect(keysOf(call(wide, { limit: 3 }))).not.toContain("rA|rB|rC");
    expect(keysOf(call(wide, { limit: 3, decklist: line("rB") }))[0]).toBe("rA|rB|rC");
  });
});

describe("find_trios ranks a trio that needs a host or trait the deck lacks after the others (#159, D71)", () => {
  const pilot = (key: string, title: string, cost: number) =>
    mk(key, title, { aspects: ["Command"], cost, traits: ["Pilot"], keywords: ["Piloting"], offers: ["offers:upgrade-to-attach"] });
  const cards = [
    pilot("PA", "Pilot feeder", 0),
    mk("PB", "Upgrade wanter", { aspects: ["Command"], cost: 0, wants: ["wants:upgrades-attached"], offers: ["offers:v2"] }),
    mk("PC", "Upgrade payoff", { aspects: ["Command"], cost: 0, wants: ["wants:v2"] }),
    ...chain("q", [3, 3, 3]),
  ];
  const t = table([
    { id: "up", offers: { "offers:upgrade-to-attach": 1 }, wants: { "wants:upgrades-attached": 1 } },
    { id: "v2", offers: { "offers:v2": 1 }, wants: { "wants:v2": 1 } },
    ...[1, 2].map((n) => ({ id: `q${n}`, offers: { [`offers:q${n}`]: 1 }, wants: { [`wants:q${n}`]: 1 } })),
  ]);
  const ctx = createSynergyContext([...cards, mk("VH", "A Vehicle", { aspects: ["Command"], cost: 6, traits: ["Vehicle"] })], t);

  it("is the cheapest trio and first without a decklist", () => {
    expect(keysOf(call(ctx))[0]).toBe("PA|PB|PC");
    expect(call(ctx).trios[0]).not.toHaveProperty("needsHost");
  });

  it("flags the Pilot trio needsHost: Vehicle and ranks it after the trio without that need, though both hold a deck card", () => {
    const out = call(ctx, { decklist: line("PC", "qA") });
    expect(keysOf(out)).toEqual(["qA|qB|qC", "PA|PB|PC"]);
    expect(out.trios[0]).not.toHaveProperty("needsHost");
    expect(out.trios[1]).toMatchObject({ needsHost: "Vehicle", deckMembers: 1 });
  });

  it("clears the need when a deck unit is a Vehicle, and the cheap Pilot trio ranks first again", () => {
    const out = call(ctx, { decklist: line("PC", "qA", "VH") });
    expect(keysOf(out)[0]).toBe("PA|PB|PC");
    expect(out.trios[0]).not.toHaveProperty("needsHost");
  });

  it("does not demote a Pilot trio when no decklist is given", () => {
    expect(keysOf(call(ctx, { limit: 2 }))).toContain("PA|PB|PC");
  });

  it("reads a trait gate against the decklist alone, with no leader: a trio whose member needs another Wookiee unit follows", () => {
    const gated = mk("GB", "Gated middle", {
      aspects: ["Command"],
      cost: 0,
      wants: ["wants:g1"],
      offers: ["offers:g2"],
      abilities: [{ repeat: "once_on_play", text: "If you control another Wookiee unit, draw a card." }],
    });
    const trioCards = [mk("GA", "Gated feeder", { aspects: ["Command"], cost: 0, offers: ["offers:g1"] }), gated, mk("GC", "Gated payoff", { aspects: ["Command"], cost: 0, wants: ["wants:g2"] }), ...chain("q", [3, 3, 3])];
    const gtable = rowsFor("g", "q");
    const without = call(createSynergyContext(trioCards, gtable), { decklist: line("GC", "qA") });
    expect(keysOf(without)).toEqual(["qA|qB|qC", "GA|GB|GC"]);
    expect(without.trios[1]).toMatchObject({ needsTrait: "Wookiee" });
    const wookiee = mk("WK", "A Wookiee", { aspects: ["Command"], cost: 5, traits: ["Wookiee"] });
    const met = call(createSynergyContext([...trioCards, wookiee], gtable), { decklist: line("GC", "qA", "WK") });
    expect(keysOf(met)[0]).toBe("GA|GB|GC");
    expect(met.trios[0]).not.toHaveProperty("needsTrait");
  });
});

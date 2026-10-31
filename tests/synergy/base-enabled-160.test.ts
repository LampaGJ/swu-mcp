import { describe, expect, it } from "vitest";
import type { PairGraph } from "../../src/synergy/graph.js";
import { baseEnabledOf } from "../../src/synergy/locks.js";
import type { PairEdge, PairRowHit } from "../../src/synergy/schema.js";
import { hasWeakClosingLink } from "../../src/synergy/slots.js";
import { mk } from "./fixtures.js";

const withText = (key: string, text: string) => mk(key, key, { abilities: [{ repeat: "constant", text }] });
const origin = mk("OT", "Origin Tree", { type: "Base", aspects: ["Command"], traits: ["Kashyyyk"] });
const jundland = mk("JW", "Jundland Wastes", { type: "Base", aspects: ["Command"], traits: ["Tatooine"] });

describe("baseEnabledOf (#160, D73)", () => {
  const soaring = withText("SC", "While you control a Kashyyyk base, this unit gains Ambush.");
  const rangers = withText("WR", "While you control another Wookiee unit or a Kashyyyk base, this unit gains Sentinel.");
  const cruiser = withText("SV", "If an opponent controls an Endor, Kashyyyk, Naboo, or Tatooine base, draw a card.");

  it("names the location and quotes the clause when the base meets it", () => {
    expect(baseEnabledOf(soaring, origin)).toEqual({ location: "Kashyyyk", clause: "While you control a Kashyyyk base, this unit gains Ambush." });
  });

  it("reads a base that is one alternative of a 'you control another X unit or a Y base' condition", () => {
    expect(baseEnabledOf(rangers, origin)?.location).toBe("Kashyyyk");
  });

  it("is silent under a base of another location, without a base, and for an opponent's base", () => {
    expect(baseEnabledOf(soaring, jundland)).toBeNull();
    expect(baseEnabledOf(soaring, undefined)).toBeNull();
    expect(baseEnabledOf(cruiser, origin)).toBeNull();
    expect(baseEnabledOf(withText("PL", "Draw a card."), origin)).toBeNull();
  });
});

describe("hasWeakClosingLink (#160, D73)", () => {
  const row = (baseId: string): PairRowHit => ({ row: baseId, baseId, offer: "offers:x", want: "wants:x", weight: 1, reason: "r" });
  const edge = (a: string, b: string, ...ids: string[]): PairEdge =>
    ({ a, b, rows: ids.map(row), link: 1, mechanicalLink: 1, traitLink: 0, linkKind: "mechanical", nonObvious: { aspects: 0, traits: 0, factor: 1 }, traitOnly: false, score: 1 }) as unknown as PairEdge;
  const graphOf = (...edges: PairEdge[]): PairGraph => ({ edgeByKey: new Map(edges.map((e) => [`${e.a}>${e.b}`, e])), conditionalByKey: new Map() }) as unknown as PairGraph;
  const trio = (shape: "chain" | "convergent-different-wants" | "loop") => ({ cardA: "A", cardB: "B", cardC: "C", shape });

  it("is weak when a chain ends on a ramp-threshold or bounce-replay row alone", () => {
    expect(hasWeakClosingLink(graphOf(edge("A", "B", "ready-reuse"), edge("B", "C", "ramp-threshold")), trio("chain"))).toBe(true);
    expect(hasWeakClosingLink(graphOf(edge("A", "B", "ready-reuse"), edge("B", "C", "bounce-replay")), trio("chain"))).toBe(true);
  });

  it("is not weak when the closing link is mechanical, even if the opening link is weak", () => {
    expect(hasWeakClosingLink(graphOf(edge("A", "B", "bounce-replay"), edge("B", "C", "ready-reuse")), trio("chain"))).toBe(false);
  });

  it("is not weak when the closing link also carries a mechanical row", () => {
    expect(hasWeakClosingLink(graphOf(edge("A", "B", "ready-reuse"), edge("B", "C", "ramp-threshold", "keyword-raid-payoff")), trio("chain"))).toBe(false);
  });

  it("reads both links into the payoff of a convergent trio", () => {
    expect(hasWeakClosingLink(graphOf(edge("A", "C", "keyword-raid-payoff"), edge("B", "C", "ramp-threshold")), trio("convergent-different-wants"))).toBe(true);
    expect(hasWeakClosingLink(graphOf(edge("A", "C", "keyword-raid-payoff"), edge("B", "C", "ready-reuse")), trio("convergent-different-wants"))).toBe(false);
  });
});

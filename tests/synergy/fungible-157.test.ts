import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { createSynergyContext } from "../../src/synergy/context.js";
import { jobShare } from "../../src/synergy/fungibility.js";
import { fungibleSubstitutes, type FungibleResolved } from "../../src/tools/synergy.js";
import type { ToolResult } from "../../src/tools.js";
import { COMMITTED_TABLE, mk } from "./fixtures.js";

function body(result: ToolResult): Record<string, any> {
  expect(result.isError, result.content[0].text.slice(0, 300)).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

const cardsOf = (out: Record<string, any>, tag: string): Record<string, any>[] =>
  out.roles.find((r: any) => r.tag === tag).substitutes.flatMap((g: any) => g.cards);

/** A unit whose single clause is the offer's source, so the role class keys on one timing and cost band. */
const pinger = (key: string, title: string, cost: number, extra: Record<string, unknown> = {}, text = `${title} text`) =>
  mk(key, title, {
    aspects: ["Command"],
    cost,
    offers: ["offers:damage-friendly-unit"],
    why: { "offers:damage-friendly-unit": `text: ${text}` },
    abilities: [{ repeat: "once_on_play", text, n: 1 }],
    ...extra,
  });

describe("fungible_substitutes honours the D59 lock (#157)", () => {
  const baseKash = mk("BK", "Kashyyyk Base", { type: "Base", icons: ["Command"], traits: ["Kashyyyk"] });
  const baseOther = mk("BO", "Other Base", { type: "Base", icons: ["Command"], traits: ["Endor"] });
  const leader = mk("LD", "Green Leader", { type: "Leader", icons: ["Command"], aspects: ["Command"] });
  const vigilant = mk("VU", "Vigilant Unit", { aspects: ["Vigilance"], cost: 4 });
  const cards = [
    leader,
    baseKash,
    baseOther,
    vigilant,
    pinger("slot", "Slot Pinger", 3),
    pinger("free", "Plain Pinger", 3),
    pinger("cheapLocked", "Naboo Pinger", 2, {}, "While you control a Naboo base, deal 1 damage to a unit."),
    pinger("gated", "Gated Pinger", 2, {}, "While you control another Vigilance unit, deal 1 damage to a unit."),
  ];
  const lockCtx = createSynergyContext(cards, COMMITTED_TABLE);
  const tag = "offers:damage-friendly-unit";
  const run = (extra: Record<string, unknown>, resolved?: FungibleResolved) =>
    body(fungibleSubstitutes(lockCtx, { cardKey: "slot", tag, evidence: false, ...extra }, new Map(), undefined, resolved));

  it("flags a card whose clause names a base the given base is not, and ranks it after the unlocked cards though it costs less", () => {
    const rows = cardsOf(run({ leader: "LD", base: "BO" }), tag);
    expect(rows.map((r) => r.cardKey)).toEqual(["free", "cheapLocked", "gated"]);
    expect(rows.find((r) => r.cardKey === "cheapLocked")?.baseLocked).toBe("Naboo");
    expect(rows.find((r) => r.cardKey === "gated")?.needsUnitAspect).toBe("Vigilance");
    expect(rows.find((r) => r.cardKey === "free")).not.toHaveProperty("baseLocked");
  });

  it("clears the base lock when the base is that location and the aspect lock when the deck holds a unit of the aspect", () => {
    const naboo = mk("BN", "Naboo Base", { type: "Base", icons: ["Command"], traits: ["Naboo"] });
    const withNaboo = createSynergyContext([...cards, naboo], COMMITTED_TABLE);
    const resolved: FungibleResolved = { deckKeys: new Set(["VU"]), deckCards: [vigilant] };
    const out = body(fungibleSubstitutes(withNaboo, { cardKey: "slot", tag, evidence: false, leader: "LD", base: "BN" }, new Map(), undefined, resolved));
    const rows = cardsOf(out, tag);
    expect(rows.map((r) => r.cardKey)).toEqual(["cheapLocked", "gated", "free"]);
    expect(JSON.stringify(rows)).not.toMatch(/baseLocked|needsUnitAspect/);
    expect(out.note ?? "").not.toContain("D59");
  });

  it("puts a group of locked cards after the groups that hold a usable one, and keeps the lock silent without a base", () => {
    const aggro = pinger("aggroLocked", "Aggro Naboo Pinger", 2, { aspects: ["Aggression"] }, "While you control a Naboo base, deal 1 damage to a unit.");
    const grouped = createSynergyContext([...cards, aggro], COMMITTED_TABLE);
    const out = body(fungibleSubstitutes(grouped, { cardKey: "slot", tag, evidence: false, leader: "LD", base: "BO", crossAspectOnly: false }));
    const groups = out.roles[0].substitutes.map((g: any) => g.aspects);
    expect(groups.at(-1)).toBe("Aggression");
    const silent = body(fungibleSubstitutes(lockCtx, { cardKey: "slot", tag, evidence: false, leader: "LD" }));
    expect(JSON.stringify(silent)).not.toMatch(/baseLocked|needsUnitAspect/);
  });

  it("flags a locked named candidate too", () => {
    const out = run({ leader: "LD", base: "BO", candidates: ["cheapLocked"] });
    expect(out.candidates[0]).toMatchObject({ cardKey: "cheapLocked", baseLocked: "Naboo" });
  });
});

describe("fungible_substitutes orders role classes by coverage and caps them (#157)", () => {
  const holder = (key: string, title: string, tags: string[]) => mk(key, title, { aspects: ["Command"], cost: 3, offers: tags });
  const coverCtx = createSynergyContext(
    [holder("s", "Slot Card", ["offers:a", "offers:b", "offers:c"]), holder("p", "Two Roles", ["offers:b", "offers:c"]), holder("q", "One Role", ["offers:a"])],
    COMMITTED_TABLE,
  );

  it("measures coverage as the share of the original's role tags a card also holds", () => {
    expect(jobShare(coverCtx.fungibility, "s", "p")).toBeCloseTo(2 / 3, 3);
    expect(jobShare(coverCtx.fungibility, "s", "q")).toBeCloseTo(1 / 3, 3);
    expect(jobShare(coverCtx.fungibility, "s", "s")).toBe(1);
  });

  it("lists the class its best card covers most first, not the order the card carries its tags", () => {
    const out = body(fungibleSubstitutes(coverCtx, { cardKey: "s", evidence: false }));
    expect(out.roles.map((r: any) => r.tag)).toEqual(["offers:b", "offers:c", "offers:a"]);
    expect(out.roles.map((r: any) => r.coverage)).toEqual([0.667, 0.667, 0.333]);
    expect(out.classesTotal).toBe(3);
    expect(out.classesCut).toBe(0);
  });

  it("caps the classes at maxClasses (default 8) and says how many were cut", () => {
    const out = body(fungibleSubstitutes(coverCtx, { cardKey: "s", evidence: false, maxClasses: 2 }));
    expect(out.roles.map((r: any) => r.tag)).toEqual(["offers:b", "offers:c"]);
    expect(out.classesCut).toBe(1);
    expect(out.note).toContain("2 of 3 role classes are listed");
    expect(out.note).toContain("1 cut");
    const many = Array.from({ length: 10 }, (_, i) => `offers:t${String(i).padStart(2, "0")}`);
    const wide = createSynergyContext([holder("s", "Slot Card", many), holder("p", "Partner", many)], COMMITTED_TABLE);
    const capped = body(fungibleSubstitutes(wide, { cardKey: "s", evidence: false }));
    expect(capped.roles).toHaveLength(8);
    expect(capped.classesCut).toBe(2);
  });

  it("orders a class that holds no usable card after one that does, whatever the order of its tag", () => {
    const lockedHolder = mk("lk", "Locked Holder", {
      aspects: ["Command"],
      cost: 3,
      offers: ["offers:a", "offers:b", "offers:c"],
      abilities: [{ repeat: "static", text: "While you control a Naboo base, this does a thing." }],
    });
    const mixed = createSynergyContext(
      [
        mk("LD", "Green Leader", { type: "Leader", icons: ["Command"] }),
        mk("BO", "Other Base", { type: "Base", icons: ["Command"], traits: ["Endor"] }),
        holder("s", "Slot Card", ["offers:a", "offers:b", "offers:c"]),
        holder("q", "One Role", ["offers:a"]),
        lockedHolder,
      ],
      COMMITTED_TABLE,
    );
    const out = body(fungibleSubstitutes(mixed, { cardKey: "s", evidence: false, leader: "LD", base: "BO" }));
    expect(out.roles[0].tag).toBe("offers:a");
    expect(out.roles.map((r: any) => r.coverage)).toEqual([0.333, 0, 0]);
  });
});

describe("fungible_substitutes marks a partner of the original (#157)", () => {
  const elite = mk("4", "The Elite Squad", { aspects: ["Aggression"], cost: 8, wants: ["wants:damage-friendly"] });
  // Offers what the slot offers and wants what the slot offers: it lands in the slot's class and is fed by the slot.
  const hybrid = pinger("7", "Pinger Hybrid", 3, { wants: ["wants:damage-friendly"], why: { "offers:damage-friendly-unit": "text: Pinger Hybrid text", "wants:damage-friendly": "text: Pinger Hybrid text" } });
  const partnerCtx = createSynergyContext(
    [pinger("1", "Death Trooper", 3), pinger("3", "Pinger Green", 3), hybrid, elite],
    COMMITTED_TABLE,
  );
  const tag = "offers:damage-friendly-unit";

  it("needs the graph to hold the edge the marks quote", () => {
    expect(partnerCtx.graph.edgeByKey.has("3>4")).toBe(true);
    expect(partnerCtx.graph.edgeByKey.has("3>7")).toBe(true);
  });

  it("marks a named candidate the original feeds as fedByOriginal, with the edge's row, and says it is a partner", () => {
    const out = body(fungibleSubstitutes(partnerCtx, { cardKey: "3", tag, evidence: false, candidates: ["4", "1"] }));
    const [elitRow, plain] = [out.candidates.find((c: any) => c.cardKey === "4"), out.candidates.find((c: any) => c.cardKey === "1")];
    expect(elitRow.fedByOriginal).toBe(true);
    expect(elitRow.fedByRow).toMatch(/^[\w-]+: offers:damage-friendly-unit -> wants:damage-friendly$/);
    expect(elitRow).not.toHaveProperty("feedsOriginal");
    expect(plain).not.toHaveProperty("fedByOriginal");
    expect(out.note).toContain("Partners, not replacements: The Elite Squad is fed by Pinger Green");
  });

  it("marks a card that feeds the original as feedsOriginal", () => {
    const out = body(fungibleSubstitutes(partnerCtx, { cardKey: "4", evidence: false, candidates: ["3"] }));
    expect(out.candidates[0].feedsOriginal).toBe(true);
    expect(out.candidates[0].feedsRow).toContain("-> wants:damage-friendly");
    expect(out.note).toContain("Pinger Green feeds The Elite Squad");
  });

  // D69 moved the partner out of the role classes: the mark now sits on its row under partners, and the class lists the plain stand-in alone.
  it("marks a listed partner under partners and leaves it out of the role classes", () => {
    const out = body(fungibleSubstitutes(partnerCtx, { cardKey: "3", tag, evidence: false }));
    const rows = cardsOf(out, tag);
    expect(rows.map((r) => r.cardKey)).toEqual(["1"]);
    expect(out.partners.map((r: any) => r.cardKey)).toEqual(["7"]);
    expect(out.partners[0].fedByOriginal).toBe(true);
    expect(rows[0]).not.toHaveProperty("fedByOriginal");
  });
});

describe("fungible_substitutes exclude (#157)", () => {
  const exCtx = createSynergyContext([pinger("slot", "Slot Pinger", 3), pinger("a", "Alpha Pinger", 3), pinger("b", "Bravo Pinger", 3)], COMMITTED_TABLE);
  const tag = "offers:damage-friendly-unit";

  it("drops a rejected card from the substitutes and lists what was excluded", () => {
    const out = body(fungibleSubstitutes(exCtx, { cardKey: "slot", tag, evidence: false, exclude: ["a"] }));
    expect(cardsOf(out, tag).map((c) => c.cardKey)).toEqual(["b"]);
    expect(out.excluded).toBe("a");
  });

  it("reports an exclude entry that names no card instead of ignoring it", () => {
    const out = body(fungibleSubstitutes(exCtx, { cardKey: "slot", tag, evidence: false, exclude: ["nope"] }));
    expect(out.unresolvedExclude[0]).toMatchObject({ card: "nope", reason: "unknown" });
    expect(cardsOf(out, tag).map((c) => c.cardKey)).toEqual(["a", "b"]);
  });

  it("uses the resolved cardKeys the registered tool hands over, and keeps a named candidate evaluated", () => {
    const resolved: FungibleResolved = { deckKeys: new Set(), deckCards: [], exclude: ["b"], candidates: ["b"] };
    const out = body(fungibleSubstitutes(exCtx, { cardKey: "slot", tag, evidence: false, exclude: ["ignored"], candidates: ["ignored"] }, new Map(), undefined, resolved));
    expect(cardsOf(out, tag).map((c) => c.cardKey)).toEqual(["a"]);
    expect(out.candidates[0]).toMatchObject({ cardKey: "b", excluded: true, outsideBand: true });
  });
});

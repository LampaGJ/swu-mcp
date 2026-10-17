import { describe, expect, it } from "vitest";
import {
  buildFungibility,
  commonMembers,
  costBand,
  fungibilityStats,
  magnitudeBand,
  roleOf,
  roleSignatures,
  substitutesFor,
} from "../../src/synergy/fungibility.js";
import { mk } from "./fixtures.js";

const draw = (key: string, title: string, aspects: string[], cost: number, extra = {}) =>
  mk(key, title, {
    cost,
    aspects,
    offers: ["offers:draw"],
    why: { "offers:draw": `text: ${title} draws` },
    abilities: [{ repeat: "once_on_play", text: `${title} draws`, n: 1 }],
    ...extra,
  });

const cards = [
  draw("1", "Green Drawer", ["Command"], 2),
  draw("2", "Red Drawer", ["Aggression"], 3),
  draw("3", "Blue Drawer", ["Cunning"], 2),
  draw("4", "Second Green", ["Command"], 3),
  draw("5", "Expensive Drawer", ["Command"], 6),
  mk("6", "Per Attack Drawer", {
    cost: 2,
    aspects: ["Vigilance"],
    offers: ["offers:draw"],
    why: { "offers:draw": "text: Per Attack Drawer draws" },
    abilities: [{ repeat: "per_attack", text: "Per Attack Drawer draws", n: 1 }],
  }),
  mk("7", "Big Drawer", {
    cost: 2,
    aspects: ["Vigilance"],
    offers: ["offers:draw"],
    why: { "offers:draw": "text: Big Drawer draws" },
    abilities: [{ repeat: "once_on_play", text: "Big Drawer draws", n: 3 }],
  }),
  mk("8", "Event Drawer", {
    type: "Event",
    cost: 2,
    aspects: ["Vigilance"],
    offers: ["offers:draw"],
    why: { "offers:draw": "text: Event Drawer draws" },
    abilities: [{ repeat: "once_on_play", text: "Event Drawer draws", n: 1 }],
  }),
  mk("9", "Tribal", { offers: ["offers:is-trait-Rebel"], wants: ["wants:trait-Rebel"], traits: ["Rebel"] }),
];

describe("role signatures", () => {
  it("derives timing and magnitude from the ability that produced the tag", () => {
    expect(roleSignatures(cards[0])).toEqual([
      { tag: "offers:draw", side: "offers", typeGroup: "Unit", timing: "once_on_play", magnitude: "1", costBand: "2-3", target: "" },
    ]);
    expect(roleSignatures(cards[5])[0].timing).toBe("per_attack");
    expect(roleSignatures(cards[6])[0].magnitude).toBe("3+");
  });

  it("falls back to static when no ability produced the tag", () => {
    expect(roleSignatures(mk("s", "Static", { offers: ["offers:buff"] }))[0]).toMatchObject({ timing: "static", magnitude: "-" });
  });

  it("finds the ability through a trigger label", () => {
    const c = mk("w", "Wd", {
      offers: ["offers:has-when-defeated"],
      why: { "offers:has-when-defeated": "text: When Defeated" },
      abilities: [{ repeat: "once_on_defeat", text: "x", trigger: "when_defeated" }],
    });
    expect(roleSignatures(c)[0].timing).toBe("once_on_defeat");
  });

  it("skips trait tags", () => {
    expect(roleSignatures(cards[8])).toEqual([]);
  });

  it("bands cost and magnitude", () => {
    expect([null, 0, 1, 2, 3, 4, 5, 6, 9].map(costBand)).toEqual(["-", "0-1", "0-1", "2-3", "2-3", "4-5", "4-5", "6+", "6+"]);
    expect([1, 2, 3, 8, "var", undefined].map(magnitudeBand)).toEqual(["1", "2", "3+", "3+", "var", "-"]);
  });
});

describe("role classes", () => {
  const index = buildFungibility(cards);

  it("groups cards that share tag, type, timing, magnitude and cost band", () => {
    const cls = roleOf(index, "1", "offers:draw");
    expect(cls?.id).toBe("offers:draw|Unit|once_on_play|m1|c2-3");
    expect(cls?.members).toEqual(["1", "2", "3", "4"]);
  });

  it("separates by timing, magnitude, cost band and card type", () => {
    const ids = new Set(["1", "5", "6", "7", "8"].map((k) => roleOf(index, k, "offers:draw")?.id));
    expect(ids.size).toBe(5);
  });

  it("gives every class a sorted member list and sorts classes by id", () => {
    const ids = index.classes.map((c) => c.id);
    expect(ids).toEqual([...ids].sort());
    for (const c of index.classes) expect(c.members).toEqual([...c.members].sort());
  });

  it("reports class count and sizes", () => {
    const stats = fungibilityStats(index);
    expect(stats.classes).toBe(5);
    expect(stats.singletonClasses).toBe(4);
    expect(stats.classesWithSubstitutes).toBe(1);
    expect(stats.classesSpanningAspects).toBe(1);
    expect(stats.sizeBuckets["3-5"]).toBe(1);
    expect(stats.largest[0]).toEqual({ id: "offers:draw|Unit|once_on_play|m1|c2-3", size: 4, aspectSets: 3 });
    expect(stats.cardsWithRole).toBe(8);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(buildFungibility(cards))).toBe(JSON.stringify(index));
  });
});

describe("substitutes by aspect", () => {
  const index = buildFungibility(cards);
  const members = roleOf(index, "1", "offers:draw")?.members ?? [];

  it("groups the other members by aspect, different aspects first, and never lists the slot card", () => {
    const groups = substitutesFor(index, members, "1");
    expect(groups.map((g) => [g.aspects, g.differsFromSlot, g.cards.map((c) => c.cardKey)])).toEqual([
      ["Aggression", true, ["2"]],
      ["Cunning", true, ["3"]],
      ["Command", false, ["4"]],
    ]);
  });

  it("sorts groups the leader and base cover first", () => {
    const groups = substitutesFor(index, members, "1", { preferAspects: ["Cunning", "Heroism"] });
    expect(groups[0]).toMatchObject({ aspects: "Cunning", covered: true });
    expect(groups.slice(1).every((g) => g.covered === false)).toBe(true);
  });

  it("can drop the card's own aspects, cap cost and cap each group", () => {
    expect(substitutesFor(index, members, "1", { crossAspectOnly: true }).map((g) => g.aspects)).toEqual(["Aggression", "Cunning"]);
    expect(substitutesFor(index, members, "1", { maxCost: 2 }).flatMap((g) => g.cards.map((c) => c.cardKey))).toEqual(["3"]);
    const many = buildFungibility([...cards, draw("10", "Third Green", ["Command"], 2), draw("11", "Fourth Green", ["Command"], 2)]);
    const all = roleOf(many, "1", "offers:draw")?.members ?? [];
    const command = substitutesFor(many, all, "1", { perGroup: 1 }).find((g) => g.aspects === "Command");
    expect(command?.cards.map((c) => c.cardKey)).toEqual(["10"]);
  });

  it("skips a printing with the slot card's own title", () => {
    const twin = draw("1b", "Green Drawer", ["Aggression"], 2);
    const idx = buildFungibility([...cards, twin]);
    const groups = substitutesFor(idx, roleOf(idx, "1", "offers:draw")?.members ?? [], "1");
    expect(groups.flatMap((g) => g.cards.map((c) => c.cardKey))).not.toContain("1b");
  });

  it("intersects several roles for a slot that plays two", () => {
    const two = (key: string, title: string, aspects: string[]) =>
      mk(key, title, {
        aspects,
        offers: ["offers:draw"],
        wants: ["wants:self-damaged"],
        abilities: [{ repeat: "once_on_play", text: "x", n: 1 }],
      });
    const idx = buildFungibility([two("a", "A", ["Command"]), two("b", "B", ["Cunning"]), draw("c", "C", ["Aggression"], 2)]);
    const common = commonMembers(idx, "a", ["offers:draw", "wants:self-damaged"]);
    expect(common.members).toEqual(["a", "b"]);
    expect(commonMembers(idx, "a", ["offers:heal"]).members).toEqual([]);
  });
});

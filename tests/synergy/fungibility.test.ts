import { describe, expect, it } from "vitest";
import {
  buildFungibility,
  commonMembers,
  costBand,
  fungibilityStats,
  magnitudeBand,
  roleOf,
  roleSignatures,
  statsBand,
  substitutesFor,
  widenedSubstitutes,
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
      { tag: "offers:draw", side: "offers", typeGroup: "Unit", timing: "once_on_play", magnitude: "1", costBand: "2-3", target: "", arena: "" },
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

  it("carries a unit's own arena, sorted and joined, and leaves non-units empty", () => {
    const arenaOf = (type: string, arenas?: string[]) =>
      roleSignatures(mk("a", "A", { type, arenas, offers: ["offers:buff"] }))[0].arena;
    expect(arenaOf("Unit", ["Ground"])).toBe("ground");
    expect(arenaOf("Unit", ["Space"])).toBe("space");
    expect(arenaOf("Unit", ["Space", "Ground"])).toBe("ground+space");
    expect(arenaOf("Unit", [])).toBe("");
    expect(arenaOf("Unit")).toBe("");
    expect(arenaOf("Event", ["Ground"])).toBe("");
    expect(arenaOf("Leader", ["Space"])).toBe("");
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

  it("splits a Ground and a Space unit that share tag, type, timing, magnitude and cost band", () => {
    const sentinel = (key: string, arenas: string[], extra = {}) =>
      mk(key, `Wants Upgrades ${key}`, { cost: 3, arenas, wants: ["wants:upgrades-attached"], ...extra });
    const arenaIndex = buildFungibility([
      sentinel("g1", ["Ground"]),
      sentinel("g2", ["Ground"], { aspects: ["Command"] }),
      sentinel("s1", ["Space"]),
      mk("e1", "Event Wants Upgrades", { type: "Event", cost: 3, arenas: ["Ground"], wants: ["wants:upgrades-attached"] }),
    ]);
    const ground = roleOf(arenaIndex, "g1", "wants:upgrades-attached");
    const space = roleOf(arenaIndex, "s1", "wants:upgrades-attached");
    expect(ground?.id).toBe("wants:upgrades-attached|Unit|static|m-|c2-3|aground");
    expect(ground?.members).toEqual(["g1", "g2"]);
    expect(space?.id).toBe("wants:upgrades-attached|Unit|static|m-|c2-3|aspace");
    expect(space?.members).toEqual(["s1"]);
    expect(substitutesFor(arenaIndex, space?.members ?? [], "s1")).toEqual([]);
    expect(substitutesFor(arenaIndex, ground?.members ?? [], "g1").flatMap((g) => g.cards.map((c) => c.cardKey))).toEqual(["g2"]);
    expect(roleOf(arenaIndex, "e1", "wants:upgrades-attached")?.id).toBe("wants:upgrades-attached|Event|static|m-|c2-3");
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

describe("widened substitutes for a slot with no other class member", () => {
  const wants = (key: string, title: string, cost: number, extra: Record<string, unknown> = {}, n = 1) =>
    mk(key, title, {
      cost,
      aspects: ["Command"],
      arenas: ["Ground"],
      wants: ["wants:self-damaged"],
      why: { "wants:self-damaged": `text: ${title} wants` },
      abilities: [{ repeat: "static", text: `${title} wants`, n }],
      ...extra,
    });
  const slot = wants("s", "Lone Slot", 3);
  const keysOf = (r: ReturnType<typeof widenedSubstitutes>) => r?.groups.flatMap((g) => g.cards.map((c) => c.cardKey)).sort();

  it("relaxes the cost band to the adjacent bands first and reports it", () => {
    const index = buildFungibility([
      slot,
      wants("near", "Next Band", 5),
      wants("lower", "Lower Band", 1),
      wants("far", "Two Bands Away", 6),
      wants("space", "Other Arena", 4, { arenas: ["Space"] }),
      mk("ev", "Event Twin", { type: "Event", cost: 4, wants: ["wants:self-damaged"], why: { "wants:self-damaged": "text: x" } }),
      wants("mag", "Bigger Magnitude", 4, {}, 3),
    ]);
    const cls = roleOf(index, "s", "wants:self-damaged") as NonNullable<ReturnType<typeof roleOf>>;
    expect(cls.members).toEqual(["s"]);
    const widened = widenedSubstitutes(index, cls, "s");
    expect(widened?.widened).toBe("cost band");
    expect(keysOf(widened)).toEqual(["lower", "near"]);
  });

  it("ignores magnitude next, still inside the adjacent bands, the same arena and the same type", () => {
    const index = buildFungibility([
      slot,
      wants("mag", "Bigger Magnitude", 4, {}, 3),
      wants("space", "Other Arena", 4, { arenas: ["Space"] }, 3),
      wants("far", "Two Bands Away", 6, {}, 3),
    ]);
    const cls = roleOf(index, "s", "wants:self-damaged") as NonNullable<ReturnType<typeof roleOf>>;
    const widened = widenedSubstitutes(index, cls, "s");
    expect(widened?.widened).toBe("cost band + magnitude");
    expect(keysOf(widened)).toEqual(["mag"]);
  });

  it("keeps the timing, and returns null when nothing qualifies", () => {
    const index = buildFungibility([
      slot,
      wants("timing", "Other Timing", 3, { abilities: [{ repeat: "per_attack", text: "x", n: 1 }], why: { "wants:self-damaged": "text: x" } }),
    ]);
    const cls = roleOf(index, "s", "wants:self-damaged") as NonNullable<ReturnType<typeof roleOf>>;
    expect(widenedSubstitutes(index, cls, "s")).toBeNull();
  });

  it("applies the same options as the exact search", () => {
    const index = buildFungibility([slot, wants("near", "Next Band", 5)]);
    const cls = roleOf(index, "s", "wants:self-damaged") as NonNullable<ReturnType<typeof roleOf>>;
    expect(widenedSubstitutes(index, cls, "s", { maxCost: 4 })).toBeNull();
    expect(keysOf(widenedSubstitutes(index, cls, "s", { maxCost: 5 }))).toEqual(["near"]);
  });

  it("widens a null-cost slot only against null-cost cards", () => {
    const index = buildFungibility([
      mk("n", "No Cost", { cost: null, wants: ["wants:self-damaged"], why: { "wants:self-damaged": "text: x" } }),
      mk("c", "Costed", { cost: 2, wants: ["wants:self-damaged"], why: { "wants:self-damaged": "text: x" } }),
    ]);
    expect(widenedSubstitutes(index, roleOf(index, "n", "wants:self-damaged") as never, "n")).toBeNull();
  });
});

describe("keyword roles for units", () => {
  const unit = (key: string, keywords: string[], extra = {}) =>
    mk(key, `Unit ${key}`, { cost: 3, arenas: ["Ground"], power: 3, hp: 4, keywords, ...extra });

  it("gives a unit one keyword:<Keyword> role per printed keyword, keyed on type, arena, cost band and stats band", () => {
    expect(roleSignatures(unit("a", ["Sentinel"]))).toEqual([
      { tag: "keyword:Sentinel", side: "keyword", typeGroup: "Unit", timing: "static", magnitude: "-", costBand: "2-3", target: "", arena: "ground", statsBand: "7-9" },
    ]);
    expect(roleSignatures(unit("b", ["Sentinel", "Saboteur", "Sentinel"])).map((s) => s.tag)).toEqual(["keyword:Saboteur", "keyword:Sentinel"]);
  });

  it("reads the keywords list too, and skips a keyword the text only grants", () => {
    const fromList = {
      ...unit("l", []),
      keywords: [
        { keyword: "Raid", n: 1, granted: false },
        { keyword: "Overwhelm", granted: true },
        { keyword: "Sentinel", granted: false },
      ],
    };
    expect(roleSignatures(fromList).map((s) => s.tag)).toEqual(["keyword:Raid", "keyword:Sentinel"]);
  });

  it("gives non-units no keyword role", () => {
    expect(roleSignatures(unit("u", ["Grit"], { type: "Upgrade" }))).toEqual([]);
    expect(roleSignatures(unit("t", ["Grit"], { type: "Leader" }))).toEqual([]);
  });

  it("bands power plus HP", () => {
    expect([[0, 3], [1, 2], [2, 2], [3, 3], [3, 4], [4, 5], [5, 5], [6, 4], [null, 4], [3, null]].map(([p, h]) => statsBand(p, h))).toEqual([
      "0-3", "0-3", "4-6", "4-6", "7-9", "7-9", "10+", "10+", "-", "-",
    ]);
  });

  it("puts two Sentinels with the same arena, cost band and stats band in one class, and splits a Space Sentinel and another stats band", () => {
    const index = buildFungibility([
      unit("g1", ["Sentinel"]),
      unit("g2", ["Sentinel"], { aspects: ["Command"], cost: 2, power: 4, hp: 3 }),
      unit("s1", ["Sentinel"], { arenas: ["Space"] }),
      unit("big", ["Sentinel"], { power: 5, hp: 6 }),
      unit("raid", ["Raid"]),
    ]);
    const cls = roleOf(index, "g1", "keyword:Sentinel");
    expect(cls?.id).toBe("keyword:Sentinel|Unit|static|m-|c2-3|aground|s7-9");
    expect(cls?.members).toEqual(["g1", "g2"]);
    expect(roleOf(index, "s1", "keyword:Sentinel")?.members).toEqual(["s1"]);
    expect(roleOf(index, "big", "keyword:Sentinel")?.members).toEqual(["big"]);
    expect(roleOf(index, "raid", "keyword:Raid")?.members).toEqual(["raid"]);
  });

  it("lists the keyword role first when the text has no offers/wants tag or only a constant want", () => {
    const upgraded = unit("w", ["Sentinel"], {
      wants: ["wants:upgrades-attached"],
      why: { "wants:upgrades-attached": "text: While this unit is upgraded, he gains Saboteur." },
      abilities: [{ repeat: "constant", text: "While this unit is upgraded, he gains Saboteur." }],
    });
    const drawer = unit("d", ["Sentinel"], {
      offers: ["offers:draw"],
      why: { "offers:draw": "text: draws" },
      abilities: [{ repeat: "once_on_play", text: "draws", n: 1 }],
    });
    const eventful = unit("e", ["Sentinel"], {
      wants: ["wants:self-damaged"],
      why: { "wants:self-damaged": "text: Each time attacks, if damaged" },
      abilities: [{ repeat: "per_attack", text: "Each time attacks, if damaged" }],
    });
    const index = buildFungibility([upgraded, drawer, eventful, unit("plain", ["Sentinel"])]);
    const tagsOf = (key: string) => (index.rolesByCard.get(key) ?? []).map((id) => index.classById.get(id)?.tag);
    expect(tagsOf("w")).toEqual(["keyword:Sentinel", "wants:upgrades-attached"]);
    expect(tagsOf("d")).toEqual(["offers:draw", "keyword:Sentinel"]);
    expect(tagsOf("e")).toEqual(["wants:self-damaged", "keyword:Sentinel"]);
    expect(tagsOf("plain")).toEqual(["keyword:Sentinel"]);
  });

  it("widens a lone keyword class by the D39 steps: adjacent cost bands first, then the stats band", () => {
    const index = buildFungibility([
      unit("slot", ["Sentinel"]),
      unit("near", ["Sentinel"], { cost: 4, power: 4, hp: 4 }),
      unit("far", ["Sentinel"], { cost: 9, power: 4, hp: 4 }),
      unit("band", ["Sentinel"], { cost: 4, power: 6, hp: 6 }),
      unit("space", ["Sentinel"], { cost: 4, arenas: ["Space"] }),
    ]);
    const slotClass = roleOf(index, "slot", "keyword:Sentinel");
    const first = widenedSubstitutes(index, slotClass as NonNullable<typeof slotClass>, "slot");
    expect(first?.widened).toBe("cost band");
    expect(first?.groups.flatMap((g) => g.cards.map((c) => c.cardKey))).toEqual(["near"]);
    const only = buildFungibility([unit("slot", ["Sentinel"]), unit("band", ["Sentinel"], { cost: 4, power: 6, hp: 6 }), unit("space", ["Sentinel"], { cost: 4, arenas: ["Space"] })]);
    const second = widenedSubstitutes(only, roleOf(only, "slot", "keyword:Sentinel") as NonNullable<ReturnType<typeof roleOf>>, "slot");
    expect(second?.widened).toBe("cost band + stats band");
    expect(second?.groups.flatMap((g) => g.cards.map((c) => c.cardKey))).toEqual(["band"]);
  });
});

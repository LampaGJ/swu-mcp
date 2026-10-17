import { describe, expect, it } from "vitest";
import { buildPairGraph } from "../../src/synergy/graph.js";
import { COMMITTED_TABLE, mk } from "./fixtures.js";

const abilityText = (text: string) => [{ repeat: "always", text }];
const rowsOf = (cards: ReturnType<typeof mk>[], a: string, b: string): string[] =>
  buildPairGraph(cards, COMMITTED_TABLE).edgeByKey.get(`${a}>${b}`)?.rows.map((r) => r.row) ?? [];

const jediConsular = mk("P1", "Jedi Consular", {
  offers: ["offers:cheat-play"],
  why: { "offers:cheat-play": "text: Play a unit from your hand." },
  abilities: abilityText("Play a unit from your hand."),
  traits: ["Force", "Jedi"],
  aspects: ["Command"],
});
const luminara = mk("P2", "Luminara Unduli", {
  wants: ["wants:units-played"],
  why: { "wants:units-played": "When you play a unit" },
  traits: ["Force", "Jedi", "Republic"],
  aspects: ["Vigilance"],
});
const kelleran = mk("P3", "Kelleran Beq", {
  offers: ["offers:tutor-to-play"],
  why: { "offers:tutor-to-play": "text: Search the top 7 cards of your deck for a unit, reveal it, and play it." },
  abilities: abilityText("Search the top 7 cards of your deck for a unit, reveal it, and play it."),
  traits: ["Force", "Jedi"],
});
const reforge = mk("P4", "Reforge", {
  type: "Event",
  offers: ["offers:tutor-to-play"],
  why: { "offers:tutor-to-play": "text: search the top 8 cards of your deck for an upgrade that can attach to that unit, reveal it, and play it on that unit." },
  abilities: abilityText("search the top 8 cards of your deck for an upgrade that can attach to that unit, reveal it, and play it on that unit."),
});
const kyloUpgradePlay = mk("P5", "Lama Su", {
  type: "Leader",
  offers: ["offers:cheat-play"],
  why: { "offers:cheat-play": "text: Play an upgrade from your hand on a friendly non-Vehicle unit." },
  abilities: abilityText("Play an upgrade from your hand on a friendly non-Vehicle unit."),
});

const r2d2 = mk("Q1", "R2-D2", {
  offers: ["offers:upgrade-to-attach"],
  why: { "offers:upgrade-to-attach": "is an upgrade or Pilot" },
  traits: ["Droid", "Pilot", "Rebel"],
  aspects: ["Vigilance"],
});
const falcon = mk("Q2", "Millennium Falcon", {
  offers: ["offers:cheat-play"],
  why: { "offers:cheat-play": "text: You may play or deploy 1 additional Pilot on this unit." },
  abilities: abilityText("You may play or deploy 1 additional Pilot on this unit."),
  traits: ["Rebel", "Transport", "Vehicle"],
});
const camtono = mk("Q3", "Camtono", {
  type: "Upgrade",
  offers: ["offers:upgrade-to-attach"],
  why: { "offers:upgrade-to-attach": "is an upgrade or Pilot" },
  traits: ["Item"],
});
const redLeader = mk("Q4", "Red Leader", {
  wants: ["wants:pilot-attached"],
  why: { "wants:pilot-attached": "When a Pilot upgrade attaches to this unit" },
  traits: ["Fighter", "Rebel", "Vehicle"],
  aspects: ["Command"],
});
const anakin = mk("Q5", "Anakin Skywalker", {
  offers: ["offers:return-upgrade", "offers:upgrade-to-attach"],
  why: { "offers:return-upgrade": "epicAction: You may return this upgrade to its owner's hand.", "offers:upgrade-to-attach": "is an upgrade or Pilot" },
  traits: ["Force", "Pilot"],
});
const fullOfSurprises = mk("Q6", "Full of Surprises", {
  type: "Event",
  offers: ["offers:return-upgrade"],
  why: { "offers:return-upgrade": "text: Return an upgrade that costs 2 or less to its owner's hand." },
});

describe("play-trigger-payoff (units played)", () => {
  it("links a cheat-play unit to a 'when you play a unit' payoff", () => {
    expect(rowsOf([jediConsular, luminara], "P1", "P2")).toContain("play-trigger-payoff");
  });
  it("links a tutor that plays a unit", () => {
    expect(rowsOf([kelleran, luminara], "P3", "P2")).toContain("play-trigger-payoff");
  });
  it("does not link offers that play an upgrade", () => {
    expect(rowsOf([reforge, luminara], "P4", "P2")).not.toContain("play-trigger-payoff");
    expect(rowsOf([kyloUpgradePlay, luminara], "P5", "P2")).not.toContain("play-trigger-payoff");
  });
});

describe("pilot-attach-trigger and upgrade-return-reattach (pilot attached)", () => {
  it("links a Pilot that attaches to a 'when a Pilot attaches' payoff", () => {
    expect(rowsOf([r2d2, redLeader], "Q1", "Q4")).toContain("pilot-attach-trigger");
  });
  it("links a card that plays an extra Pilot", () => {
    expect(rowsOf([falcon, redLeader], "Q2", "Q4")).toContain("pilot-attach-trigger");
  });
  it("does not link a non-Pilot upgrade", () => {
    expect(rowsOf([camtono, redLeader], "Q3", "Q4")).toEqual([]);
  });
  it("links a returned Pilot upgrade that can attach again", () => {
    expect(rowsOf([anakin, redLeader], "Q5", "Q4")).toContain("upgrade-return-reattach");
    expect(rowsOf([fullOfSurprises, redLeader], "Q6", "Q4")).toContain("upgrade-return-reattach");
  });
  it("matches the documented example pairs to their rows", () => {
    const g = buildPairGraph([r2d2, redLeader, anakin, jediConsular, luminara], COMMITTED_TABLE);
    const byRow = new Map(g.exampleChecks.map((c) => [c.row, c.matches]));
    expect(byRow.get("play-trigger-payoff")).toBe(true);
    expect(byRow.get("pilot-attach-trigger")).toBe(true);
    expect(byRow.get("upgrade-return-reattach")).toBe(true);
  });
});

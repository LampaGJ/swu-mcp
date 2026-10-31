import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { createSynergyContext } from "../../src/synergy/context.js";
import { cutOrder, jobFamilyOf, KEEP_RULE, recommendKeep, type KeepCut, type KeepEntry } from "../../src/synergy/fungibility.js";
import type { SynergyCard } from "../../src/synergy/schema.js";
import { fungibleSubstitutes, type FungibleResolved } from "../../src/tools/synergy.js";
import type { ToolResult } from "../../src/tools.js";
import { mk, table } from "./fixtures.js";

function body(result: ToolResult): Record<string, any> {
  expect(result.isError, result.content[0].text.slice(0, 300)).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

describe("recommendKeep suggests the deck card to cut for a partner (#159, D71)", () => {
  const entry = (cardKey: string, penalty: number | null, fedBy: number, relationToFirst?: "feeds" | "fedBy"): KeepEntry => ({
    cardKey,
    label: cardKey.toUpperCase(),
    penalty,
    playShare: null,
    fedBy,
    ...(relationToFirst === undefined ? {} : { relationToFirst }),
  });
  const cut = (cardKey: string, penalty: number | null, playShare: number | null, deckLinks: number, feeds: string[] = []): KeepCut => ({ cardKey, label: cardKey.toUpperCase(), penalty, playShare, deckLinks, feeds });
  const keepOriginal = [entry("o", 2, 16), entry("c", 0, 0, "feeds")];

  it("picks the highest penalty, then the lowest play share, then the fewest deck links, then the title", () => {
    const pool = [cut("a", 0, null, 0), cut("b", 2, 0.4, 0), cut("c2", 2, 0.1, 5), cut("d", 2, 0.1, 1), cut("e", 2, 0.1, 1)];
    expect(recommendKeep(keepOriginal, pool).cutForCandidate?.cardKey).toBe("d");
    expect([...pool].sort(cutOrder).map((c) => c.cardKey)).toEqual(["d", "e", "c2", "b", "a"]);
    expect([cut("x", null, 0.2, 0), cut("y", 1, 0.9, 9)].sort(cutOrder)[0].cardKey).toBe("y");
    expect([cut("x", 2, null, 3), cut("y", 2, 0.02, 0)].sort(cutOrder)[0].cardKey).toBe("x");
  });

  it("never cuts the original or the candidate", () => {
    const pool = [cut("o", 9, null, 0), cut("c", 9, null, 0), cut("z", 0, 0.5, 4)];
    expect(recommendKeep(keepOriginal, pool).cutForCandidate?.cardKey).toBe("z");
  });

  it("never cuts a card with a pair edge into the original or into the candidate, however high its penalty", () => {
    const pool = [cut("f1", 2, null, 0, ["o"]), cut("f2", 2, null, 0, ["c"]), cut("f3", 2, null, 0, ["o", "c"]), cut("z", 0, 0.5, 4, ["other"])];
    expect(recommendKeep(keepOriginal, pool).cutForCandidate?.cardKey).toBe("z");
    expect(recommendKeep(keepOriginal, pool.slice(0, 3))).not.toHaveProperty("cutForCandidate");
    expect(recommendKeep(keepOriginal, pool.slice(0, 3)).sentence).not.toContain("make room");
  });

  it("says so in the verdict with the card's numbers", () => {
    const verdict = recommendKeep(keepOriginal, [cut("q", 2, null, 0)]);
    expect(verdict.sentence).toBe(
      "Keep O: 16 cards already in the deck feed it against 0 for C, a gap of at least 4 that outweighs its penalty 2, and C is a partner worth a slot elsewhere because it feeds O. To make room for C, cut Q (penalty 2, unplayed, 0 pair links to other deck cards).",
    );
    expect(recommendKeep(keepOriginal, [cut("q", null, 0.31, 2)]).sentence).toMatch(/cut Q \(31% of decks, 2 pair links to other deck cards\)\.$/);
    expect(recommendKeep(keepOriginal, [cut("q", 1, null, 1)]).sentence).toMatch(/cut Q \(penalty 1, unplayed, 1 pair link to other deck cards\)\.$/);
  });

  it("adds no cut when the candidate is no partner, when the candidate wins, or when no other deck card exists", () => {
    expect(recommendKeep([entry("o", 2, 16), entry("c", 0, 0)], [cut("q", 2, null, 0)])).not.toHaveProperty("cutForCandidate");
    expect(recommendKeep([entry("o", 2, 0), entry("c", 0, 0, "feeds")], [cut("q", 2, null, 0)])).toMatchObject({ keep: "c" });
    expect(recommendKeep([entry("o", 2, 0), entry("c", 0, 0, "feeds")], [cut("q", 2, null, 0)])).not.toHaveProperty("cutForCandidate");
    expect(recommendKeep(keepOriginal, [])).not.toHaveProperty("cutForCandidate");
    expect(recommendKeep(keepOriginal).sentence).not.toContain("make room");
  });

  it("states the cut order in the rule", () => {
    expect(KEEP_RULE).toContain("highest aspect penalty under the base, then the lowest play share");
  });

  it("reads every keyword want as one job", () => {
    expect(jobFamilyOf("wants:keyword-raid")).toBe("wants:keyword-*");
    expect(jobFamilyOf("wants:keyword-hidden")).toBe("wants:keyword-*");
    expect(jobFamilyOf("wants:extra-attacks")).toBe("wants:extra-attacks");
  });
});

describe("fungible_substitutes counts only the deck cards that feed the job compared (#159, D71)", () => {
  const leader = mk("LD", "Green Leader", { type: "Leader", icons: ["Command"], aspects: ["Command"] });
  const base = mk("BO", "Green Base", { type: "Base", icons: ["Command"] });
  const slot = mk("S", "Keyword Payoff", { aspects: ["Command"], cost: 5, offers: ["offers:buff"], wants: ["wants:keyword-raid", "wants:keyword-hidden", "wants:extra-attacks"] });
  const holder = (n: number) => mk(`H${n}`, `Raid Holder ${n}`, { aspects: ["Command"], cost: 2, offers: ["offers:has-keyword-raid"] });
  const ready = (n: number) => mk(`R${n}`, `Readier ${n}`, { aspects: ["Command"], cost: 3, offers: ["offers:ready-unit"] });
  const holders = [1, 2, 3, 4].map(holder);
  const readiers = [1, 2, 3].map(ready);
  const hidden = mk("C1", "Hidden Body", { aspects: ["Command"], cost: 1, offers: ["offers:has-keyword-hidden"] });
  const plain = mk("C2", "Plain Stand-in", { aspects: ["Command"], cost: 5, offers: ["offers:buff"] });
  const penalised = mk("P1", "Penalised Card", { aspects: ["Vigilance"], cost: 2 });
  const feeder = mk("P2", "A Feeding Penalised Card", { aspects: ["Vigilance"], cost: 2, offers: ["offers:has-keyword-hidden"] });
  const zapper = mk("P3", "A Zapping Penalised Card", { aspects: ["Vigilance"], cost: 2, offers: ["offers:zap"] });
  const zapped = mk("P4", "A Zapped Penalised Card", { aspects: ["Vigilance"], cost: 2, wants: ["wants:zap"] });
  const t = table([
    { id: "keyword-payoff", offers: { "offers:has-keyword-raid": 1, "offers:has-keyword-hidden": 1 }, wants: { "wants:keyword-raid": 1, "wants:keyword-hidden": 1 } },
    { id: "zap", offers: { "offers:zap": 1 }, wants: { "wants:zap": 1 } },
    { id: "ready-reuse", offers: { "offers:ready-unit": 1 }, wants: { "wants:extra-attacks": 1 } },
  ]);
  const ctx = createSynergyContext([leader, base, slot, ...holders, ...readiers, hidden, plain, penalised, feeder, zapper, zapped], t);
  const deckOf = (...extra: SynergyCard[]): FungibleResolved => {
    const cards = [slot, ...holders, ...readiers, penalised, ...extra];
    return { deckKeys: new Set(cards.map((c) => c.cardKey)), deckCards: cards };
  };
  const call = (candidates: string[], deck: FungibleResolved = deckOf()) =>
    body(fungibleSubstitutes(ctx, { cardKey: "S", evidence: false, leader: "LD", base: "BO", candidates }, new Map(), undefined, deck));

  it("has an edge from every holder and every readier into the slot, so the counts below mean something", () => {
    for (const d of [...holders, ...readiers]) expect(ctx.graph.edgeByKey.has(`${d.cardKey}>S`), d.title).toBe(true);
  });

  it("counts the keyword holders for a candidate that feeds the keyword want, and not the readiers", () => {
    const rec = call(["C1"]).recommendation;
    expect(rec.feederJob).toBe("wants:keyword-*");
    const original = rec.cards.find((c: any) => c.role === "original");
    expect(original.fedByDeck).toBe(4);
    expect(original.fedByCards).toBe("Raid Holder 1; Raid Holder 2; Raid Holder 3; Raid Holder 4");
    expect(rec.keep).toBe("S");
    expect(rec.decidedBy).toBe("deckFeeders");
  });

  it("counts every mechanical edge as before when the candidate is no partner of the original", () => {
    const rec = call(["C2"]).recommendation;
    expect(rec).not.toHaveProperty("feederJob");
    expect(rec.cards.find((c: any) => c.role === "original").fedByDeck).toBe(7);
    expect(rec).not.toHaveProperty("cutForCandidate");
    expect(rec.verdict).not.toContain("make room");
  });

  it("keeps the original, names the partner and suggests the deck card with the highest penalty to cut", () => {
    const rec = call(["C1"]).recommendation;
    expect(rec.cutForCandidate).toEqual({ cardKey: "P1", title: "Penalised Card", aspects: "Vigilance", penalty: 2, playShare: null, deckLinks: 0 });
    expect(rec.verdict).toContain("Hidden Body is a partner worth a slot elsewhere because it feeds Keyword Payoff.");
    expect(rec.verdict).toContain("To make room for Hidden Body, cut Penalised Card (penalty 2, unplayed, 0 pair links to other deck cards).");
  });

  it("breaks a penalty tie by the fewest links to the rest of the deck", () => {
    const rec = call(["C1"], deckOf(zapper, zapped)).recommendation;
    expect(ctx.graph.edgeByKey.has("P3>P4")).toBe(true);
    expect(rec.cutForCandidate).toMatchObject({ cardKey: "P1", deckLinks: 0 });
  });

  it("never suggests cutting a deck card that feeds the original, though it pays the same penalty and sorts first by title", () => {
    const rec = call(["C1"], deckOf(feeder)).recommendation;
    expect(ctx.graph.edgeByKey.has("P2>S")).toBe(true);
    expect(rec.cutForCandidate).toMatchObject({ cardKey: "P1" });
    expect(rec.verdict).not.toContain("A Feeding Penalised Card");
  });

  it("never suggests cutting a deck card that feeds the candidate", () => {
    const fedCandidate = mk("C3", "Fed Candidate", { aspects: ["Command"], cost: 1, offers: ["offers:has-keyword-hidden"], wants: ["wants:zap"] });
    const local = createSynergyContext([leader, base, slot, ...holders, ...readiers, fedCandidate, penalised, zapper], t);
    const cards = [slot, ...holders, ...readiers, penalised, zapper];
    const deck: FungibleResolved = { deckKeys: new Set(cards.map((c) => c.cardKey)), deckCards: cards };
    const rec = body(fungibleSubstitutes(local, { cardKey: "S", evidence: false, leader: "LD", base: "BO", candidates: ["C3"] }, new Map(), undefined, deck)).recommendation;
    expect(local.graph.edgeByKey.has("P3>C3")).toBe(true);
    expect(rec.cutForCandidate).toMatchObject({ cardKey: "P1" });
  });
});

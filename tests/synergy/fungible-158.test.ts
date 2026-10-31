import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { createSynergyContext } from "../../src/synergy/context.js";
import { KEEP_RULE, recommendKeep, type KeepEntry } from "../../src/synergy/fungibility.js";
import type { SynergyCard } from "../../src/synergy/schema.js";
import { fungibleSubstitutes, type FungibleResolved } from "../../src/tools/synergy.js";
import type { ToolResult } from "../../src/tools.js";
import { COMMITTED_TABLE, mk } from "./fixtures.js";

function body(result: ToolResult): Record<string, any> {
  expect(result.isError, result.content[0].text.slice(0, 300)).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

const tag = "offers:damage-friendly-unit";
const rolesCards = (out: Record<string, any>): Record<string, any>[] =>
  out.roles.flatMap((r: any) => r.substitutes.flatMap((g: any) => g.cards));

const pinger = (key: string, title: string, cost: number, extra: Record<string, unknown> = {}) =>
  mk(key, title, {
    aspects: ["Command"],
    cost,
    offers: ["offers:damage-friendly-unit"],
    why: { "offers:damage-friendly-unit": `text: ${title} text`, "wants:damage-friendly": `text: ${title} text` },
    abilities: [{ repeat: "once_on_play", text: `${title} text`, n: 1 }],
    ...extra,
  });

describe("fungible_substitutes splits partners from stand-ins (#158, D69)", () => {
  const elite = mk("4", "The Elite Squad", { aspects: ["Aggression"], cost: 8, wants: ["wants:damage-friendly"] });
  const hybrid = pinger("7", "Pinger Hybrid", 3, { wants: ["wants:damage-friendly"] });
  const ctx = createSynergyContext([pinger("1", "Death Trooper", 3), pinger("3", "Pinger Green", 3), hybrid, elite], COMMITTED_TABLE);
  const run = (extra: Record<string, unknown> = {}) => body(fungibleSubstitutes(ctx, { cardKey: "3", tag, evidence: false, ...extra }));

  it("lists a card with a pair edge to the original under partners and every other card under standIns", () => {
    const out = run();
    expect(out.partners.map((p: any) => p.cardKey)).toEqual(["7"]);
    expect(out.partners[0].fedByOriginal).toBe(true);
    expect(out.partners[0].fedByRow).toMatch(/offers:damage-friendly-unit -> wants:damage-friendly$/);
    expect(out.standIns.map((s: any) => s.cardKey)).toEqual(["1"]);
  });

  it("never lists a partner among the stand-ins or inside a role class", () => {
    const out = run({ candidates: ["4"] });
    const partnerKeys = new Set(out.partners.map((p: any) => p.cardKey));
    expect([...partnerKeys].sort()).toEqual(["4", "7"]);
    expect(out.standIns.some((s: any) => partnerKeys.has(s.cardKey))).toBe(false);
    expect(rolesCards(out).some((c) => partnerKeys.has(c.cardKey))).toBe(false);
    expect(rolesCards(out).map((c) => c.cardKey)).toEqual(["1"]);
  });

  it("keeps a named candidate that is a partner under partners though no role lists it, and in candidates as before", () => {
    const out = run({ candidates: ["4"] });
    expect(out.partners.find((p: any) => p.cardKey === "4")).toMatchObject({ fedByOriginal: true, candidate: true });
    expect(out.candidates.find((c: any) => c.cardKey === "4").fedByOriginal).toBe(true);
  });

  it("states the split in the note: partners work beside the original, stand-ins replace it", () => {
    const out = run();
    expect(out.note).toContain("Partners, not replacements: Pinger Hybrid is fed by Pinger Green");
    expect(out.note).toContain("standIns");
    expect(out.note).not.toContain("the answer to which one is both");
  });

  it("caps the partners at maxPartners, counts what was cut, and still lists a named candidate", () => {
    const many = Array.from({ length: 4 }, (_, i) => pinger(`h${i}`, `Hybrid ${i}`, 3, { wants: ["wants:damage-friendly"] }));
    const wide = createSynergyContext([pinger("3", "Pinger Green", 3), ...many, elite], COMMITTED_TABLE);
    const out = body(fungibleSubstitutes(wide, { cardKey: "3", tag, evidence: false, maxPartners: 2, candidates: ["4"] }));
    expect(out.partners).toHaveLength(3);
    expect(out.partners.some((p: any) => p.cardKey === "4")).toBe(true);
    expect(out.partnersTotal).toBe(5);
    expect(out.partnersCut).toBe(2);
  });

  it("measures a class's coverage over stand-ins only", () => {
    const only = createSynergyContext([pinger("3", "Pinger Green", 3), hybrid], COMMITTED_TABLE);
    const out = body(fungibleSubstitutes(only, { cardKey: "3", tag, evidence: false }));
    expect(out.standIns).toEqual([]);
    expect(out.partners.map((p: any) => p.cardKey)).toEqual(["7"]);
    expect(out.roles[0].coverage).toBe(0);
  });
});

describe("fungible_substitutes recommends which of the original and the candidates to keep (#158, D69)", () => {
  const leader = mk("LD", "Green Leader", { type: "Leader", icons: ["Command"], aspects: ["Command"] });
  const base = mk("BO", "Green Base", { type: "Base", icons: ["Command"] });
  const slot = pinger("S", "Slot Pinger", 3, { wants: ["wants:damage-friendly"] });
  const deckPingers = [1, 2, 3, 4].map((n) => pinger(`D${n}`, `Deck Pinger ${n}`, 5));
  const plain = pinger("C1", "Plain Candidate", 3);
  const fed = pinger("C2", "Fed Candidate", 3, { wants: ["wants:damage-friendly"] });
  const offAspect = pinger("C3", "Off Aspect Candidate", 3, { aspects: ["Vigilance"], wants: ["wants:damage-friendly"] });
  const ctx = createSynergyContext([leader, base, slot, ...deckPingers, plain, fed, offAspect], COMMITTED_TABLE);
  const deckOf = (original: SynergyCard, feeders: number): FungibleResolved => {
    const cards = [original, ...deckPingers.slice(0, feeders)];
    return { deckKeys: new Set(cards.map((c) => c.cardKey)), deckCards: cards };
  };
  const call = (cardKey: string, candidates: string[], deck: FungibleResolved, context = ctx) =>
    body(fungibleSubstitutes(context, { cardKey, tag, evidence: false, leader: "LD", base: "BO", candidates }, new Map(), undefined, deck));

  it("needs a pair edge from each deck pinger into the slot for the counts below to mean anything", () => {
    for (const d of deckPingers) expect(ctx.graph.edgeByKey.has(`${d.cardKey}>S`)).toBe(true);
    expect(ctx.graph.edgeByKey.has("D1>C1")).toBe(false);
  });

  it("gives the three numbers for the original and the candidate and keeps the card the deck feeds by a gap of 4", () => {
    const rec = call("S", ["C1"], deckOf(slot, 4)).recommendation;
    const [orig, cand] = rec.cards;
    expect(orig).toMatchObject({ cardKey: "S", role: "original", penalty: 0, playShare: null, fedByDeck: 4 });
    expect(orig.fedByCards).toBe("Deck Pinger 1; Deck Pinger 2; Deck Pinger 3; Deck Pinger 4");
    expect(cand).toMatchObject({ cardKey: "C1", role: "candidate", penalty: 0, fedByDeck: 0 });
    expect(rec.keep).toBe("S");
    expect(rec.decidedBy).toBe("deckFeeders");
    expect(rec.verdict).toContain("Keep Slot Pinger: 4 cards already in the deck feed it against 0 for Plain Candidate, a gap of at least 4");
    expect(rec.rule).toBe(KEEP_RULE);
    expect(KEEP_RULE).toContain("at least 4");
  });

  it("lets a gap of 4 outweigh the original's penalty and names the candidate that feeds it as a partner for a slot elsewhere", () => {
    const off = pinger("SO", "Off Slot", 3, { aspects: ["Vigilance"], wants: ["wants:damage-friendly"] });
    const offCtx = createSynergyContext([leader, base, off, ...deckPingers, plain], COMMITTED_TABLE);
    const rec = call("SO", ["C1"], deckOf(off, 4), offCtx).recommendation;
    expect(rec.cards[0]).toMatchObject({ penalty: 2, fedByDeck: 4 });
    expect(rec.keep).toBe("SO");
    expect(rec.decidedBy).toBe("deckFeeders");
    expect(rec.verdict).toBe(
      "Keep Off Slot: 4 cards already in the deck feed it against 0 for Plain Candidate, a gap of at least 4 that outweighs its penalty 2, and Plain Candidate is a partner worth a slot elsewhere because it feeds Off Slot.",
    );
  });

  it("falls to the penalty when the feeder gap is 3", () => {
    const off = pinger("SO", "Off Slot", 3, { aspects: ["Vigilance"], wants: ["wants:damage-friendly"] });
    const offCtx = createSynergyContext([leader, base, off, ...deckPingers, plain], COMMITTED_TABLE);
    const rec = call("SO", ["C1"], deckOf(off, 3), offCtx).recommendation;
    expect(rec.cards[0]).toMatchObject({ penalty: 2, fedByDeck: 3 });
    expect(rec.keep).toBe("C1");
    expect(rec.decidedBy).toBe("penalty");
    expect(rec.verdict).toContain("the feeder gap is under 4 (0 against 3)");
    expect(rec.verdict).toContain("penalty 0 under the base against 2");
  });

  it("does not count the original as a feeder of its own replacement", () => {
    const rec = call("S", ["C2"], deckOf(slot, 4)).recommendation;
    expect(rec.cards.find((c: any) => c.cardKey === "C2").fedByDeck).toBe(4);
    expect(rec.decidedBy).toBe("tie");
    expect(rec.keep).toBe("S");
  });

  it("keeps the card with no penalty when the gap is small", () => {
    const rec = call("S", ["C3"], deckOf(slot, 2)).recommendation;
    expect(rec.cards.find((c: any) => c.cardKey === "C3").penalty).toBe(2);
    expect(rec.keep).toBe("S");
    expect(rec.decidedBy).toBe("penalty");
  });

  it("recommends the candidate when the original is the one that pays the penalty and the gap is small", () => {
    const off = createSynergyContext([leader, base, offAspect, ...deckPingers, fed], COMMITTED_TABLE);
    const out = call("C3", ["C2"], deckOf(offAspect, 2), off);
    expect(out.recommendation.keep).toBe("C2");
    expect(out.recommendation.decidedBy).toBe("penalty");
    expect(out.recommendation.verdict).toContain("Keep Fed Candidate");
  });

  it("gives no recommendation without a decklist or without candidates", () => {
    expect(call("S", ["C1"], { deckKeys: new Set(), deckCards: [] })).not.toHaveProperty("recommendation");
    const none = body(fungibleSubstitutes(ctx, { cardKey: "S", tag, evidence: false, leader: "LD", base: "BO" }, new Map(), undefined, deckOf(slot, 2)));
    expect(none).not.toHaveProperty("recommendation");
  });
});

describe("recommendKeep applies the stated rule (#158, D69)", () => {
  const entry = (cardKey: string, penalty: number | null, playShare: number | null, fedBy: number, relationToFirst?: "feeds" | "fedBy"): KeepEntry => ({
    cardKey,
    label: cardKey.toUpperCase(),
    penalty,
    playShare,
    fedBy,
    ...(relationToFirst === undefined ? {} : { relationToFirst }),
  });

  it("keeps the card 4 or more deck cards feed, else the lower penalty, else the higher play share, else the first entry", () => {
    expect(recommendKeep([entry("a", 2, null, 4), entry("b", 0, 0.9, 0)])).toMatchObject({ keep: "a", decidedBy: "deckFeeders" });
    expect(recommendKeep([entry("a", 2, null, 3), entry("b", 0, 0.9, 0)])).toMatchObject({ keep: "b", decidedBy: "penalty" });
    expect(recommendKeep([entry("a", 0, null, 2), entry("b", 0, 0.31, 1)])).toMatchObject({ keep: "b", decidedBy: "playShare" });
    expect(recommendKeep([entry("a", 0, 0.3, 2), entry("b", 0, 0.3, 1)])).toMatchObject({ keep: "a", decidedBy: "tie" });
  });

  it("skips the penalty step when a penalty is unknown and the play step when no share is known", () => {
    expect(recommendKeep([entry("a", null, null, 1), entry("b", null, 0.4, 2)])).toMatchObject({ keep: "b", decidedBy: "playShare" });
    expect(recommendKeep([entry("a", null, null, 1), entry("b", null, null, 5)])).toMatchObject({ keep: "b", decidedBy: "deckFeeders" });
    expect(recommendKeep([entry("a", 0, null, 1), entry("b", 0, null, 1)])).toMatchObject({ keep: "a", decidedBy: "tie" });
  });

  it("lets the earlier entry keep a tie when three entries meet", () => {
    expect(recommendKeep([entry("a", 0, null, 0), entry("b", 0, null, 0), entry("c", 2, null, 9)])).toMatchObject({ keep: "c", decidedBy: "deckFeeders" });
    expect(recommendKeep([entry("a", 0, null, 0), entry("b", 0, null, 0), entry("c", 0, null, 0)])).toMatchObject({ keep: "a", decidedBy: "tie" });
  });

  it("builds the sentence from the numbers only, with the partner clause only when the original wins over its partner", () => {
    expect(recommendKeep([entry("a", 0, null, 2), entry("b", 0, 0.31, 1)]).sentence).toBe(
      "Keep B: the feeder gap is under 4 (1 against 2), penalty ties (0), and the leader's lists play it in 31% of decks against unplayed for A.",
    );
    expect(recommendKeep([entry("a", 2, null, 16), entry("b", 0, null, 0, "feeds")]).sentence).toBe(
      "Keep A: 16 cards already in the deck feed it against 0 for B, a gap of at least 4 that outweighs its penalty 2, and B is a partner worth a slot elsewhere because it feeds A.",
    );
    expect(recommendKeep([entry("a", 2, null, 0), entry("b", 0, null, 0, "feeds")]).sentence).not.toContain("partner");
  });
});

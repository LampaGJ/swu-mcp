import { decode } from "@toon-format/toon";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { indexLeaderCards, leaderCardsFileSchema } from "../../src/meta/schema.js";
import { createSynergyContext } from "../../src/synergy/context.js";
import { engineHitOf, leaderEngineOf, readiesLeader, roleKeepOf, suppliedKeywords } from "../../src/synergy/leader-engine.js";
import { synergyCardsSchema, type SynergyCard } from "../../src/synergy/schema.js";
import type { ToolResult } from "../../src/tools.js";
import { findPairings, fungibleSubstitutes } from "../../src/tools/synergy.js";
import { COMMITTED_TABLE } from "./fixtures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Real feature records of The Warrior and the cards decision D60 names (scripts/meta/make-leader-engine-fixture.ts). */
const CARDS: SynergyCard[] = synergyCardsSchema.parse(
  (JSON.parse(readFileSync(path.join(HERE, "leader-engine-cards.json"), "utf8")) as { cards: unknown[] }).cards,
);
const card = (key: string): SynergyCard => CARDS.find((c) => c.cardKey === key) as SynergyCard;
const WARRIOR = "09010018";
const BOBA = "09010225";
const OPPO = "05010105";
const ANAKIN = "05010190";
const TRAYA = "06010188";
const CHEWBACCA = "09010117";
const CHIEFTAIN = "09010212";

const body = (result: ToolResult): Record<string, any> => {
  expect(result.isError, result.content[0].text).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
};

const leaderCards = (rows: [string, number][]) =>
  indexLeaderCards(
    leaderCardsFileSchema.parse({
      schemaVersion: 1,
      window: { from: "2026-07-20", to: "2026-10-17", days: 90 },
      weighting: "test weighting",
      baseline: "test baseline",
      maxCards: 150,
      leaders: [
        {
          leader: { cardKey: WARRIOR, title: "The Warrior", aspects: ["Cunning", "Heroism"] },
          population: "community",
          fallback: true,
          decks: 67,
          weight: 67,
          window: { from: "2026-07-20", to: "2026-10-17" },
          topBase: { cardKey: "09010028", title: "Jundland Wastes", decks: 50 },
          cards: rows.map(([cardKey, inclusion]) => ({ cardKey, title: cardKey, inclusion, meanCopies: 2, baselineInclusion: 0.1, lift: inclusion - 0.1 })),
        },
      ],
    }),
  );

describe("leaderEngineOf and engineHitOf (D60, #149)", () => {
  it("reads The Warrior's played-unit limit and granted keyword from its own clause", () => {
    expect(leaderEngineOf(card(WARRIOR))).toEqual({
      clause: "Play a unit with 3 or less power from your hand and give it Ambush for this phase.",
      playsUnitMaxPower: 3,
      grantsKeywords: ["Ambush"],
    });
    expect(leaderEngineOf(card(TRAYA))).toBeNull();
  });

  it("finds the partner whose text keys on a friendly unit with the granted keyword, and the units the action can play", () => {
    const engine = leaderEngineOf(card(WARRIOR));
    expect(engine).not.toBeNull();
    expect(engineHitOf(engine!, card(BOBA))).toMatchObject({ kind: "pays-off", keyword: "Ambush" });
    expect(engineHitOf(engine!, card(OPPO))).toMatchObject({ kind: "pays-off", keyword: "Ambush" });
    expect(engineHitOf(engine!, card(CHEWBACCA))).toMatchObject({ kind: "plays" });
    expect(engineHitOf(engine!, card("09010024"))).toBeNull();
    expect(engineHitOf({ ...engine!, playsUnitMaxPower: 0 }, card(ANAKIN))).toBeNull();
  });
});

describe("roleKeepOf (D60, #149)", () => {
  it("names a leader-readying card's job and keeps only cards that ready a leader", () => {
    expect(readiesLeader(card(TRAYA))).toBe(true);
    expect(readiesLeader(card(OPPO))).toBe(false);
    const keep = roleKeepOf(card(TRAYA), new Set());
    expect(keep?.families).toEqual(["ready-leader"]);
    expect(keep?.keptBy(card(TRAYA))).toEqual(["ready-leader"]);
    expect(keep?.keptBy(card(CHEWBACCA))).toEqual([]);
    expect(keep?.note).toContain("readies a leader");
  });

  it("names Oppo's job only for the keywords the deck or leader supplies", () => {
    const supplied = suppliedKeywords(leaderEngineOf(card(WARRIOR)), [card(BOBA), card("09010254")]);
    expect([...supplied].sort()).toEqual(["Ambush", "Raid", "Saboteur", "Shielded"]);
    const keep = roleKeepOf(card(OPPO), supplied);
    expect(keep?.families).toEqual(["grant-Ambush", "grant-Raid", "grant-Saboteur", "grant-Shielded"]);
    expect(keep?.keptBy(card(CHEWBACCA))).toEqual(["grant-Raid"]);
    expect(keep?.keptBy(card(ANAKIN))).toEqual([]);
    expect(roleKeepOf(card(OPPO), new Set())).toBeNull();
    expect(roleKeepOf(card(CHEWBACCA), supplied)?.families).toEqual(["grant-Raid"]);
  });
});

describe("find_pairings: the leader's own clause is a want source (#149)", () => {
  const ctx = createSynergyContext(CARDS, COMMITTED_TABLE, leaderCards([[CHEWBACCA, 0.5]]));
  const run = (extra: object) => body(findPairings(ctx, { cardKey: WARRIOR, limit: 20, ...extra }));

  it("lists Boba Fett, Family Found as a partner of The Warrior, ranked with the leader factor, naming the leader clause", () => {
    const out = run({ aspects: ["Cunning", "Heroism", "Command"] });
    const boba = out.pairings.find((p: { cardKey: string }) => p.cardKey === BOBA);
    expect(boba).toBeDefined();
    expect(boba.linkKind).toBe("leader-engine");
    expect(boba.reason).toContain("Play a unit with 3 or less power from your hand and give it Ambush for this phase.");
    expect(boba.reason).toContain("When a friendly unit with Ambush enters play");
    expect(boba.leaderInclusion).toBeNull();
    expect(boba.rank).toBeGreaterThanOrEqual(1.1);
    expect(out.tribal?.pairings.map((p: { cardKey: string }) => p.cardKey) ?? []).not.toContain(BOBA);
    expect(out.leader.engine).toMatchObject({ playsUnitMaxPower: 3, grantsKeywords: "Ambush" });
  });

  it("raises a played-by-the-action unit to at least the staple factor and names the clause in its reason", () => {
    const out = run({ aspects: ["Cunning", "Heroism", "Command"] });
    const withEdge = out.pairings.filter((p: { linkKind: string }) => p.linkKind !== "leader-engine");
    for (const p of withEdge.filter((r: { reason: string }) => r.reason.includes("Leader engine"))) expect(p.reason).toContain("Play a unit with 3 or less power");
  });

  it("leaves a call without leader weighting as it was", () => {
    const out = run({ weighting: "none", aspects: ["Cunning", "Heroism", "Command"] });
    expect(out.pairings.map((p: { cardKey: string }) => p.cardKey)).not.toContain(BOBA);
    expect(out.pairings.every((p: { linkKind: string }) => p.linkKind !== "leader-engine")).toBe(true);
  });

  it("keeps the leader-engine rows in every weighting mode when a leader is given; weighting none only drops the play-share factor (#154, D63)", () => {
    const given = { leader: WARRIOR, base: "09010024", aspects: ["Cunning", "Heroism", "Command"] };
    const engineKeys = (o: Record<string, any>): string[] =>
      o.pairings.filter((p: { linkKind: string }) => p.linkKind === "leader-engine").map((p: { cardKey: string }) => p.cardKey).sort();
    const weighted = run(given);
    const none = run({ ...given, weighting: "none" });
    expect(engineKeys(weighted)).toContain(BOBA);
    expect(engineKeys(none)).toEqual(engineKeys(weighted));
    const boba = none.pairings.find((p: { cardKey: string }) => p.cardKey === BOBA);
    expect(boba.reason).toContain("Play a unit with 3 or less power from your hand and give it Ambush for this phase.");
    expect(boba).not.toHaveProperty("leaderInclusion");
    expect(none.leader.engine).toMatchObject({ playsUnitMaxPower: 3, grantsKeywords: "Ambush" });
    expect(none.leader.note).toContain("weighting: none");
    expect(none.pairings.every((p: Record<string, unknown>) => !("leaderInclusion" in p))).toBe(true);
  });

  it("does not replace the supplied aspect set with the leader's top base", () => {
    const given = run({ aspects: ["Cunning", "Heroism", "Command"] });
    expect(given.leader).not.toHaveProperty("base");
    expect(given.leader).toMatchObject({ cardKey: WARRIOR, defaulted: true });
    expect(given.pairings.every((p: { aspectPair: string }) => p.aspectPair === "icons Cunning+Heroism+Command")).toBe(true);
    const bare = run({});
    expect(bare.leader.base).toMatchObject({ cardKey: "09010028", defaulted: true });
  });
});

describe("fungible_substitutes: named candidates, the deck, and the card's job (#149)", () => {
  const ctx = createSynergyContext(CARDS, COMMITTED_TABLE, leaderCards([[CHEWBACCA, 0.5]]));
  const deck = new Set([CHEWBACCA, CHIEFTAIN, BOBA]);
  const call = (extra: object, deckCards: SynergyCard[] = [card(CHEWBACCA), card(CHIEFTAIN), card(BOBA)]) =>
    body(fungibleSubstitutes(ctx, { cardKey: OPPO, evidence: false, ...extra }, new Map(), undefined, { deckKeys: new Set(deckCards.map((c) => c.cardKey)), deckCards }));
  const listed = (out: Record<string, any>): string[] => out.roles.flatMap((r: any) => r.substitutes.flatMap((g: any) => g.cards.map((c: any) => c.cardKey)));

  it("lists a named candidate outside the cost band with outsideBand true and the penalty it pays under the base, and the original's own penalty", () => {
    const out = call({ candidates: [ANAKIN], leader: WARRIOR, base: "09010024" });
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]).toMatchObject({ cardKey: ANAKIN, title: "Anakin Skywalker, Force Prodigy", cost: 1, outsideBand: true, penalty: 0 });
    expect(out.card).toMatchObject({ cardKey: OPPO, penalty: 2 });
    expect(out.suppliedIcons).toBe("Cunning+Heroism+Command");
  });

  it("shows a candidate's penalty when only preferAspects is given", () => {
    const out = call({ candidates: [ANAKIN], preferAspects: ["Command", "Command"] });
    expect(out.candidates[0]).toMatchObject({ cardKey: ANAKIN, penalty: 4 });
    expect(out.card.penalty).toBe(0);
  });

  it("excludes cards already in the deck from the substitutes when a decklist is given", () => {
    const without = call({}, []);
    expect(listed(without)).toEqual(expect.arrayContaining([CHEWBACCA, CHIEFTAIN, BOBA]));
    const out = call({});
    for (const k of deck) expect(listed(out)).not.toContain(k);
  });

  it("lists a candidate that is in the deck, marked inDeck, and says when one does not resolve", () => {
    const out = call({ candidates: [CHEWBACCA, "nope"] });
    expect(out.candidates.find((c: any) => c.cardKey === CHEWBACCA)).toMatchObject({ inDeck: true });
    expect(out.unresolvedCandidates).toEqual([expect.objectContaining({ card: "nope" })]);
  });

  it("keeps the unit's job: with the deck's keywords supplied only roles in Oppo's keyword-granting family remain, each substitute naming which", () => {
    const out = call({ leader: WARRIOR });
    expect(out.roleKept.families).toContain("grant-Ambush");
    for (const r of out.roles) expect(r.tag).toMatch(/^offers:grant-/);
    for (const k of listed(out)) expect(k).not.toBe(ANAKIN);
    const sub = out.roles.flatMap((r: any) => r.substitutes.flatMap((g: any) => g.cards))[0];
    if (sub !== undefined) expect(sub.keepsRole).toBeTruthy();
  });

  it("offers only cards that ready a leader for Darth Traya, or says none exist", () => {
    const out = body(fungibleSubstitutes(ctx, { cardKey: TRAYA, evidence: false, leader: WARRIOR }, new Map(), undefined, { deckKeys: new Set(), deckCards: [] }));
    expect(out.roleKept.families).toEqual(["ready-leader"]);
    expect(listed(out)).toEqual([]);
    expect(out.roleKept.none).toBe("no card in the pool readies a leader");
  });

  it("is unchanged without leader, base, candidates or decklist", () => {
    const plain = fungibleSubstitutes(ctx, { cardKey: OPPO, evidence: false }, new Map());
    expect(plain.content[0].text).not.toContain("roleKept");
    expect(plain.content[0].text).not.toContain("candidates");
  });
});

describe("find_pairings narrows the leader's lists to the given base (#148)", () => {
  const withSplit = indexLeaderCards(
    leaderCardsFileSchema.parse({
      schemaVersion: 1,
      window: { from: "2026-07-20", to: "2026-10-17", days: 90 },
      weighting: "test weighting",
      baseline: "test baseline",
      maxCards: 150,
      leaders: [
        {
          leader: { cardKey: WARRIOR, title: "The Warrior", aspects: ["Cunning", "Heroism"] },
          population: "community",
          fallback: true,
          decks: 30,
          weight: 30,
          window: { from: "2026-07-20", to: "2026-10-17" },
          topBase: { cardKey: "09010028", title: "Jundland Wastes", decks: 18 },
          cards: [{ cardKey: OPPO, title: OPPO, inclusion: 0.2, meanCopies: 2, baselineInclusion: 0.1, lift: 0.1 }],
          baseDecks: [
            { cardKey: "09010028", title: "Jundland Wastes", aspects: ["Aggression"], decks: 18 },
            { cardKey: "09010024", title: "Origin Tree", aspects: ["Command"], decks: 12 },
          ],
          splits: [
            {
              kind: "base",
              key: "09010024",
              label: "Origin Tree",
              decks: 12,
              weight: 12,
              cards: [{ cardKey: OPPO, title: OPPO, inclusion: 0.9, meanCopies: 3, baselineInclusion: 0.1, lift: 0.8 }],
            },
          ],
        },
      ],
    }),
  );
  const ctx = createSynergyContext(CARDS, COMMITTED_TABLE, withSplit);
  const run = (extra: object) => body(findPairings(ctx, { cardKey: WARRIOR, limit: 20, evidence: false, withAlternatives: false, ...extra }));
  const inclusionOf = (out: Record<string, any>) => out.pairings.find((p: { cardKey: string }) => p.cardKey === OPPO)?.leaderInclusion;

  it("weights by the Origin Tree lists when the base is given and 12 of them exist, and labels the population", () => {
    const out = run({ leader: WARRIOR, base: "09010024" });
    expect(inclusionOf(out)).toBe(0.9);
    expect(out.leader).toMatchObject({ decks: 12, base: { title: "Origin Tree" }, listsOfLeader: 30 });
    expect(out.leader.populationNote).toBe("12 Origin Tree lists of 30 community The Warrior lists");
  });

  it("reads the base from aspects that add one icon, and keeps all lists when no split reaches the floor, saying so", () => {
    const byAspects = run({ aspects: ["Cunning", "Heroism", "Command"] });
    expect(byAspects.leader).toMatchObject({ baseAspects: "Command" });
    const none = run({ leader: WARRIOR, aspects: ["Cunning", "Heroism", "Vigilance"] });
    expect(none.leader.populationNote).toContain("using all 30 The Warrior lists, 18 of which run Jundland Wastes (Aggression)");
  });
});

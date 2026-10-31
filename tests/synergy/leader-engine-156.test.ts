import { decode } from "@toon-format/toon";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { indexLeaderCards, leaderCardsFileSchema } from "../../src/meta/schema.js";
import { createSynergyContext } from "../../src/synergy/context.js";
import { engineHitOf, leaderActionOf, leaderEngineOf, readiesLeader, roleKeepOf } from "../../src/synergy/leader-engine.js";
import { synergyCardsSchema, type SynergyCard } from "../../src/synergy/schema.js";
import type { ToolResult } from "../../src/tools.js";
import { findPairings } from "../../src/tools/synergy.js";
import { COMMITTED_TABLE } from "./fixtures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Real feature records of The Warrior and the cards decision D60 names (scripts/meta/make-leader-engine-fixture.ts). */
const CARDS: SynergyCard[] = synergyCardsSchema.parse(
  (JSON.parse(readFileSync(path.join(HERE, "leader-engine-cards.json"), "utf8")) as { cards: unknown[] }).cards,
);
const card = (key: string): SynergyCard => CARDS.find((c) => c.cardKey === key) as SynergyCard;
const WARRIOR = "09010018";
const BOBA = "09010225";
const TRAYA = "06010188";
const CHEWBACCA = "09010117";
const OPPO = "05010105";
const ANAKIN = "05010190";

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

describe("the leader's Action and the cards that repeat it (#156, D65)", () => {
  it("reads The Warrior's Action that exhausts it, with the Action text", () => {
    expect(leaderActionOf(card(WARRIOR))).toMatch(/^Action \[1 resource, Exhaust\]: /);
    expect(leaderActionOf(card(TRAYA))).toBeNull();
  });

  it("makes a card that readies a leader an engine partner of a leader with an Action, and of no other", () => {
    expect(readiesLeader(card(TRAYA))).toBe(true);
    const action = leaderActionOf(card(WARRIOR));
    expect(engineHitOf(leaderEngineOf(card(WARRIOR)), card(TRAYA), action)).toMatchObject({ kind: "repeats-action", clause: action, partnerText: "You may ready a non-unit leader." });
    expect(engineHitOf(leaderEngineOf(card(WARRIOR)), card(TRAYA), null)).toMatchObject({ kind: "plays" });
    expect(engineHitOf(null, card(TRAYA), null)).toBeNull();
    expect(engineHitOf(null, card(OPPO), action)).toBeNull();
  });
});

describe("the engine factor needs a played partner (#156, D65)", () => {
  const aspects = ["Cunning", "Heroism", "Command"];
  const rankOf = (inclusion: number): { rank: number; score: number; leaderInclusion: number | null } => {
    const ctx = createSynergyContext(CARDS, COMMITTED_TABLE, leaderCards([[CHEWBACCA, 0.5], [BOBA, inclusion]]));
    const out = body(findPairings(ctx, { cardKey: WARRIOR, limit: 20, aspects, evidence: false, withAlternatives: false }));
    return out.pairings.find((p: { cardKey: string }) => p.cardKey === BOBA);
  };

  it("lifts a partner the leader's lists play at 5% to the staple factor and halves one they play at 1% (under the 2% floor)", () => {
    const played = rankOf(0.05);
    expect(played.leaderInclusion).toBe(0.05);
    expect(played.rank).toBeCloseTo(1.1 * played.score, 2);
    const under = rankOf(0.01);
    expect(under.rank).toBeLessThanOrEqual(under.score * 0.5 + 0.001);
  });
});

describe("roleKeepOf with offer jobs (#156, D65)", () => {
  it("keeps Oppo's keyword-granting job as before and adds no ready, draw or removal job to a unit that has none", () => {
    expect(roleKeepOf(card(OPPO), new Set(["Ambush"]), true)?.families).toEqual(["grant-Ambush"]);
    expect(roleKeepOf(card(ANAKIN), new Set(), true)).toBeNull();
  });

  it("names a unit that readies a unit as keeping that job, and leaves Darth Traya's stricter ready-leader job alone", () => {
    const neel = { ...card(ANAKIN), cardKey: "neel", type: "Unit", tags: { offers: [{ tag: "offers:ready-unit", why: "x" }], wants: [] } } as SynergyCard;
    const keep = roleKeepOf(neel, new Set(), true);
    expect(keep?.families).toEqual(["ready"]);
    expect(keep?.jobs).toEqual(["readies a unit"]);
    expect(keep?.keptBy(card(TRAYA))).toEqual(["ready"]);
    expect(keep?.keptBy(card(CHEWBACCA))).toEqual([]);
    expect(roleKeepOf(neel, new Set(), false)).toBeNull();
    expect(roleKeepOf(card(TRAYA), new Set(), true)?.families).toEqual(["ready-leader"]);
  });

  it("covers draw and removal offers", () => {
    const unit = (tag: string) => ({ ...card(ANAKIN), type: "Unit", tags: { offers: [{ tag, why: "x" }], wants: [] } }) as SynergyCard;
    expect(roleKeepOf(unit("offers:draw"), new Set(), true)?.jobs).toEqual(["draws a card"]);
    expect(roleKeepOf(unit("offers:defeat-enemy-unit"), new Set(), true)?.jobs).toEqual(["removes a unit"]);
    expect(roleKeepOf({ ...unit("offers:draw"), type: "Event" } as SynergyCard, new Set(), true)).toBeNull();
  });
});

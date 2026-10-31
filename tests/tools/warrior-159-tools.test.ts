import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import type { ToolResult } from "../../src/tools.js";
import { META_TOOLS } from "../../src/tools/meta.js";
import { SYNERGY_TOOLS, synergyContextOf } from "../../src/tools/synergy.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const OWNER_DECK = JSON.parse(readFileSync(path.join(HERE, "../fixtures/decks/warrior-chewie-raid.swudb.json"), "utf8")) as {
  deck: { id: string; count: number }[];
};
const DECKLIST = OWNER_DECK.deck.map((d) => ({ card: d.id, count: d.count }));

const builtRun = newestRun(path.join(REPO_ROOT, "data/runs"));
const hasData = builtRun !== undefined && existsSync(path.join(builtRun, "llm/cards.toon")) && existsSync(path.join(builtRun, "meta/leader-cards.json"));

function body(result: ToolResult): Record<string, any> {
  expect(result.isError, result.content[0].text.slice(0, 300)).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

const WARRIOR = "09010018";
const ORIGIN_TREE = "09010024";
const OPPO = "05010105";
const QIMIR = "09010196";
const RITUAL_DRAGON = "09010234";

// Session eight, seventh judge (#159, D71) against the owner's deck.
describe.skipIf(!hasData)("find_trios anchors to the owner's decklist (#159, D71)", () => {
  const real = hasData ? loadStore(builtRun as string) : (undefined as never);
  const ctx = hasData ? synergyContextOf(real) : (undefined as never);
  // Step 6 of the judged session: colours only, no leader, 50 cards.
  const step6 = (extra: object = {}): Record<string, any>[] =>
    body(
      SYNERGY_TOOLS.find_trios.handler(real, {
        leaderAspects: ["Cunning", "Heroism"],
        baseAspects: ["Command"],
        decklist: DECKLIST,
        limit: 6,
        evidence: false,
        withAlternatives: false,
        ...extra,
      }),
    ).trios;
  const inDeck = new Set(DECKLIST.map((d) => d.card));

  it("returns six trios that each hold deck cards, the ones holding more first", () => {
    const trios = step6();
    expect(trios).toHaveLength(6);
    const counts = trios.map((t) => t.deckMembers as number);
    expect(counts.every((n) => n >= 1)).toBe(true);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    expect(counts[0]).toBeGreaterThanOrEqual(2);
  });

  it("holds no Pilot package at the top: no printed Piloting card, no needsHost", () => {
    for (const t of step6()) {
      expect(t.needsHost).toBeUndefined();
      for (const k of String(t.cardKeys).split("|")) {
        const kw = (ctx.graph.byKey.get(k)?.structured as { keywordsField?: string[] }).keywordsField ?? [];
        expect(kw, String(t.cards)).not.toContain("Piloting");
      }
    }
  });

  // D73 replaced the order "more deck members first" with tiers (a trio that adds a card, then all-deck trios); the full tier test is in warrior-160-tools.test.ts.
  it("holds deck cards in every one of the first 50 trios, the unlocked ones grouped by tier", () => {
    const trios = step6({ limit: 50 });
    const open = trios.filter((t) => ["needsHost", "baseLocked", "nameLocked", "needsForce", "needsTrait"].every((k) => t[k] === undefined));
    const counts = open.map((t) => t.deckMembers as number);
    expect(counts.every((n) => n >= 1)).toBe(true);
    const tiers = counts.map((n) => (n === 3 ? 1 : 0));
    expect([...tiers].sort((x, y) => x - y)).toEqual(tiers);
  });

  it("keeps the unanchored answer without a decklist", () => {
    const plain = SYNERGY_TOOLS.find_trios.handler(real, { leaderAspects: ["Cunning", "Heroism"], baseAspects: ["Command"], limit: 6, evidence: false, withAlternatives: false });
    const trios = body(plain).trios as Record<string, any>[];
    expect(trios[0].deckMembers).toBeUndefined();
    expect(String(trios[0].cardKeys).split("|").some((k) => inDeck.has(k))).toBe(false);
  });
});

describe.skipIf(!hasData)("fungible_substitutes counts job feeders and suggests the cut for Oppo Rancisis (#159, D71)", () => {
  const real = hasData ? loadStore(builtRun as string) : (undefined as never);
  const rec = (): Record<string, any> =>
    body(
      SYNERGY_TOOLS.fungible_substitutes.handler(real, {
        cardKey: OPPO,
        preferAspects: ["Cunning", "Heroism", "Command"],
        leader: WARRIOR,
        base: ORIGIN_TREE,
        candidates: ["LOF_190"],
        decklist: DECKLIST,
        evidence: false,
      }),
    ).recommendation;

  it("no longer counts Darth Traya or Ahsoka Tano, I Learned It from You, which copy no keyword", () => {
    const oppo = rec().cards.find((c: any) => c.role === "original");
    expect(oppo.fedByCards).not.toContain("Darth Traya");
    expect(oppo.fedByCards).not.toContain("Ahsoka Tano, I Learned It from You");
    for (const name of ["Captain Tarpals", "Tribubble Bongo Sub", "Grogu", "Raiding Party", "Boba Fett"]) expect(oppo.fedByCards, name).toContain(name);
    expect(oppo.fedByDeck).toBe(14);
    expect(rec().feederJob).toBe("wants:keyword-*");
  });

  it("still keeps Oppo, by the feeder gap", () => {
    expect(rec()).toMatchObject({ keep: OPPO, decidedBy: "deckFeeders" });
  });

  it("never suggests a deck card with a pair edge into Oppo or Anakin, Darth Traya (who feeds Oppo) included", () => {
    const ctx = synergyContextOf(real);
    const cut = rec().cutForCandidate.cardKey as string;
    for (const target of [OPPO, "05010190"]) expect(ctx.graph.edgeByKey.has(`${cut}>${target}`), `${cut} feeds ${target}`).toBe(false);
    expect(rec().cutForCandidate.title).not.toContain("Darth Traya");
  });

  it("suggests cutting the penalised Qimir, Everyone Has a Weakness for Anakin, and says so in the verdict", () => {
    expect(rec().cutForCandidate).toEqual({
      cardKey: QIMIR,
      title: "Qimir, Everyone Has a Weakness",
      aspects: "Cunning+Villainy",
      penalty: 2,
      playShare: "unplayed",
      deckLinks: 0,
    });
    expect(rec().verdict).toContain("To make room for Anakin Skywalker, Force Prodigy, cut Qimir, Everyone Has a Weakness (penalty 2, unplayed, 0 pair links to other deck cards).");
  });
});

describe.skipIf(!hasData)("meta_answers flags Ritual Dragon and ranks it after the unlocked answers (#159, D71)", () => {
  const real = hasData ? loadStore(builtRun as string) : (undefined as never);
  const additions = (extra: object = {}): Record<string, any>[] =>
    body(META_TOOLS.meta_answers.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, limit: 40, archetypes: 6, ...extra })).additions.filter((r: any) => r.hiddenByFloor !== true);
  const locked = (r: Record<string, any>): boolean => ["baseLocked", "needsUnitAspect", "nameLocked", "needsForce", "needsTrait"].some((k) => r[k] !== undefined);

  it("carries baseLocked: Tatooine, as playable_cards does, and follows every unlocked addition", () => {
    const rows = additions();
    const at = rows.findIndex((r) => r.cardKey === RITUAL_DRAGON);
    expect(at, "Ritual Dragon answers through its printed Saboteur").toBeGreaterThanOrEqual(0);
    expect(rows[at].baseLocked).toBe("Tatooine");
    expect(rows[at].lockedOut).toBeUndefined();
    const first = rows.findIndex(locked);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(at);
    expect(rows.slice(first).every(locked)).toBe(true);
  });

  it("does not list it among the ten default additions for the owner's deck", () => {
    const rows = body(META_TOOLS.meta_answers.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, limit: 10, archetypes: 6 })).additions as Record<string, any>[];
    expect(rows.map((r) => r.cardKey)).not.toContain(RITUAL_DRAGON);
  });
});

import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import { clauseLock, lockSupply } from "../../src/synergy/clause-lock.js";
import type { SynergyCard } from "../../src/synergy/schema.js";
import type { ToolResult } from "../../src/tools.js";
import { resolveRef } from "../../src/tools/deck.js";
import { SYNERGY_TOOLS, synergyContextOf } from "../../src/tools/synergy.js";

// LampaGJ/swu-mcp#164, D82: dead and redundant trio cards, the deck-first tie-break, in-deck markers and the trait gate a
// deck meets, and the ready-unit reason survivors. Judged sessions: scratchpad judge-8-w16.md (Warrior), judge-7-w16.md (Cad Bane).

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
const CHEWBACCA = "09010117";
const CHIEFTAIN = "09010212";
const FLANKING_FANG = "04010257";
const BABU_FRIK = "05010206";
const ACCELERATE = "06010228";
const KAGE_ELITE = "07010234";
const C3PO = "06010093";
const FIGURE_OF_UNITY = "06010104";
const INSURGENT_CAMP = "09010216";
const UNDERCOVER_OPERATION = "06010236";
const TOUR_SHUTTLE = "09010165";
const CORONA_X_WING = "09010209";

const real = hasData ? loadStore(builtRun as string) : (undefined as never);
const ctx = hasData ? synergyContextOf(real) : (undefined as never);
const IN_DECK = new Set(
  DECKLIST.map((d) => {
    const hit = hasData ? resolveRef(real, d.card, "main") : undefined;
    return hit?.ok ? hit.row.cardKey : d.card;
  }),
);
const newCards = (t: Record<string, any>): string[] => String(t.cardKeys).split("|").filter((k) => !IN_DECK.has(k));
const card = (k: string): SynergyCard => ctx.graph.byKey.get(k) as SynergyCard;

const step6 = (): Record<string, any>[] =>
  body(SYNERGY_TOOLS.find_trios.handler(real, { leaderAspects: ["Cunning", "Heroism"], baseAspects: ["Command"], decklist: DECKLIST, limit: 6, withAlternatives: false })).trios;
const step14 = (): Record<string, any>[] =>
  body(SYNERGY_TOOLS.find_trios.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, limit: 5, withAlternatives: false })).trios;

describe.skipIf(!hasData)("a friendly-trait target is a trait lock, and a trio whose new card's links are all locked is dropped (#164 item 1, D82)", () => {
  it("Babu Frik (\"You may attack with a friendly Droid unit\") needs a Droid unit; a Droid in the pool meets it", () => {
    const deck = [...IN_DECK].map(card).filter((c) => c !== undefined);
    expect(deck.some((c) => c.type === "Unit" && c.structured.traits.includes("Droid"))).toBe(false);
    const lock = clauseLock(card(BABU_FRIK), lockSupply(card(WARRIOR), card(ORIGIN_TREE), deck));
    expect(lock.needsTrait).toEqual(["Droid"]);
    const droid = ctx.cards.find((c) => c.type === "Unit" && c.structured.traits.includes("Droid")) as SynergyCard;
    expect(clauseLock(card(BABU_FRIK), lockSupply(card(WARRIOR), card(ORIGIN_TREE), [...deck, droid])).needsTrait).toBeUndefined();
  });

  it("step 6 lists no trio that rests on Babu Frik", () => {
    const trios = step6();
    for (const t of trios) expect(String(t.cardKeys).split("|"), t.cards).not.toContain(BABU_FRIK);
  });
});

describe.skipIf(!hasData)("a trio's new card that adds no job the deck lacks at its standing is dropped (#164 item 1, D82)", () => {
  it("step 6 drops Accelerate Our Plans (Ahsoka Tano, I Learned It from You already gives Chewbacca the extra attack) and keeps Figure of Unity", () => {
    const trios = step6();
    for (const t of trios) expect(newCards(t), t.cards).not.toContain(ACCELERATE);
    expect(trios.some((t) => newCards(t).includes(FIGURE_OF_UNITY)), trios.map((t) => t.cards).join("\n")).toBe(true);
  });

  it("step 14 drops Kage Elite (Boba Fett already feeds Oppo's Raid and Saboteur) and the unplayed C-3PO (Grogu already uses Neel's ready), and keeps Insurgent Camp", () => {
    const trios = step14();
    for (const t of trios) {
      expect(newCards(t), t.cards).not.toContain(KAGE_ELITE);
      expect(newCards(t), t.cards).not.toContain(C3PO);
    }
    expect(trios.some((t) => newCards(t).includes(INSURGENT_CAMP)), trios.map((t) => t.cards).join("\n")).toBe(true);
  });
});

describe.skipIf(!hasData)("find_pairings breaks rank ties by deck membership, marks deck partners and names the deck unit a trait gate needs (#164 items 2 and 3, D82)", () => {
  const step13 = (extra: Record<string, unknown> = {}): Record<string, any> =>
    body(SYNERGY_TOOLS.find_pairings.handler(real, { cardKey: WARRIOR, leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, limit: 8, weighting: "none", ...extra }));

  it("the unweighted control keeps the deck's Chewbacca and The Chieftain on the 8-row page", () => {
    const keys = step13().pairings.map((p: Record<string, any>) => p.cardKey);
    expect(keys).toContain(CHEWBACCA);
    expect(keys).toContain(CHIEFTAIN);
  });

  it("among rows of equal rank a deck card comes first, then the higher play-calibrated score", () => {
    const rows: Record<string, any>[] = step13({ limit: 40, perLink: 100 }).pairings;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].rank !== rows[i - 1].rank) continue;
      expect(Number(rows[i].inDeck === true) <= Number(rows[i - 1].inDeck === true), `${rows[i - 1].title} before ${rows[i].title}`).toBe(true);
    }
  });

  it("each partner row carries inDeck, and copies when the deck holds it", () => {
    const rows: Record<string, any>[] = step13({ limit: 40, perLink: 100 }).pairings;
    const chewie = rows.find((p) => p.cardKey === CHEWBACCA) as Record<string, any>;
    expect(chewie.inDeck).toBe(true);
    expect(chewie.copies).toBe(3);
    const fang = rows.find((p) => p.cardKey === FLANKING_FANG) as Record<string, any>;
    expect(fang.inDeck).toBe(false);
    expect(fang.copies).toBeUndefined();
  });

  it("without a decklist no row carries inDeck", () => {
    const rows: Record<string, any>[] = body(SYNERGY_TOOLS.find_pairings.handler(real, { cardKey: WARRIOR, leader: WARRIOR, base: ORIGIN_TREE, limit: 8 })).pairings;
    for (const r of rows) expect(r.inDeck).toBeUndefined();
  });

  it("Flanking Fang Fighter's row names the deck's Corona Squadron X-Wing as the other Fighter its Raid 2 needs", () => {
    const rows: Record<string, any>[] = step13({ limit: 40, perLink: 100 }).pairings;
    const fang = rows.find((p) => p.cardKey === FLANKING_FANG) as Record<string, any>;
    expect(fang.traitGateMetBy).toContain(`${card(CORONA_X_WING).title} (3)`);
  });
});

describe.skipIf(!hasData)("a ready offer into an attack want states the gain the target takes (#164 item 7, D82)", () => {
  it("Undercover Operation and Commandeered Tour Shuttle into Chewbacca no longer use the Action [Exhaust] / On Attack reason", () => {
    const rows: Record<string, any>[] = body(
      SYNERGY_TOOLS.find_pairings.handler(real, { cardKey: CHEWBACCA, leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, limit: 60, perLink: 100 }),
    ).pairings;
    for (const key of [UNDERCOVER_OPERATION, TOUR_SHUTTLE]) {
      const row = rows.find((p) => p.cardKey === key) as Record<string, any>;
      expect(row, key).toBeDefined();
      expect(row.reason, key).not.toContain("re-uses its Action [Exhaust]");
    }
    const undercover = rows.find((p) => p.cardKey === UNDERCOVER_OPERATION) as Record<string, any>;
    expect(undercover.reason).toContain("attack the turn it enters play");
    const shuttle = rows.find((p) => p.cardKey === TOUR_SHUTTLE) as Record<string, any>;
    expect(shuttle.reason).toContain("attack again");
  });
});

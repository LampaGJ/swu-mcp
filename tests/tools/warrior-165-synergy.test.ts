import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import { evidenceSpan } from "../../src/synergy/evidence.js";
import type { SynergyCard } from "../../src/synergy/schema.js";
import type { ToolResult } from "../../src/tools.js";
import { SYNERGY_TOOLS, synergyContextOf } from "../../src/tools/synergy.js";

// LampaGJ/swu-mcp#165 items 7 to 11 and 14, D83: leader-clashing and dead-rider trio cards, variants that fill their slot,
// the trio order key, one find_pairings row per partner with the same-phase cost, a reason that names only the row's card,
// and whole choose-one quotes. Judged sessions: scratchpad judge-8-w18.md (Warrior), judge-7-w18.md (Cad Bane).

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
const MANDO_N1 = "08010203";
const FAMILIAR = "09010266";
const OPPO = "05010105";
const MARCHION = "05010186";
const KELLERAN_OTHERS = "08010206";
const KOSKA = "08010079";
const CHIMAERA = "08010052";
const CHOOSE_PATH = "08010257";
const CAD_BANE = "08010011";
const NEVARRO = "08010020";
const CAD_CORE = [
  { card: "Marrok, Mysterious Warrior", count: 3 }, { card: "Pre Vizsla, Strong-Willed Ruler", count: 3 }, { card: "08010052", count: 3 },
  { card: "IG-2000, Assassin's Aggressor", count: 3 }, { card: "No Glory, Only Results", count: 3 }, { card: "Koska Reeves, Warrior of Mandalore", count: 3 },
  { card: "Justifier, Relentless", count: 3 }, { card: "TIE Dagger Vanguard", count: 3 }, { card: "HK-47, Exclamation: Die, Meatbag!", count: 3 },
  { card: "Onyx Squadron Brute", count: 3 }, { card: "Ninth Sister, Hulking Inquisitor", count: 2 }, { card: "Outer Rim Constable", count: 2 },
];

const real = hasData ? loadStore(builtRun as string) : (undefined as never);
const ctx = hasData ? synergyContextOf(real) : (undefined as never);
const card = (k: string): SynergyCard => ctx.graph.byKey.get(k) as SynergyCard;
const keysOf = (t: Record<string, any>): string[] => String(t.cardKeys).split("|");
const LOCK_FIELDS = ["baseLocked", "nameLocked", "needsForce", "needsTrait", "needsHost", "leaderClash", "riderUnmet"];
const locked = (t: Record<string, any>): boolean => LOCK_FIELDS.some((f) => t[f] !== undefined);

const unweighted = (extra: Record<string, unknown> = {}): Record<string, any>[] =>
  body(SYNERGY_TOOLS.find_trios.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, weighting: "none", limit: 50, withAlternatives: false, evidence: false, ...extra })).trios;
const step6 = (): Record<string, any>[] =>
  body(SYNERGY_TOOLS.find_trios.handler(real, { leaderAspects: ["Cunning", "Heroism"], baseAspects: ["Command"], decklist: DECKLIST, limit: 6, withAlternatives: false, evidence: false })).trios;
const step14 = (): Record<string, any> =>
  body(SYNERGY_TOOLS.find_trios.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, limit: 5, withAlternatives: false, evidence: false }));

describe.skipIf(!hasData)("trio filler that clashes with the leader or whose rider never fires (#165 item 7, D83)", () => {
  it("Mando's N-1 Starfighter exhausts a friendly leader, which competes with The Warrior's Action [Exhaust]: leaderClash, after every unlocked trio", () => {
    const withN1 = unweighted({ cardKey: MANDO_N1 });
    expect(withN1.length).toBeGreaterThan(0);
    for (const t of withN1) expect(t.leaderClash, t.cards).toContain("Mando's N-1 Starfighter");
    // Before the fix Ahsoka Tano + Neel + Mando's N-1 sat fourth among the unweighted trios; a locked trio now follows every unlocked one.
    const trios = unweighted();
    const firstLocked = trios.findIndex(locked);
    if (firstLocked >= 0) for (const t of trios.slice(firstLocked)) expect(locked(t), `${t.cards} after a locked trio`).toBe(true);
    for (const t of trios.filter((x) => keysOf(x).includes(MANDO_N1))) expect(t.leaderClash, t.cards).toBeDefined();
  });

  it("Familiar Strategem's +2 needs a unit sharing a trait with Chewbacca, the deck's only Wookiee: riderUnmet", () => {
    const familiarChewie = unweighted({ cardKey: FAMILIAR }).filter((t) => keysOf(t).includes(CHEWBACCA));
    expect(familiarChewie.length).toBeGreaterThan(0);
    for (const t of familiarChewie) expect(t.riderUnmet, t.cards).toContain("shares a Trait");
  });

  it("the quote keeps the conditional rider: \"Attack with a unit. If it shares a Trait with another friendly unit, it gets +2/+0 for this attack.\"", () => {
    expect(evidenceSpan(card(FAMILIAR), "text: Attack with a unit.")).toBe(
      "text: Attack with a unit. If it shares a Trait with another friendly unit, it gets +2/+0 for this attack.",
    );
  });
});

describe.skipIf(!hasData)("each trio variant names its slot and penalty and fills the slot's role (#165 item 8, D83)", () => {
  it("step 14: Oppo Rancisis (3 power) is no variant of the 0-power Kelleran Beq trio, and every variant carries slot and penalty", () => {
    const trios: Record<string, any>[] = step14().trios;
    for (const t of trios) {
      for (const v of (t.variants ?? []) as Record<string, any>[]) {
        expect(["A", "B", "C"], `${t.cards}: ${v.title}`).toContain(v.slot);
        expect(typeof v.penalty, `${t.cards}: ${v.title}`).toBe("number");
      }
      if (keysOf(t).includes(KELLERAN_OTHERS)) expect(((t.variants ?? []) as Record<string, any>[]).map((v) => v.title).join("; ")).not.toContain("Oppo Rancisis");
    }
  });

  it("step 6: off-colour variants show their penalty (Lobot and Yanna are Vigilance under Cunning, Heroism and Command)", () => {
    for (const t of step6()) {
      for (const v of (t.variants ?? []) as Record<string, any>[]) {
        expect(typeof v.penalty, `${t.cards}: ${v.title}`).toBe("number");
        if (/^Lobot|^Yanna/.test(String(v.title))) expect(v.penalty, v.title).toBe(2);
      }
    }
  });
});

describe.skipIf(!hasData)("find_trios names the key it orders by (#165 item 9, D83)", () => {
  it("each idea-tier trio prints orderRank = rank x newCardWeight, and trios of one tier, lock state and deckMembers follow it", () => {
    const out = step14();
    const trios: Record<string, any>[] = out.trios;
    expect(String(out.order)).toContain("orderRank");
    for (const t of trios) if (t.newCardWeight !== undefined) expect(t.orderRank, t.cards).toBeCloseTo(t.rank * t.newCardWeight, 2);
    for (let i = 1; i < trios.length; i++) {
      const [x, y] = [trios[i - 1], trios[i]];
      if (locked(x) !== locked(y) || x.deckMembers !== y.deckMembers || x.orderRank === undefined || y.orderRank === undefined) continue;
      expect(y.orderRank <= x.orderRank, `${x.cards} (${x.orderRank}) before ${y.cards} (${y.orderRank})`).toBe(true);
    }
  });
});

describe.skipIf(!hasData)("find_pairings lists a partner once, with the same-phase cost (#165 item 10, D83)", () => {
  const koska = (): Record<string, any> =>
    body(SYNERGY_TOOLS.find_pairings.handler(real, { cardKey: KOSKA, leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE, limit: 8 }));

  it("Chimaera fills one row, its links merged", () => {
    const rows: Record<string, any>[] = koska().pairings;
    const keys = rows.map((r) => r.cardKey);
    expect(new Set(keys).size, keys.join(",")).toBe(keys.length);
    const chimaera = rows.find((r) => r.cardKey === CHIMAERA) as Record<string, any>;
    expect(chimaera.link).toContain("wants:friendly-unit-defeated");
    expect(chimaera.link).toContain("wants:sac-fodder");
  });

  it("a row into Koska's \"defeated this phase\" want prints the cost of both cards in one phase (Chimaera 7 + Koska 4 = 11)", () => {
    const rows: Record<string, any>[] = koska().pairings;
    expect((rows.find((r) => r.cardKey === CHIMAERA) as Record<string, any>).samePhaseCost).toBe(11);
  });
});

describe.skipIf(!hasData)("a shared row reason names only the row's own card (#165 item 11, D83)", () => {
  it("The Chieftain's Oppo row does not explain Marchion Ro, and the Marchion Ro row does not explain Oppo", () => {
    const rows: Record<string, any>[] = body(
      SYNERGY_TOOLS.find_pairings.handler(real, { cardKey: CHIEFTAIN, leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, limit: 60, perLink: 100 }),
    ).pairings;
    const oppo = rows.find((r) => r.cardKey === OPPO) as Record<string, any>;
    const marchion = rows.find((r) => r.cardKey === MARCHION) as Record<string, any>;
    expect(oppo.reason).not.toContain("Marchion Ro");
    expect(oppo.reason).toContain("Oppo Rancisis");
    expect(marchion.reason).not.toContain("Oppo Rancisis");
    expect(marchion.reason).toContain("Marchion Ro");
  });
});

describe.skipIf(!hasData)("a choose-one quote is whole in find_pairings (#165 item 14, D83)", () => {
  it("Choose Your Path's Mandalorian mode is quoted with its place among the modes, never with an elision mark", () => {
    const why = card(CHOOSE_PATH).tags.wants.find((t) => t.tag === "wants:trait-Mandalorian")?.why as string;
    const span = evidenceSpan(card(CHOOSE_PATH), why);
    expect(span).not.toContain("…");
    expect(span).toBe("text: Choose one (mode 2 of 2): If you control a Mandalorian unit, create a Mandalorian token and give an Advantage token to it.");
  });
});

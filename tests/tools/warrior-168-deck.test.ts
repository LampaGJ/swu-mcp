import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import { answerOffers, counterCardSchema, loadCounterTable, relationHit } from "../../src/meta/counters.js";
import type { ThreatProfile } from "../../src/meta/schema.js";
import type { ToolResult } from "../../src/tools.js";
import { DECK_TOOLS } from "../../src/tools/deck.js";
import { META_TOOLS } from "../../src/tools/meta.js";

// LampaGJ/swu-mcp#168 items 1, 2, 3, 4, 5 and 7, D86: a locked or opponent-chosen answer takes no reserved slot, an unfed conditional
// answer does not hold a threat's reserved slot alone, one-sided go-wide removal is read, curve-glut fills count specific links with
// the leader's engine as a strong one, playable_cards rows carry evidenceClass, and a damage limit names every mode. Judged sessions:
// scratchpad judge-8-w21.md (Warrior) and judge-7-w21.md (Cad Bane).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const OWNER_SWUDB = JSON.parse(readFileSync(path.join(HERE, "../fixtures/decks/warrior-chewie-raid.swudb.json"), "utf8")) as {
  deck: { id: string; count: number }[];
};
const DECKLIST = OWNER_SWUDB.deck.map((d) => ({ card: d.id, count: d.count }));

const builtRun = newestRun(path.join(REPO_ROOT, "data/runs"));
const hasData = builtRun !== undefined && existsSync(path.join(builtRun, "llm/cards.toon")) && existsSync(path.join(builtRun, "meta/leader-cards.json"));
const real = hasData ? loadStore(builtRun as string) : (undefined as never);

function body(result: ToolResult): Record<string, any> {
  expect(result.isError, result.content[0].text.slice(0, 300)).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

const WARRIOR = "09010018";
const ORIGIN_TREE = "09010024";
const CAD_BANE = "08010011";
const NEVARRO = "08010020";
const GORAX = "09010188";
const MARROK = "08010030";
const PRE_VIZSLA = "08010053";
const IG_2000 = "04010140";
const KELLERAN = "08010206";
const GREE = "09010138";
const T6_SHUTTLE = "08010109";
const BLACK_SQUADRON = "04010202";
const LIFE_WIND_SAGE = "05010212";
const AHSOKA_WHISPERS = "04010201";
const DEPA = "05010199";
const LIBERTY = "07010224";
const BOBAS_RANCOR = "08010179";
const CYBORG_MECH = "08010147";
const CAD_CORE = [
  { card: "Marrok, Mysterious Warrior", count: 3 }, { card: "Pre Vizsla, Strong-Willed Ruler", count: 3 }, { card: "08010052", count: 3 },
  { card: "IG-2000, Assassin's Aggressor", count: 3 }, { card: "No Glory, Only Results", count: 3 }, { card: "Koska Reeves, Warrior of Mandalore", count: 3 },
  { card: "Justifier, Relentless", count: 3 }, { card: "TIE Dagger Vanguard", count: 3 }, { card: "HK-47, Exclamation: Die, Meatbag!", count: 3 },
  { card: "Onyx Squadron Brute", count: 3 }, { card: "Ninth Sister, Hulking Inquisitor", count: 2 }, { card: "Outer Rim Constable", count: 2 },
];

const cadAnswers = (extra: Record<string, unknown> = {}): Record<string, any> =>
  body(META_TOOLS.meta_answers.handler(real, { leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE, limit: 10, archetypes: 6, ...extra }));
const shownRows = (out: Record<string, any>): Record<string, any>[] => [...(out.staples as Record<string, any>[]), ...(out.additions as Record<string, any>[])];

describe.skipIf(!hasData)("meta_answers: a locked or opponent-chosen answer takes no reserved slot (#168 item 1, D86)", () => {
  it("Giant Gorax (every clause under an Endor base, the opponent picks the mode) is not shown, reserved or counted under Nevarro City", () => {
    const out = cadAnswers();
    const shown = shownRows(out);
    expect(shown.map((r) => r.cardKey), shown.map((r) => r.title).join("; ")).not.toContain(GORAX);
  });

  it("listed with includeUnplayed, Giant Gorax sits under lockedAnswers at coverage 0, its Endor gate and the opponent's choice named", () => {
    const out = cadAnswers({ includeUnplayed: true, limit: 60 });
    expect(shownRows(out).map((r) => r.cardKey)).not.toContain(GORAX);
    const gorax = (out.lockedAnswers as Record<string, any>[]).find((r) => r.cardKey === GORAX) as Record<string, any>;
    expect(gorax, (out.lockedAnswers as Record<string, any>[]).map((r) => r.title).join("; ")).toBeDefined();
    expect(gorax.coverage).toBe(0);
    expect(gorax.lockedOut).toBe(true);
    expect(gorax.baseLocked).toBe("Endor");
    expect(String(gorax.opponentChooses)).toContain("each opponent chooses one");
  });
});

describe.skipIf(!hasData)("meta_answers: an unfed conditional answer does not hold a reserved slot alone (#168 item 2, D86)", () => {
  it("Marrok's Saboteur needs an upgrade nothing in the deck supplies: his row says so, and sentinel-wall also shows an unconditional answer", () => {
    const shown = shownRows(cadAnswers());
    const marrok = shown.find((r) => r.cardKey === MARROK) as Record<string, any>;
    expect(marrok, shown.map((r) => r.title).join("; ")).toBeDefined();
    const conditional = (marrok.answers as Record<string, any>[]).find((a) => a.relation === "sentinel-bypass-conditional") as Record<string, any>;
    expect(String(conditional.conditionUnfed)).toContain("wants:upgrades-attached");
    const firm = shown.filter((r) => (r.answers as Record<string, any>[]).some((a) => a.threat === "sentinel-wall" && !String(a.relation).endsWith("-conditional")));
    expect(firm.length, shown.map((r) => `${r.title}: ${(r.answers as Record<string, any>[]).map((a) => a.relation).join(",")}`).join(" | ")).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasData)("meta_answers reads one-sided go-wide removal (#168 item 3, D86)", () => {
  const table = loadCounterTable();
  const sweeper = table.relations.find((r) => r.id === "sweeper") as (typeof table.relations)[number];
  const features = hasData ? (JSON.parse(readFileSync(path.join(builtRun as string, "features/features.json"), "utf8")) as Record<string, unknown>[]) : [];
  const card = (k: string) => counterCardSchema.parse(features.find((f) => f.cardKey === k));
  const profile = (cheapUnitMedianHp: number): ThreatProfile => ({
    cardsKnown: 50, units: 40, events: 5, upgrades: 8, arena: { ground: 20, space: 20, spaceShare: 0.5 }, curve: { "2": 20 }, meanCost: 3,
    keywords: {}, offers: { "offers:create-token-units": 12 }, cheapUnits: 16, cheapUnitMedianHp, leader: { power: 4, hp: 7, arenas: ["Ground"] }, keyUnits: [], heavyKeyUnits: 0,
  });

  it("Pre Vizsla defeats any number of non-leader units with a total of 6 or less remaining HP: a one-sided sweep of two or more cheap units", () => {
    const pre = card(PRE_VIZSLA);
    for (const hp of [2, 3]) {
      const hit = relationHit(pre, answerOffers(pre), sweeper, profile(hp));
      expect(hit, `cheap HP ${hp}`).not.toBeNull();
      expect(hit?.symmetric).toBe(false);
    }
    expect(relationHit(pre, answerOffers(pre), sweeper, profile(4))).toBeNull();
  });

  it("IG-2000 deals 1 damage to each of up to 3 units: one-sided, and it reaches only an archetype whose cheap units have 1 HP", () => {
    const ig = card(IG_2000);
    const hit = relationHit(ig, answerOffers(ig), sweeper, profile(1));
    expect(hit).not.toBeNull();
    expect(hit?.symmetric).toBe(false);
    expect(relationHit(ig, answerOffers(ig), sweeper, profile(2))).toBeNull();
  });

  it("in the Cad Bane session Pre Vizsla is a go-wide staple, not symmetric", () => {
    const shown = shownRows(cadAnswers());
    const pre = shown.find((r) => r.cardKey === PRE_VIZSLA) as Record<string, any>;
    expect(pre, shown.map((r) => r.title).join("; ")).toBeDefined();
    const goWide = (pre.answers as Record<string, any>[]).find((a) => a.threat === "go-wide") as Record<string, any>;
    expect(goWide?.relation).toBe("sweeper");
    expect(pre.symmetric).toBeUndefined();
  });
});

describe.skipIf(!hasData)("deck_audit glut fills count specific links, the leader's engine strong (#168 item 4, D86)", () => {
  const glut = (): Record<string, any> => body(DECK_TOOLS.deck_audit.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST })).curveGlut;

  // Coordinator ruling 2026-10-31: a fill the leader's engine reads ranks first within its cost, before fillRank; fillRank orders the rest.
  it("Commander Gree, a leader-engine partner (The Warrior's Ambush attack meets his Raid 4), is a cost-4 fill", () => {
    const fills = glut().fills as Record<string, any>[];
    const shown = fills.map((f) => `${f.title} (${f.deckLinks}, ${f.fillRank})`).join("; ");
    const gree = fills.find((f) => f.cardKey === GREE);
    expect(gree, shown).toBeDefined();
    expect(gree?.cost).toBe(4);
    expect(gree?.leaderEngine, shown).toBe(true);
  });

  // D87 (#169) flips this: an engine-read fill leads only within its fillRank band and is listed past the cap, so Kelleran Beq (3.806)
  // leads Life Wind Sage (engine, 3), and Commander Gree (engine, 1.5) follows the three ranked fills.
  it("engine-read fills lead within their fillRank band; deckLinks counts specific links only (Kelleran Beq, then Life Wind Sage 5, Gree listed)", () => {
    const fills = glut().fills as Record<string, any>[];
    const shown = fills.map((f) => `${f.title} (${f.deckLinks}, ${f.fillRank}${f.leaderEngine === true ? ", engine" : ""})`).join("; ");
    const fours = fills.filter((f) => f.cost === 4);
    expect(fours[0]?.cardKey, shown).toBe(KELLERAN);
    expect(fours[1]?.cardKey, shown).toBe(LIFE_WIND_SAGE);
    expect(fours[1]?.deckLinks, shown).toBe(5);
    expect(fours.map((f) => f.cardKey), shown).toContain(GREE);
  });
  it("a fill linked only through generic wants (extra attacks) has no deck links from them: T-6 Shuttle and Black Squadron leave, no tie at 7", () => {
    const fills = glut().fills as Record<string, any>[];
    const shown = fills.map((f) => `${f.title} (${f.deckLinks}, ${f.fillRank})`).join("; ");
    for (const k of [T6_SHUTTLE, BLACK_SQUADRON]) {
      const f = fills.find((x) => x.cardKey === k);
      if (f !== undefined) expect(f.deckLinks, shown).toBeLessThan(3);
    }
    expect(fills.filter((f) => f.deckLinks === 7).length, shown).toBeLessThan(2);
  });
});

describe.skipIf(!hasData)("playable_cards rows carry evidenceClass, a measured negative last in its cost (#168 item 5, D86)", () => {
  const cards = (): Record<string, any>[] => body(DECK_TOOLS.playable_cards.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, limit: 24, perCost: 3 })).cards;

  it("Ahsoka Tano, Chasing Whispers, Depa Billaba and Liberty are flagged negative, as meta_answers measures them", () => {
    const rows = cards();
    for (const k of [AHSOKA_WHISPERS, DEPA, LIBERTY]) {
      const r = rows.find((x) => x.cardKey === k);
      if (r !== undefined) expect(r.evidenceClass, r.title).toBe("negative");
    }
    expect(rows.filter((r) => [AHSOKA_WHISPERS, DEPA, LIBERTY].includes(r.cardKey)).length).toBeGreaterThan(0);
  });

  // D87 (#169) flips this: a negative card 50% or more of the leader's lists play (Lightmaker) keeps its place; every other negative row follows.
  it("within each cost every negative row the leader's lists play under 50% follows every row that is not negative", () => {
    const rows = cards().filter((r) => r.cardKey !== null);
    for (const cost of new Set(rows.map((r) => r.cost))) {
      const same = rows.filter((r) => r.cost === cost && !(r.evidenceClass === "negative" && (r.leaderInclusion ?? 0) >= 0.5)).map((r) => r.evidenceClass === "negative");
      const firstNegative = same.indexOf(true);
      if (firstNegative >= 0) expect(same.slice(firstNegative).every(Boolean), `cost ${cost}: ${rows.filter((r) => r.cost === cost).map((r) => `${r.title} ${r.evidenceClass}`).join("; ")}`).toBe(true);
    }
  });
});

describe.skipIf(!hasData)("budget swaps print every damage mode (#168 item 7, D86)", () => {
  const swaps = (): Record<string, any>[] =>
    (body(DECK_TOOLS.budget_alternatives.handler(real, { leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE, maxPrice: 2 })).slots as Record<string, any>[]).flatMap(
      (s) => s.alternatives as Record<string, any>[],
    );

  it("Boba Fett's Rancor deals 5 and then 5 more to the same unit: 10 damage", () => {
    const rancor = swaps().find((a) => a.cardKey === BOBAS_RANCOR) as Record<string, any>;
    expect(rancor).toBeDefined();
    expect(String(rancor.limit)).toMatch(/^10 damage, ground units only/);
  });

  it("The Cyborg Mech names both modes: 2 damage to an undamaged ground unit or 5 damage to a damaged one", () => {
    const mech = swaps().find((a) => a.cardKey === CYBORG_MECH) as Record<string, any>;
    expect(mech).toBeDefined();
    expect(String(mech.limit)).toContain("2 damage, ground units only, undamaged units only");
    expect(String(mech.limit)).toContain("or 5 damage, ground units only, damaged units only");
  });
});

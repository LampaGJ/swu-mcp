import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import type { ToolResult } from "../../src/tools.js";
import { DECK_TOOLS } from "../../src/tools/deck.js";
import { META_TOOLS } from "../../src/tools/meta.js";

// LampaGJ/swu-mcp#167 items 3, 4, 9 and 10, D85: a curve glut read against the leader's Action, fills ranked by deck links, additions
// filled from rows not measured negative and carrying their drawback, damage-removal limits and token or Sentinel jobs in budget
// swaps, and every clause of a card adding its answers. Judged sessions: scratchpad judge-8-w20.md and judge-7-w20.md.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const OWNER_SWUDB = JSON.parse(readFileSync(path.join(HERE, "../fixtures/decks/warrior-chewie-raid.swudb.json"), "utf8")) as {
  deck: { id: string; count: number }[];
  sideboard: { id: string; count: number }[];
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
const GREE = "09010138";
const HELIX = "08010221";
const LEGACY_RUN = "05010213";
const STOLEN_HAULER = "04010221";
const ELITE_SQUAD = "06010143";
const FULMINATRIX = "06010142";
const TRESPASSER = "09010186";
const KOSKA = "08010079";
const JUSTIFIER = "08010146";
const CHIMAERA = "08010052";
const NINTH_SISTER = "08010148";
const CAD_CORE = [
  { card: "Marrok, Mysterious Warrior", count: 3 }, { card: "Pre Vizsla, Strong-Willed Ruler", count: 3 }, { card: "08010052", count: 3 },
  { card: "IG-2000, Assassin's Aggressor", count: 3 }, { card: "No Glory, Only Results", count: 3 }, { card: "Koska Reeves, Warrior of Mandalore", count: 3 },
  { card: "Justifier, Relentless", count: 3 }, { card: "TIE Dagger Vanguard", count: 3 }, { card: "HK-47, Exclamation: Die, Meatbag!", count: 3 },
  { card: "Onyx Squadron Brute", count: 3 }, { card: "Ninth Sister, Hulking Inquisitor", count: 2 }, { card: "Outer Rim Constable", count: 2 },
];

describe.skipIf(!hasData)("deck_audit reads the curve glut against the leader's Action (#167 item 3, D85)", () => {
  const glut = (): Record<string, any> => body(DECK_TOOLS.deck_audit.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST })).curveGlut;

  it("The Warrior's Action plays a unit of 3 or less power for 1 more resource: the 3-cost cluster sits in the Action's band, and the note says so", () => {
    const g = glut();
    const band = g.leaderAction as Record<string, any>;
    expect(band, JSON.stringify(g).slice(0, 400)).toBeDefined();
    expect(band.extraCost).toBe(1);
    expect(band.playable).toBeGreaterThan(g.cards / 2);
    expect(String(band.note)).toContain("The Warrior, Deft Duelist");
    expect(String(band.note)).toContain("4 resources");
  });

  // Coordinator ruling 2026-10-31: play share counts three times, so a card in more than half the leader's lists outranks an unplayed card with many links.
  it("Lightmaker (58% of the leader's lists, 2 links) leads the cost-5 fills, above unplayed cards with 7 deck links", () => {
    const fives = (glut().fills as Record<string, any>[]).filter((f) => f.cost === 5);
    expect(fives[0]?.title, fives.map((f) => `${f.title} (${f.deckLinks}, ${f.fillRank})`).join("; ")).toBe("Lightmaker, I Have An Idea");
  });

  it("fills rank by deck links and play share: Helix Starfighter (1 weak link, 3% of lists) gives way; Commander Gree, if listed, comes before it", () => {
    const fills = glut().fills as Record<string, any>[];
    const at = (k: string) => fills.findIndex((f) => f.cardKey === k);
    const shown = fills.map((f) => `${f.title} (${f.deckLinks}, ${f.fillRank})`).join("; ");
    expect(at(HELIX), shown).toBe(-1);
    if (at(GREE) >= 0 && at(HELIX) >= 0) expect(at(GREE)).toBeLessThan(at(HELIX));
    expect(fills.map((f) => f.title).join("; ")).toContain("Lightmaker");
    for (const f of fills) expect(f.deckLinks, f.title).toBeGreaterThanOrEqual(2);
    for (const cost of new Set(fills.map((f) => f.cost))) {
      const sameCost = fills.filter((f) => f.cost === cost);
      for (let i = 1; i < sameCost.length; i++) expect(sameCost[i].fillRank <= sameCost[i - 1].fillRank, `${sameCost[i - 1].title} before ${sameCost[i].title}`).toBe(true);
    }
    for (const f of fills) {
      const share = f.leaderInclusion !== null && f.leaderInclusion >= 0.02 ? f.leaderInclusion : 0;
      expect(f.fillRank, f.title).toBeCloseTo((1 + f.deckLinks) * (0.5 + 3 * share), 3);
    }
  });
});

describe.skipIf(!hasData)("meta_answers additions: no measured negative fills a slot, and drawbacks are named (#167 item 4, D85)", () => {
  const warrior = (): Record<string, any> => body(META_TOOLS.meta_answers.handler(real, { swudb: OWNER_SWUDB, limit: 10, archetypes: 6 }));

  it("The Legacy Run (5 decks, -13 points) takes no addition slot; no addition is measured negative, and the left-out rows are listed apart", () => {
    const out = warrior();
    const additions = out.additions as Record<string, any>[];
    expect(additions.map((r) => r.cardKey)).not.toContain(LEGACY_RUN);
    for (const r of additions) if (r.reserved !== true) expect(r.evidenceClass, r.title).not.toBe("negative");
    const negative = (out.negativeAdditions ?? []) as Record<string, any>[];
    const legacy = negative.find((r) => r.cardKey === LEGACY_RUN) as Record<string, any>;
    expect(legacy, negative.map((r) => r.title).join("; ")).toBeDefined();
    expect(legacy.evidenceClass).toBe("negative");
    for (const r of negative) expect(r.evidenceClass, r.title).toBe("negative");
  });

  it("Stolen AT-Hauler's When Defeated lets the opponent play it for free: drawback, the clause quoted", () => {
    const hauler = (warrior().additions as Record<string, any>[]).find((r) => r.cardKey === STOLEN_HAULER) as Record<string, any>;
    expect(hauler).toBeDefined();
    expect(String(hauler.drawback)).toContain("they may play this unit from its owner's discard pile for free");
  });
});

describe.skipIf(!hasData)("budget swaps: damage-removal limits and token or Sentinel jobs (#167 item 9, D85)", () => {
  const budget = (): Record<string, any> => body(DECK_TOOLS.budget_alternatives.handler(real, { leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE, maxPrice: 2 }));
  const swaps = (out: Record<string, any>) => (out.slots as Record<string, any>[]).flatMap((s) => s.alternatives as Record<string, any>[]);

  it("The Elite Squad (unique units only), Fulminatrix (ground only) and Mining Guild Trespasser (2 damage) print their damage limit", () => {
    const all = swaps(budget());
    const of = (k: string) => all.find((a) => a.cardKey === k) as Record<string, any> | undefined;
    const squad = of(ELITE_SQUAD);
    expect(squad, all.map((a) => a.title).join("; ")).toBeDefined();
    expect(String(squad?.limit)).toContain("2 damage");
    expect(String(squad?.limit)).toContain("unique units only");
    const fulm = of(FULMINATRIX);
    if (fulm !== undefined) expect(String(fulm.limit)).toContain("4 damage, ground units only");
    const tres = of(TRESPASSER);
    if (tres !== undefined) expect(String(tres.limit)).toContain("2 damage");
    expect([fulm, tres].some((x) => x !== undefined)).toBe(true);
  });

  it("Koska Reeves' slot names her token and Sentinel job, so Street Gang Recruiter and Ravening Gundark are no swap", () => {
    const out = budget();
    const slot = (out.slots as Record<string, any>[]).find((s) => s.cardKey === KOSKA);
    const none = (out.noAlternative as Record<string, any>[]).find((n) => n.card === "Koska Reeves, Warrior of Mandalore");
    expect(slot !== undefined || none !== undefined).toBe(true);
    if (slot !== undefined) {
      expect(String(slot.job)).toMatch(/creates a token unit|holds Sentinel/);
      const titles = (slot.alternatives as Record<string, any>[]).map((a) => a.title);
      expect(titles).not.toContain("Street Gang Recruiter");
      expect(titles).not.toContain("Ravening Gundark");
    } else expect(String(none?.reason)).toMatch(/creates a token unit|holds Sentinel/);
  });
});

describe.skipIf(!hasData)("meta_answers reads every clause of a card (#167 item 10, D85)", () => {
  const cad = (): Record<string, any>[] => {
    const out = body(META_TOOLS.meta_answers.handler(real, { leader: CAD_BANE, base: NEVARRO, limit: 10, archetypes: 6 }));
    return [...(out.staples as Record<string, any>[]), ...(out.additions as Record<string, any>[])];
  };

  it("Chimaera, A Frightening Reality answers every threat it meets: its select-then-defeat clause removes key units, beside the heal and its space body", () => {
    const rows = cad();
    const r = rows.find((x) => x.cardKey === CHIMAERA) as Record<string, any>;
    expect(r, rows.map((x) => x.title).join("; ")).toBeDefined();
    const answers = r.answers as Record<string, any>[];
    const threats = answers.map((a) => a.threat);
    expect(threats, threats.join(", ")).toEqual(expect.arrayContaining(["key-units", "base-pressure", "space-heavy"]));
    const keyUnits = answers.find((a) => a.threat === "key-units") as Record<string, any>;
    expect(keyUnits.offer).toBe("offers:defeat-enemy-unit");
    expect(String(keyUnits.evidence)).toContain("If you do, defeat those units.");
    expect(r.archetypesAnswered).toBeLessThanOrEqual(6);
  });

  it("Justifier's 1 damage reaches no key unit's printed HP and Ninth Sister's damage has no fixed amount, so neither claims key units", () => {
    const rows = cad();
    for (const k of [JUSTIFIER, NINTH_SISTER]) {
      const r = rows.find((x) => x.cardKey === k) as Record<string, any>;
      expect(r, rows.map((x) => x.title).join("; ")).toBeDefined();
      expect((r.answers as Record<string, any>[]).map((a) => a.threat), r.title).not.toContain("key-units");
    }
  });
});

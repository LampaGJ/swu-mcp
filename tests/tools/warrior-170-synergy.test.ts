import { decode } from "@toon-format/toon";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import type { ToolResult } from "../../src/tools.js";
import { SYNERGY_TOOLS } from "../../src/tools/synergy.js";

// LampaGJ/swu-mcp#170, D89: the find_trios items of wave 24 (leaderTier per want class, near-duplicate trios as alsoWith, a cap
// per closing pair). Judged sessions: scratchpad judge-8-w23.md (Warrior) and judge-7-w23.md (Cad Bane); the calls are the
// sessions' own (the Warrior's 50-card list and the Cad Bane core).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
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
const WARRIOR_LIST = [
  ["09010254", 2], ["08010248", 2], ["09010208", 1], ["09010196", 2], ["09010209", 3], ["09010224", 3], ["07010246", 1], ["08010114", 1], ["09010117", 3],
  ["06010188", 3], ["09010136", 3], ["09010213", 3], ["09010225", 2], ["09010212", 2], ["09010127", 1], ["08010219", 2], ["08010236", 1], ["05010261", 1],
  ["05010246", 2], ["06010096", 1], ["05010105", 1], ["08010135", 2], ["04010201", 1], ["09010230", 2], ["05010186", 2], ["09010145", 1], ["08010112", 2],
].map(([card, count]) => ({ card, count }));
const CAD_CORE = [
  { card: "Marrok, Mysterious Warrior", count: 3 }, { card: "Pre Vizsla, Strong-Willed Ruler", count: 3 }, { card: "08010052", count: 3 },
  { card: "IG-2000, Assassin's Aggressor", count: 3 }, { card: "No Glory, Only Results", count: 3 }, { card: "Koska Reeves, Warrior of Mandalore", count: 3 },
  { card: "Justifier, Relentless", count: 3 }, { card: "TIE Dagger Vanguard", count: 3 }, { card: "HK-47, Exclamation: Die, Meatbag!", count: 3 },
  { card: "Onyx Squadron Brute", count: 3 }, { card: "Ninth Sister, Hulking Inquisitor", count: 2 }, { card: "Outer Rim Constable", count: 2 },
];

const trios = (args: Record<string, unknown>): Record<string, any> => body(SYNERGY_TOOLS.find_trios.handler(real, { withAlternatives: false, ...args }));
const keysOf = (t: Record<string, any>): string[] => String(t.cardKeys).split("|");
const LOCKS = ["baseLocked", "nameLocked", "needsForce", "needsTrait", "needsHost", "leaderClash", "riderUnmet", "drawback"];

const OGGDO = "05010063";

describe.skipIf(!hasData)("leaderTier keeps one card per want class and folds the rest into alternatives (#170 item 3, D89)", () => {
  const tier = (): Record<string, any>[] => trios({ leader: CAD_BANE, base: NEVARRO, weighting: "none", decklist: CAD_CORE, limit: 6 }).leaderTier as Record<string, any>[];

  it("Cad Bane, weighting none: no two leaderTier rows rest on the same link into the same want clause (five Grit units were five rows)", () => {
    const rows = tier();
    const classes = rows.map((r) => `${r.link} | ${((r.evidence ?? []) as Record<string, any>[]).map((e) => e.want).join(" / ")}`);
    expect(new Set(classes).size, classes.join("\n")).toBe(classes.length);
  });

  it("the first Grit row lists the other Grit units as alternatives, and Oggdo Bogdo (can't attack unless damaged) gets a row", () => {
    const rows = tier();
    const grit = rows.find((r) => ((r.evidence ?? []) as Record<string, any>[]).some((e) => e.want === "Grit")) as Record<string, any>;
    expect(grit, rows.map((r) => r.title).join("; ")).toBeDefined();
    expect(((grit.alternatives ?? []) as unknown[]).length).toBeGreaterThanOrEqual(4);
    expect(rows.map((r) => r.cardKey)).toContain(OGGDO);
  });
});

const BOWCASTER = "09010127";
const CAMP = "09010216";
const CHEWBACCA = "09010117";
const IMPROVISED_IDENTITY = "08010230";
const TUSKEN_RAIDER = "09010224";
const TARPALS = "09010254";
const KELLERAN_OTHERS = "08010206";
const NEEL = "08010248";
const GROGU = "05010246";

describe.skipIf(!hasData)("a near-duplicate trio whose new card links only through a generic want is an alsoWith entry (#170 item 4, D89)", () => {
  it("the Warrior's step 14: Improvised Identity holds no row of its own; it is listed alsoWith on the Camp and Neel rows", () => {
    const list = trios({ leader: WARRIOR, base: ORIGIN_TREE, decklist: WARRIOR_LIST, limit: 5, evidence: false }).trios as Record<string, any>[];
    const shown = list.map((t) => t.cards).join(" | ");
    expect(list.filter((t) => keysOf(t).includes(IMPROVISED_IDENTITY)).map((t) => t.cards)).toEqual([]);
    const camp = list.find((t) => [BOWCASTER, CAMP, CHEWBACCA].every((k) => keysOf(t).includes(k))) as Record<string, any>;
    expect(camp, shown).toBeDefined();
    expect(((camp.alsoWith ?? []) as Record<string, any>[]).map((a) => a.title)).toContain("Improvised Identity");
    const neel = list.find((t) => [CAMP, NEEL, GROGU].every((k) => keysOf(t).includes(k))) as Record<string, any>;
    expect(((neel?.alsoWith ?? []) as Record<string, any>[]).map((a) => a.title)).toContain("Improvised Identity");
  });

  it("Tusken Raider + Captain Tarpals + Kelleran Beq, the distinct package, is back on the five-row page", () => {
    const list = trios({ leader: WARRIOR, base: ORIGIN_TREE, decklist: WARRIOR_LIST, limit: 5, evidence: false }).trios as Record<string, any>[];
    expect(list.some((t) => [TUSKEN_RAIDER, TARPALS, KELLERAN_OTHERS].every((k) => keysOf(t).includes(k))), list.map((t) => t.cards).join(" | ")).toBe(true);
  });

  it("#169's own-row rule holds for a third card with a specific link: Bowcaster + Insurgent Camp + Chewbacca is a row in the step 6 page", () => {
    const list = trios({ leader: WARRIOR, base: ORIGIN_TREE, weighting: "none", decklist: WARRIOR_LIST, limit: 6, evidence: false }).trios as Record<string, any>[];
    expect(list.some((t) => [BOWCASTER, CAMP, CHEWBACCA].every((k) => keysOf(t).includes(k))), list.map((t) => t.cards).join(" | ")).toBe(true);
  });
});

/** The links into the payoff (every link of a loop), as "A>B" card keys from the trio's evidence. */
const closingOf = (t: Record<string, any>): string[] => {
  const keys = keysOf(t);
  const titles = String(t.cards).split(" + ");
  const keyOf = new Map(titles.map((title, i) => [title, keys[i]]));
  const links = [...new Set(((t.evidence ?? []) as Record<string, any>[]).map((e) => String(e.link)))].map((l) => l.split(" > ").map((x) => keyOf.get(x)).join(">"));
  return links.filter((l) => t.shape === "loop" || l.endsWith(`>${keys[2]}`));
};

describe.skipIf(!hasData)("trios are capped per closing card pair (#170 item 4, D89)", () => {
  it.each([
    ["the Warrior, step 6", { leader: WARRIOR, base: ORIGIN_TREE, weighting: "none", decklist: WARRIOR_LIST }],
    ["Cad Bane, step 6", { leader: CAD_BANE, base: NEVARRO, weighting: "none", decklist: CAD_CORE }],
  ])("%s: an unlocked trio whose every closing link an earlier row already shows follows every unlocked trio of its leaderAlreadyFeeds class with a new one", (_name, args) => {
    const list = (trios({ ...args, limit: 12 }).trios as Record<string, any>[]).filter((t) => LOCKS.every((f) => t[f] === undefined) && t.leaderAlreadyFeeds === undefined && t.score > 0);
    const seen = new Set<string>();
    const repeated = list.map((t) => {
      const closing = closingOf(t);
      const rep = closing.length > 0 && closing.every((l) => seen.has(l));
      if (!rep) for (const l of closing) seen.add(l);
      return rep;
    });
    const first = repeated.indexOf(true);
    if (first >= 0) expect(repeated.slice(first).every(Boolean), list.map((t, i) => `${repeated[i] ? "R " : ""}${t.cards}`).join(" | ")).toBe(true);
  });

  const NEEL_BUREAUCRAT_CHEWIE = [NEEL, "06010216", CHEWBACCA];
  it("the Warrior, step 6: Neel + Regulations Bureaucrat + Chewbacca closes only on the Bureaucrat > Chewbacca link an earlier row shows, so it leaves the first 12 rows (it was 8th)", () => {
    const list = trios({ leader: WARRIOR, base: ORIGIN_TREE, weighting: "none", decklist: WARRIOR_LIST, limit: 12, evidence: false }).trios as Record<string, any>[];
    expect(list.some((t) => NEEL_BUREAUCRAT_CHEWIE.every((k) => keysOf(t).includes(k))), list.map((t) => t.cards).join(" | ")).toBe(false);
  });

  it("the Warrior, step 14: the same trio keeps its place on the five-row page, where no earlier row closes on that link", () => {
    const list = trios({ leader: WARRIOR, base: ORIGIN_TREE, decklist: WARRIOR_LIST, limit: 5, evidence: false }).trios as Record<string, any>[];
    const neel = list.find((t) => NEEL_BUREAUCRAT_CHEWIE.every((k) => keysOf(t).includes(k)));
    expect(neel, list.map((t) => t.cards).join(" | ")).toBeDefined();
    expect(neel?.closingRepeats).toBeUndefined();
  });
});


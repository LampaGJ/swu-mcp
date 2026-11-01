import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import type { ToolResult } from "../../src/tools.js";
import { DECK_TOOLS } from "../../src/tools/deck.js";
import { META_TOOLS } from "../../src/tools/meta.js";

// LampaGJ/swu-mcp#169, D87: the playable_cards and deck_audit items of wave 23. Judged sessions: scratchpad judge-8-w22.md (Warrior)
// and judge-7-w22.md (Cad Bane).

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
const LIGHTMAKER = "06010207";
const DARKSABER = "08010135";

const playable = (args: Record<string, unknown>): Record<string, any> => body(DECK_TOOLS.playable_cards.handler(real, args));

describe.skipIf(!hasData)("a negative row the deck holds or the leader's lists play at 50% stays listed (#169 item 2, D87)", () => {
  it("Lightmaker (58% of Warrior lists, measured negative) is listed and flagged at cost 5 in the session's call, and the cap prints what it removed", () => {
    const out = playable({ leader: WARRIOR, base: ORIGIN_TREE, limit: 24, perCost: 3 });
    const cards = out.cards as Record<string, any>[];
    const lightmaker = cards.find((r) => r.cardKey === LIGHTMAKER) as Record<string, any>;
    expect(lightmaker, cards.filter((r) => r.cost === 5).map((r) => r.title).join("; ")).toBeDefined();
    expect(lightmaker.evidenceClass).toBe("negative");
    expect(typeof out.negativeHidden).toBe("number");
  });

  it("The Darksaber, held by the owner's deck and measured negative, is listed and flagged when the decklist is given", () => {
    const cards = playable({ leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, limit: 24, perCost: 3 }).cards as Record<string, any>[];
    const saber = cards.find((r) => r.cardKey === DARKSABER) as Record<string, any>;
    expect(saber, cards.filter((r) => r.cost === 4).map((r) => r.title).join("; ")).toBeDefined();
    expect(saber.evidenceClass).toBe("negative");
  });

  it("deck_audit fills and missingStaples carry evidenceClass, so the audit and playable_cards flag Lightmaker alike", () => {
    const out = body(DECK_TOOLS.deck_audit.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST }));
    const fillRows = (out.curveGlut?.fills ?? []) as Record<string, any>[];
    expect(fillRows.length).toBeGreaterThan(0);
    for (const r of fillRows) expect(r, r.title).toHaveProperty("evidenceClass");
    expect(fillRows.find((r) => r.cardKey === LIGHTMAKER)?.evidenceClass).toBe("negative");
    const staples = out.leaderComparison.missingStaples as Record<string, any>[];
    expect(staples.length).toBeGreaterThan(0);
    for (const r of staples) expect(r, r.title).toHaveProperty("evidenceClass");
    expect(staples.find((r) => r.cardKey === LIGHTMAKER)?.evidenceClass).toBe("negative");
  });
});

describe.skipIf(!hasData)("playable_cards prints evidenceGap on every row (#169 item 9, D87)", () => {
  // D89 (#170) flips "null unless negative": an ok row prints its measured gap too; only unmeasured and thin-control rows print null.
  it("Cad Bane's step 4: every row carries evidenceGap (null unless measured), so the rows stay one TOON table", () => {
    const result = DECK_TOOLS.playable_cards.handler(real, { leader: CAD_BANE, base: NEVARRO, limit: 24, perCost: 3 });
    const cards = body(result).cards as Record<string, any>[];
    for (const r of cards) expect(r, r.title).toHaveProperty("evidenceGap");
    for (const r of cards.filter((x) => x.evidenceClass !== "negative" && x.evidenceClass !== "ok")) expect(r.evidenceGap, r.title).toBeNull();
    expect(cards.some((x) => x.evidenceClass === "ok" && typeof x.evidenceGap === "number")).toBe(true);
    expect(result.content[0].text).toMatch(/^cards\[\d+\]\{/m);
  });
});

const AETHERSPRITE = "05010197";
const LIFE_WIND_SAGE = "05010212";
const KELLERAN = "08010206";
const GREE = "09010138";
const audit = (): Record<string, any> => body(DECK_TOOLS.deck_audit.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST }));

describe.skipIf(!hasData)("a fill's deck links skip the generic When Played want (#169 item 4, D87)", () => {
  it("Qui-Gon Jinn's Aethersprite no longer counts the 6 deck links the judged run gave it through wants:when-played-cards", () => {
    const fills = audit().curveGlut.fills as Record<string, any>[];
    const sprite = fills.find((r) => r.cardKey === AETHERSPRITE);
    if (sprite !== undefined) expect(sprite.deckLinks).toBeLessThan(6);
  });
});

describe.skipIf(!hasData)("a leader-engine fill leads only within its fillRank band (#169 item 5, D87)", () => {
  it("Kelleran Beq (fillRank 3.806) precedes Life Wind Sage (engine, 3); no engine fill precedes a fill of a higher band; Commander Gree stays listed", () => {
    const fills = audit().curveGlut.fills as Record<string, any>[];
    const cost4 = fills.filter((r) => r.cost === 4);
    const keys = cost4.map((r) => r.cardKey);
    const shown = cost4.map((r) => `${r.title} ${r.fillRank}${r.leaderEngine ? " engine" : ""}`).join("; ");
    expect(keys, shown).toContain(GREE);
    expect(keys, shown).toContain(KELLERAN);
    if (keys.includes(LIFE_WIND_SAGE)) expect(keys.indexOf(KELLERAN), shown).toBeLessThan(keys.indexOf(LIFE_WIND_SAGE));
    const band = (r: Record<string, any>): number => Math.round(Number(r.fillRank) * 2);
    for (const cost of new Set(fills.map((r) => r.cost))) {
      const rows = fills.filter((r) => r.cost === cost);
      rows.forEach((a, i) => {
        for (const b of rows.slice(i + 1)) if (a.leaderEngine === true && b.leaderEngine !== true) expect(band(a), `${a.title} before ${b.title}`).toBeGreaterThanOrEqual(band(b));
      });
    }
  });
});

const MARROK = "08010030";
const CAD_CORE = [
  { card: "Marrok, Mysterious Warrior", count: 3 }, { card: "Pre Vizsla, Strong-Willed Ruler", count: 3 }, { card: "08010052", count: 3 },
  { card: "IG-2000, Assassin's Aggressor", count: 3 }, { card: "No Glory, Only Results", count: 3 }, { card: "Koska Reeves, Warrior of Mandalore", count: 3 },
  { card: "Justifier, Relentless", count: 3 }, { card: "TIE Dagger Vanguard", count: 3 }, { card: "HK-47, Exclamation: Die, Meatbag!", count: 3 },
  { card: "Onyx Squadron Brute", count: 3 }, { card: "Ninth Sister, Hulking Inquisitor", count: 2 }, { card: "Outer Rim Constable", count: 2 },
];
const cadAnswers = (extra: Record<string, unknown> = {}): Record<string, any> =>
  body(META_TOOLS.meta_answers.handler(real, { leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE, limit: 10, archetypes: 6, ...extra }));
const answerRows = (out: Record<string, any>): Record<string, any>[] => [...(out.staples as Record<string, any>[]), ...(out.additions as Record<string, any>[])];

describe.skipIf(!hasData)("meta_answers: an answer whose condition no deck card feeds covers nothing (#169 item 7, D87)", () => {
  // D89 (#170): Justifier's Advantage token is an upgrade, so the full core feeds Marrok; the rule is held on the core without Justifier.
  it("Marrok (Saboteur only while upgraded, no upgrade in the core without Justifier): coverage 0, and threatsCovered counts him apart as unfed", () => {
    const out = cadAnswers({ decklist: CAD_CORE.filter((d) => d.card !== "Justifier, Relentless") });
    const marrok = answerRows(out).find((r) => r.cardKey === MARROK) as Record<string, any>;
    expect(marrok).toBeDefined();
    expect((marrok.answers as Record<string, any>[]).every((a) => a.conditionUnfed !== undefined), JSON.stringify(marrok.answers)).toBe(true);
    expect(marrok.coverage).toBe(0);
    expect(marrok.archetypesAnswered).toBe(0);
    const covered = String(out.threatsCovered);
    const sentinel = /sentinel-wall (\d+)(?: \(\+(\d+) unfed\))?/.exec(covered);
    expect(sentinel, covered).not.toBeNull();
    const firm = answerRows(out).filter((r) => (r.answers as Record<string, any>[]).some((a) => a.threat === "sentinel-wall" && a.conditionUnfed === undefined)).length;
    expect(Number(sentinel?.[1]), covered).toBe(firm);
    expect(Number(sentinel?.[2] ?? 0), covered).toBeGreaterThanOrEqual(1);
  });
});

import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import type { ToolResult } from "../../src/tools.js";
import { DECK_TOOLS } from "../../src/tools/deck.js";
import { META_TOOLS } from "../../src/tools/meta.js";

// LampaGJ/swu-mcp#165 items 12, 13 and 15 to 18, D83: the Darksaber sequence, measured-first staples, the sideboard cardpool
// check, meta_answers with the swudb sideboard, the role a budget slot cannot fill, and a swap that pays the opponent.
// Judged sessions: scratchpad judge-8-w18.md (Warrior), judge-7-w18.md (Cad Bane).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const OWNER_SWUDB = JSON.parse(readFileSync(path.join(HERE, "../fixtures/decks/warrior-chewie-raid.swudb.json"), "utf8")) as {
  metadata: { name: string };
  leader: { id: string; count: number };
  base: { id: string; count: number };
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
const OUTER_RIM_CONSTABLE = "06010163";
const CHIMAERA = "08010052";
const NO_GLORY = "04010043";
const EXPLOIT_CONFIDENCE = "09010238";
const DISPLAY_PIECE = "07010103";
const FAR_FAR_AWAY = "08010236";
const AXE_FORGETS = "07010246";
const SHYYYO = "09010145";
const BOBA_FETT = "09010225";
const CAD_CORE = [
  { card: "Marrok, Mysterious Warrior", count: 3 }, { card: "Pre Vizsla, Strong-Willed Ruler", count: 3 }, { card: "08010052", count: 3 },
  { card: "IG-2000, Assassin's Aggressor", count: 3 }, { card: "No Glory, Only Results", count: 3 }, { card: "Koska Reeves, Warrior of Mandalore", count: 3 },
  { card: "Justifier, Relentless", count: 3 }, { card: "TIE Dagger Vanguard", count: 3 }, { card: "HK-47, Exclamation: Die, Meatbag!", count: 3 },
  { card: "Onyx Squadron Brute", count: 3 }, { card: "Ninth Sister, Hulking Inquisitor", count: 2 }, { card: "Outer Rim Constable", count: 2 },
];

describe.skipIf(!hasData)("deck_audit reports the Darksaber sequence of taxed carriers (#165 item 12, D83)", () => {
  const audit = (): Record<string, any> => body(DECK_TOOLS.deck_audit.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, gapLimit: 10 }));

  it("Qimir, Darth Traya and Marchion Ro pay 0 while a Darksaber sits on the first of them you play, which pays its own penalty", () => {
    const a = audit();
    for (const title of ["Qimir", "Darth Traya", "Marchion Ro"]) {
      const row = a.aspect.uncovered.find((r: Record<string, any>) => String(r.card).startsWith(title));
      expect(row.sequenced, title).toBe(true);
      expect(row.effectivePenaltyEach, title).toBe(0);
      expect(row.removedBy, title).toContain("the first one you play pays its own aspect penalty");
    }
  });

  it("the sequence total is a range: best case 2 (one carrier taxed), worst case 14 (every copy at its printed penalty)", () => {
    const seq = audit().aspect.sequence;
    expect(seq.bestCaseTotal).toBe(2);
    expect(seq.worstCaseTotal).toBe(14);
    expect(seq.note).toContain("must be drawn");
  });
});

describe.skipIf(!hasData)("meta_answers ranks measured staples before unmeasured ones (#165 item 13, D83)", () => {
  it("Cad Bane: the significant Outer Rim Constable is listed before the unmeasured Chimaera and No Glory, Only Results", () => {
    const staples: Record<string, any>[] = body(META_TOOLS.meta_answers.handler(real, { leader: CAD_BANE, base: NEVARRO, limit: 10, archetypes: 6 })).staples;
    const at = (k: string): number => staples.findIndex((s) => s.cardKey === k);
    expect(staples.find((s) => s.cardKey === OUTER_RIM_CONSTABLE)?.significant).toBe(true);
    expect(at(OUTER_RIM_CONSTABLE)).toBeGreaterThanOrEqual(0);
    for (const k of [CHIMAERA, NO_GLORY]) if (at(k) >= 0) expect(at(OUTER_RIM_CONSTABLE), k).toBeLessThan(at(k));
  });
});

describe.skipIf(!hasData)("meta_answers staples: measured (ok) before unmeasured, the coordinator's ruling of 2026-10-31 (#165 item 13, D83)", () => {
  it("Warrior: Far Far Away and The Axe Forgets (ok) sit above the unmeasured Origin Tree Shyyyo and Boba Fett; the negative Ahsoka stays below the ok rows", () => {
    const staples: Record<string, any>[] = body(META_TOOLS.meta_answers.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, limit: 10, archetypes: 6 })).staples;
    const at = (k: string): number => staples.findIndex((s) => s.cardKey === k);
    for (const k of [FAR_FAR_AWAY, AXE_FORGETS, SHYYYO, BOBA_FETT]) expect(at(k), k).toBeGreaterThanOrEqual(0);
    expect(staples[at(FAR_FAR_AWAY)].evidenceClass).toBe("ok");
    expect(staples[at(SHYYYO)].evidenceClass).toBe("unmeasured");
    for (const ok of [FAR_FAR_AWAY, AXE_FORGETS]) for (const unmeasured of [SHYYYO, BOBA_FETT]) expect(at(ok), `${ok} before ${unmeasured}`).toBeLessThan(at(unmeasured));
    const lastOk = Math.max(...staples.flatMap((s, i) => (s.evidenceClass === "ok" ? [i] : [])));
    staples.forEach((s, i) => {
      if (s.evidenceClass === "unmeasured" || s.evidenceClass === "negative") expect(i, s.title).toBeGreaterThan(lastOk);
    });
  });
});

describe.skipIf(!hasData)("deck_legality_check checks sideboard cards against the Premier cardpool (#165 item 15, D83)", () => {
  // The served data holds no rotated card (a rotated name does not resolve), so the failing case is in tests/deck-tools.test.ts on synthetic sets.
  it("the owner's sideboard is checked against the cardpool and passes; the data limits no longer say the sideboard skips it", () => {
    const out = body(DECK_TOOLS.deck_legality_check.handler(real, { swudb: OWNER_SWUDB }));
    expect(out.legal).toBe(true);
    expect((out.dataLimits as string[]).join(" ")).not.toContain("not checked against the Premier cardpool");
    expect((out.dataLimits as string[]).join(" ")).toContain("against the Premier cardpool like the deck");
  });

});

describe.skipIf(!hasData)("meta_answers takes the swudb document and marks what the sideboard holds (#165 item 16, D83)", () => {
  it("Exploit Confidence, two copies in the owner's sideboard, carries inSideboard: 2", () => {
    const out = body(META_TOOLS.meta_answers.handler(real, { swudb: OWNER_SWUDB, limit: 10, archetypes: 6 }));
    // D84 (#166) flipped where the row sits: a sideboard answer is listed under sideboardAnswers, never among the additions.
    const rows: Record<string, any>[] = [...out.staples, ...out.additions, ...(out.sideboardAnswers ?? [])];
    const exploit = rows.find((r) => r.cardKey === EXPLOIT_CONFIDENCE);
    expect(exploit, rows.map((r) => r.title).join("; ")).toBeDefined();
    expect(exploit?.inSideboard).toBe(2);
    for (const r of rows) if (r.cardKey !== EXPLOIT_CONFIDENCE && r.inSideboard !== undefined) expect(OWNER_SWUDB.sideboard.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasData)("budget_alternatives names the role no band card fills, and a swap's drawback (#165 items 17 and 18, D83)", () => {
  it("Chewbacca's Bowcaster: band upgrades exist, none resources a card, and the reason says so", () => {
    const out = body(DECK_TOOLS.budget_alternatives.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, maxPrice: 2 }));
    const row = (out.noAlternative as Record<string, any>[]).find((r) => String(r.card).startsWith("Chewbacca's Bowcaster"));
    expect(row).toBeDefined();
    expect(row?.reason).not.toBe("no card within the cost band");
    expect(row?.reason).toContain("no card in the cost band fills");
  });

  it("Display Piece, offered for No Glory, carries its drawback: the defeated unit's controller resources it", () => {
    const out = body(DECK_TOOLS.budget_alternatives.handler(real, { leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE, maxPrice: 2 }));
    const swaps = (out.slots as Record<string, any>[]).flatMap((s) => s.alternatives as Record<string, any>[]);
    const display = swaps.find((a) => a.cardKey === DISPLAY_PIECE);
    expect(display).toBeDefined();
    expect(display?.drawback).toContain("Its controller resources it");
  });
});

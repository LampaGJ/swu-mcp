import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import { buildTags } from "../../src/ability-grammar/index.js";
import { indexLeaderCards } from "../../src/meta/schema.js";
import { createSynergyContext, DEFAULT_CURATED_PATH, DEFAULT_TABLE_PATH, loadCuratedClauses } from "../../src/synergy/context.js";
import { cardLabel } from "../../src/synergy/order.js";
import { complementarityTableSchema, synergyCardsSchema } from "../../src/synergy/schema.js";
import type { ToolResult } from "../../src/tools.js";
import { DECK_TOOLS, inPremierPool } from "../../src/tools/deck.js";
import { findTrios, SYNERGY_TOOLS } from "../../src/tools/synergy.js";

// LampaGJ/swu-mcp#173, D91: the tool items of wave 25. Judged sessions: scratchpad judge-8-w24.md (Warrior, dump
// deck-session-dump-8-w24.txt) and judge-7-w24.md (Cad Bane, dump deck-session-dump-7-w24.txt); the calls are the sessions' own
// (the Warrior's 50-card list and the Cad Bane core).

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
const WARRIOR_ASPECTS = ["Cunning", "Heroism", "Command"];
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

const pairings = (args: Record<string, unknown>): Record<string, any>[] =>
  body(SYNERGY_TOOLS.find_pairings.handler(real, { evidence: false, withAlternatives: false, ...args })).pairings as Record<string, any>[];
const trios = (args: Record<string, unknown>): Record<string, any> => body(SYNERGY_TOOLS.find_trios.handler(real, { withAlternatives: false, ...args }));
const keysOf = (t: Record<string, any>): string[] => String(t.cardKeys).split("|");

const PELLAEON = "08010093";
const FO_TIE = "04010081";
const FLANKING_FANG = "04010257";
const TRAYA = "06010188";
const CAT_AND_MOUSE = "04010195";
const UNDERCOVER_OPERATION = "06010236";
const CAMP = "09010216";
const GREE = "09010138";
const CHEWBACCA = "09010117";
const CHIEFTAIN = "09010212";

describe.skipIf(!hasData)("find_pairings ranks on the effective penalty only for cards the deck holds (#173 item 1, D91)", () => {
  const warrior5a = (): Record<string, any>[] => pairings({ cardKey: WARRIOR, leader: WARRIOR, base: ORIGIN_TREE, decklist: WARRIOR_LIST, limit: 10, aspects: WARRIOR_ASPECTS });

  it("step 5a: Captain Pellaeon and First Order TIE Fighter (not in the deck) rank at their printed penalty, so Flanking Fang Fighter is back in the top 10", () => {
    const rows = warrior5a();
    const keys = rows.map((r) => r.cardKey);
    expect(keys, rows.map((r) => `${r.title} ${r.rank}`).join("; ")).toContain(FLANKING_FANG);
    for (const k of [PELLAEON, FO_TIE]) {
      const row = rows.find((r) => r.cardKey === k);
      if (row === undefined) continue;
      expect(row.effectivePenalty).toBe(0);
      expect(row.effectiveNote).toMatch(/printed penalty/);
      expect(row.rank).toBeLessThanOrEqual(0.5);
    }
  });

  it("a deck card still ranks on the penalty the remover leaves (Darth Traya, effective 0, keeps rank 0.75 at a 1.5 score)", () => {
    const traya = warrior5a().find((r) => r.cardKey === TRAYA) as Record<string, any>;
    expect(traya.effectivePenalty).toBe(0);
    expect(traya.effectiveNote).toBeUndefined();
    expect(traya.rank).toBeGreaterThan(0.7);
  });

  it("step 13 (weighting none): Pellaeon no longer sits level with Insurgent Camp, and Commander Gree is back on the 8 rows", () => {
    const rows = pairings({ cardKey: WARRIOR, leader: WARRIOR, base: ORIGIN_TREE, decklist: WARRIOR_LIST, limit: 8, weighting: "none" });
    const at = (k: string): number => rows.findIndex((r) => r.cardKey === k);
    expect(at(CAMP)).toBeGreaterThanOrEqual(0);
    expect(at(PELLAEON) === -1 || at(PELLAEON) > at(CAMP)).toBe(true);
    expect(rows.map((r) => r.cardKey)).toContain(GREE);
  });

  it("step 5c (The Chieftain): penalty-free Undercover Operation ranks above Cat and Mouse (penalty 2, not in the deck)", () => {
    const rows = pairings({ cardKey: CHIEFTAIN, leader: WARRIOR, base: ORIGIN_TREE, decklist: WARRIOR_LIST, limit: 10, aspects: WARRIOR_ASPECTS });
    const at = (k: string): number => rows.findIndex((r) => r.cardKey === k);
    expect(at(UNDERCOVER_OPERATION)).toBeGreaterThanOrEqual(0);
    expect(at(CAT_AND_MOUSE) === -1 || at(CAT_AND_MOUSE) > at(UNDERCOVER_OPERATION)).toBe(true);
  });

  it("a Raid-gain condition no deck card feeds is marked: First Order TIE Fighter needs a token unit the Warrior deck never makes", () => {
    const rows = pairings({ cardKey: WARRIOR, leader: WARRIOR, base: ORIGIN_TREE, decklist: WARRIOR_LIST, limit: 100, perLink: 100, aspects: WARRIOR_ASPECTS });
    const tie = rows.find((r) => r.cardKey === FO_TIE) as Record<string, any>;
    expect(tie, "First Order TIE Fighter row").toBeDefined();
    expect(tie.conditionUnfed).toMatch(/wants:tokens/);
    const chewie = pairings({ cardKey: CHEWBACCA, leader: WARRIOR, base: ORIGIN_TREE, decklist: WARRIOR_LIST, limit: 100, perLink: 100, aspects: WARRIOR_ASPECTS });
    expect(chewie.filter((r) => r.cardKey === FLANKING_FANG).map((r) => r.conditionUnfed)).not.toContainEqual(expect.stringMatching(/Fighter/));
  });
});

const ACKLAY = "09010156";
const RANCOR_KEEPER = "08010032";
const TIE_DAGGER = "04010239";
const OGGDO = "05010063";
const GALVANIZED_LEAP = "08010188";

describe.skipIf(!hasData)("leaderTier, weighting none, keeps one row per want class and ranks rows on what the leader feeds (#173 item 5, D91)", () => {
  const tier = (): Record<string, any>[] => trios({ leader: CAD_BANE, base: NEVARRO, weighting: "none", decklist: CAD_CORE, limit: 6, evidence: false }).leaderTier as Record<string, any>[];
  const named = (rows: Record<string, any>[]): string[] => rows.flatMap((r) => [r.title as string, ...((r.alternatives ?? []) as string[])]);

  it("Cad Bane: the damage-taken payoffs (Arena Acklay, Rancor Keeper) and TIE Dagger Vanguard are in the tier, and Galvanized Leap does not rank above them", () => {
    const rows = tier();
    const all = named(rows).join(" | ");
    expect(all).toMatch(/Arena Acklay/);
    expect(all).toMatch(/Rancor Keeper/);
    expect(all).toMatch(/TIE Dagger Vanguard/);
    const at = (k: string): number => rows.findIndex((r) => r.cardKey === k);
    expect(at(ACKLAY) >= 0 || at(RANCOR_KEEPER) >= 0, rows.map((r) => r.title).join("; ")).toBe(true);
    const leap = at(GALVANIZED_LEAP);
    expect(leap === -1 || leap > Math.max(at(ACKLAY), at(RANCOR_KEEPER))).toBe(true);
  });

  it("coordinator ruling 2026-10-31: a card the deck holds heads its want class, so TIE Dagger Vanguard heads the damaged-units row", () => {
    const rows = tier();
    const damaged = rows.find((r) => r.link === "offers:damage-any-unit -> wants:damaged-units") as Record<string, any>;
    expect(damaged, rows.map((r) => `${r.title}: ${r.link}`).join("; ")).toBeDefined();
    expect(damaged.cardKey).toBe(TIE_DAGGER);
    expect(damaged.inDeck).toBe(true);
    expect(((damaged.alternatives ?? []) as string[]).some((a) => /Venomous Wyyyshokk/.test(a)), String(damaged.alternatives)).toBe(true);
  });

  it("no two rows share a link into the same want, and Oggdo Bogdo stays in the tier (row or alternative)", () => {
    const rows = tier();
    const links = rows.filter((r) => r.linkKind !== "leader-engine").map((r) => r.link);
    expect(new Set(links).size, links.join("\n")).toBe(links.length);
    expect(named(rows).join(" | ")).toMatch(/Oggdo Bogdo/);
    expect(rows.some((r) => r.cardKey === OGGDO) || rows.some((r) => ((r.alternatives ?? []) as string[]).some((a) => /Oggdo/.test(a)))).toBe(true);
    void TIE_DAGGER;
  });
});

const WHBN = "06010245";
const EMERGENCY_POWERS = "06010040";
const MARROK = "08010030";

describe.skipIf(!hasData)("an opener whose condition no deck card meets carries riderUnmet (#173 item 6, D91)", () => {
  it("When Has Become Now needs a Plot card in your resources, and the Cad Bane core holds none", () => {
    const own = trios({ leader: CAD_BANE, base: NEVARRO, weighting: "none", decklist: CAD_CORE, cardKey: WHBN, limit: 10, evidence: false }).trios as Record<string, any>[];
    expect(own.length).toBeGreaterThan(0);
    const ep = own.find((t) => [WHBN, EMERGENCY_POWERS, MARROK].every((k) => keysOf(t).includes(k))) as Record<string, any>;
    expect(ep, own.map((t) => t.cards).join(" | ")).toBeDefined();
    expect(ep.riderUnmet).toMatch(/When Has Become Now: .*needs a card with Plot/);
    // A trio whose other member has Plot (Fully Armed and Operational) meets the gate and carries no such rider.
    for (const t of own.filter((x) => x.riderUnmet === undefined)) expect(String(t.cards)).toMatch(/Fully Armed and Operational/);
    // The step 6 page: the When Has Become Now trio no longer holds a row among the unlocked trios.
    const page = trios({ leader: CAD_BANE, base: NEVARRO, weighting: "none", decklist: CAD_CORE, limit: 6, evidence: false }).trios as Record<string, any>[];
    expect(page.filter((t) => keysOf(t).includes(WHBN)).map((t) => t.cards)).toEqual([]);
  });
});

const CHIMAERA = "08010052";
const COMMENCE_PATROL = "04010205";
const OWEN_LARS = "05010057";

describe.skipIf(!hasData)("with a decklist, a heavy-penalty trio and one whose new card adds no link the deck lacks follow (#173 item 7, D91)", () => {
  const step14 = (): Record<string, any>[] =>
    trios({ leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE, limit: 5, maxTotalCost: 12, evidence: false }).trios as Record<string, any>[];

  it("Cad Bane step 14: Chimaera + Commence Patrol + Koska (penalty 4) is no longer on the first five rows ahead of penalty-0 trios", () => {
    const list = step14();
    const at = list.findIndex((t) => [CHIMAERA, COMMENCE_PATROL].every((k) => keysOf(t).includes(k)));
    // Within the idea tier (a deck card and a card from outside the deck: newCardWeight is printed) no unlocked penalty-0 trio follows it.
    const zeroAfter = list.slice(at + 1).some((t) => t.penalty === 0 && t.newCardWeight !== undefined && t.riderUnmet === undefined && t.leaderAlreadyFeeds === undefined);
    expect(at === -1 || !zeroAfter, list.map((t) => `${t.cards} (${t.penalty})`).join(" | ")).toBe(true);
  });

  it("a trio flagged as adding no new link says which links the deck already has", () => {
    const list = trios({ leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE, limit: 40, maxTotalCost: 12, evidence: false }).trios as Record<string, any>[];
    const flagged = list.filter((t) => t.deckHasLinks !== undefined);
    expect(flagged.length, list.map((t) => t.cards).join(" | ")).toBeGreaterThan(0);
    const lastPlain = list.map((t, i) => (t.deckHasLinks === undefined && t.riderUnmet === undefined && t.leaderAlreadyFeeds === undefined && t.penalty < 4 ? i : -1)).filter((i) => i >= 0);
    const firstFlagged = list.findIndex((t) => t.deckHasLinks !== undefined && t.riderUnmet === undefined && t.leaderAlreadyFeeds === undefined && t.deckMembers === 2);
    if (firstFlagged >= 0) expect(lastPlain.filter((i) => i > firstFlagged && list[i].deckMembers === 2).length).toBe(0);
    void OWEN_LARS;
  });
});

// The run's features were tagged before #173, so this block re-derives every card's tags with the current tag builder from the
// run's own clause features, as the next build:data will, and reads the trios through that context.
describe.skipIf(!hasData)("coordinator ruling 2026-10-31: a deck-restating trio that shares two members with a listed row folds into its alsoWith (#173 item 7, D91)", () => {
  it("Cad Bane step 14: the No Glory + X + Koska Reeves trios whose X adds no link the deck lacks are one row, the others listed alsoWith", () => {
    const pkg = builtRun as string;
    const raw = JSON.parse(readFileSync(path.join(pkg, "features/features.json"), "utf8")) as Record<string, unknown>[];
    const cards = synergyCardsSchema.parse(raw.map((c) => ({ ...c, tags: buildTags(c as never) })));
    const table = complementarityTableSchema.parse(JSON.parse(readFileSync(DEFAULT_TABLE_PATH, "utf8")));
    const leaderCards = indexLeaderCards(JSON.parse(readFileSync(path.join(pkg, "meta/leader-cards.json"), "utf8")));
    const ctx = createSynergyContext(cards, table, leaderCards, loadCuratedClauses(DEFAULT_CURATED_PATH));
    const keyOf = (title: string): string => (cards.find((c) => cardLabel(c) === title || c.cardKey === title) as { cardKey: string }).cardKey;
    const decklist = CAD_CORE.map((l) => ({ card: keyOf(l.card), count: l.count }));
    const deckCards = decklist.flatMap((l) => [ctx.graph.byKey.get(l.card) ?? []].flat());
    const deckCounts = new Map(decklist.map((l) => [l.card, l.count]));
    const args = { leader: CAD_BANE, base: NEVARRO, decklist, limit: 5, maxTotalCost: 12, evidence: false, withAlternatives: false };
    const list = body(findTrios(ctx, args, inPremierPool(real), deckCards, new Map(), deckCounts)).trios as Record<string, any>[];
    const noGlory = keyOf("No Glory, Only Results");
    const koska = keyOf("Koska Reeves, Warrior of Mandalore");
    const pairRows = list.filter((t) => [noGlory, koska].every((k) => keysOf(t).includes(k)));
    expect(pairRows.length, list.map((t) => t.cards).join(" | ")).toBe(1);
    const folded = ((pairRows[0].alsoWith ?? []) as Record<string, any>[]).filter((a) => a.deckHasLinks !== undefined);
    expect(folded.length, JSON.stringify(pairRows[0].alsoWith)).toBeGreaterThanOrEqual(2);
    for (const a of folded) expect(String(a.deckHasLinks)).toMatch(/already feeds it|feeds it itself/);
  });
});

describe.skipIf(!hasData)("playable_cards names a cost emptied only by hidden negative cards (#173 item 8, D91)", () => {
  it("the Warrior's step 4: cost 7's only candidates are measured negative, so emptyCosts names cost 7", () => {
    const out = body(DECK_TOOLS.playable_cards.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, decklist: WARRIOR_LIST, limit: 24, perCost: 3 }));
    expect((out.cards as Record<string, any>[]).some((c) => c.cost === 7)).toBe(false);
    expect(out.negativeHidden).toBeGreaterThan(0);
    expect(out.emptyCosts).toMatch(/\b7: every candidate is measured negative\b/);
  });
});

const BT1 = "BT-1";
const MERRIN = "Merrin";

describe.skipIf(!hasData)("deck_audit clusterGaps never prints an empty gap list, and self-discard fills no disruption label (#173 item 9, D91)", () => {
  const audit = (): Record<string, any> => body(DECK_TOOLS.deck_audit.handler(real, { leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE })).clusterGaps as Record<string, any>;

  it("no shown cluster has an empty cards field: a cluster with no qualifying card names its defining tags", () => {
    const gaps = audit().gapCards as Record<string, any>[];
    for (const g of gaps) expect(String(g.cards), `${g.clusterId} ${g.label}`).not.toBe("");
    const friendly = gaps.find((g) => g.label === "friendly unit triggers");
    if (friendly !== undefined && !/%|unplayed/.test(String(friendly.cards))) expect(String(friendly.cards)).toMatch(/^none: .*wants:|^none: .*offers:/);
  });

  it("'hand disruption and disclose' names no card whose only job there is discarding or milling your own cards (BT-1, Merrin)", () => {
    const gaps = audit().gapCards as Record<string, any>[];
    const hand = gaps.find((g) => g.label === "hand disruption and disclose");
    if (hand === undefined) return;
    expect(String(hand.cards)).not.toContain(BT1);
    expect(String(hand.cards)).not.toContain(MERRIN);
  });
});

const BOWCASTER = "09010127";
const TUSKEN_RAIDER = "09010224";
const TARPALS = "09010254";
const KELLERAN_OTHERS = "08010206";

describe.skipIf(!hasData)("the Warrior trios restored in #169 and #170 still show (#173 acceptance)", () => {
  it("step 14: Bowcaster + Insurgent Camp + Chewbacca leads, and Tusken Raider + Captain Tarpals + Kelleran Beq is on the five-row page", () => {
    const list = trios({ leader: WARRIOR, base: ORIGIN_TREE, decklist: WARRIOR_LIST, limit: 5, evidence: false }).trios as Record<string, any>[];
    expect([BOWCASTER, CAMP, CHEWBACCA].every((k) => keysOf(list[0]).includes(k)), list.map((t) => t.cards).join(" | ")).toBe(true);
    expect(list.some((t) => [TUSKEN_RAIDER, TARPALS, KELLERAN_OTHERS].every((k) => keysOf(t).includes(k))), list.map((t) => t.cards).join(" | ")).toBe(true);
  });

  it("step 6 (weighting none): Bowcaster + Insurgent Camp + Chewbacca is listed", () => {
    const list = trios({ leader: WARRIOR, base: ORIGIN_TREE, weighting: "none", decklist: WARRIOR_LIST, limit: 6, evidence: false }).trios as Record<string, any>[];
    expect(list.some((t) => [BOWCASTER, CAMP, CHEWBACCA].every((k) => keysOf(t).includes(k))), list.map((t) => t.cards).join(" | ")).toBe(true);
  });
});

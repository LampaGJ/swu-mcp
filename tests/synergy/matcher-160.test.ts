import { decode } from "@toon-format/toon";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractFeatures, loadCuratedTable } from "../../src/ability-grammar/index.js";
import { swuFeatureInputCardSchema } from "../../src/schemas/card-features.js";
import { createSynergyContext } from "../../src/synergy/context.js";
import { coverCombos } from "../../src/synergy/cover.js";
import { edgeEvidence } from "../../src/synergy/evidence.js";
import { buildPairGraph } from "../../src/synergy/graph.js";
import { engineHitOf, leaderEngineOf } from "../../src/synergy/leader-engine.js";
import { synergyCardsSchema, type SynergyCard } from "../../src/synergy/schema.js";
import { searchTrios } from "../../src/synergy/trios.js";
import type { ToolResult } from "../../src/tools.js";
import { findPairings } from "../../src/tools/synergy.js";
import type { CardSpec } from "../ability-grammar/helpers.js";
import { COMMITTED_TABLE, mk } from "./fixtures.js";

// LampaGJ/swu-mcp#160 Matcher bullets, D72: a count of units with a printed stat wants those units; Fett's Firespray pays off Ambush.
// Card rows from the 2026-10-31 run (originals 2026-10-16), text verbatim; T-keys are synthetic.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const { index } = loadCuratedTable(readFileSync(path.join(REPO_ROOT, "data/curated-rules.json"), "utf8"));
type Spec = CardSpec & { subtitle?: string; cost?: number; power?: number; hp?: number; arenas?: string; unique?: boolean; aspects?: string };
const featuresOf = (spec: Spec) => extractFeatures([swuFeatureInputCardSchema.parse({ type2: "", ...spec })], index).cards[0];

const KELLERAN = "08010206";
const TARPALS = "09010254";
const TUSKEN = "09010224";
const CHEWBACCA = "09010117";
const RAIDING_PARTY = "09010230";
const NEEL = "08010248";
const FIRESPRAY = "09010053";
const WARRIOR = "09010018";

const CARDS = {
  [KELLERAN]: {
    cardKey: KELLERAN, title: "Kelleran Beq", subtitle: "Where are the Others?", type: "Unit", traits: "Force|Jedi", keywords: "Ambush", cost: 4, power: 3, hp: 5, arenas: "Ground", unique: true, aspects: "Cunning|Heroism",
    text: "Ambush\nThis unit gets +1/+0 for each other unit (friendly and enemy) with 0 power.",
  },
  [TARPALS]: {
    cardKey: TARPALS, title: "Captain Tarpals", subtitle: "Grand Army Captain", type: "Unit", traits: "Gungan|Trooper", keywords: "Shielded|Raid", cost: 1, power: 0, hp: 2, arenas: "Ground", unique: true, aspects: "Heroism",
    text: "Shielded (When you play this unit, give a Shield token to him.)\nRaid 2 (This unit gets +2/+0 while attacking.)",
  },
  [TUSKEN]: { cardKey: TUSKEN, title: "Tusken Raider", type: "Unit", traits: "Tusken", keywords: "Raid", cost: 2, power: 0, hp: 4, arenas: "Ground", aspects: "Cunning", text: "Raid 3 (This unit gets +3/+0 while attacking.)" },
  [CHEWBACCA]: {
    cardKey: CHEWBACCA, title: "Chewbacca", subtitle: "Resourceful Wookiee", type: "Unit", traits: "Wookiee", keywords: "Raid|Overwhelm", cost: 3, power: 0, hp: 5, arenas: "Ground", unique: true, aspects: "Command|Heroism",
    text: "This unit gains Raid 1 for each exhausted resource you control.\nWhile each resource you control is exhausted, this unit gains Overwhelm.",
  },
  [RAIDING_PARTY]: {
    cardKey: RAIDING_PARTY, title: "Raiding Party", type: "Unit", traits: "Tusken", keywords: "Raid", cost: 5, power: 0, hp: 6, arenas: "Ground", aspects: "Cunning",
    text: "Raid 6 (This unit gets +6/+0 while attacking.)\nWhen Played: If you control another Tusken unit or a Tatooine base, you may exhaust a ground unit.",
  },
  [NEEL]: {
    cardKey: NEEL, title: "Neel", subtitle: "The Cutest Boy", type: "Unit", traits: "Fringe", cost: 1, power: 1, hp: 4, arenas: "Ground", unique: true, aspects: "Heroism",
    text: "When Played/On Attack: The next unit you play this phase with 1 or less power enters play ready.",
  },
  [FIRESPRAY]: {
    cardKey: FIRESPRAY, title: "Fett's Firespray", subtitle: "Settling the Score", type: "Unit", traits: "Underworld|Vehicle|Transport", keywords: "Ambush", cost: 6, power: 6, hp: 6, arenas: "Space", unique: true, aspects: "Aggression|Cunning",
    text: "Friendly units can attack bases while using Ambush.",
  },
  [WARRIOR]: {
    cardKey: WARRIOR, title: "The Warrior", subtitle: "Deft Duelist", type: "Leader", traits: "Tusken", keywords: "Ambush|Raid", cost: 5, power: 3, hp: 6, arenas: "Ground", unique: true, aspects: "Cunning|Heroism",
    text: "Action [1 resource, Exhaust]: Play a unit with 3 or less power from your hand (paying its cost) and give it Ambush for this phase.",
    deployBox: "Ambush (When you deploy this leader, she may immediately attack an enemy unit.)\nRaid 1 (This unit gets +1/+0 while attacking.)",
    epicAction: "Epic Action: If you control 5 or more resources, deploy this leader.",
  },
  T160A: { cardKey: "T160A", title: "Small Squad Leader", type: "Unit", traits: "Trooper", cost: 3, power: 2, hp: 3, arenas: "Ground", aspects: "Command", text: "This unit gets +1/+0 for each other friendly unit with 1 or less power." },
  T160B: { cardKey: "T160B", title: "Heavy Hauler", type: "Unit", traits: "Vehicle", cost: 4, power: 2, hp: 5, arenas: "Ground", aspects: "Command", text: "This unit gets +1/+1 for each other friendly unit that costs 5 or more." },
} satisfies Record<string, Spec>;

const FEATURES = Object.values(CARDS).map((spec) => featuresOf(spec));
const BASE = mk("B160", "Test Base", { type: "Base", aspects: ["Command"], icons: ["Command"] });
const CARDS_ALL: SynergyCard[] = [...synergyCardsSchema.parse(FEATURES), BASE];
const byKey = new Map(CARDS_ALL.map((c) => [c.cardKey, c]));
const card = (k: string): SynergyCard => byKey.get(k) as SynergyCard;
const graph = buildPairGraph(CARDS_ALL, COMMITTED_TABLE);
const wantsOf = (k: string) => card(k).tags.wants.map((t) => t.tag);
const offersOf = (k: string) => card(k).tags.offers.map((t) => t.tag);
const rowsOf = (from: string, to: string) => graph.edgeByKey.get(`${from}>${to}`)?.rows.map((r) => r.row) ?? [];
const body = (r: ToolResult): Record<string, any> => {
  expect(r.isError, r.content[0].text.slice(0, 300)).toBeUndefined();
  return decode(r.content[0].text) as Record<string, any>;
};
const ZERO_POWER = [TARPALS, TUSKEN, CHEWBACCA, RAIDING_PARTY];

describe("a count of units with a printed stat wants those units (Kelleran Beq, Where are the Others?)", () => {
  it("Kelleran's 'for each other unit with 0 power' is a want for 0-power units, with the clause as its why", () => {
    const want = card(KELLERAN).tags.wants.find((w) => w.tag === "wants:unit-power-0");
    expect(want?.why).toBe("text: This unit gets +1/+0 for each other unit with 0 power.");
  });
  it("links every printed 0-power unit to Kelleran through stat-count:power-0, and no unit with power above 0", () => {
    for (const k of ZERO_POWER) expect(rowsOf(k, KELLERAN), k).toContain("stat-count:power-0");
    for (const k of [NEEL, FIRESPRAY, "T160A"]) expect(rowsOf(k, KELLERAN), k).not.toContain("stat-count:power-0");
  });
  it("the link's evidence names the printed stat and quotes Kelleran's clause", () => {
    const e = graph.edgeByKey.get(`${TARPALS}>${KELLERAN}`);
    const rows = e?.rows.filter((r) => r.row === "stat-count:power-0") ?? [];
    expect(edgeEvidence(card(TARPALS), card(KELLERAN), rows)).toEqual([{ offer: "printed power 0", want: "text: This unit gets +1/+0 for each other unit with 0 power." }]);
  });
  it("reads 'with N or less power' and 'that costs N or more' too", () => {
    expect(wantsOf("T160A")).toContain("wants:unit-power-1-or-less");
    expect(wantsOf("T160B")).toContain("wants:unit-cost-5-or-more");
    for (const k of [TARPALS, NEEL, CHEWBACCA]) expect(rowsOf(k, "T160A"), k).toContain("stat-count:power-1-or-less");
    for (const k of [KELLERAN, FIRESPRAY]) expect(rowsOf(k, "T160A"), k).not.toContain("stat-count:power-1-or-less");
    for (const k of [RAIDING_PARTY, FIRESPRAY]) expect(rowsOf(k, "T160B"), k).toContain("stat-count:cost-5-or-more");
    for (const k of [TARPALS, KELLERAN]) expect(rowsOf(k, "T160B"), k).not.toContain("stat-count:cost-5-or-more");
  });
  it("a leader or a base is no counted unit", () => {
    expect(rowsOf(WARRIOR, "T160A")).not.toContain("stat-count:power-1-or-less");
    expect(rowsOf("B160", KELLERAN)).toEqual([]);
  });
  it("is a counting want: two 0-power units into Kelleran add up and keep a combo score (not D64 substitutes)", () => {
    const trios = searchTrios(graph, coverCombos(CARDS_ALL));
    const t = Object.values(trios.trios)
      .flat()
      .find((x) => [x.cardA, x.cardB, x.cardC].join("|") === `${TUSKEN}|${TARPALS}|${KELLERAN}`);
    expect(t).toBeDefined();
    expect(t?.score ?? 0).toBeGreaterThan(0);
    expect(t?.reasons.startsWith("substitutes:")).toBe(false);
  });
  it("find_pairings for Kelleran lists the four 0-power units with the clause as evidence", () => {
    const ctx = createSynergyContext(CARDS_ALL, COMMITTED_TABLE);
    const rows = body(findPairings(ctx, { cardKey: KELLERAN, limit: 20, perLink: 20, evidence: true, withAlternatives: false })).pairings as Record<string, any>[];
    for (const k of ZERO_POWER) {
      const row = rows.find((r) => r.cardKey === k);
      expect(row, k).toBeDefined();
      expect(row?.link).toContain("offers:printed-power-0 -> wants:unit-power-0");
      expect(JSON.stringify(row?.evidence)).toContain("for each other unit with 0 power");
    }
    expect(rows.map((r) => r.cardKey)).not.toContain(NEEL);
  });
});

describe("Fett's Firespray, Settling the Score pays off Ambush, so The Warrior's engine reads it", () => {
  it("wants friendly Ambush holders ('while using Ambush') and keeps its curated extra-attack offer", () => {
    const want = card(FIRESPRAY).tags.wants.find((w) => w.tag === "wants:keyword-ambush");
    expect(want?.why).toBe("text: Friendly units can attack bases while using Ambush.");
    expect(offersOf(FIRESPRAY)).toContain("offers:extra-attack");
  });
  it("is fed by a printed Ambush unit through keyword-ambush-payoff", () => {
    expect(rowsOf(KELLERAN, FIRESPRAY)).toContain("keyword-ambush-payoff");
  });
  it("is a pays-off hit of The Warrior's engine, quoting Firespray's clause", () => {
    const hit = engineHitOf(leaderEngineOf(card(WARRIOR)), card(FIRESPRAY));
    expect(hit?.kind).toBe("pays-off");
    expect(hit?.keyword).toBe("Ambush");
    expect(hit?.partnerText).toBe("Friendly units can attack bases while using Ambush.");
    expect(hit?.how).toContain("using Ambush");
  });
  it("find_pairings for The Warrior lists Firespray as a leader-engine row that quotes both clauses", () => {
    const ctx = createSynergyContext(CARDS_ALL, COMMITTED_TABLE);
    const rows = body(findPairings(ctx, { cardKey: WARRIOR, leader: WARRIOR, base: "B160", limit: 30, perLink: 30, evidence: true, withAlternatives: false })).pairings as Record<string, any>[];
    const row = rows.find((r) => r.cardKey === FIRESPRAY);
    expect(row).toBeDefined();
    expect(row?.linkKind).toBe("leader-engine");
    expect(row?.link).toBe("leader:grant-ambush -> wants:friendly-unit-with-ambush");
    expect(row?.reason).toContain("Play a unit with 3 or less power from your hand (paying its cost) and give it Ambush for this phase.");
    expect(row?.reason).toContain("Friendly units can attack bases while using Ambush.");
  });
});

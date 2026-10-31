import { decode } from "@toon-format/toon";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractFeatures, loadCuratedTable } from "../../src/ability-grammar/index.js";
import { swuFeatureInputCardSchema } from "../../src/schemas/card-features.js";
import { clauseLock, forceNeedOfText, lockFields, lockSupply, makesForce, traitGateOfClause } from "../../src/synergy/clause-lock.js";
import { createSynergyContext } from "../../src/synergy/context.js";
import { evidenceSpan, tagEvidence } from "../../src/synergy/evidence.js";
import { buildPairGraph } from "../../src/synergy/graph.js";
import { synergyCardsSchema, type SynergyCard } from "../../src/synergy/schema.js";
import type { ToolResult } from "../../src/tools.js";
import { findPairings, findTrios } from "../../src/tools/synergy.js";
import type { CardSpec } from "../ability-grammar/helpers.js";
import { COMMITTED_TABLE, mk } from "./fixtures.js";

// LampaGJ/swu-mcp#158, D68: evidence keeps the cost and gate, Force and trait locks, drawback When Defeated.
// Card rows from the 2026-10-31 run (originals 2026-10-16), text verbatim; T-keys are synthetic.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const { index } = loadCuratedTable(readFileSync(path.join(REPO_ROOT, "data/curated-rules.json"), "utf8"));
type Spec = CardSpec & { subtitle?: string; cost?: number; power?: number; hp?: number; arenas?: string; unique?: boolean; aspects?: string };
const featuresOf = (spec: Spec) => extractFeatures([swuFeatureInputCardSchema.parse({ type2: "", ...spec })], index).cards[0];

const CARDS = {
  "05010094": {
    cardKey: "05010094", title: "Jedi Consular", type: "Unit", traits: "Force|Jedi", cost: 2, power: 1, hp: 4, arenas: "Ground", aspects: "Command|Heroism",
    text: "Action [Exhaust, use the Force (lose your Force token)]: Play a unit from your hand. It costs 2 resources less.",
  },
  "05010249": {
    cardKey: "05010249", title: "Luke Skywalker", subtitle: "A Hero's Beginning", type: "Unit", traits: "Force|Fringe", cost: 4, power: 3, hp: 5, arenas: "Ground", unique: true, aspects: "Heroism",
    text: "When you play another <uq> (unique) unit: You may use the Force (lose your Force token). If you do, give an Experience token and a Shield token to this unit.",
  },
  "06010249": {
    cardKey: "06010249", title: "High Command Councilor", type: "Unit", traits: "Rebel|Official", keywords: "Raid", cost: 2, power: 1, hp: 4, arenas: "Ground", aspects: "Heroism",
    text: "While you control another Official unit, this unit gains Raid 2. (It gets +2/+0 while attacking.)",
  },
  "06010163": { cardKey: "06010163", title: "Outer Rim Constable", type: "Unit", traits: "Fringe|Official", cost: 2, power: 3, hp: 1, arenas: "Ground", aspects: "Aggression", text: "When Played: You may defeat an upgrade." },
  "05010193": { cardKey: "05010193", title: "Youngling Padawan", type: "Unit", traits: "Force|Jedi", cost: 2, power: 2, hp: 3, arenas: "Ground", aspects: "Cunning|Heroism", text: "When Played: The Force is with you (create your Force token)." },
  "05010196": {
    cardKey: "05010196", title: "Jedi Sentinel", type: "Unit", traits: "Force|Jedi", keywords: "Sentinel", cost: 4, power: 5, hp: 4, arenas: "Ground", aspects: "Cunning|Heroism",
    text: "While the Force is with you, this unit gains Sentinel. (Enemy units in this arena must attack a Sentinel when they attack you.)",
  },
  "09010142": {
    cardKey: "09010142", title: "Wookiee Rangers", type: "Unit", traits: "Wookiee", keywords: "Sentinel", cost: 5, power: 5, hp: 6, arenas: "Ground", aspects: "Command",
    text: "While you control another Wookiee unit or a Kashyyyk base, this unit gains Sentinel. (Enemy units in this arena must attack a Sentinel when they attack you.)",
  },
  "06010215": { cardKey: "06010215", title: "Emissary's Sheathipede", type: "Unit", traits: "Separatist|Vehicle|Transport", cost: 2, power: 2, hp: 4, arenas: "Space", aspects: "Cunning", text: "When Defeated: Each opponent may ready a resource." },
  "04010221": {
    cardKey: "04010221", title: "Stolen AT-Hauler", type: "Unit", traits: "Underworld|Vehicle|Transport", cost: 3, power: 4, hp: 5, arenas: "Space", aspects: "Cunning",
    text: "When Defeated: Choose an opponent. For this phase, they may play this unit from its owner's discard pile for free.",
  },
  T158D: { cardKey: "T158D", title: "Salvage Skiff", type: "Unit", traits: "Vehicle|Transport", cost: 2, power: 2, hp: 3, arenas: "Space", aspects: "Cunning", text: "When Defeated: Draw a card." },
  "04010127": {
    cardKey: "04010127", title: "Lightspeed Assault", type: "Event", traits: "Gambit", cost: 2, aspects: "Command",
    text: "Defeat a friendly space unit and deal damage equal to its power to an enemy space unit. If you do, deal indirect damage equal to the enemy unit's power to its controller.",
  },
  "09010216": {
    cardKey: "09010216", title: "Insurgent Camp", type: "Upgrade", traits: "Fortification", keywords: "Fortify", cost: 1, aspects: "Cunning|Heroism",
    text: "Fortify (Attach this to your base, not a unit.)\nWhen you play a unit with 3 or less power: You may defeat this upgrade. If you do, ready that unit.",
  },
  "08010248": {
    cardKey: "08010248", title: "Neel", subtitle: "The Cutest Boy", type: "Unit", traits: "Fringe", cost: 1, power: 1, hp: 4, arenas: "Ground", unique: true, aspects: "Heroism",
    text: "When Played/On Attack: The next unit you play this phase with 1 or less power enters play ready.",
  },
  T158E: { cardKey: "T158E", title: "Quick Muster", type: "Event", traits: "Tactic", cost: 1, aspects: "Cunning", text: "Play a unit from your hand. It costs 1 resource less." },
  "05010023": { cardKey: "05010023", title: "Jedi Temple", type: "Base", aspects: "Command", hp: 28, text: "When a friendly Force unit attacks: The Force is with you (create your Force token)." },
} satisfies Record<string, Spec>;

type Key = keyof typeof CARDS;
const KEYS = Object.keys(CARDS) as Key[];
const FEATURES = KEYS.map((k) => featuresOf(CARDS[k]));
const LEADER = mk("L158", "Test Leader", { type: "Leader", aspects: ["Cunning", "Heroism"], icons: ["Cunning", "Heroism"], traits: ["Tusken"] });
const BASE = mk("B158", "Test Base", { type: "Base", aspects: ["Command"], icons: ["Command"], traits: ["Kashyyyk"] });
const OTHER_BASE = mk("B158T", "Other Base", { type: "Base", aspects: ["Command"], icons: ["Command"], traits: ["Tatooine"] });
const CARDS_ALL = [...synergyCardsSchema.parse(FEATURES), LEADER, BASE, OTHER_BASE];
const byKey = new Map(CARDS_ALL.map((c) => [c.cardKey, c]));
const card = (k: string): SynergyCard => byKey.get(k) as SynergyCard;
const graph = buildPairGraph(CARDS_ALL, COMMITTED_TABLE);
const body = (r: ToolResult): Record<string, any> => {
  expect(r.isError, r.content[0].text.slice(0, 300)).toBeUndefined();
  return decode(r.content[0].text) as Record<string, any>;
};
const deck = (...keys: string[]) => keys.map((card) => ({ card, count: 1 }));

describe("evidence keeps the cost and the gating condition of the offer or want", () => {
  it("Jedi Consular's paid play quotes its 'use the Force' cost (judge line 2719)", () => {
    const text = tagEvidence(card("05010094"), "offers:paid-play");
    expect(text).toContain("use the Force");
    expect(text).toContain("Play a unit from your hand.");
  });
  it("Jedi Consular's ready want quotes the Action it readies, Force cost included", () => {
    expect(tagEvidence(card("05010094"), "wants:ready-unit")).toContain("Action [Exhaust, use the Force]: Play a unit from your hand.");
  });
  it("Luke's Shield offer keeps the 'You may use the Force. If you do' it hangs on", () => {
    expect(tagEvidence(card("05010249"), "offers:give-shield-self")).toBe(
      "text: When you play another unique unit: You may use the Force. If you do, give an Experience token and a Shield token to this unit.",
    );
  });
  it("Luke's trigger want quotes what the trigger costs", () => {
    expect(tagEvidence(card("05010249"), "wants:units-played")).toContain("When you play another unique unit: You may use the Force.");
  });
  it("Insurgent Camp's ready keeps the cost of defeating itself", () => {
    expect(tagEvidence(card("09010216"), "offers:ready-unit")).toContain("You may defeat this upgrade. If you do, ready that unit.");
  });
  it("a When Defeated want quotes what the trigger does", () => {
    expect(tagEvidence(card("T158D"), "wants:self-defeated")).toBe("text: When Defeated: Draw a card.");
  });
  it("a why that names no clause (printed trait, a title) is returned unchanged", () => {
    expect(evidenceSpan(card("05010094"), "printed trait")).toBe("printed trait");
    expect(evidenceSpan(card("05010094"), "title: Jedi Consular")).toBe("title: Jedi Consular");
  });
});

describe("needsForce: a clause that needs the Force is locked unless the leader, base or deck makes it", () => {
  it("reads the need from 'use the Force' and 'While the Force is with you', never from a clause that makes the Force", () => {
    expect(forceNeedOfText("You may use the Force.")).toBe("use the Force");
    expect(forceNeedOfText("Action [Exhaust, use the Force ]")).toBe("use the Force");
    expect(forceNeedOfText("While the Force is with you, this unit gains Sentinel.")).toBe("while the Force is with you");
    expect(forceNeedOfText("The Force is with you.")).toBeNull();
    expect(forceNeedOfText("If you do, the Force is with you.")).toBeNull();
    expect(forceNeedOfText("You may either exhaust a friendly unit or use the Force.")).toBeNull();
  });
  it("a card that says 'The Force is with you' makes the Force; 'While the Force is with you' does not", () => {
    expect(makesForce(card("05010193"))).toBe(true);
    expect(makesForce(card("05010023"))).toBe(true);
    expect(makesForce(card("05010196"))).toBe(false);
    expect(makesForce(card("05010094"))).toBe(false);
  });
  it("locks Jedi Consular (cost in the trigger) and Luke unless a deck card, the base or the leader makes the Force", () => {
    const plain = lockSupply(LEADER, BASE, [card("08010248"), card("09010216")]);
    expect(lockFields(clauseLock(card("05010094"), plain))).toEqual({ needsForce: "use the Force" });
    expect(lockFields(clauseLock(card("05010249"), plain))).toEqual({ needsForce: "use the Force" });
    expect(lockFields(clauseLock(card("05010094"), lockSupply(LEADER, BASE, [card("05010196")])))).toEqual({ needsForce: "use the Force" });
    expect(lockFields(clauseLock(card("05010094"), lockSupply(LEADER, BASE, [card("05010193")])))).toEqual({});
    expect(lockFields(clauseLock(card("05010094"), lockSupply(LEADER, card("05010023"), [card("08010248")])))).toEqual({});
  });
});

describe("needsTrait: a clause gated on a unit of a trait is locked unless the deck (or the leader's played lists) holds one", () => {
  it("reads the trait from 'another Official unit' and 'a Force unit', never from an aspect or an 'instead' upgrade", () => {
    expect(traitGateOfClause("While you control another Official unit, this unit gains Raid 2.")).toEqual({ traits: ["Official"], another: true });
    expect(traitGateOfClause("If you control a Force unit, draw a card.")).toEqual({ traits: ["Force"], another: false });
    expect(traitGateOfClause("While you control another Creature or Spectre unit, this unit gets +2/+2.")).toEqual({ traits: ["Creature", "Spectre"], another: true });
    expect(traitGateOfClause("While you control another Wookiee unit or a Kashyyyk base, this unit gains Sentinel.")).toEqual({ traits: ["Wookiee"], another: true, orBase: "Kashyyyk" });
    expect(traitGateOfClause("If you control another Bounty Hunter unit, you may deal damage.")).toEqual({ traits: ["Bounty Hunter"], another: true });
    expect(traitGateOfClause("While you control another Aggression unit, this unit gains Raid 2.")).toBeNull();
    expect(traitGateOfClause("If you control a Capital Ship unit, deal 12 indirect damage instead.")).toBeNull();
  });
  it("locks High Command Councilor unless another Official unit is in the deck; the card itself does not count", () => {
    expect(lockFields(clauseLock(card("06010249"), lockSupply(LEADER, BASE, [card("08010248")])))).toEqual({ needsTrait: "Official" });
    expect(lockFields(clauseLock(card("06010249"), lockSupply(LEADER, BASE, [card("06010249")])))).toEqual({ needsTrait: "Official" });
    expect(lockFields(clauseLock(card("06010249"), lockSupply(LEADER, BASE, [card("06010163")])))).toEqual({});
  });
  it("without a decklist the leader's played lists supply the trait; with neither the lock stays silent and keeps its old shape", () => {
    expect(lockFields(clauseLock(card("06010249"), lockSupply(LEADER, BASE, [], [card("06010163")])))).toEqual({});
    expect(lockFields(clauseLock(card("06010249"), lockSupply(LEADER, BASE, [], [card("08010248")])))).toEqual({ needsTrait: "Official" });
    expect(clauseLock(card("06010249"), lockSupply(LEADER, BASE, []))).toEqual({ baseLocked: [], needsUnitAspect: [] });
    expect(clauseLock(card("05010094"), lockSupply(LEADER, BASE, []))).toEqual({ baseLocked: [], needsUnitAspect: [] });
  });
  it("a trait gate with a base alternative is met by that base", () => {
    expect(lockFields(clauseLock(card("09010142"), lockSupply(LEADER, BASE, [card("08010248")])))).toEqual({});
    expect(lockFields(clauseLock(card("09010142"), lockSupply(LEADER, OTHER_BASE, [card("08010248")])))).toEqual({ needsTrait: "Wookiee or a Kashyyyk base" });
  });
});

describe("find_pairings and find_trios flag and demote the Force and trait locks", () => {
  const ctx = createSynergyContext(CARDS_ALL, COMMITTED_TABLE);
  it("find_pairings flags Luke as needsForce under a decklist that makes no Force and ranks him after every unlocked partner", () => {
    const rows = body(findPairings(ctx, { cardKey: "T158E", leader: "L158", base: "B158", decklist: deck("08010248", "09010216"), limit: 50, evidence: false, withAlternatives: false }))
      .pairings as Record<string, any>[];
    const at = rows.findIndex((r) => r.cardKey === "05010249");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(rows[at].needsForce).toBe("use the Force");
    expect(rows.some((r) => r.cardKey === "09010216" && r.needsForce === undefined)).toBe(true);
    const locked = (r: Record<string, any>) => ["baseLocked", "nameLocked", "needsForce", "needsTrait"].some((k) => r[k] !== undefined);
    const first = rows.findIndex(locked);
    expect(rows.slice(first).every(locked)).toBe(true);
  });
  it("find_pairings clears the Force lock when the decklist makes the Force", () => {
    const rows = body(findPairings(ctx, { cardKey: "T158E", leader: "L158", base: "B158", decklist: deck("05010193"), limit: 50, evidence: false, withAlternatives: false })).pairings as Record<string, any>[];
    expect(rows.find((r) => r.cardKey === "05010249")).not.toHaveProperty("needsForce");
  });
  it("find_pairings without a leader reads no Force or trait lock", () => {
    const rows = body(findPairings(ctx, { cardKey: "T158E", limit: 50, evidence: false, withAlternatives: false })).pairings as Record<string, any>[];
    expect(rows.find((r) => r.cardKey === "05010249")).not.toHaveProperty("needsForce");
  });
  it("find_trios flags Neel + Jedi Consular + Insurgent Camp as needsForce and ranks it after every unlocked trio", () => {
    const trios = body(findTrios(ctx, { leader: "L158", base: "B158", decklist: deck("08010248", "09010216"), limit: 40, evidence: false, withAlternatives: false })).trios as Record<string, any>[];
    const members = (t: Record<string, any>): string[] => String(t.cardKeys).split("|");
    // Youngling Padawan makes the Force, so a trio holding it meets Jedi Consular's cost.
    const withConsular = trios.filter((t) => members(t).includes("05010094") && !members(t).includes("05010193"));
    expect(withConsular.length).toBeGreaterThan(0);
    expect(withConsular.every((t) => t.needsForce === "use the Force")).toBe(true);
    const locked = (t: Record<string, any>) => ["baseLocked", "nameLocked", "needsForce", "needsTrait"].some((k) => t[k] !== undefined);
    const first = trios.findIndex(locked);
    expect(trios.slice(first).every(locked)).toBe(true);
  });
  it("find_trios: a trio member that makes the Force meets its partner's need", () => {
    const trios = body(findTrios(ctx, { leader: "L158", base: "B158", decklist: deck("08010248"), limit: 40, evidence: false, withAlternatives: false, includeLeaders: false })).trios as Record<string, any>[];
    for (const t of trios.filter((x) => String(x.cardKeys).split("|").includes("05010193"))) expect(t).not.toHaveProperty("needsForce");
  });
});

describe("a When Defeated that benefits the opponent is no sacrifice payoff", () => {
  const tagsOf = (k: string) => card(k).tags.wants.map((t) => t.tag);
  it("Emissary's Sheathipede ('Each opponent may ready a resource') and Stolen AT-Hauler want no defeat", () => {
    expect(tagsOf("06010215")).not.toContain("wants:self-defeated");
    expect(tagsOf("04010221")).not.toContain("wants:self-defeated");
  });
  it("a When Defeated that pays its controller still wants the defeat", () => {
    expect(tagsOf("T158D")).toContain("wants:self-defeated");
  });
  it("Lightspeed Assault no longer feeds Emissary's Sheathipede (judge lines 1834, 1851) and still feeds the paying unit", () => {
    expect(graph.edgeByKey.get("04010127>06010215")?.rows.map((r) => r.row) ?? []).toEqual([]);
    expect(graph.edgeByKey.get("04010127>T158D")?.rows.map((r) => r.row) ?? []).toContain("sac-outlet-when-defeated");
  });
});

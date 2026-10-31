import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractFeatures, loadCuratedTable } from "../../src/ability-grammar/index.js";
import { swuFeatureInputCardSchema } from "../../src/schemas/card-features.js";
import { coverCombos } from "../../src/synergy/cover.js";
import { buildPairGraph } from "../../src/synergy/graph.js";
import { roleKeepOf } from "../../src/synergy/leader-engine.js";
import { synergyCardsSchema } from "../../src/synergy/schema.js";
import { searchTrios } from "../../src/synergy/trios.js";
import { offerTags, wantTags, type CardSpec } from "../ability-grammar/helpers.js";
import { COMMITTED_TABLE, mk } from "./fixtures.js";

// LampaGJ/swu-mcp#155, D64: keyword copiers, Raid amplifiers, trait counts, target restrictions, feasible and non-redundant trios.
// Card rows from the 2026-10-31 run (originals 2026-10-16), text verbatim; T-keys are synthetic.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const { index } = loadCuratedTable(readFileSync(path.join(REPO_ROOT, "data/curated-rules.json"), "utf8"));
type Spec = CardSpec & { subtitle?: string; cost?: number; power?: number; hp?: number; arenas?: string; unique?: boolean; aspects?: string };
const featuresOf = (spec: Spec) => extractFeatures([swuFeatureInputCardSchema.parse({ type2: "", ...spec })], index).cards[0];

const CARDS = {
  "05010105": {
    cardKey: "05010105", title: "Oppo Rancisis", subtitle: "Ancient Councilor", type: "Unit", traits: "Force|Jedi|Republic",
    keywords: "Ambush|Grit|Hidden|Overwhelm|Saboteur|Sentinel|Shielded|Raid|Restore", cost: 3, power: 3, hp: 5, arenas: "Ground", unique: true, aspects: "Command",
    text: "This unit gains Ambush while another friendly unit has Ambush. The same is true for Grit, Hidden, Overwhelm, Saboteur, Sentinel, and Shielded.\nThis unit gains Raid 2 while another friendly unit has Raid. The same is true for Restore.",
  },
  "05010190": {
    cardKey: "05010190", title: "Anakin Skywalker", subtitle: "Force Prodigy", type: "Unit", traits: "Force|Fringe", keywords: "Hidden|Shielded",
    cost: 1, power: 1, hp: 1, arenas: "Ground", unique: true, aspects: "Cunning|Heroism",
    text: "Hidden (This unit can't be attacked if it was played this phase.)\nShielded (When you play this unit, give a Shield token to him.)",
  },
  "05010241": { cardKey: "05010241", title: "In the Shadows", type: "Event", traits: "Plan", keywords: "Hidden", cost: 2, aspects: "Villainy", text: "Give an Experience token to each of up to 3 friendly units with Hidden." },
  "08010064": {
    cardKey: "08010064", title: "The Armorer", subtitle: "Secrecy is Our Survival", type: "Unit", traits: "Mandalorian", keywords: "Shielded",
    cost: 6, power: 5, hp: 5, arenas: "Ground", unique: true, aspects: "Vigilance|Heroism",
    text: "Shielded (When you play this unit, give a Shield token to her.)\nWhen Played: Give a Shield token to each friendly unit with Shielded (including this one).",
  },
  T155A: { cardKey: "T155A", title: "Plain Trooper", type: "Unit", traits: "Trooper", cost: 2, power: 2, hp: 2, arenas: "Ground", text: "" },
  "05010186": {
    cardKey: "05010186", title: "Marchion Ro", subtitle: "Eye of the Nihil", type: "Unit", traits: "Underworld|Nihil", keywords: "Raid",
    cost: 6, power: 6, hp: 7, arenas: "Ground", unique: true, aspects: "Cunning|Villainy", text: "Each friendly unit's Raid is doubled.",
  },
  "09010117": {
    cardKey: "09010117", title: "Chewbacca", subtitle: "Resourceful Wookiee", type: "Unit", traits: "Wookiee", keywords: "Raid|Overwhelm",
    cost: 3, power: 0, hp: 5, arenas: "Ground", unique: true, aspects: "Command|Heroism",
    text: "This unit gains Raid 1 for each exhausted resource you control.\nWhile each resource you control is exhausted, this unit gains Overwhelm.",
  },
  "09010212": {
    cardKey: "09010212", title: "The Chieftain", subtitle: "Here Since the Oceans Dried", type: "Unit", traits: "Tusken", keywords: "Raid",
    cost: 3, power: 2, hp: 5, arenas: "Ground", unique: true, aspects: "Cunning|Heroism",
    text: "This unit gains Raid 1 for each other friendly Tusken unit.\nWhile a friendly Tusken unit is defending, it gets +1/+0 for each Raid it has.",
  },
  "09010224": { cardKey: "09010224", title: "Tusken Raider", type: "Unit", traits: "Tusken", keywords: "Raid", cost: 2, power: 0, hp: 4, arenas: "Ground", aspects: "Cunning", text: "Raid 3 (This unit gets +3/+0 while attacking.)" },
  "09010230": {
    cardKey: "09010230", title: "Raiding Party", type: "Unit", traits: "Tusken", keywords: "Raid", cost: 5, power: 0, hp: 6, arenas: "Ground", aspects: "Cunning",
    text: "Raid 6 (This unit gets +6/+0 while attacking.)\nWhen Played: If you control another Tusken unit or a Tatooine base, you may exhaust a ground unit.",
  },
  T155B: { cardKey: "T155B", title: "Ground Captain", type: "Unit", traits: "Official", cost: 3, power: 2, hp: 3, arenas: "Ground", text: "This unit gets +1/+0 for each other friendly ground unit." },
  "04010235": {
    cardKey: "04010235", title: "Commandeer", type: "Event", traits: "Trick", cost: 5, aspects: "Cunning",
    text: "Take control of a non-leader Vehicle unit that costs 6 or less without a Pilot on it. If you do, ready it. At the start of the next regroup phase, return that unit to its owner's hand.",
  },
  T155V: { cardKey: "T155V", title: "Patrol Skiff", type: "Unit", traits: "Vehicle|Transport", cost: 3, power: 2, hp: 4, arenas: "Ground", aspects: "Command", text: "Action [Exhaust]: Draw a card." },
  T155W: { cardKey: "T155W", title: "Heavy Hauler", type: "Unit", traits: "Vehicle|Transport", cost: 7, power: 5, hp: 8, arenas: "Ground", text: "Action [Exhaust]: Draw a card." },
  T155X: { cardKey: "T155X", title: "Strike Fighter", type: "Unit", traits: "Vehicle|Fighter", cost: 2, power: 2, hp: 2, arenas: "Space", text: "On Attack: Deal 1 damage to a unit." },
  "04010203": {
    cardKey: "04010203", title: "Han Solo", subtitle: "Has His Moments", type: "Unit", traits: "Rebel|Pilot", keywords: "Ambush|Piloting",
    cost: 5, power: 4, hp: 5, arenas: "Ground", unique: true, aspects: "Cunning|Heroism", text: "Ambush",
    epicAction: "Piloting [2 resources Cunning Heroism] \nWhen played as an upgrade: You may attack with attached unit. If it's the Millennium Falcon, it deals its combat damage before the defender.",
  },
  "04010121": { cardKey: "04010121", title: "Salvage", type: "Event", traits: "Supply", cost: 0, aspects: "Command", text: "Play a Vehicle unit from your discard pile (paying its cost). Then, deal 1 damage to it." },
  "09010216": {
    cardKey: "09010216", title: "Insurgent Camp", type: "Upgrade", traits: "Fortification", keywords: "Fortify", cost: 1, aspects: "Command",
    text: "Fortify (Attach this to your base, not a unit.)\nWhen you play a unit with 3 or less power: You may defeat this upgrade. If you do, ready that unit.",
  },
  "06010093": {
    cardKey: "06010093", title: "C-3PO", subtitle: "Anything I Might Do?", type: "Unit", traits: "Republic|Droid", cost: 1, power: 1, hp: 3, arenas: "Ground", unique: true,
    aspects: "Command|Heroism", text: "Action [Exhaust, return this unit to its owner's hand]: Give a unit +2/+2 for this phase.",
  },
  "08010248": {
    cardKey: "08010248", title: "Neel", subtitle: "The Cutest Boy", type: "Unit", traits: "Fringe", cost: 1, power: 1, hp: 4, arenas: "Ground", unique: true, aspects: "Heroism",
    text: "When Played/On Attack: The next unit you play this phase with 1 or less power enters play ready.",
  },
  T155C: { cardKey: "T155C", title: "Pep Talk", type: "Event", cost: 1, aspects: "Command", text: "Give an Experience token to a unit." },
  T155D: { cardKey: "T155D", title: "Supply Run", type: "Event", cost: 1, aspects: "Command", text: "Give a Shield token to a unit." },
  T155E: { cardKey: "T155E", title: "Armoured Veteran", type: "Unit", traits: "Trooper", cost: 3, power: 3, hp: 3, arenas: "Ground", aspects: "Command", text: "While this unit is upgraded, it gets +2/+0." },
  "04010093": {
    cardKey: "04010093", title: "Nien Nunb", subtitle: "Loyal Co-Pilot", type: "Unit", traits: "Rebel|Pilot", keywords: "Piloting", cost: 1, power: 1, hp: 2, arenas: "Ground", unique: true,
    aspects: "Command|Heroism", text: "This unit gets +1/+0 for each other friendly Pilot unit and upgrade.",
    epicAction: "Piloting [1 resource Command Heroism] \nAttached unit gets +1/+0 for each other friendly Pilot unit and upgrade.",
  },
  "09010235": { cardKey: "09010235", title: "Gaderffii Stick", type: "Upgrade", traits: "Item|Weapon", cost: 1, aspects: "Cunning", text: "Attach to a non-Vehicle unit with 3 or less power." },
  "09010236": { cardKey: "09010236", title: "Booma Ball", type: "Upgrade", traits: "Item|Weapon", cost: 3, aspects: "Cunning", text: "When Played: You may return an upgrade that costs 3 or less to its owner's hand." },
  T155F: { cardKey: "T155F", title: "Plate Armour", type: "Upgrade", traits: "Item|Armor", cost: 1, aspects: "Command", text: "Attached unit gets +1/+1." },
  T155G: { cardKey: "T155G", title: "Field Kit", type: "Upgrade", traits: "Item|Gear", cost: 1, aspects: "Command", text: "Attached unit gets +1/+1." },
  "06010010": {
    cardKey: "06010010", title: "Dedra Meero", subtitle: "Not Wasting Time", type: "Leader", traits: "Imperial|Official", keywords: "Raid", cost: 4, power: 2, hp: 5, arenas: "Ground", unique: true,
    aspects: "Aggression|Villainy", text: "Action [1 resource, Exhaust]: Choose an enemy unit. Its controller may deal 2 damage to it. If they don't, draw a card.",
    deployBox: "While you have more cards in hand than an opponent, this unit gains Raid 2. (She gets +2/+0 while attacking.)",
    epicAction: "Epic Action: If you control 4 or more resources, deploy this leader.",
  },
  T155H: { cardKey: "T155H", title: "Rage Charm", type: "Upgrade", traits: "Condition", cost: 1, aspects: "Command", text: "Attached unit gains Raid 2." },
} satisfies Record<string, Spec>;

type Key = keyof typeof CARDS;
const KEYS = Object.keys(CARDS) as Key[];
const FEATURES = KEYS.map((k) => featuresOf(CARDS[k]));
const feat = (k: Key) => FEATURES[KEYS.indexOf(k)];
const LEADER = mk("L155", "Test Leader", { type: "Leader", icons: ["Cunning", "Heroism"] });
const BASE = mk("B155", "Test Base", { type: "Base", icons: ["Command"] });
const CARDS_ALL = [...synergyCardsSchema.parse(FEATURES), LEADER, BASE];
const graph = buildPairGraph(CARDS_ALL, COMMITTED_TABLE);
const rowsOf = (a: string, b: string): string[] => graph.edgeByKey.get(`${a}>${b}`)?.rows.map((r) => r.row) ?? [];
const trios = searchTrios(graph, coverCombos(CARDS_ALL));
const keysOf = (t: { cardA: string; cardB: string; cardC: string }): string => [t.cardA, t.cardB, t.cardC].join("|");

describe("defect 1: Oppo Rancisis copies the keywords other friendly units have", () => {
  it("05010105 Oppo offers no keyword grant", () => {
    expect(offerTags(feat("05010105")).filter((t) => t.startsWith("offers:grant-"))).toEqual([]);
  });
  it("Oppo's role in a deck that supplies every keyword is not 'gives keywords' (judge line 1971)", () => {
    const supplied = new Set(["Ambush", "Grit", "Hidden", "Overwhelm", "Raid", "Restore", "Saboteur", "Sentinel", "Shielded"]);
    expect(roleKeepOf(graph.byKey.get("05010105")!, supplied)).toBeNull();
  });
  it("05010105 Oppo wants friendly units with each of the nine keywords it copies", () => {
    for (const k of ["ambush", "grit", "hidden", "overwhelm", "raid", "restore", "saboteur", "sentinel", "shielded"]) expect(wantTags(feat("05010105"))).toContain(`wants:keyword-${k}`);
  });
  it("05010190 Anakin Skywalker, Force Prodigy (printed Hidden, Shielded) links to Oppo through the Hidden and Shielded rows", () => {
    expect(offerTags(feat("05010190"))).toEqual(expect.arrayContaining(["offers:has-keyword-hidden", "offers:has-keyword-shielded"]));
    expect(rowsOf("05010190", "05010105")).toEqual(expect.arrayContaining(["grant-hidden-payoff", "grant-shielded-payoff"]));
  });
  it("a unit with no keyword does not link to Oppo", () => {
    expect(rowsOf("T155A", "05010105")).toEqual([]);
  });
  it("Oppo holds each copied keyword while another friendly unit has it, so he offers has-keyword, never grant", () => {
    for (const k of ["ambush", "grit", "hidden", "overwhelm", "raid", "restore", "saboteur", "sentinel", "shielded"]) expect(offerTags(feat("05010105"))).toContain(`offers:has-keyword-${k}`);
  });
  it("Oppo feeds 08010064 The Armorer's 'each friendly unit with Shielded' (pairs-v1 item labelled correct)", () => {
    expect(rowsOf("05010105", "08010064")).toContain("grant-shielded-payoff");
  });
  it("The Armorer (printed Shielded) feeds Oppo", () => {
    expect(rowsOf("08010064", "05010105")).toContain("grant-shielded-payoff");
  });
  it("a printed Hidden unit feeds that card", () => {
    expect(rowsOf("05010190", "05010241")).toContain("grant-hidden-payoff");
  });
});

describe("defect 2: Marchion Ro doubles Raid, so he wants units with Raid", () => {
  it("05010186 Marchion wants wants:keyword-raid", () => {
    expect(wantTags(feat("05010186"))).toContain("wants:keyword-raid");
  });
  it("09010117 Chewbacca (self-gained Raid) links to Marchion", () => {
    expect(offerTags(feat("09010117"))).toContain("offers:has-keyword-raid");
    expect(rowsOf("09010117", "05010186")).toContain("keyword-raid-payoff");
  });
  it("09010212 The Chieftain (self-gained Raid) links to Marchion", () => {
    expect(rowsOf("09010212", "05010186")).toContain("keyword-raid-payoff");
  });
  it("09010224 Tusken Raider (printed Raid 3) links to Marchion", () => {
    expect(rowsOf("09010224", "05010186")).toContain("keyword-raid-payoff");
  });
  it("a unit without Raid does not link to Marchion through a keyword row", () => {
    expect(rowsOf("05010190", "05010186")).not.toContain("keyword-raid-payoff");
    expect(rowsOf("T155A", "05010186")).toEqual([]);
  });
  it("a keyword mentioned in the text but not printed is no holder (Marchion's raw keywords field lists Raid)", () => {
    expect(offerTags(feat("05010186"))).not.toContain("offers:has-keyword-raid");
  });
});

describe("defect 3: 'for each other friendly <Trait> unit' wants units of that trait", () => {
  it("09010212 The Chieftain wants wants:trait-Tusken", () => {
    expect(wantTags(feat("09010212"))).toContain("wants:trait-Tusken");
  });
  it("09010224 Tusken Raider and 09010230 Raiding Party link to The Chieftain by trait", () => {
    expect(rowsOf("09010224", "09010212")).toContain("trait-reference:Tusken");
    expect(rowsOf("09010230", "09010212")).toContain("trait-reference:Tusken");
  });
  it("a non-Tusken unit gets no trait link to The Chieftain", () => {
    expect(rowsOf("09010117", "09010212").filter((r) => r.startsWith("trait-reference"))).toEqual([]);
  });
  it("'for each other friendly ground unit' names no trait", () => {
    expect(wantTags(feat("T155B")).filter((t) => t.startsWith("wants:trait-"))).toEqual([]);
  });
});

describe("defect 4: a take-control or attack clause's target restriction binds its partners", () => {
  it("04010235 Commandeer readies only the stolen Vehicle: no link to 09010117 Chewbacca or 09010212 The Chieftain", () => {
    expect(rowsOf("04010235", "09010117")).not.toContain("ready-reuse");
    expect(rowsOf("04010235", "09010212")).not.toContain("ready-reuse");
  });
  it("Commandeer readies a Vehicle that costs 6 or less", () => {
    expect(rowsOf("04010235", "T155V")).toContain("ready-reuse");
  });
  it("Commandeer does not ready a Vehicle that costs 7", () => {
    expect(rowsOf("04010235", "T155W")).not.toContain("ready-reuse");
  });
  it("04010203 Han Solo's Piloting attack goes through the Vehicle he pilots: no link to 09010117 Chewbacca", () => {
    expect(rowsOf("04010203", "09010117")).not.toContain("extra-attack-on-attack");
  });
  it("Han Solo's Piloting attack feeds a Vehicle's On Attack", () => {
    expect(rowsOf("04010203", "T155X")).toContain("extra-attack-on-attack");
  });
});

describe("ruling 2: a keyword a unit gives only itself is held, not granted", () => {
  for (const k of ["09010117", "09010212"] as const) {
    it(`${k} ${CARDS[k].title} offers has-keyword-raid and the self-gained extra-attacks want, never grant-raid`, () => {
      expect(offerTags(feat(k))).not.toContain("offers:grant-raid");
      expect(offerTags(feat(k))).toContain("offers:has-keyword-raid");
      expect(wantTags(feat(k))).toContain("wants:extra-attacks");
    });
    it(`roleKeepOf does not say ${CARDS[k].title} gives Raid`, () => {
      expect(roleKeepOf(graph.byKey.get(k)!, new Set(["Raid"]))).toBeNull();
    });
  }
  it("09010117 Chewbacca's self-gained Overwhelm is held, not granted", () => {
    expect(offerTags(feat("09010117"))).not.toContain("offers:grant-overwhelm");
    expect(offerTags(feat("09010117"))).toContain("offers:has-keyword-overwhelm");
  });
  it("06010010 Dedra Meero's deployed unit gains Raid itself: has-keyword-raid, never grant-raid, and it links to Marchion Ro", () => {
    expect(offerTags(feat("06010010"))).not.toContain("offers:grant-raid");
    expect(offerTags(feat("06010010"))).toContain("offers:has-keyword-raid");
    expect(rowsOf("06010010", "05010186")).toContain("keyword-raid-payoff");
  });
  it("an upgrade's 'Attached unit gains Raid 2' still grants Raid, and its role still says so", () => {
    expect(offerTags(feat("T155H"))).toContain("offers:grant-raid");
    expect(offerTags(feat("T155H"))).not.toContain("offers:has-keyword-raid");
    expect(roleKeepOf(graph.byKey.get("T155H")!, new Set(["Raid"]))?.families).toEqual(["grant-Raid"]);
  });
});

describe("defect 5: trios must compose and must not pair two substitutes", () => {
  it("Salvage > Insurgent Camp > C-3PO is no chain: Camp readies the Vehicle Salvage played", () => {
    expect(trios.trios.chain.map(keysOf)).not.toContain("04010121|09010216|06010093");
  });
  it("Salvage > Insurgent Camp > a Vehicle with Action [Exhaust] is a chain", () => {
    expect(trios.trios.chain.map(keysOf)).toContain("04010121|09010216|T155V");
  });
  it("Neel and Insurgent Camp both readying C-3PO rank as substitutes, after every combo", () => {
    const all = Object.values(trios.trios).flat();
    const t = all.find((x) => keysOf(x) === "06010093|08010248|09010216" || keysOf(x) === "08010248|09010216|06010093");
    expect(t).toBeDefined();
    expect(t?.score).toBe(0);
    expect(t?.reasons.startsWith("substitutes:")).toBe(true);
  });
  it("ruling 1: two upgrades into a want that counts upgrades (09010235 Gaderffii Stick + 09010236 Booma Ball + 04010093 Nien Nunb) add up: a combo with its normal score", () => {
    const t = Object.values(trios.trios).flat().find((x) => keysOf(x) === "09010235|09010236|04010093");
    expect(t).toBeDefined();
    expect(t?.score ?? 0).toBeGreaterThan(0);
    expect(t?.reasons.startsWith("substitutes:")).toBe(false);
  });
  it("ruling 1: two upgrades into 'while this unit is upgraded', which one upgrade satisfies, are substitutes", () => {
    const t = Object.values(trios.trios).flat().find((x) => keysOf(x) === "T155F|T155G|T155E");
    expect(t?.score).toBe(0);
    expect(t?.reasons.startsWith("substitutes:")).toBe(true);
  });
  it("two members that offer different things to the same want stay a combo", () => {
    const t = trios.trios["convergent-same-want"].find((x) => keysOf(x) === "T155C|T155D|T155E");
    expect(t?.score ?? 0).toBeGreaterThan(0);
    expect(t?.reasons.startsWith("substitutes:")).toBe(false);
  });
});

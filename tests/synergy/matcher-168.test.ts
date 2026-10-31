import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractFeatures, loadCuratedTable } from "../../src/ability-grammar/index.js";
import { answerOffers, counterCardSchema } from "../../src/meta/counters.js";
import { swuFeatureInputCardSchema } from "../../src/schemas/card-features.js";
import { buildPairGraph } from "../../src/synergy/graph.js";
import { synergyCardsSchema, type SynergyCard } from "../../src/synergy/schema.js";
import type { CardSpec } from "../ability-grammar/helpers.js";
import { COMMITTED_TABLE, mk } from "./fixtures.js";

// LampaGJ/swu-mcp#168 items 1 and 9, D86: a mode "each opponent" picks is the opponent's, like "an opponent chooses", and a ready
// that reaches only a unit that did not attack this phase gives no second attack. Judged session: scratchpad judge-7-w21.md (Cad Bane).
// Card rows from the 2026-11-01 run (originals 2026-10-16), text verbatim.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const { index } = loadCuratedTable(readFileSync(path.join(REPO_ROOT, "data/curated-rules.json"), "utf8"));
type Spec = CardSpec & { subtitle?: string; cost?: number; power?: number; hp?: number; arenas?: string; unique?: boolean; aspects?: string };
const featuresOf = (spec: Spec) => extractFeatures([swuFeatureInputCardSchema.parse({ type2: "", ...spec })], index).cards[0];

const GORAX = "09010188";
const NOT_OVER = "06010177";
const CLANDESTINE = "06010264";
const PLAIN_READY = "T168READY";

const CARDS = {
  [GORAX]: {
    cardKey: GORAX, title: "Giant Gorax", type: "Unit", cost: 7, power: 7, hp: 7, arenas: "Ground", aspects: "Aggression", traits: "Creature", keywords: "Overwhelm", unique: false,
    text: "Overwhelm\nOn Attack/When Defeated: If you control an Endor base, each opponent chooses one:\nYou deal 3 damage to a unit or base they control.\nThey discard a card from their hand and defeat a resource they control.\n",
  },
  [NOT_OVER]: {
    cardKey: NOT_OVER, title: "It's Not Over Yet", type: "Event", cost: 2, aspects: "Aggression", traits: "Innate",
    text: "You may ready a unit that didn't attack or enter play this phase.\nCreate a Spy token.",
  },
  [CLANDESTINE]: {
    cardKey: CLANDESTINE, title: "Clandestine Connections", type: "Upgrade", cost: 2, power: 1, hp: 1, aspects: "Villainy", traits: "Innate",
    text: "Attached unit gains: “On Attack: You may pay 2 resources. If you do, deal 2 damage to a base.”",
  },
  [PLAIN_READY]: { cardKey: PLAIN_READY, title: "Plain Ready Test Event", type: "Event", cost: 2, aspects: "Aggression", traits: "Innate", text: "Ready a unit." },
} satisfies Record<string, Spec>;

const FEATURES = Object.values(CARDS).map((spec) => featuresOf(spec));
const BASE = mk("B168", "Test Base", { type: "Base", aspects: ["Vigilance"], icons: ["Vigilance"] });
const CARDS_ALL: SynergyCard[] = [...synergyCardsSchema.parse(FEATURES), BASE];
const graph = buildPairGraph(CARDS_ALL, COMMITTED_TABLE);
const rowsOf = (from: string, to: string) => graph.edgeByKey.get(`${from}>${to}`)?.rows.map((r) => `${r.offer} -> ${r.want}`) ?? [];

describe("a mode each opponent picks is not the controller's offer (#168 item 1, D86)", () => {
  it("Giant Gorax's damage and discard modes carry opponentChooses, as Watto's do", () => {
    expect(graph.qualifier(GORAX, "offers", "offers:damage-enemy-unit")?.opponentChooses).toBe(true);
    expect(graph.qualifier(GORAX, "offers", "offers:discard-opponent")?.opponentChooses).toBe(true);
  });

  it("meta_answers' offers name the Endor gate of the mode list and the opponent's choice", () => {
    const raw = FEATURES.find((f) => f.cardKey === GORAX);
    const offers = answerOffers(counterCardSchema.parse(raw));
    const damage = offers.find((o) => o.tag === "offers:damage-enemy-unit");
    expect(damage?.opponentChooses).toContain("each opponent chooses one");
    expect((damage?.gates ?? []).join(" | ")).toContain("If you control an Endor base");
    const resources = offers.find((o) => o.tag === "disrupt-resources");
    expect(resources?.opponentChooses).toContain("each opponent chooses one");
    expect(offers.find((o) => o.tag === "keyword:Overwhelm")?.opponentChooses).toBeUndefined();
  });
});

describe("a ready of a unit that did not attack gives no second attack (#168 item 9, D86)", () => {
  it("It's Not Over Yet readies only a unit that didn't attack this phase, so it never feeds an extra-attacks want", () => {
    expect(rowsOf(NOT_OVER, CLANDESTINE)).not.toContain("offers:ready-unit -> wants:extra-attacks");
  });
  it("a plain ready still feeds the same want", () => {
    expect(rowsOf(PLAIN_READY, CLANDESTINE)).toContain("offers:ready-unit -> wants:extra-attacks");
  });
});

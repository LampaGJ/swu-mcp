import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { extractFeatures, loadCuratedTable } from "../../src/ability-grammar/index.js";
import { swuFeatureInputCardSchema } from "../../src/schemas/card-features.js";
import type { CardSpec } from "../ability-grammar/helpers.js";
import { CARDS_R3 as CARDS } from "../ability-grammar/regression-cards-round3.js";
import { buildPairGraph } from "../../src/synergy/graph.js";
import { synergyCardsSchema } from "../../src/synergy/schema.js";
import { COMMITTED_TABLE } from "./fixtures.js";

// Pair-level follow-ups for LampaGJ/swu-mcp#15 item 3, from the 2026-10-16 originals.

const { index } = loadCuratedTable(readFileSync(new URL("../../data/curated-rules.json", import.meta.url), "utf8"));
const featuresOf = (spec: CardSpec) => extractFeatures([swuFeatureInputCardSchema.parse({ type2: "", ...spec })], index).cards[0];

const keys = ["06010054", "08010168", "04010195", "06010224"] as const;
const cards = synergyCardsSchema.parse(keys.map((k) => featuresOf(CARDS[k])));
const graph = buildPairGraph(cards, COMMITTED_TABLE);
const rowsOf = (a: string, b: string): string[] => graph.edgeByKey.get(`${a}>${b}`)?.rows.map((r) => r.row) ?? [];

describe("an upgrade that blanks its host", () => {
  it("06010054 Exiled from the Force does not power 08010168 Migs Mayfeld's if-upgraded ability", () => {
    expect(rowsOf("06010054", "08010168")).not.toContain("upgrade-stacking");
  });
});

describe("a combat scope on a state want", () => {
  it("04010195 Cat and Mouse exhausts an enemy for 06010224 Vel Sartha's exhausted-enemy penalty", () => {
    expect(rowsOf("04010195", "06010224")).toContain("exhaust-enemy-payoff");
  });
});

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { decode } from "@toon-format/toon";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/create-server.js";
import { loadStore } from "../src/data.js";
import type { ToolResult } from "../src/tools.js";
import {
  cardFeaturesHandler,
  compareCardsHandler,
  dataVersionHandler,
  explainRubricHandler,
  findByEffectHandler,
  rankCardsHandler,
  scoreCardHandler,
} from "../src/tools/value.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const store = loadStore(fixtures);

function body(result: ToolResult): Record<string, any> {
  expect(result.isError, result.content[0].text).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

const DEATH_TROOPER = "0101033";

describe("score_card", () => {
  it("returns the component breakdown with one explanatory line each", () => {
    const out = body(scoreCardHandler(store, { cardKey: DEATH_TROOPER }));
    expect(out.card.title).toBe("Death Trooper");
    const names = out.components.map((c: { name: string }) => c.name);
    expect(names).toEqual(["expectedStats", "statSurplus", "keywordPoints", "effectPoints", "modifiers", "playabilityT", "playCalibrated", "total"]);
    for (const c of out.components) expect(c.why.length).toBeGreaterThan(10);
    expect(out.components.find((c: { name: string }) => c.name === "statSurplus").why).toContain("3/3");
    expect(out.dataVersion).toMatch(/^2026-10-16\.1\/[0-9a-f]{12}$/);
  });

  it("agrees with the stored scores and leaves terms out on request", () => {
    const withTerms = body(scoreCardHandler(store, { title: "Death Trooper" }));
    const without = body(scoreCardHandler(store, { title: "Death Trooper", includeBreakdown: false }));
    expect(withTerms.terms.length).toBeGreaterThan(0);
    expect(without.terms).toBeUndefined();
    expect(without.total).toBe(withTerms.total);
  });

  it("scores an event with a cost term and a leader without a play score", () => {
    const event = body(scoreCardHandler(store, { cardKey: "0101074" }));
    expect(event.components.map((c: { name: string }) => c.name)).toContain("costTerm");
    const leader = body(scoreCardHandler(store, { cardKey: "04010001" }));
    expect(leader.playCalibrated).toBeNull();
    expect(leader.flags).toContain("leader_effects_unpriced");
  });

  it("reports an unknown or ambiguous card as an error", () => {
    expect(scoreCardHandler(store, { cardKey: "nope" }).isError).toBe(true);
    expect(scoreCardHandler(store, {}).isError).toBe(true);
  });
});

describe("rank_cards", () => {
  it("sorts by the chosen metric, highest first, with ranks", () => {
    const out = body(rankCardsHandler(store, { sortBy: "total", type: "Unit" }));
    const totals = out.cards.map((c: { total: number }) => c.total);
    expect(totals).toEqual([...totals].sort((a: number, b: number) => b - a));
    expect(out.cards[0].rank).toBe(1);
    expect(out.cards.every((c: { type: string }) => c.type === "Unit")).toBe(true);
  });

  it("applies the filters", () => {
    expect(body(rankCardsHandler(store, { keyword: "Grit", type: "Unit" })).cards.map((c: { cardKey: string }) => c.cardKey)).toEqual(["0101165"]);
    expect(body(rankCardsHandler(store, { arena: "Space" })).cards.map((c: { cardKey: string }) => c.cardKey)).toEqual(["04010087"]);
    expect(body(rankCardsHandler(store, { minCost: 5, maxCost: 5, sortBy: "statEfficiency" })).cards.map((c: { cardKey: string }) => c.cardKey).sort()).toEqual(["0101165", "09010218"]);
    expect(body(rankCardsHandler(store, { set: "HMW", aspect: "Cunning" })).total).toBeGreaterThan(0);
  });

  it("drops cards without the sort metric and warns about cross-type totals", () => {
    const play = body(rankCardsHandler(store, { sortBy: "playCalibrated" }));
    expect(play.cards.map((c: { cardKey: string }) => c.cardKey)).not.toContain("04010001");
    expect(body(rankCardsHandler(store, { sortBy: "total" })).note).toContain("pass type");
    expect(play.note).toBeUndefined();
  });

  it("respects limit", () => {
    expect(body(rankCardsHandler(store, { limit: 2 })).shown).toBe(2);
  });
});

describe("compare_cards", () => {
  it("lines two to five cards up by metric", () => {
    const out = body(compareCardsHandler(store, { cardKeys: [DEATH_TROOPER, "0101165", "04010087"] }));
    expect(out.cards).toHaveLength(3);
    const total = out.metrics.find((m: { metric: string }) => m.metric === "total");
    expect(Object.keys(total)).toEqual(["metric", DEATH_TROOPER, "0101165", "04010087"]);
    expect(out.metrics.find((m: { metric: string }) => m.metric === "type")["0101165"]).toBe("Unit");
    expect(["0101033", "0101165", "04010087"]).toContain(out.highest.total);
  });

  it("rejects one card, six cards and an unknown key", () => {
    expect(() => compareCardsHandler(store, { cardKeys: [DEATH_TROOPER] })).toThrow();
    expect(() => compareCardsHandler(store, { cardKeys: Array.from({ length: 6 }, () => DEATH_TROOPER) })).toThrow();
    expect(compareCardsHandler(store, { cardKeys: [DEATH_TROOPER, "nope"] }).isError).toBe(true);
  });
});

describe("card_features", () => {
  it("lists clauses with effects, trigger and provenance", () => {
    const out = body(cardFeaturesHandler(store, { cardKey: DEATH_TROOPER }));
    expect(out.clauses[0].trigger).toBe("when_played");
    expect(out.clauses[0].effects[0]).toContain("damage 2");
    expect(out.clauses[0].source).toBe("grammar");
    expect(out.provenance.grammarClauses).toBe(1);
    expect(out.offers.map((t: { tag: string }) => t.tag)).toContain("offers:damage-enemy-unit");
  });

  it("omits provenance on request and reports keywords", () => {
    const out = body(cardFeaturesHandler(store, { cardKey: "0101165", includeProvenance: false }));
    expect(out.keywords.map((k: { keyword: string }) => k.keyword)).toContain("Grit");
    expect(out.provenance).toBeUndefined();
    expect(out.clauses[0]?.source).toBeUndefined();
  });
});

describe("find_by_effect", () => {
  it("finds cards by effect category with a target filter", () => {
    const out = body(findByEffectHandler(store, { effect: "damage", side: "enemy" }));
    expect(out.cards.map((c: { cardKey: string }) => c.cardKey)).toContain(DEATH_TROOPER);
    expect(body(findByEffectHandler(store, { effect: "damage", side: "enemy", arena: "space" })).cards.map((c: { cardKey: string }) => c.cardKey)).not.toContain(DEATH_TROOPER);
  });

  it("filters by timing and cost", () => {
    expect(body(findByEffectHandler(store, { effect: "damage", timing: "when_played", maxCost: 3 })).cards.map((c: { cardKey: string }) => c.cardKey)).toContain(DEATH_TROOPER);
    expect(body(findByEffectHandler(store, { effect: "damage", timing: "on_attack" })).cards.map((c: { cardKey: string }) => c.cardKey)).not.toContain(DEATH_TROOPER);
    expect(body(findByEffectHandler(store, { effect: "damage", maxCost: 2 })).cards.map((c: { cardKey: string }) => c.cardKey)).not.toContain(DEATH_TROOPER);
  });

  it("matches offers by tag fragment and rejects an unknown category", () => {
    expect(body(findByEffectHandler(store, { effect: "damage-enemy-unit", role: "offers" })).cards.map((c: { cardKey: string }) => c.cardKey)).toContain(DEATH_TROOPER);
    const bad = findByEffectHandler(store, { effect: "teleport" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("damage");
  });
});

describe("explain_rubric", () => {
  it("states the formula, weights and sources", () => {
    const out = body(explainRubricHandler(store, {}));
    expect(out.formula.length).toBeGreaterThan(4);
    expect(out.designerWeights.powerWeight).toBe(1.17);
    expect(out.vanillaCurve.power.cost).toBeGreaterThan(0.9);
    expect(out.source.fittedBy).toBe("scripts/fit-coefficients.ts");
    expect(out.playabilityT.appliedLogInclusionVsCost2["6"]).toBeLessThan(0);
  });

  it("lists fitted terms with standard errors for each section", () => {
    for (const section of ["unit_terms", "event_terms", "upgrade_terms", "play_terms"]) {
      const out = body(explainRubricHandler(store, { section }));
      expect(out.terms.length).toBeGreaterThan(3);
      expect(out.terms[0]).toHaveProperty("se");
      expect(out.source.coefficientsSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("data_version", () => {
  it("reports the hashes and commit behind the scores", () => {
    const out = body(dataVersionHandler(store, {}));
    expect(out.rubricVersion).toBe("2026-10-16.1");
    expect(out.coefficientsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.scoresCurrent).toBe(true);
    expect(out.codeCommit).toBe("fixture");
    expect(out.inputHashes.cardsToon).toMatch(/^[0-9a-f]{64}$/);
    expect(out.features.curatedTableVersion).toBe(2);
    expect(out.swuStatsCapture.playerGames).toBeGreaterThan(100000);
    expect(out.scoredCards).toBe(9);
  });
});

describe("missing scores", () => {
  it("returns a tool error that names the commands to run", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "swu-value-"));
    try {
      cpSync(path.join(fixtures, "llm"), path.join(dir, "llm"), { recursive: true });
      const result = scoreCardHandler(loadStore(dir), { cardKey: DEATH_TROOPER });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("pnpm score");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MCP protocol", () => {
  it("serves a value tool over the server", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([createServer(store).connect(serverSide), client.connect(clientSide)]);
    const result = await client.callTool({ name: "score_card", arguments: { cardKey: DEATH_TROOPER } });
    expect(JSON.stringify(result.content)).toContain("Death Trooper");
    const version = await client.callTool({ name: "data_version", arguments: {} });
    expect(JSON.stringify(version.content)).toContain("rubricVersion");
    await client.close();
  });
});

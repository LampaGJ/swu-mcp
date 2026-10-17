import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = path.join(REPO_ROOT, "data/runs");
const hasBuiltData = existsSync(RUNS) && readdirSync(RUNS).some((name) => /^\d{4}-\d{2}-\d{2}$/.test(name));

const ELIA_KANE = "06010242";
const IDEN_VERSIO = "0101002";
const ASAJJ_VENTRESS = "04010001";
const CHOPPER_BASE = "0101030";
const DECKLIST = [
  { card: ELIA_KANE, count: 3 },
  { card: "0101033", count: 3 },
  { card: "0101074", count: 2 },
];

/** One valid call per registered tool. A tool without an entry fails the suite, so new tools cannot be missed. */
const ARGUMENTS: Record<string, Record<string, unknown>> = {
  get_card: { cardKey: ELIA_KANE },
  search_cards: { query: "raid", type: "Unit", limit: 5 },
  list_facet: { facet: "keyword" },
  cards_by_facet: { facet: "keyword", value: "Raid", limit: 5 },
  fungible_substitutes: { cardKey: ELIA_KANE },
  find_pairings: { cardKey: ELIA_KANE, limit: 5 },
  find_trios: { cardKey: ELIA_KANE, maxTotalCost: 9, limit: 3 },
  explain_synergy: { cardKeys: [ELIA_KANE, "0101033"] },
  aspect_cover: { cardKeys: [ELIA_KANE, "0101033"], limit: 3 },
  score_card: { cardKey: ELIA_KANE },
  rank_cards: { type: "Unit", limit: 5 },
  compare_cards: { cardKeys: [ELIA_KANE, "0101033"] },
  card_features: { cardKey: ELIA_KANE },
  find_by_effect: { effect: "damage", limit: 5 },
  explain_rubric: { section: "summary" },
  data_version: {},
  card_price: { cardKey: ELIA_KANE },
  play_stats: { cardKey: ELIA_KANE },
  value_vs_price: { limit: 5 },
  rules_core: {},
  rules_search: { query: "aspect penalty", limit: 3 },
  get_rule: { section: "7.5.11" },
  card_rulings: { cardKey: IDEN_VERSIO },
  keyword_rules: { keyword: "Raid" },
  rules_version: {},
  similar_cards: { cardKey: ELIA_KANE, limit: 5 },
  kin_cards: { cardKey: ELIA_KANE, limit: 5 },
  cluster: { cardKey: ELIA_KANE, members: 5 },
  get_cards_batch: { cardKeys: [ELIA_KANE, "0101033"], fields: ["title", "cost"] },
  resolve_card_name: { text: "elia kane", limit: 3 },
  get_printings: { cardKey: ELIA_KANE },
  list_sets: {},
  format_legality: { cardKey: ELIA_KANE },
  search_rulings: { query: "damage", since: "2024-01-01", limit: 3 },
  deck_audit: { decklist: DECKLIST, leader: ASAJJ_VENTRESS, base: CHOPPER_BASE },
  deck_legality_check: { decklist: DECKLIST, leader: ASAJJ_VENTRESS, base: CHOPPER_BASE },
  suggest_leader_base: { decklist: DECKLIST, limit: 3 },
  playable_cards: { leader: ASAJJ_VENTRESS, base: CHOPPER_BASE, decklist: DECKLIST, limit: 5 },
  fungible_in_deck: { decklist: DECKLIST, leader: ASAJJ_VENTRESS, base: CHOPPER_BASE },
  budget_alternatives: { decklist: DECKLIST, minSaving: 0.01 },
  price_list: { items: DECKLIST, groupBy: "rarity" },
  trade_balance: { sideA: DECKLIST, sideB: [{ card: ASAJJ_VENTRESS, count: 1 }] },
  owned_vs_needed: { decklist: DECKLIST, owned: [{ card: "0101033", count: 1 }] },
  play_value_vs_price: { minSampleSize: 1000, limit: 5 },
  score_vs_play: { limit: 5 },
};

describe.skipIf(!hasBuiltData)("stdio end to end against the built data", () => {
  const client = new Client({ name: "swu-mcp-e2e", version: "0.0.0" });
  let toolNames: string[] = [];

  beforeAll(async () => {
    await client.connect(new StdioClientTransport({ command: "pnpm", args: ["--silent", "mcp"], cwd: REPO_ROOT, stderr: "ignore" }));
    toolNames = (await client.listTools()).tools.map((tool) => tool.name);
  }, 60_000);

  afterAll(async () => {
    await client.close();
  });

  it("registers tools and has an arguments entry for each, and none for a tool that is gone", () => {
    expect(toolNames.length).toBeGreaterThan(0);
    expect(toolNames.filter((name) => ARGUMENTS[name] === undefined)).toEqual([]);
    expect(Object.keys(ARGUMENTS).filter((name) => !toolNames.includes(name))).toEqual([]);
  });

  it("calls every registered tool once with valid arguments and gets non-empty content", async () => {
    const failures: string[] = [];
    for (const name of toolNames) {
      const result = await client.callTool({ name, arguments: ARGUMENTS[name] ?? {} });
      const content = result.content as { type: string; text?: string }[];
      const text = content.map((part) => part.text ?? "").join("");
      if (result.isError === true || text.trim() === "") failures.push(`${name}: ${result.isError === true ? "isError" : "empty"} ${text.slice(0, 160)}`);
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it("returns candidate status and clause evidence from the pairing tools, and drops it on request", async () => {
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return (result.content as { text?: string }[]).map((part) => part.text ?? "").join("");
    };
    const withText = await call("find_pairings", { cardKey: ELIA_KANE, limit: 5 });
    expect(withText).toContain("status");
    expect(withText).toContain("candidate");
    expect(withText).toContain("evidence");
    const without = await call("find_pairings", { cardKey: ELIA_KANE, limit: 5, evidence: false });
    expect(without).toContain("candidate");
    expect(without).not.toContain("evidence");
    expect(without.length).toBeLessThan(withText.length);
  }, 60_000);

  it("serves the core primer resource", async () => {
    const resources = (await client.listResources()).resources.map((resource) => resource.uri);
    expect(resources).toContain("rules://core-primer");
    const primer = (await client.readResource({ uri: "rules://core-primer" })).contents[0];
    expect("text" in primer ? primer.text.length : 0).toBeGreaterThan(1000);
  });

  it("serves the rubric, glossary, usage guide and a rules section, and both prompts", async () => {
    for (const uri of ["swu://rubric", "swu://glossary", "swu://usage-guide", "swu://rules/1.7"]) {
      const content = (await client.readResource({ uri })).contents[0];
      expect("text" in content ? content.text.length : 0, uri).toBeGreaterThan(100);
    }
    const prompts = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
    expect(prompts).toEqual(expect.arrayContaining(["rules_question", "build_deck_for_leader"]));
  });
});

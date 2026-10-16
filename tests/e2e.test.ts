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

  it("serves the core primer resource", async () => {
    const resources = (await client.listResources()).resources.map((resource) => resource.uri);
    expect(resources).toContain("rules://core-primer");
    const primer = (await client.readResource({ uri: "rules://core-primer" })).contents[0];
    expect("text" in primer ? primer.text.length : 0).toBeGreaterThan(1000);
  });
});

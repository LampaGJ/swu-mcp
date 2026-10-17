import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/create-server.js";
import { loadStore } from "../src/data.js";
import { USAGE_GUIDE } from "../src/resources.js";
import { TOOLS } from "../src/tools.js";
import { REPO_ROOT, writeFixtureRulesDir } from "./rules/helpers.js";

const base = path.join(REPO_ROOT, "tmp");
mkdirSync(base, { recursive: true });
const pkg = mkdtempSync(path.join(base, "resources-test-"));
cpSync(path.join(REPO_ROOT, "tests/fixtures/llm"), path.join(pkg, "llm"), { recursive: true });
mkdirSync(path.join(pkg, "docs"));
writeFileSync(path.join(pkg, "docs/swu-glossary.json"), JSON.stringify({ terms: [{ term: "Kin" }] }));
writeFileSync(path.join(pkg, "docs/swu-card-value-rubric.md"), "# Rubric\nvalue = stats\n");
const rulesDir = writeFixtureRulesDir({ schemaVersion: 1, entries: [{ id: "1.3", topic: "t", why: "w" }] });
const previous = process.env.SWU_MCP_RULES;

let client: Client;
beforeAll(async () => {
  process.env.SWU_MCP_RULES = rulesDir;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([createServer(loadStore(pkg)).connect(serverSide), client.connect(clientSide)]);
});
afterAll(async () => {
  await client.close();
  if (previous === undefined) delete process.env.SWU_MCP_RULES;
  else process.env.SWU_MCP_RULES = previous;
});

const textOf = (result: { contents: Record<string, unknown>[] }): string => String(result.contents[0].text);

describe("resources", () => {
  it("lists the rubric, glossary and usage guide", async () => {
    const uris = (await client.listResources()).resources.map((resource) => resource.uri);
    expect(uris).toEqual(expect.arrayContaining(["swu://rubric", "swu://glossary", "swu://usage-guide", "rules://core-primer"]));
  });

  it("serves the rubric and glossary from the data package docs", async () => {
    expect(textOf(await client.readResource({ uri: "swu://rubric" }))).toContain("value = stats");
    expect(JSON.parse(textOf(await client.readResource({ uri: "swu://glossary" })))).toEqual({ terms: [{ term: "Kin" }] });
  });

  it("serves the usage guide, which names only registered tools", async () => {
    const text = textOf(await client.readResource({ uri: "swu://usage-guide" }));
    expect(text).toBe(USAGE_GUIDE);
    const named = [...USAGE_GUIDE.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]);
    expect(named.length).toBeGreaterThan(10);
    expect(named.filter((name) => !(name in TOOLS))).toEqual([]);
  });

  it("names every registered tool in the usage guide", () => {
    const named = new Set([...USAGE_GUIDE.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]));
    expect(Object.keys(TOOLS).filter((name) => !named.has(name))).toEqual([]);
  });

  it("serves a rules section through the swu://rules/{section} template", async () => {
    const templates = (await client.listResourceTemplates()).resourceTemplates.map((template) => template.uriTemplate);
    expect(templates).toContain("swu://rules/{section}");
    const text = textOf(await client.readResource({ uri: "swu://rules/1.7" }));
    expect(text).toContain("1.7");
    expect(text.toLowerCase()).toContain("resources");
  });

  it("accepts the forms get_rule accepts and rejects an unknown section", async () => {
    expect(textOf(await client.readResource({ uri: "swu://rules/1.7." }))).toContain("1.7");
    await expect(client.readResource({ uri: "swu://rules/99.99" })).rejects.toThrow(/99\.99/);
  });
});

describe("prompts", () => {
  it("lists both prompts", async () => {
    expect((await client.listPrompts()).prompts.map((prompt) => prompt.name).sort()).toEqual(["build_deck_for_leader", "rules_question"]);
  });

  it("rules_question embeds the question and the find-rule, find-ruling, cite workflow", async () => {
    const result = await client.getPrompt({ name: "rules_question", arguments: { question: "Does Raid stack?" } });
    const text = (result.messages[0].content as { text: string }).text;
    expect(text).toContain("Does Raid stack?");
    for (const tool of ["rules_search", "get_rule", "card_rulings", "rules_version"]) expect(text).toContain(tool);
  });

  it("build_deck_for_leader embeds the leader and names only registered tools", async () => {
    const result = await client.getPrompt({ name: "build_deck_for_leader", arguments: { leader: "Iden Versio" } });
    const text = (result.messages[0].content as { text: string }).text;
    expect(text).toContain("Iden Versio");
    const named = [...text.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]);
    expect(named.length).toBeGreaterThan(3);
    expect(named.filter((name) => !(name in TOOLS))).toEqual([]);
  });
});

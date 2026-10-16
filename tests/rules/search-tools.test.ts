import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { decode } from "@toon-format/toon";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../src/create-server.js";
import { loadStore } from "../../src/data.js";
import { CORE_BOOST, loadRules } from "../../src/rules/store.js";
import type { ToolResult } from "../../src/tools.js";
import { RULES_TOOLS, normalizeSectionId } from "../../src/tools/rules.js";
import { REPO_ROOT, writeCore, writeFixtureRulesDir } from "./helpers.js";

const cards = loadStore(path.join(REPO_ROOT, "tests/fixtures"));
const plainCore = writeCore([{ id: "9.9" }]);
const boostedCore = writeCore([{ id: "1.7" }]);
const rulesDir = writeFixtureRulesDir({ schemaVersion: 1, entries: [{ id: "1.3", topic: "t", why: "w" }] });
const previous = process.env.SWU_MCP_RULES;

beforeAll(() => {
  process.env.SWU_MCP_RULES = rulesDir;
});
afterAll(() => {
  if (previous === undefined) delete process.env.SWU_MCP_RULES;
  else process.env.SWU_MCP_RULES = previous;
});

const body = (result: ToolResult): Record<string, any> => {
  expect(result.isError).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
};

describe("search", () => {
  const plain = loadRules(rulesDir, plainCore);
  const boosted = loadRules(rulesDir, boostedCore);

  it("returns the same ranking every time, ties broken by document order", () => {
    const first = plain.search("resource", 20);
    expect(plain.search("resource", 20)).toEqual(first);
    expect(loadRules(rulesDir, plainCore).search("resource", 20)).toEqual(first);
    const scores = first.hits.map((hit) => hit.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    for (let i = 1; i < first.hits.length; i += 1) {
      if (first.hits[i].score === first.hits[i - 1].score) {
        expect(plain.order.get(first.hits[i].id)).toBeGreaterThan(plain.order.get(first.hits[i - 1].id) as number);
      }
    }
  });

  it("matches a stemmed heading: 'resources' finds 1.7 RESOURCES first", () => {
    expect(plain.search("resources", 3).hits[0].id).toBe("1.7");
  });

  it("adds exactly the documented boost to core sections and nothing else", () => {
    const a = new Map(plain.search("resource", 200).hits.map((hit) => [hit.id, hit]));
    const b = new Map(boosted.search("resource", 200).hits.map((hit) => [hit.id, hit]));
    expect(b.size).toBe(a.size);
    for (const [id, hit] of b) {
      const base = a.get(id)!;
      expect(hit.relevance).toBe(base.relevance);
      const inCore = id === "1.7" || id.startsWith("1.7.");
      expect(hit.core).toBe(inCore);
      expect(Math.round((hit.score - base.score) * 1e6) / 1e6).toBe(inCore ? CORE_BOOST : 0);
    }
  });
});

describe("rules tools", () => {
  it("rules_search returns id, path, snippet and score", () => {
    const out = body(RULES_TOOLS.rules_search.handler(cards, { query: "golden rules precedence", limit: 3 }));
    expect(out.rulesVersion).toBe("8.0");
    expect(out.results.length).toBeLessThanOrEqual(3);
    expect(out.results[0]).toMatchObject({ core: true });
    expect(out.results[0].id).toMatch(/^1\.3/);
    expect(out.results[0].path).toContain("1.3 GOLDEN RULES");
    expect(typeof out.results[0].snippet).toBe("string");
  });

  it("get_rule returns text, children, links and accepts loose ids", () => {
    const out = body(RULES_TOOLS.get_rule.handler(cards, { section: "1.5.2", depth: 1, include: ["children", "parent", "siblings"] }));
    expect(out.rule.id).toBe("1.5.2");
    expect(out.rule.children.map((c: any) => c.id)).toContain("1.5.2.b");
    expect(out.parent.id).toBe("1.5");
    expect(out.siblings.map((s: any) => s.id)).toContain("1.5.3");
    const withRef = body(RULES_TOOLS.get_rule.handler(cards, { section: "1.5.1.B", include: [] }));
    expect(withRef.links).toEqual([{ id: "1.7", title: "RESOURCES" }]);
    expect(normalizeSectionId("7.6.3A")).toBe("7.6.3.a");
    expect(normalizeSectionId("8.1.")).toBe("8.1");
  });

  it("get_rule fails clearly for an unknown id", () => {
    const result = RULES_TOOLS.get_rule.handler(cards, { section: "99.9" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("rules_search");
  });

  it("card_rulings returns dated rulings by cardKey and by title", () => {
    const byKey = body(RULES_TOOLS.card_rulings.handler(cards, { cardKey: "0101033" }));
    expect(byKey.cards[0].title).toBe("Death Trooper");
    expect(byKey.cards[0].rulings[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const byTitle = body(RULES_TOOLS.card_rulings.handler(cards, { title: "death trooper" }));
    expect(byTitle.cards[0].cardKey).toBe("0101033");
    expect(RULES_TOOLS.card_rulings.handler(cards, { title: "No Such Card" }).isError).toBe(true);
    expect(RULES_TOOLS.card_rulings.handler(cards, {}).isError).toBe(true);
  });

  it("keyword_rules returns the glossary definition and CR sections", () => {
    const out = body(RULES_TOOLS.keyword_rules.handler(cards, { keyword: "deck" }));
    expect(out).toMatchObject({ keyword: "Deck", inCr: true });
    expect(out.sections[0].id).toBe("1.2");
    expect(RULES_TOOLS.keyword_rules.handler(cards, { keyword: "Nope" }).isError).toBe(true);
  });

  it("rules_version reports version, PDF hash, fetch date and the rulings source hash", () => {
    const out = body(RULES_TOOLS.rules_version.handler(cards));
    expect(out).toMatchObject({ rulesVersion: "8.0", pdfSha256: "a".repeat(64), fetchedAt: "2026-10-16" });
    expect(out.rulingsSource.rawPagesManifestSha256).toBe("b".repeat(64));
  });

  it("is wired into the MCP server with the core primer as a resource", async () => {
    const server = createServer(cards);
    const client = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of ["rules_search", "get_rule", "card_rulings", "keyword_rules", "rules_version", "rules_core"]) expect(names).toContain(name);
    const resource = await client.readResource({ uri: "rules://core-primer" });
    expect((resource.contents[0] as { text: string }).text).toContain("core primer");
    const primerTool = await client.callTool({ name: "rules_core", arguments: {} });
    expect(JSON.stringify(primerTool.content)).toContain("1.3.2");
    await client.close();
  });
});

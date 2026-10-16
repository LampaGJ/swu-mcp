import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { decode } from "@toon-format/toon";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/create-server.js";
import { loadStore } from "../src/data.js";
import { cardsByFacet, getCard, listFacet, searchCards, type ToolResult } from "../src/tools.js";

const store = loadStore(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures"));

function body(result: ToolResult): Record<string, any> {
  expect(result.isError).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

describe("loadStore", () => {
  it("reads the cards and every facet index", () => {
    expect(store.cards).toHaveLength(9);
    expect([...store.facets.keys()].sort()).toEqual(["arena", "aspect", "expansion", "keyword", "rarity", "trait", "type", "variant"]);
  });
});

describe("get_card", () => {
  it("finds a card by cardKey with its text and without art fields", () => {
    const { card } = body(getCard(store, { cardKey: "0101033" }));
    expect(card.title).toBe("Death Trooper");
    expect(card.text).toContain("Deal 2 damage");
    expect(card).not.toHaveProperty("artFront");
  });

  it("finds a card by exact title ignoring case", () => {
    expect(body(getCard(store, { title: "death trooper" })).card.cardKey).toBe("0101033");
  });

  it("narrows by subtitle", () => {
    expect(body(getCard(store, { title: "Grand Moff Tarkin", subtitle: "Tyrant of the Outer Rim" })).card.cardKey).toBe("09010004");
  });

  it("reports an unknown card as an error", () => {
    expect(getCard(store, { title: "Nobody" }).isError).toBe(true);
    expect(getCard(store, { cardKey: "nope" }).isError).toBe(true);
    expect(getCard(store, {}).isError).toBe(true);
  });
});

describe("search_cards", () => {
  it("matches a substring in the card text", () => {
    const out = body(searchCards(store, { query: "heal 3 damage" }));
    expect(out.cards.map((card: { cardKey: string }) => card.cardKey)).toEqual(["0101074"]);
  });

  it("combines filters", () => {
    const out = body(searchCards(store, { keyword: "grit", type: "unit", maxCost: 5 }));
    expect(out.cards.map((card: { title: string }) => card.title)).toEqual(["Occupier Siege Tank"]);
    expect(out.total).toBe(1);
  });

  it("filters by aspect and set, and respects limit", () => {
    const out = body(searchCards(store, { aspect: "Vigilance", set: "SOR", limit: 1 }));
    expect(out.shown).toBe(1);
    expect(out.total).toBeGreaterThan(1);
  });

  it("excludes cards without a cost when maxCost is given", () => {
    const out = body(searchCards(store, { type: "Base", maxCost: 10 }));
    expect(out.total).toBe(0);
  });
});

describe("list_facet", () => {
  it("lists values with counts and definitions", () => {
    const out = body(listFacet(store, { facet: "keyword" }));
    const grit = out.values.find((entry: { value: string }) => entry.value === "Grit");
    expect(grit.cards).toBe(2);
    expect(grit.definition).toContain("Grit");
  });

  it("rejects an unknown facet", () => {
    expect(() => listFacet(store, { facet: "colour" })).toThrow();
  });
});

describe("cards_by_facet", () => {
  it("returns the cards carrying a value", () => {
    const out = body(cardsByFacet(store, { facet: "keyword", value: "grit" }));
    expect(out.cards.map((card: { cardKey: string }) => card.cardKey)).toEqual(["0101165", "04010001"]);
  });

  it("points at list_facet for an unknown value", () => {
    const result = cardsByFacet(store, { facet: "keyword", value: "Nonsense" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("list_facet");
  });
});

describe("MCP protocol", () => {
  it("lists the four tools and answers a call", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([createServer(store).connect(serverSide), client.connect(clientSide)]);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["cards_by_facet", "get_card", "list_facet", "search_cards"]);
    const result = await client.callTool({ name: "get_card", arguments: { cardKey: "0101030" } });
    expect(JSON.stringify(result.content)).toContain("Chopper Base");
    await client.close();
  });
});

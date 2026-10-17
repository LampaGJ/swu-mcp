import { decode } from "@toon-format/toon";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadStore, type CardStore } from "../src/data.js";
import type { ToolResult } from "../src/tools.js";
import { CATALOG_TOOLS, formatLegality, getCardsBatch, getPrintings, listSets, resolveCardName, searchRulings } from "../src/tools/catalog.js";
import { REPO_ROOT, writeFixtureRulesDir } from "./rules/helpers.js";

const store = loadStore(path.join(REPO_ROOT, "tests/fixtures"));
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

function withSets(cardKey: string, sets: string): CardStore {
  const cards = store.cards.map((card) => (card.cardKey === cardKey ? { ...card, sets } : card));
  return { ...store, cards, byKey: new Map(cards.map((card) => [card.cardKey, card])) };
}

describe("registration", () => {
  it("exports the six catalog tools", () => {
    expect(Object.keys(CATALOG_TOOLS).sort()).toEqual(["format_legality", "get_cards_batch", "get_printings", "list_sets", "resolve_card_name", "search_rulings"]);
  });
});

describe("get_cards_batch", () => {
  it("returns the default columns for each found card and lists missing keys", () => {
    const out = body(getCardsBatch(store, { cardKeys: ["0101033", "nope", "0101074"] }));
    expect(out.found).toBe(2);
    expect(out.missing).toEqual(["nope"]);
    expect(out.cards.map((card: { title: string }) => card.title)).toEqual(["Death Trooper", "Repair"]);
    expect(out.cards[0]).not.toHaveProperty("artFront");
  });

  it("projects only the requested fields", () => {
    const out = body(getCardsBatch(store, { cardKeys: ["0101033"], fields: ["title", "priceNormal"] }));
    expect(Object.keys(out.cards[0])).toEqual(["title", "priceNormal"]);
  });

  it("rejects an unknown field and an all-missing batch", () => {
    expect(getCardsBatch(store, { cardKeys: ["0101033"], fields: ["bogus"] }).isError).toBe(true);
    expect(getCardsBatch(store, { cardKeys: ["nope"] }).isError).toBe(true);
  });

  it("refuses more than 50 keys", () => {
    expect(() => getCardsBatch(store, { cardKeys: Array.from({ length: 51 }, (_, i) => String(i)) })).toThrow();
  });
});

describe("resolve_card_name", () => {
  const keys = (text: string, limit = 5): string[] => body(resolveCardName(store, { text, limit })).candidates.map((c: { cardKey: string }) => c.cardKey);

  it("finds a card through a typo", () => {
    expect(keys("dath troper")[0]).toBe("0101033");
  });

  it("marks an exact title and ignores case and accents", () => {
    const top = body(resolveCardName(store, { text: "DEATH TROOPÉR" })).candidates[0];
    expect(top).toMatchObject({ cardKey: "0101033", match: "exact" });
  });

  it("matches a subtitle and a prefix", () => {
    expect(keys("tyrant outer rim")[0]).toBe("09010004");
    expect(keys("occupi")[0]).toBe("0101165");
  });

  it("matches title plus subtitle as an exact name", () => {
    expect(body(resolveCardName(store, { text: "Asajj Ventress, I Work Alone" })).candidates[0]).toMatchObject({ cardKey: "04010001", match: "exact" });
  });

  it("is deterministic, respects limit and returns nothing for gibberish", () => {
    expect(keys("trooper")).toEqual(keys("trooper"));
    expect(keys("a", 2).length).toBeLessThanOrEqual(2);
    expect(body(resolveCardName(store, { text: "zzzzqqqq" })).candidates ?? []).toEqual([]);
  });
});

describe("list_sets", () => {
  const sets = body(listSets(store)).sets as Record<string, any>[];
  const by = (code: string) => sets.find((set) => set.code === code) as Record<string, any>;

  it("parses name, kind, number, release date and Premier status from the expansion notes", () => {
    expect(by("HMW")).toMatchObject({ name: "Homeworlds", kind: "main", mainSet: 9, released: "2026-10-09", premier: "legal" });
    expect(by("JTL")).toMatchObject({ kind: "main", mainSet: 4, premier: "legal", premierAsOf: "2026-10-07", printings: 1130, cards: 5 });
    expect(by("SOR")).toMatchObject({ premier: "rotated", mainSet: 1 });
    expect(by("SHD").premier).toBe("rotated");
  });

  it("gives a weekly play set its main set's status and a promo set by_card", () => {
    expect(by("HMWP")).toMatchObject({ kind: "weekly_play", mainSet: 9, premier: "legal" });
    expect(by("IC27")).toMatchObject({ kind: "promo", premier: "by_card", mainSet: null });
  });

  it("is sorted by code point", () => {
    const codes = sets.map((set) => set.code as string);
    expect(codes).toEqual([...codes].sort());
  });

  it("reads a set whose note is not understood as unknown, not legal", () => {
    const odd: CardStore = { ...store, facets: new Map([["expansion", [{ value: "ZZZ", cards: 1, definition: "Mystery. Main set 12.", cardKeys: ["0101033"] }]]]) };
    expect(body(listSets(odd)).sets[0]).toMatchObject({ code: "ZZZ", premier: "unknown" });
  });
});

describe("get_printings", () => {
  it("lists the sets with names and Premier status, variants and the canonical printing", () => {
    const out = body(getPrintings(store, { cardKey: "0101033" }));
    expect(out).toMatchObject({ title: "Death Trooper", canonicalSet: "SOR", printingCount: 12 });
    expect(out.sets.map((set: { set: string }) => set.set)).toEqual(["SOR", "SHD", "SEC", "IC27"]);
    expect(out.sets[0]).toMatchObject({ name: "Spark of Rebellion", premier: "rotated" });
    expect(out.variants).toContain("Hyperspace Foil");
    expect(out.imageStem).toMatch(/\.png$/);
    expect(out.limits).toContain("Per-printing");
  });

  it("errors on an unknown cardKey", () => {
    expect(getPrintings(store, { cardKey: "nope" }).isError).toBe(true);
  });
});

describe("format_legality", () => {
  const formats = (result: ToolResult): Record<string, any> => Object.fromEntries(body(result).formats.map((f: { format: string }) => [f.format, f]));

  it("marks a card with a Premier-legal printing legal in all three formats", () => {
    const out = formats(formatLegality(store, { cardKey: "0101033" }));
    expect(out.premier).toMatchObject({ legal: true });
    expect(out.premier.reason).toContain("SEC");
    expect(out.eternal.legal).toBe(true);
    expect(out.twin_suns.legal).toBe(true);
  });

  it("marks a card printed only in rotated sets illegal in Premier but legal in Eternal", () => {
    const out = formats(formatLegality(withSets("0101033", "SOR|SHD"), { cardKey: "0101033" }));
    expect(out.premier.legal).toBe(false);
    expect(out.eternal.legal).toBe(true);
  });

  it("reports unknown, not legal, when only an unrecognised set is printed", () => {
    const odd: CardStore = { ...withSets("0101033", "SOR|ZZZ") };
    expect(formats(formatLegality(odd, { cardKey: "0101033" })).premier.legal).toBeNull();
  });

  it("filters to one format and states that no ban list exists", () => {
    const out = body(formatLegality(store, { cardKey: "0101033", format: "premier" }));
    expect(out.formats).toHaveLength(1);
    expect(out.limits).toContain("no ban or suspension list");
  });

  it("errors on an unknown cardKey", () => {
    expect(formatLegality(store, { cardKey: "nope" }).isError).toBe(true);
  });
});

describe("search_rulings", () => {
  const titles = (out: Record<string, any>): string[] => out.rulings.map((r: { title: string }) => r.title);

  it("lists all rulings newest first, dated before undated, ties by cardKey", () => {
    const out = body(searchRulings(store, {}));
    const dates = out.rulings.map((r: { date: string | null }) => r.date);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(dates[0]).toBe("2026-07-20");
    expect(out.total).toBe(out.rulings.length);
  });

  it("requires every query word, case-insensitively", () => {
    expect(titles(body(searchRulings(store, { query: "COMBAT damage" })))).toEqual(["Han Solo", "Han Solo", "Shoot First", "Shoot First"]);
    expect(body(searchRulings(store, { query: "combat zebra" })).total).toBe(0);
  });

  it("filters by date, dropping older rulings", () => {
    const out = body(searchRulings(store, { since: "2026-01-01" }));
    expect(out.rulings.every((r: { date: string }) => r.date >= "2026-01-01")).toBe(true);
    expect(out.total).toBe(3);
  });

  it("finds a keyword by the card carrying it or by the ruling naming it", () => {
    const named = body(searchRulings(store, { keyword: "Ambush" }));
    expect(new Set(titles(named))).toEqual(new Set(["Agent Kallus", "Han Solo"]));
    expect(titles(body(searchRulings(store, { keyword: "Grit" })))).toEqual(["Han Solo", "Shoot First"]);
    const cards = store.cards.map((card) => (card.cardKey === "0101033" ? { ...card, keywords: "Zorp" } : card));
    const carrying: CardStore = { ...store, cards, byKey: new Map(cards.map((card) => [card.cardKey, card])) };
    expect(titles(body(searchRulings(carrying, { keyword: "zorp" })))).toEqual(["Death Trooper"]);
  });

  it("respects limit and rejects a malformed date", () => {
    expect(body(searchRulings(store, { limit: 2 })).shown).toBe(2);
    expect(() => searchRulings(store, { since: "yesterday" })).toThrow();
  });
});

describe("resolve_card_name ranking", () => {
  it("breaks equal scores by edit distance to the name", () => {
    const rows = body(resolveCardName(store, { text: "death troper" })).candidates as { cardKey: string; distance: number }[];
    expect(rows[0]).toMatchObject({ cardKey: "0101033", distance: 1 });
    for (let i = 1; i < rows.length; i += 1) expect(rows[i].distance).toBeGreaterThanOrEqual(0);
  });
});

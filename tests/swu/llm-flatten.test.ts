// Ported from mault packages/server/tests/adapters/swu/llm-flatten.test.ts.
import { describe, expect, it } from "vitest";

import {
  buildFacetIndexes,
  buildLogicalCards,
  buildNameIndex,
  encodeToonTable,
  flattenPrinting,
  newFlattenIssues,
  priceCellsByCardId,
  setReleaseOrder,
  splitByCurrentSets,
  type FlatRow,
  type RawCardRecord,
} from "../../src/swu/llm-flatten.js";

const CDN = "https://cdn.starwarsunlimited.com/";

function upload(stem: string, ext: string, sizes: string[], slash = ""): unknown {
  const formats = Object.fromEntries(
    sizes.map((size) => [size, { ext, hash: `${size}_${stem}`, url: `${CDN}${slash}${size}_${stem}${ext}` }]),
  );
  return { data: { attributes: { hash: stem, ext, url: `${CDN}${slash}${stem}${ext}`, formats } } };
}

function named(...names: string[]): unknown {
  return { data: names.map((name) => ({ attributes: { name } })) };
}

function record(serialCode: string, overrides: Record<string, unknown> = {}): RawCardRecord {
  return {
    id: 1,
    attributes: {
      serialCode,
      title: "Luke Skywalker",
      subtitle: "Faithful Friend",
      text: "Line one.\nLine two, with comma. ",
      textStyled: "<p>Line one.</p>",
      linkHtml: "<a>x</a>",
      createdAt: "2023-01-01T00:00:00.000Z",
      updatedAt: "2023-01-01T00:00:00.000Z",
      publishedAt: "2023-01-01T00:00:00.000Z",
      localizations: named("x"),
      cost: 6,
      hasFoil: false,
      aspects: named("Vigilance", "Heroism"),
      traits: named(),
      keywords: named(),
      arenas: named("Ground"),
      aspectDuplicates: named(),
      type: { data: { attributes: { name: "Leader", value: "leader" } } },
      type2: { data: null },
      rarity: { data: { attributes: { name: "Rare" } } },
      expansion: { data: { attributes: { name: "Spark of Rebellion", code: "SOR" } } },
      variantTypes: named("Standard"),
      variantOf: { data: null },
      reprintOf: { data: null },
      artFront: upload("SOR_005_Luke_ab12", ".png", ["card", "xsmall"]),
      artBack: { data: null },
      artThumbnail: upload("SOR_005_Thumb_cd34", ".png", ["thumbnail"], "/"),
      ...overrides,
    },
  };
}

const link = (serialCode: string): unknown => ({ data: { attributes: { serialCode } } });

describe("flattenPrinting", () => {
  it("joins relations, shrinks uploads to stems and drops the listed fields", () => {
    const issues = newFlattenIssues();
    const row = flattenPrinting(record("0101005"), issues);
    expect(row).toMatchObject({
      aspects: "Vigilance|Heroism",
      arenas: "Ground",
      traits: "",
      type: "Leader",
      type2: "",
      rarity: "Rare",
      expansion: "SOR",
      artFront: "SOR_005_Luke_ab12.png",
      artBack: "",
      artThumbnail: "/SOR_005_Thumb_cd34.png",
      variantOf: "",
    });
    for (const dropped of ["textStyled", "linkHtml", "createdAt", "updatedAt", "publishedAt", "localizations", "id"]) {
      expect(row).not.toHaveProperty(dropped);
    }
    expect(issues.imageUnfit).toEqual([]);
    expect(issues.imageDoubleSlash).toBe(1);
    expect([...(issues.sizeKeys.get("artFront") ?? [])].sort()).toEqual(["card", "xsmall"]);
  });

  it("keeps the full URL and counts an image whose formats disagree on the stem", () => {
    const bad = upload("SOR_005_Luke_ab12", ".png", ["card"]) as { data: { attributes: { formats: { card: { hash: string } } } } };
    bad.data.attributes.formats.card.hash = "card_Other_ff00";
    const issues = newFlattenIssues();
    const row = flattenPrinting(record("0101005", { artFront: bad }), issues);
    expect(row.artFront).toBe(`${CDN}SOR_005_Luke_ab12.png`);
    expect(issues.imageUnfit).toEqual(["0101005:artFront"]);
  });

  it("resolves variantOf to the target serialCode", () => {
    const row = flattenPrinting(record("0101P05", { variantOf: link("0101005") }), newFlattenIssues());
    expect(row.variantOf).toBe("0101005");
  });
});

describe("buildLogicalCards", () => {
  const flat = (serial: string, overrides: Record<string, unknown> = {}): FlatRow =>
    flattenPrinting(record(serial, overrides), newFlattenIssues());
  const hyperspace = {
    variantTypes: named("Hyperspace"),
    variantOf: link("0101005"),
    expansion: { data: { attributes: { code: "SOR" } } },
  };

  it("folds variants and reprints into the canonical printing and aggregates them", () => {
    const printings = [
      flat("0201050", {
        variantTypes: named("Standard"),
        reprintOf: link("0101005"),
        expansion: { data: { attributes: { code: "SHD" } } },
      }),
      flat("0101105", hyperspace),
      flat("0101005"),
    ];
    const { cards, printingsFolded, mismatches } = buildLogicalCards(
      printings,
      new Map([["0101005", { priceNormal: 1.5, priceFoil: null }]]),
    );
    expect(cards).toHaveLength(1);
    expect(printingsFolded).toBe(2);
    expect(mismatches).toEqual([]);
    expect(cards[0]).toMatchObject({
      cardKey: "0101005",
      sets: "SOR|SHD",
      firstSet: "SOR",
      printingCount: 3,
      variants: "Hyperspace|Standard",
      priceNormal: 1.5,
      priceFoil: null,
    });
    expect(cards[0]).not.toHaveProperty("variantOf");
    expect(cards[0]).not.toHaveProperty("serialCode");
  });

  it("ignores whitespace and list order but reports real gameplay differences", () => {
    const printings = [
      flat("0101005"),
      flat("0101105", { ...hyperspace, text: "Line one.\nLine two, with comma.", aspects: named("Heroism", "Vigilance") }),
      flat("0101205", { ...hyperspace, cost: 7 }),
    ];
    const { mismatches } = buildLogicalCards(printings, new Map());
    expect(mismatches).toEqual([{ cardKey: "0101005", serialCode: "0101205", field: "cost", canonical: 6, other: 7 }]);
  });

  it("falls back to the earliest set when every printing links elsewhere", () => {
    const printings = [
      flat("0201050", { reprintOf: link("0301050"), expansion: { data: { attributes: { code: "SHD" } } } }),
      flat("0301050", { reprintOf: link("0201050"), expansion: { data: { attributes: { code: "TWI" } } } }),
    ];
    const { cards, multiRootComponents } = buildLogicalCards(printings, new Map());
    expect(cards.map((card) => card.cardKey)).toEqual(["0201050"]);
    expect(multiRootComponents).toBe(1);
  });
});

describe("indexes and encoding", () => {
  const cards = buildLogicalCards(
    [
      flattenPrinting(record("0101005"), newFlattenIssues()),
      flattenPrinting(record("0101006", { aspects: named("Heroism") }), newFlattenIssues()),
    ],
    new Map(),
  ).cards;

  it("counts cards per facet value and reports missing definitions", () => {
    const glossary = { version: 1 as const, facets: { aspect: [{ value: "Heroism", definition: "Brave." }] } };
    const aspect = buildFacetIndexes(cards, glossary).find((index) => index.facet === "aspect");
    expect(aspect?.rows).toEqual([
      { value: "Heroism", cards: 2, definition: "Brave.", cardKeys: "0101005|0101006" },
      { value: "Vigilance", cards: 1, definition: "", cardKeys: "0101005" },
    ]);
    expect(aspect?.missingDefinitions).toBe(1);
    expect(buildFacetIndexes(cards, null).every((index) => index.rows.every((row) => row.definition === ""))).toBe(true);
  });

  it("indexes names by title and subtitle", () => {
    expect(buildNameIndex(cards)).toEqual([{ title: "Luke Skywalker", subtitle: "Faithful Friend", cardKeys: "0101005|0101006" }]);
  });

  it("encodes byte-identical TOON for the same input and quotes awkward text", () => {
    const first = encodeToonTable("cards", cards);
    expect(encodeToonTable("cards", structuredClone(cards))).toBe(first);
    expect(first.startsWith("cards[2]{cardKey,")).toBe(true);
    expect(first).toContain("\\n");
  });

  it("takes the first non-null price per card id by product id", () => {
    const prices = priceCellsByCardId([
      { cardId: "A", productId: 2, priceNormal: 5, priceFoil: 9 },
      { cardId: "A", productId: 1, priceNormal: null, priceFoil: 8 },
    ]);
    expect(prices.get("A")).toEqual({ priceNormal: 5, priceFoil: 8 });
  });
});

describe("splitByCurrentSets", () => {
  const card = (cardKey: string, sets: string): FlatRow => ({ cardKey, sets });

  it("orders Weekly Play codes by their base set and leaves promo sets unknown", () => {
    expect(setReleaseOrder("JTLP")).toBe(setReleaseOrder("JTL"));
    expect(setReleaseOrder("P25")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("keeps cards with any printing in JTL or later and splits the rest", () => {
    const split = splitByCurrentSets([
      card("a", "SOR|JTL"),
      card("b", "SHD|TWI"),
      card("c", "P25|IBH"),
      card("d", "JTLP"),
      card("e", "TWI|P26"),
    ]);
    expect(split.kept.map((c) => c.cardKey)).toEqual(["a", "d"]);
    expect(split.oldSetsOnly.map((c) => c.cardKey)).toEqual(["b", "e"]);
    expect(split.promoOnly.map((c) => c.cardKey)).toEqual(["c"]);
  });
});

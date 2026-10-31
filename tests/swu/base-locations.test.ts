import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFeatureRun } from "../../src/ability-grammar/index.js";
import { mergeBaseLocations } from "../../src/ability-grammar/base-locations.js";
import type { CardRow, CardStore } from "../../src/data.js";
import { REPO_ROOT } from "../../src/paths.js";
import { baseLocationsFileSchema, baseLocationsManifestSchema } from "../../src/schemas/base-locations.js";
import { captureBaseLocations, locationDisplayName } from "../../src/swu/base-locations-capture.js";
import { sha256Hex } from "../../src/swu/canonical.js";

const row = (cardKey: string, title: string, extra: Partial<CardRow> & Record<string, unknown> = {}): CardRow => ({
  cardKey, title, subtitle: null, type: "Base", cost: null, power: null, hp: 30, aspects: "Command", traits: null, keywords: null, arenas: null, text: null, sets: "HMW", ...extra,
});

const ROWS: CardRow[] = [
  row("09010024", "Origin Tree", { expansion: "HMW", cardNumber: 24 }),
  row("09010028", "Jundland Wastes", { expansion: "HMW", cardNumber: 28 }),
  row("0101030", "Chopper Base", { expansion: "SOR", cardNumber: 30, sets: "SOR|JTL" }),
  row("0101050", "Some Unit", { type: "Unit", cost: 2, expansion: "SOR", cardNumber: 50 }),
];
const store: CardStore = { dataDir: "/nonexistent", cards: ROWS, byKey: new Map(ROWS.map((r) => [r.cardKey, r])), facets: new Map() };

const engineBase = (title: string, location: string, set: string, number: number, extraCodes: { set: string; number: number }[] = []) => ({
  title,
  types: ["base"],
  traits: [location],
  setId: { set, number },
  setCodes: [{ set, number }, ...extraCodes],
});

describe("locationDisplayName (#150)", () => {
  it("capitalises each word and each part after an apostrophe", () => {
    expect(locationDisplayName("kashyyyk")).toBe("Kashyyyk");
    expect(locationDisplayName("cloud city")).toBe("Cloud City");
    expect(locationDisplayName("d'qar")).toBe("D'Qar");
    expect(locationDisplayName("narkina 5")).toBe("Narkina 5");
  });
});

describe("captureBaseLocations maps engine bases to our cardKeys by printing (#150)", () => {
  it("places a base by setId, and by any listed printing when setId names one the table lacks", () => {
    const out = captureBaseLocations(
      [
        engineBase("Origin Tree", "kashyyyk", "HMW", 24),
        engineBase("Jundland Wastes", "tatooine", "HMW", 28),
        engineBase("Chopper Base", "atollon", "JTL", 29, [{ set: "SOR", number: 30 }]),
        { title: "Some Unit", types: ["unit"], traits: [] },
      ],
      store,
    );
    expect(out.rows).toEqual([
      { cardKey: "09010024", title: "Origin Tree", location: "kashyyyk", locationName: "Kashyyyk" },
      { cardKey: "09010028", title: "Jundland Wastes", location: "tatooine", locationName: "Tatooine" },
      { cardKey: "0101030", title: "Chopper Base", location: "atollon", locationName: "Atollon" },
    ].sort((a, b) => (a.cardKey < b.cardKey ? -1 : 1)));
    expect(out.engineBases).toBe(3);
  });

  it("lists an engine base the card table does not hold by name", () => {
    const out = captureBaseLocations([engineBase("Old Base", "hoth", "SOR", 99)], store);
    expect(out.rows).toEqual([]);
    expect(out.engineBasesNotInCardTable).toEqual(["Old Base"]);
  });

  it("refuses a title clash, a base without exactly one trait, and a card file with no types list", () => {
    expect(() => captureBaseLocations([engineBase("Wrong Name", "kashyyyk", "HMW", 24)], store)).toThrow(/lands on "Origin Tree"/);
    expect(() => captureBaseLocations([{ ...engineBase("Origin Tree", "kashyyyk", "HMW", 24), traits: [] }], store)).toThrow(/exactly one/);
    expect(() => captureBaseLocations([{ title: "Renamed field" }], store)).toThrow();
  });

  it("refuses two engine cards that place one table card at different locations", () => {
    expect(() => captureBaseLocations([engineBase("Origin Tree", "kashyyyk", "HMW", 24), engineBase("Origin Tree", "naboo", "HMW", 24)], store)).toThrow(/different engine cards/);
  });
});

const pin = (rows: { cardKey: string; title: string; location: string; locationName: string }[]): string =>
  JSON.stringify({ source: "forceteki", cardDataHash: "a".repeat(64), rows });
const PIN = pin([{ cardKey: "B1", title: "Origin Tree", location: "kashyyyk", locationName: "Kashyyyk" }]);

describe("mergeBaseLocations joins the pinned location into base traits (#150)", () => {
  const cards = [
    { cardKey: "B1", title: "Origin Tree", type: "Base", traits: null },
    { cardKey: "B2", title: "Unpinned Base", type: "Base", traits: null },
    { cardKey: "B3", title: "Pinned But Has Traits", type: "Base", traits: "Fortress" },
    { cardKey: "U1", title: "A Unit", type: "Unit", traits: "Rebel" },
  ];

  it("adds the display name to a pinned base, keeps its other traits, and reports an unpinned base by name", () => {
    const out = mergeBaseLocations(cards, pin([...JSON.parse(PIN).rows, { cardKey: "B3", title: "Pinned But Has Traits", location: "endor", locationName: "Endor" }]));
    expect(out.cards.map((c) => c.traits)).toEqual(["Kashyyyk", null, "Endor|Fortress", "Rebel"]);
    expect(out.record).toEqual({ sha256: sha256Hex(pin([...JSON.parse(PIN).rows, { cardKey: "B3", title: "Pinned But Has Traits", location: "endor", locationName: "Endor" }])), applied: 2, missing: ["B2 Unpinned Base"] });
  });

  it("refuses a pinned file with an unknown key or a duplicate cardKey", () => {
    expect(() => mergeBaseLocations(cards, JSON.stringify({ ...JSON.parse(PIN), extra: 1 }))).toThrow();
    const dup = JSON.parse(PIN).rows[0];
    expect(() => mergeBaseLocations(cards, pin([dup, dup]))).toThrow(/duplicate cardKey/);
  });

  it("leaves the features run unchanged without a pin, and records the pin and the merge in the replay with one", () => {
    const input = [{ cardKey: "B1", title: "Origin Tree", type: "Base", hp: 30, aspects: "Command" }];
    const table = JSON.stringify({ schemaVersion: 1, tableVersion: 1, entries: [] });
    const plain = buildFeatureRun(input, table, "test");
    expect(plain.replay).not.toHaveProperty("baseLocations");
    expect(plain.result.cards[0].structured.traits).toEqual([]);
    const located = buildFeatureRun(input, table, "test", PIN);
    expect(located.result.cards[0].structured.traits).toEqual(["Kashyyyk"]);
    expect(located.replay.baseLocations).toEqual({ sha256: sha256Hex(PIN), applied: 1, missing: [] });
    expect(located.replay.inputHash).toBe(plain.replay.inputHash);
    expect(buildFeatureRun(input, table, "test", PIN).replay.outputHashes).toEqual(located.replay.outputHashes);
  });
});

describe("the committed pinned base locations (#150)", () => {
  const dir = path.join(REPO_ROOT, "data/pinned/base-locations");
  const text = readFileSync(path.join(dir, "forceteki-7b0a1cd3726c.json"), "utf8");
  const manifest = baseLocationsManifestSchema.parse(JSON.parse(readFileSync(path.join(dir, "forceteki-7b0a1cd3726c.manifest.json"), "utf8")));
  const file = baseLocationsFileSchema.parse(JSON.parse(text));
  const locationOf = (cardKey: string): string | undefined => file.rows.find((r) => r.cardKey === cardKey)?.locationName;

  it("carries provenance that matches its bytes", () => {
    expect(manifest.file).toBe("forceteki-7b0a1cd3726c.json");
    expect(manifest.sha256).toBe(sha256Hex(text));
    expect(manifest.cardDataHash).toBe(file.cardDataHash);
    expect(manifest.cardDataHash.startsWith("7b0a1cd3726c")).toBe(true);
    expect(manifest.mappedBases).toBe(file.rows.length);
  });

  it("places the owner's bases: Origin Tree is Kashyyyk, Jundland Wastes Tatooine, Nevarro City, Restored Nevarro", () => {
    expect(locationOf("09010024")).toBe("Kashyyyk");
    expect(locationOf("09010028")).toBe("Tatooine");
    expect(locationOf("08010020")).toBe("Nevarro");
  });

  it("holds each cardKey once", () => {
    expect(new Set(file.rows.map((r) => r.cardKey)).size).toBe(file.rows.length);
  });
});

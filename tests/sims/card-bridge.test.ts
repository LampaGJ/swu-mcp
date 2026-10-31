import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCardBridge, deckCoverage, loadCardBridge, translateDeck, type BridgePrinting, type EngineCardMaps } from "../../scripts/sims/card-bridge.js";
import { DEFAULT_FORCETEKI } from "../../src/sims/engine-pin.js";

const p = (cardKey: string, expansion: string, cardNumber: number, title: string, subtitle: string | null, variant = "Standard", type = "Unit"): BridgePrinting => ({
  cardKey,
  expansion,
  cardNumber,
  title,
  subtitle,
  type,
  variantTypes: [variant],
});

const printings: BridgePrinting[] = [
  p("0101001", "SOR", 1, "Alpha", "First"),
  p("0101001", "P25", 10, "Alpha", "First", "SQ Prize Wall"),
  p("0201154", "SHD", 154, "Wrecker", "Boom!"),
  p("0201154", "J24", 5, "Wrecker", "BOOM!", "Judge Program"),
  p("0901001", "X99", 1, "Gamma", "Sub Title"),
  p("0601010", "TWI", 300, "Delta", null, "Hyperspace"),
  p("0601010", "TWI", 10, "Delta", null),
  p("0001000", "SOR", 900, "Shield", null, "Standard", "Token Upgrade"),
];

const engine: EngineCardMaps = {
  setCodeMap: { SOR_001: "alpha#first-id", SHD_154: "wrecker#boom-id", ZZZ_007: "gamma#sub-title-id", TWI_010: "delta-id", TWI_300: "delta-id" },
  cardMap: [
    { id: "alpha#first-id", internalName: "alpha#first" },
    { id: "wrecker#boom-id", internalName: "wrecker#boom" },
    { id: "gamma#sub-title-id", internalName: "gamma#sub-title" },
    { id: "delta-id", internalName: "delta" },
    { id: "shield-id", internalName: "shield" },
  ],
};

describe("cardKey to engine set code", () => {
  const bridge = buildCardBridge(printings, engine);

  it("picks the best-ranked printing the engine knows", () => {
    expect(bridge.toEngine("0101001")).toEqual({ setCode: "SOR_001", via: "printing" });
    expect(bridge.toEngine("0601010")).toEqual({ setCode: "TWI_010", via: "printing" });
    const noStandard = buildCardBridge(printings, { ...engine, setCodeMap: { TWI_300: "delta-id" } });
    expect(noStandard.toEngine("0601010")).toEqual({ setCode: "TWI_300", via: "printing" });
  });

  it("falls back to the title#subtitle slug through the card map", () => {
    expect(bridge.toEngine("0901001")).toEqual({ setCode: "ZZZ_007", via: "slug" });
  });

  it("returns null for a card the engine lacks, never a guess", () => {
    expect(bridge.toEngine("9999999")).toBeNull();
  });

  it("translates a promo set code by card identity (the J24_005 case)", () => {
    expect(bridge.translate("SOR_001")).toEqual({ from: "SOR_001", setCode: "SOR_001", via: "direct", cardKey: "0101001" });
    expect(bridge.translate("J24_005")).toEqual({ from: "J24_005", setCode: "SHD_154", via: "printing", cardKey: "0201154" });
    expect(bridge.translate("NOPE_001")).toBeNull();
  });

  it("maps engine internal names back to cardKeys, tokens by slug", () => {
    expect(bridge.cardKeyOf("alpha#first")).toBe("0101001");
    expect(bridge.cardKeyOf("delta")).toBe("0601010");
    expect(bridge.cardKeyOf("shield")).toBe("0001000");
    expect(bridge.cardKeyOf("unknown#card")).toBeNull();
    expect(bridge.engineCardKeys["wrecker#boom"]).toBe("0201154");
  });
});

describe("translateDeck", () => {
  const bridge = buildCardBridge(printings, engine);
  it("rewrites untranslatable ids, keeps order and counts, and lists what it could not map", () => {
    const out = translateDeck(bridge, {
      leader: { id: "SOR_001", count: 1 },
      base: { id: "SHD_154", count: 1 },
      deck: [
        { id: "J24_005", count: 2 },
        { id: "NOPE_001", count: 1 },
        { id: "TWI_010", count: 3 },
      ],
    });
    expect(out.deck.deck).toEqual([
      { id: "SHD_154", count: 2 },
      { id: "NOPE_001", count: 1 },
      { id: "TWI_010", count: 3 },
    ]);
    expect(out.translations).toEqual([{ from: "J24_005", setCode: "SHD_154", via: "printing", cardKey: "0201154" }]);
    expect(out.unmapped).toEqual(["NOPE_001"]);
  });
});

const DECKS = "data/originals/decks/2026-10-17";
const RUN = "data/runs/2026-10-31";
const ORIGINALS = "/Volumes/Local Files/Projects/mault/data/swu-originals/2026-10-16";
const hasData = existsSync(DECKS) && existsSync(path.join(RUN, "replay.json")) && existsSync(ORIGINALS) && existsSync(path.join(DEFAULT_FORCETEKI, "test/json/_setCodeMap.json"));

describe.skipIf(!hasData)("every tournament list maps to the engine (#109, data-backed)", () => {
  it("has one named exception, J24_005, translated by identity; no list is dropped", { timeout: 60_000 }, () => {
    const bridge = loadCardBridge(RUN, ORIGINALS, DEFAULT_FORCETEKI);
    const report = deckCoverage(bridge, DECKS);
    expect(report.unmappedAfterTranslation).toEqual([]);
    expect(Object.keys(report.translatedIds)).toEqual(["J24_005"]);
    expect(report.translatedIds.J24_005).toEqual({ setCode: "SHD_154", via: "printing", cardKey: "0201154", slots: 522, files: 517 });
    expect(report.filesWithTranslation).toHaveLength(517);
    expect(report.filesWithTranslation.every((f) => f.startsWith("melee-"))).toBe(true);
    expect(report.slots).toBe(782616);
    expect(report.roundTrip.cardKeys).toBeGreaterThan(2000);
    expect(report.roundTrip.mismatches).toEqual([]);
    expect(report.directSlots).toBe(782616 - 522);
    for (const spike of ["melee-0b373cb2-6dfb-425e-842d-b4a700e2d337.json", "melee-6563300e-ae56-49d6-b88c-b3ea0151a4da.json", "melee-1a7b3451-7300-4e19-b69b-b44200bbce01.json"])
      expect(report.filesWithTranslation).not.toContain(spike);
  });

  it("maps the owner's deck directly", () => {
    const bridge = loadCardBridge(RUN, ORIGINALS, DEFAULT_FORCETEKI);
    const out = translateDeck(bridge, JSON.parse(readFileSync("tests/fixtures/decks/warrior-chewie-raid.swudb.json", "utf8")));
    expect(out.unmapped).toEqual([]);
    expect(out.translations).toEqual([]);
  });
});

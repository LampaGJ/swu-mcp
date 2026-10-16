import { decode } from "@toon-format/toon";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore } from "../src/data.js";
import type { ToolResult } from "../src/tools.js";
import { cardPriceHandler, playStatsHandler, valueVsPriceHandler } from "../src/tools/market.js";

const store = loadStore(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures"));

function body(result: ToolResult): Record<string, any> {
  expect(result.isError, result.content[0].text).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

describe("card_price", () => {
  it("returns the canonical prices, the import and every printing", () => {
    const out = body(cardPriceHandler(store, { title: "Death Trooper" }));
    expect(out.card.cardKey).toBe("0101033");
    expect(out.canonical.normal).toBe(0.08);
    expect(out.priceImport).toEqual({ id: 43, date: "2026-10-16" });
    expect(out.printings.length).toBeGreaterThan(1);
    expect(out.printings[0]).toMatchObject({ variant: "standard", priceSource: "direct" });
    expect(out.coverage).toContain("US");
  });

  it("accepts a cardKey and reports unknown cards and ambiguous input as errors", () => {
    expect(body(cardPriceHandler(store, { cardKey: "09010004" })).card.title).toBe("Grand Moff Tarkin");
    expect(cardPriceHandler(store, { cardKey: "nope" }).isError).toBe(true);
    expect(cardPriceHandler(store, {}).isError).toBe(true);
  });
});

describe("play_stats", () => {
  it("returns counts, win share and date range per window with the caveat note", () => {
    const out = body(playStatsHandler(store, { cardKey: "0101033" }));
    expect(out.note).toBe("inclusion in online Karabast/Petranaki games; not tournament data; HMW has < 1 week");
    expect(out.windows.map((w: { window: string }) => w.window)).toEqual(["w0-55", "w29-55", "w43-55"]);
    const w = out.windows[1];
    expect(w).toMatchObject({ startDate: "2026-04-11", endDate: "2026-10-16" });
    expect(w.included).toBeGreaterThan(0);
    expect(w.winShare).toBeCloseTo(w.wins / w.included, 4);
  });

  it("filters to one window and rejects an unknown one", () => {
    expect(body(playStatsHandler(store, { cardKey: "0101033", window: "w43-55" })).windows).toHaveLength(1);
    expect(playStatsHandler(store, { cardKey: "0101033", window: "w1-2" }).isError).toBe(true);
  });
});

describe("value_vs_price", () => {
  it("ranks priced, positively scored cards by score per dollar, descending, with the rarity caveat", () => {
    const out = body(valueVsPriceHandler(store, {}));
    expect(out.note).toContain("rarity");
    const ratios = out.cards.map((c: { scorePerDollar: number }) => c.scorePerDollar);
    expect(ratios.length).toBeGreaterThan(0);
    expect([...ratios].sort((a, b) => b - a)).toEqual(ratios);
    for (const c of out.cards) expect(c.price).toBeGreaterThan(0);
  });

  it("applies type, set, aspect and maxPrice filters and the limit", () => {
    const all = body(valueVsPriceHandler(store, {}));
    const units = body(valueVsPriceHandler(store, { type: "Unit" }));
    expect(units.cards.every((c: { type: string }) => c.type === "Unit")).toBe(true);
    expect(units.matched).toBeLessThanOrEqual(all.matched);
    expect(body(valueVsPriceHandler(store, { maxPrice: 0.05 })).cards.every((c: { price: number }) => c.price <= 0.05)).toBe(true);
    expect(body(valueVsPriceHandler(store, { aspect: "Villainy" })).matched).toBeLessThanOrEqual(all.matched);
    expect(body(valueVsPriceHandler(store, { limit: 1 })).cards).toHaveLength(1);
  });
});

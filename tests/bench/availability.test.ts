import { describe, expect, it } from "vitest";
import { cardFirstOrder, isObservable, releaseDatesFromDefinitions, sourceWindow, UNKNOWN_ORDER } from "../../scripts/bench/availability.js";
import type { Printing } from "../../scripts/bench/card-map.js";

const printing = (cardKey: string, expansion: string): Printing => ({
  serialCode: `${cardKey}-${expansion}`,
  cardKey,
  expansion,
  cardNumber: 1,
  title: cardKey,
  subtitle: null,
  type: "Unit",
  variantTypes: ["Standard"],
  aspectIcons: [],
});

describe("observability window", () => {
  const first = cardFirstOrder([printing("reprint", "SEC"), printing("reprint", "SOR"), printing("weekly", "LAWP"), printing("promo", "P26"), printing("new", "HMW")]);

  it("orders a card by its earliest main set; Weekly Play takes its base set; promo-only is unknown", () => {
    expect(first.get("reprint")).toBe(1);
    expect(first.get("weekly")).toBe(7);
    expect(first.get("promo")).toBe(UNKNOWN_ORDER);
    expect(first.get("new")).toBe(9);
  });

  it("reads release dates from expansion definitions", () => {
    expect(releaseDatesFromDefinitions([{ value: "HMW", definition: "Homeworlds. Main set 9, released 2026-10-09. Introduced..." }, { value: "SEC", definition: "Main set 6." }])).toEqual(
      new Map([["HMW", "2026-10-09"]]),
    );
  });

  it("a source reaches dated sets released by its capture date and sets it shows in use", () => {
    const dates = new Map([["HMW", "2026-10-09"]]);
    const early = sourceWindow("decks", "2026-01-19", dates, new Map([["SEC", 500], ["LAW", 3]]));
    expect(early.reachesOrder).toBe(6);
    const preview = sourceWindow("games", "2026-02-10", dates, new Map([["LAW", 900]]));
    expect(preview.reachesOrder).toBe(7);
    expect(sourceWindow("later", "2026-10-10", dates, new Map()).reachesOrder).toBe(9);
  });

  it("an unreleased card is not observable unless the source itself shows it", () => {
    const w = sourceWindow("decks", "2026-01-19", new Map(), new Map([["SEC", 500]]));
    expect(isObservable("reprint", w, first, new Set())).toBe(true);
    expect(isObservable("new", w, first, new Set())).toBe(false);
    expect(isObservable("promo", w, first, new Set())).toBe(false);
    expect(isObservable("promo", w, first, new Set(["promo"]))).toBe(true);
  });
});

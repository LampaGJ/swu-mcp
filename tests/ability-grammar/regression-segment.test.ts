import { describe, expect, it } from "vitest";
import { assertNoStaleCurated, buildFeatureRun, normalizeText } from "../../src/ability-grammar/index.js";
import { sha256Hex } from "../../src/swu/canonical.js";
import { CARDS } from "./regression-cards.js";
import { clauseWith, clausesOf, featuresOf, wantTags } from "./helpers.js";

// Golden regressions for RC16 (U+2011 in non-X) and the RC15 token whose whole text is a parenthetical.

describe("RC16 the non-breaking hyphen is normalised", () => {
  it("rewrites U+2011 to an ASCII hyphen", () => {
    expect(normalizeText("Choose a non\u2011Vehicle unit.")).toBe("Choose a non-Vehicle unit.");
  });

  it("09010095 Carbonite Chamber: non-Vehicle keeps its negation", () => {
    const card = featuresOf(CARDS["09010095"]);
    const select = clauseWith(card, "Choose a non").structure[0];
    expect(select.target?.restrict).toEqual(["non_trait:Vehicle"]);
    expect(wantTags(card)).not.toContain("wants:trait-Vehicle");
  });
});

describe("RC15 a paragraph that is one parenthetical is rules text, not a reminder", () => {
  it("05010t03 The Force token: the whole text is a parenthetical, so it is read, not stripped", () => {
    const card = featuresOf(CARDS["05010t03"]);
    const clauses = clausesOf(card);
    expect(clauses.length).toBeGreaterThan(0);
    expect(clauses.flatMap((c) => c.clause.effects.map((e) => e.cat))).toContain("gain_force");
    expect(card.unclassified).toEqual([]);
  });

  it("still strips reminder text that trails a real ability", () => {
    const card = featuresOf({ cardKey: "99990001", title: "Reminder", type: "Unit", text: "Raid 2 (This unit gets +2/+0 while attacking.)" });
    expect(card.keywords).toEqual([{ keyword: "Raid", n: 2, granted: false }]);
  });
});

describe("a curated entry written with U+2011 still applies after the normaliser rewrites it", () => {
  const clause = "Put a non\u2011Vehicle unit from your discard pile on top of your deck.";
  const table = JSON.stringify({
    schemaVersion: 1,
    tableVersion: 1,
    entries: [
      {
        id: "cur-0001", cardKey: "99990001", title: "Bacta Tank", face: "text", sourceClause: clause, clauseSha256: sha256Hex(clause),
        features: { effects: [{ rule: "curated", cat: "recycle", n: 1 }], offers: [], wants: [] },
        rationale: "test", reviewedBy: null, addedIn: "test",
      },
    ],
  });

  it("is applied, not reported stale", () => {
    const run = buildFeatureRun([{ cardKey: "99990001", title: "Bacta Tank", type: "Upgrade", text: `Action [defeat this upgrade]: ${clause}` }], table, "test");
    expect(run.result.curated).toMatchObject({ applied: 1, stale: [], redundant: [] });
    expect(run.result.coverage.unclassified).toBe(0);
  });

  it("does not fail the run when an entry is only redundant", () => {
    const redundant = JSON.stringify({
      schemaVersion: 1, tableVersion: 1,
      entries: [{
        id: "cur-0001", cardKey: "99990002", title: "Poe", face: "text", sourceClause: "You may play it.", clauseSha256: sha256Hex("You may play it."),
        features: { effects: [], offers: [], wants: [] }, rationale: "test", reviewedBy: null, addedIn: "test",
      }],
    });
    const run = buildFeatureRun([{ cardKey: "99990002", title: "Poe", type: "Event", text: "You may play it." }], redundant, "test");
    expect(run.result.curated.redundant).toHaveLength(1);
    expect(() => assertNoStaleCurated(run)).not.toThrow();
  });
});

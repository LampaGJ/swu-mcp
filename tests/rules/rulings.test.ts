import { describe, expect, it } from "vitest";
import { buildCardRulings, parseRulesStyled } from "../../src/rules/rulings.js";
import { fixtureRecords } from "./helpers.js";

const source = { originalsRun: "fixture", rawPagesManifestSha256: "b".repeat(64) };
const file = buildCardRulings(fixtureRecords(), source);
const card = (key: string) => file.cards.find((entry) => entry.cardKey === key);

describe("parseRulesStyled", () => {
  it("returns ISO dates and plain text per row, turning icons into tokens", () => {
    const html =
      '<figure class="table"><table><tbody><tr><td>7/14/2025</td><td>A.</td></tr><tr><td>07/20/2026</td><td>Unique becomes <img src="https://x/icon_unique_white_a0.png" alt="icon_cunning.png">.</td></tr></tbody></table></figure>';
    expect(parseRulesStyled(html)).toEqual([
      { date: "2025-07-14", text: "A." },
      { date: "2026-07-20", text: "Unique becomes <uq>." },
    ]);
  });

  it("refuses a row that is not (date, text)", () => {
    expect(() => parseRulesStyled("<table><tr><td>3/1/2024</td></tr></table>")).toThrow(/cells/);
  });
});

describe("buildCardRulings", () => {
  it("folds printings of one card into the logical cardKey and dedupes", () => {
    const vader = card("0101010");
    expect(vader?.printings).toBe(3);
    expect(vader?.rulings).toHaveLength(1);
    expect(file.cards.some((entry) => entry.cardKey === "0102002")).toBe(false);
  });

  it("counts printings, logical cards and distinct rulings", () => {
    expect(file.stats).toMatchObject({ printingsWithRulings: 7, logicalCardsWithRulings: 5 });
    expect(file.stats.rulingRows).toBeGreaterThan(file.stats.distinctDatedRulings);
  });

  it("orders rulings newest first and cards by cardKey", () => {
    const kallus = card("0101115");
    const dates = kallus?.rulings.map((r) => r.date) ?? [];
    expect(dates).toEqual([...dates].sort().reverse());
    const keys = file.cards.map((entry) => entry.cardKey);
    expect(keys).toEqual([...keys].sort());
  });

  it("is deterministic", () => {
    expect(JSON.stringify(buildCardRulings(fixtureRecords(), source))).toBe(JSON.stringify(file));
  });
});

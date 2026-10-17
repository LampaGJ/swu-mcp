import { describe, expect, it } from "vitest";
import { buildCardRulings, compareRulings, normaliseRulingText, parseRulesStyled } from "../../src/rules/rulings.js";
import type { RawCardRecord } from "../../src/swu/llm-flatten.js";
import { fixtureRecords } from "./helpers.js";

const source = { originalsRun: "fixture", rawPagesManifestSha256: "b".repeat(64) };
const file = buildCardRulings(fixtureRecords(), source);
const card = (key: string) => file.cards.find((entry) => entry.cardKey === key);

describe("parseRulesStyled", () => {
  it("returns ISO dates and plain text per row, turning icons into tokens", () => {
    const html =
      '<figure class="table"><table><tbody><tr><td>7/14/2025</td><td>A.</td></tr><tr><td>07/20/2026</td><td>Unique becomes <img src="https://x/icon_unique_white_a0.png" alt="icon_cunning.png">.</td></tr></tbody></table></figure>';
    expect(parseRulesStyled(html)).toEqual([
      { date: "2025-07-14", source: "rulesStyled", text: "A." },
      { date: "2026-07-20", source: "rulesStyled", text: "Unique becomes <uq>." },
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

const styledRow = (date: string, text: string) => `<figure class="table"><table><tbody><tr><td>${date}</td><td>${text}</td></tr></tbody></table></figure>`;

function record(serial: string, title: string, rules: string | null, rulesStyled: string | null, extra: Record<string, unknown> = {}): RawCardRecord {
  return {
    attributes: {
      serialCode: serial,
      title,
      subtitle: null,
      variantOf: { data: null },
      reprintOf: { data: null },
      expansion: { data: { attributes: { code: "SOR" } } },
      rules,
      rulesStyled,
      ...extra,
    },
  } as unknown as RawCardRecord;
}

describe("normaliseRulingText", () => {
  it("folds whitespace and quote style but keeps case and wording", () => {
    expect(normaliseRulingText("  It\u2019s  \u201Cready\u201D.\n")).toBe('It\'s "ready".');
    expect(normaliseRulingText("It is Ready")).not.toBe(normaliseRulingText("it is ready"));
  });
});

describe("undated plain-rules rulings (issue #10)", () => {
  const chosen = "The chosen unit can still gain the effect.";
  const resource = "A card put into play as a resource enters play exhausted.";
  const out = buildCardRulings(
    [
      // plain line has no styled row at all
      record("0101140", "Chosen A", `${chosen}\n`, styledRow("1/5/2025", "Something else entirely.")),
      // same plain line on a second printing of a different card: kept per logical card
      record("0101138", "Chosen B", `${chosen}\n`, null),
      // no styled table, only a plain line
      record("0201114", "Resource Card", `${resource}\n`, null),
      // plain line matches the styled row up to quote style and spacing: not duplicated
      record("0301001", "Matched", "It\u2019s  \u201Cfine\u201D.\n", styledRow("2/2/2025", "It's \"fine\".")),
    ],
    source,
  );
  const get = (key: string) => out.cards.find((entry) => entry.cardKey === key)?.rulings;

  it("keeps the plain line of a printing whose styled table lacks it, after the dated rows", () => {
    expect(get("0101140")).toEqual([
      { date: "2025-01-05", source: "rulesStyled", text: "Something else entirely." },
      { date: null, source: "rules", text: chosen },
    ]);
  });

  it("keeps a plain line from a printing with no styled table", () => {
    expect(get("0101138")).toEqual([{ date: null, source: "rules", text: chosen }]);
    expect(get("0201114")).toEqual([{ date: null, source: "rules", text: resource }]);
  });

  it("does not duplicate a plain line that matches a styled ruling after normalisation", () => {
    expect(get("0301001")).toEqual([{ date: "2025-02-02", source: "rulesStyled", text: "It's \"fine\"." }]);
  });

  it("dedupes an undated line across printings of one logical card", () => {
    const twice = buildCardRulings(
      [
        record("0401001", "Twin", "Same line.\n", null),
        record("0501001", "Twin", "Same   line.\n", null, { variantOf: { data: { attributes: { serialCode: "0401001" } } } }),
      ],
      source,
    );
    expect(twice.cards.flatMap((entry) => entry.rulings)).toHaveLength(1);
    expect(twice.stats.distinctUndatedRulings).toBe(1);
  });

  it("counts every printing that carries any ruling and the undated rulings", () => {
    expect(out.stats).toMatchObject({ printingsWithRulings: 4, logicalCardsWithRulings: 4, distinctDatedRulings: 2, distinctUndatedRulings: 3 });
  });

  it("orders dated newest first (then text), then undated by text", () => {
    const rulings = [
      { date: null, source: "rules", text: "b" },
      { date: "2024-01-01", source: "rulesStyled", text: "z" },
      { date: null, source: "rules", text: "a" },
      { date: "2025-01-01", source: "rulesStyled", text: "y" },
      { date: "2024-01-01", source: "rulesStyled", text: "c" },
    ] as const;
    expect([...rulings].sort(compareRulings).map((r) => `${r.date}:${r.text}`)).toEqual(["2025-01-01:y", "2024-01-01:c", "2024-01-01:z", "null:a", "null:b"]);
  });
});

import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildIndex,
  buildPackets,
  loadInputs,
  orderBySeed,
  orderStratified,
  parseFieldGuide,
  pdfExcerpt,
  serialize,
  type Inputs,
  type RawRecord,
} from "../../scripts/verify/sample.js";

const SEED = "verify-2026-10-16";
const names = (...values: string[]): unknown => ({ data: values.map((name) => ({ attributes: { name } })) });
const one = (name: string, field = "name"): unknown => ({ data: { attributes: { [field]: name } } });

function record(n: number): RawRecord {
  const serial = `0${(n % 3) + 4}010${String(n).padStart(3, "0")}`;
  return {
    id: n,
    serial,
    attributes: {
      serialCode: serial,
      title: `Card ${n}`,
      subtitle: n % 2 === 0 ? `Sub ${n}` : null,
      cost: n % 7,
      power: 2,
      hp: 3,
      text: `When Played: Deal ${n} damage to a unit. `,
      deployBox: null,
      epicAction: null,
      unique: n % 5 === 0,
      type: one(n % 4 === 0 ? "Event" : "Unit"),
      type2: { data: null },
      aspects: names("Command"),
      traits: names(n % 2 === 0 ? "Rebel" : "Imperial"),
      arenas: names("Ground"),
      keywords: n % 3 === 0 ? names("Ambush") : names(),
      expansion: one(["JTL", "LOF", "SEC"][n % 3], "code"),
      variantTypes: names("Standard"),
      rarity: one("Common"),
    },
  };
}

function inputs(): Inputs {
  const records = Array.from({ length: 30 }, (_, i) => record(i + 1));
  const cards = records.map((r) => ({
    cardKey: r.serial,
    type: r.attributes.type && (r.attributes.type as { data: { attributes: { name: string } } }).data.attributes.name,
    firstSet: (r.attributes.expansion as { data: { attributes: { code: string } } }).data.attributes.code,
    traits: (r.attributes.traits as { data: { attributes: { name: string } }[] }).data.map((t) => t.attributes.name).join("|"),
    keywords: (r.attributes.keywords as { data: unknown[] }).data.length > 0 ? "Ambush" : "",
    aspects: "Command",
    arenas: "Ground",
    rarity: "Common",
    text: String(r.attributes.text),
    deployBox: null,
    epicAction: null,
  }));
  const features = cards.map((c) => ({
    cardKey: c.cardKey,
    unclassified: [],
    faces: { text: [{ kind: "ability", triggers: [{ trigger: "when_played", text: "When Played" }], clauses: [{ text: "Deal damage.", source: "grammar", effects: [{ rule: "damage", cat: "damage", n: 2, target: { side: "enemy", kind: "unit", arena: "any", quant: "one", restrict: [], text: "a unit" } }], conditions: [] }] }] },
    tags: { offers: [{ tag: "offers:damage-enemy-unit", why: "text: Deal damage." }], wants: [{ tag: "wants:damaged-units", why: "text" }] },
  }));
  const sections = [
    { id: "1", parentId: null, depth: 0, title: "GAME CONCEPTS", text: "", page: 1 },
    { id: "1.1", parentId: "1", depth: 1, title: "GENERAL", text: "", page: 1 },
    { id: "1.1.1", parentId: "1.1", depth: 2, title: null, text: "The rules in this document apply to any game of Star Wars Unlimited, unless otherwise specified.", page: 1 },
    { id: "1.1.2", parentId: "1.1", depth: 2, title: null, text: "To play a game, players need one deck each and an initiative counter.", page: 1 },
  ];
  return {
    cards,
    records,
    pageMeta: [{ pagination: { page: 1, pageCount: 1, total: 30 } }],
    features,
    curated: Array.from({ length: 6 }, (_, i) => ({ id: `cur-${i}`, cardKey: cards[i].cardKey, face: "text", sourceClause: "Deal damage.", features: { effects: [{ rule: "curated", cat: "damage" }] }, rationale: "r" })),
    pairs: Array.from({ length: 20 }, (_, i) => ({ cardA: cards[i].cardKey, cardB: cards[i + 1].cardKey, reason: "row-a: why", rows: i % 2 === 0 ? "row-a" : "trait-reference:Rebel", source: "rule", link: 1, nonObvious: 1, score: 1 })),
    complementarity: [{ id: "row-a", offers: { "offers:x": 1 }, wants: { "wants:y": 1 }, reason: "why" }, { id: "trait-reference", offers: { "offers:is-trait-*": 1 }, wants: ["wants:trait-*"], reason: "tribal" }],
    fungibilityClasses: Array.from({ length: 5 }, (_, i) => ({ id: `offers:t${i}|Unit|once_on_play|m-|c0-1`, tag: `offers:t${i}`, side: "offers", typeGroup: "Unit", timing: "once_on_play", magnitude: "-", costBand: "0-1", size: 4, members: cards.slice(i, i + 4).map((c) => c.cardKey) })),
    sections,
    pdfPages: ["      1.     GAME CONCEPTS\n\n      1.     GENERAL\n             1.     The rules in this document apply to any game of Star Wars Unlimited, unless otherwise specified.\n             2.     To play a game, players need one deck each and an initiative counter.\n\n1. GAME CONCEPTS      CONTENTS GLOSSARY StarWarsUnlimited.com 1"],
    glossary: { keyword: [{ value: "Ambush", definition: "d", strategicValue: "s", source: "x", inScope: true }], trait: [{ value: "Rebel", definition: "d" }, { value: "Imperial", definition: "d" }], aspect: [{ value: "Command", definition: "d" }], expansion: [{ value: "JTL", definition: "d" }], variant: [{ value: "Standard", definition: "d" }], token: [{ value: "Spy", definition: "d" }] },
    keywordRules: [{ keyword: "Ambush", sections: ["1.1.1"], mentionedIn: ["1.1.2"], definition: "d" }],
    fieldGuide: parseFieldGuide("## Printing\n\n- **`printings[].title`**\n  - Type: string.\n  - Meaning: the name.\n- **`printings[].cost`**\n  - Type: integer.\n## Price import\n\n- **`import.id`**: integer, `43`.\n"),
    priceSources: { printings: [], corrections: [], quarantine: [], importRow: [{ id: 43 }] },
  };
}

describe("seeded ordering", () => {
  it("orders by sha256(seed + id) with code-point tie-breaks", () => {
    const ids = ["b", "a", "c", "d", "e"];
    const expected = [...ids].sort((x, y) => {
      const hx = createHash("sha256").update(SEED + x).digest("hex");
      const hy = createHash("sha256").update(SEED + y).digest("hex");
      return hx < hy ? -1 : hx > hy ? 1 : 0;
    });
    expect(orderBySeed(ids, SEED, (id) => id)).toEqual(expected);
  });

  it("does not depend on input order", () => {
    const ids = ["x1", "x2", "x3", "x4", "x5", "x6"];
    expect(orderBySeed([...ids].reverse(), SEED, (id) => id)).toEqual(orderBySeed(ids, SEED, (id) => id));
  });

  it("interleaves strata one per round", () => {
    const items = [..."aaaa", ..."bb", ..."c"].map((stratum, i) => ({ stratum, id: `${stratum}${i}` }));
    const out = orderStratified(items, SEED, (item) => item.id, [(item) => item.stratum]);
    expect(out).toHaveLength(items.length);
    expect(new Set(out.slice(0, 3).map((item) => item.stratum)).size).toBe(3);
    expect(new Set(out.slice(3, 5).map((item) => item.stratum)).size).toBe(2);
  });
});

describe("buildPackets", () => {
  it("gives byte-identical packets for the same seed", () => {
    const first = buildPackets(inputs(), SEED).map(serialize);
    const second = buildPackets(inputs(), SEED).map(serialize);
    expect(second).toEqual(first);
  });

  it("changes the sample when the seed changes", () => {
    const a = buildPackets(inputs(), SEED).map((p) => p.items.map((i) => i.id));
    const b = buildPackets(inputs(), "another-seed").map((p) => p.items.map((i) => i.id));
    expect(b).not.toEqual(a);
  });

  it("emits the eight named packets and an index with the verdict schema", () => {
    const packets = buildPackets(inputs(), SEED);
    expect(packets.map((p) => p.packet)).toEqual(["features-1", "features-2", "curated", "pairings", "fungible", "rules", "glossary", "fieldguide"]);
    const index = buildIndex(packets, SEED, new Map()) as { totalItems: number; verdictSchema: { required: string[] } };
    expect(index.totalItems).toBe(packets.reduce((n, p) => n + p.itemCount, 0));
    expect(index.verdictSchema.required).toEqual(["packet", "items", "summary"]);
  });

  it("carries the original card text beside the derived claim", () => {
    const [features] = buildPackets(inputs(), SEED);
    const item = features.items[0] as { raw: { text: string }; derived: { tags: { offers: unknown[] } } };
    expect(item.raw.text).toMatch(/^When Played: Deal \d+ damage to a unit\.$/);
    expect(item.derived.tags.offers).toHaveLength(1);
  });
});

describe("field guide and PDF helpers", () => {
  it("parses bold-path bullets with their body and section", () => {
    const entries = parseFieldGuide("## Printing\n\n- **`printings[].title`**\n  - Type: string.\n  - Meaning: the name.\n\n## Price import\n\n- **`import.a`**, **`import.b`**: strings, `x`.\n");
    expect(entries).toEqual([
      { paths: ["printings[].title"], section: "Printing", body: "- Type: string.\n- Meaning: the name." },
      { paths: ["import.a", "import.b"], section: "Price import", body: "strings, `x`." },
    ]);
  });

  it("locates a section in the raw page text", () => {
    const page = "   1.   Intro line\n   2.   The unit enters play exhausted and remains in play\n        until it is defeated.\n   3.   Next rule\n\n1. X   CONTENTS GLOSSARY StarWarsUnlimited.com 1";
    const found = pdfExcerpt({ page: 1, title: null, text: "The unit enters play exhausted and remains in play until it is defeated." }, [page]);
    expect(found.located).toBe(true);
    expect(found.text).toContain("until it is defeated.");
    expect(pdfExcerpt({ page: 1, title: null, text: "Nothing like this appears anywhere" }, [page]).located).toBe(false);
  });
});

const ORIGINALS = "/Volumes/Local Files/Projects/mault/data/swu-originals/2026-10-16";
const RUN = path.resolve(import.meta.dirname, "../../data/runs/2026-10-16");

describe.skipIf(!existsSync(ORIGINALS) || !existsSync(RUN))("real data", () => {
  it("reproduces the eight packets byte for byte and respects the item caps", () => {
    const real = loadInputs({ originalsDir: ORIGINALS, runDir: RUN });
    const first = buildPackets(real, SEED);
    expect(buildPackets(real, SEED).map(serialize)).toEqual(first.map(serialize));
    expect(Object.fromEntries(first.map((p) => [p.packet, p.itemCount]))).toEqual({ "features-1": 40, "features-2": 40, curated: 40, pairings: 40, fungible: 25, rules: 40, glossary: 40, fieldguide: 30 });
  });
});

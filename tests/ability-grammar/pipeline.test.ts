import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CuratedTableError,
  StaleCuratedEntriesError,
  assertNoStaleCurated,
  buildFeatureRun,
  curatedReport,
  extractFeatures,
  loadCuratedTable,
} from "../../src/ability-grammar/index.js";
import { sha256Hex } from "../../src/swu/canonical.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../..");
const CURATED_PATH = path.resolve(REPO_ROOT, "data/curated-rules.json");

const EMPTY_TABLE = JSON.stringify({ schemaVersion: 1, tableVersion: 1, entries: [] });

function card(overrides: Record<string, unknown>): Record<string, unknown> {
  return { cardKey: "99990001", title: "Test Card", type: "Unit", ...overrides };
}

function entry(id: string, cardKey: string, face: string, clause: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    cardKey,
    title: "Test Card",
    face,
    sourceClause: clause,
    clauseSha256: sha256Hex(clause),
    features: { effects: [], structure: [{ rule: "curated", cat: "win_game" }], offers: [], wants: [] },
    rationale: "test",
    reviewedBy: null,
    addedIn: "test",
    ...extra,
  };
}

const table = (entries: unknown[]): string => JSON.stringify({ schemaVersion: 1, tableVersion: 1, entries });

const tagsOf = (c: Record<string, unknown>, curated = EMPTY_TABLE) => {
  const run = buildFeatureRun([c], curated, "test");
  const f = run.result.cards[0];
  return { offers: f.tags.offers.map((t) => t.tag), wants: f.tags.wants.map((t) => t.tag), card: f };
};

describe("tag precision regressions", () => {
  it("defeating an Experience token on a friendly unit is not a sacrifice outlet", () => {
    const t = tagsOf(card({ text: "When Played: Defeat an Experience token on a friendly unit." }));
    expect(t.offers).not.toContain("offers:defeat-friendly-unit");
    expect(t.wants).not.toContain("wants:sac-fodder");
    expect(t.offers).toContain("offers:defeat-own-upgrade");
  });

  it("defeating a friendly unit is a sacrifice outlet", () => {
    const t = tagsOf(card({ text: "When Played: Defeat a friendly unit." }));
    expect(t.offers).toContain("offers:defeat-friendly-unit");
    expect(t.wants).toContain("wants:sac-fodder");
  });

  it("\"This unit enters play ready\" is not an offer to other cards", () => {
    const t = tagsOf(card({ text: "This unit enters play ready." }));
    expect(t.offers).not.toContain("offers:ready-unit");
  });

  it("readying a friendly unit is an offer", () => {
    expect(tagsOf(card({ text: "When Played: Ready a friendly unit." })).offers).toContain("offers:ready-unit");
  });

  it("a leader's deploy threshold does not create wants:resource-ramp", () => {
    const leader = card({ type: "Leader", epicAction: "Epic Action: If you control 6 or more resources, deploy this leader." });
    expect(tagsOf(leader).wants).not.toContain("wants:resource-ramp");
  });

  it("a resource condition on the main face does create wants:resource-ramp", () => {
    const unit = card({ text: "On Attack: If you control 6 or more resources, draw a card." });
    expect(tagsOf(unit).wants).toContain("wants:resource-ramp");
  });

  it("an unclassified clause contributes no tag", () => {
    const t = tagsOf(card({ text: "Xyzzy plugh frobnicate." }));
    expect(t.card.unclassified).toHaveLength(1);
    expect(t.offers.filter((o) => !o.startsWith("offers:is-trait-"))).toEqual([]);
    expect(t.wants).toEqual([]);
  });

  it("keeps a granted ability out of the card's own keywords", () => {
    const t = tagsOf(card({ type: "Upgrade", text: "Attached unit gains “On Attack: Draw a card.”" }));
    const grant = t.card.faces.text?.[0];
    expect(grant && grant.kind === "ability" && grant.grantedAbilities).toHaveLength(1);
  });

  it("cross-checks the keyword field against the keyword lines", () => {
    const run = buildFeatureRun([card({ text: "Sentinel", keywords: "Raid" })], EMPTY_TABLE, "test");
    expect(run.result.coverage.keywordFieldMismatchCards).toBe(1);
    expect(run.result.cards[0].keywordCheck.textNotInField).toEqual(["Sentinel"]);
  });
});

describe("curated table", () => {
  const CLAUSE = "Xyzzy plugh frobnicate.";

  it("applies to a clause the grammar leaves unclassified and records provenance", () => {
    const t = table([entry("cur-0001", "99990001", "text", CLAUSE)]);
    const run = buildFeatureRun([card({ text: CLAUSE })], t, "test");
    const clause = run.result.cards[0].faces.text?.[0];
    expect(clause && clause.kind === "ability" && clause.clauses[0]).toMatchObject({ source: "curated", curatedId: "cur-0001", residue: [] });
    expect(run.result.coverage).toMatchObject({ classifiedByCurated: 1, unclassified: 0 });
    expect(run.result.curated).toMatchObject({ applied: 1, stale: [], redundant: [] });
  });

  it("aborts on a clauseSha256 that does not hash sourceClause", () => {
    const bad = entry("cur-0001", "99990001", "text", CLAUSE, { clauseSha256: sha256Hex("something else") });
    expect(() => loadCuratedTable(table([bad]))).toThrow(CuratedTableError);
  });

  it("rejects a malformed table at the schema", () => {
    expect(() => loadCuratedTable(JSON.stringify({ schemaVersion: 2, tableVersion: 1, entries: [] }))).toThrow();
    expect(() => loadCuratedTable(table([entry("cur-0001", "1", "nope", CLAUSE)]))).toThrow();
  });

  it("rejects a duplicate key", () => {
    const e = entry("cur-0001", "99990001", "text", CLAUSE);
    expect(() => loadCuratedTable(table([e, { ...e, id: "cur-0002" }]))).toThrow(CuratedTableError);
  });

  it("reports an entry whose clause no longer exists as stale, and the run fails", () => {
    const t = table([entry("cur-0001", "99990001", "text", "This clause is gone.")]);
    const run = buildFeatureRun([card({ text: CLAUSE })], t, "test");
    expect(run.result.curated.stale).toEqual([`99990001|text|${sha256Hex("This clause is gone.")}`]);
    expect(() => assertNoStaleCurated(run)).toThrow(StaleCuratedEntriesError);
  });

  it("reports an entry for a clause the grammar now classifies as redundant, and keeps the grammar result", () => {
    const t = table([entry("cur-0001", "99990001", "text", "Draw a card.")]);
    const run = buildFeatureRun([card({ text: "Draw a card." })], t, "test");
    expect(run.result.curated.redundant).toHaveLength(1);
    expect(run.result.curated.stale).toEqual([]);
    const a = run.result.cards[0].faces.text?.[0];
    expect(a && a.kind === "ability" && a.clauses[0].source).toBe("grammar");
  });

  it("replaces grammar output when the entry sets override", () => {
    const e = entry("cur-0001", "99990001", "text", "Draw a card.", {
      override: true,
      features: { effects: [{ rule: "curated", cat: "recycle", n: 1 }], offers: [], wants: [] },
    });
    const run = buildFeatureRun([card({ text: "Draw a card." })], table([e]), "test");
    const a = run.result.cards[0].faces.text?.[0];
    const c = a && a.kind === "ability" ? a.clauses[0] : undefined;
    expect(c).toMatchObject({ source: "curated", curatedId: "cur-0001" });
    expect(c?.effects.map((x) => x.cat)).toEqual(["recycle"]);
  });

  it("does not let an effect category outside the known set through", () => {
    const e = entry("cur-0001", "99990001", "text", CLAUSE, { features: { effects: [{ rule: "curated", cat: "not_a_category" }] } });
    expect(() => loadCuratedTable(table([e]))).toThrow();
  });

  it("builds a fresh index per run so used flags do not leak", () => {
    const { index } = loadCuratedTable(table([entry("cur-0001", "99990001", "text", CLAUSE)]));
    extractFeatures([card({ text: CLAUSE }) as never], index);
    expect(curatedReport(index).applied).toBe(1);
  });
});

describe("committed curated table (data/swu/curated-rules.json)", () => {
  const text = readFileSync(CURATED_PATH, "utf8");
  const { table: parsed } = loadCuratedTable(text);

  it("parses, with every clauseSha256 the hash of its sourceClause", () => {
    expect(parsed.entries.length).toBeGreaterThan(0);
    for (const e of parsed.entries) expect(sha256Hex(e.sourceClause), e.id).toBe(e.clauseSha256);
  });

  it("has unique, ascending ids (a removed entry leaves a gap; ids are never renumbered)", () => {
    const ids = parsed.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());
    expect(ids.every((id) => /^cur-\d{4}$/.test(id))).toBe(true);
  });

  it("has unique (cardKey, face, clause) keys", () => {
    const keys = parsed.entries.map((e) => `${e.cardKey}|${e.face}|${e.clauseSha256}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("lists every newVocab note on an entry that carries a confidence or a rationale", () => {
    for (const e of parsed.entries) {
      expect(e.rationale.length, e.id).toBeGreaterThan(0);
      if (e.confidence !== undefined) expect(["high", "medium", "low"]).toContain(e.confidence);
    }
  });
});

describe("determinism", () => {
  const cards = [
    card({ cardKey: "99990002", title: "B", text: "On Attack: Deal 2 damage to an enemy unit. You may draw a card." }),
    card({ cardKey: "99990001", title: "A", type: "Event", text: "Heal 3 damage from a unit or base. Xyzzy plugh frobnicate." }),
    card({ cardKey: "99990003", title: "C", type: "Leader", deployBox: "Action [Exhaust]: Ready a Rebel unit.", epicAction: "Epic Action: Deploy this leader." }),
  ];

  it("gives byte-identical output for the same input, in any input order", () => {
    const a = buildFeatureRun(cards, EMPTY_TABLE, "c1");
    const b = buildFeatureRun([...cards].reverse(), EMPTY_TABLE, "c1");
    expect(b.files).toEqual(a.files);
    expect(b.replay).toEqual(a.replay);
  });

  it("changes the input hash when a read column changes, and not when an unread one does", () => {
    const base = buildFeatureRun(cards, EMPTY_TABLE, "c1").replay.inputHash;
    expect(buildFeatureRun(cards.map((c) => ({ ...c, unrelated: "x" })), EMPTY_TABLE, "c1").replay.inputHash).toBe(base);
    expect(buildFeatureRun(cards.map((c) => ({ ...c, text: `${String(c.text ?? "")} ` })), EMPTY_TABLE, "c1").replay.inputHash).not.toBe(base);
  });

  it("records the output hash of every file it wrote", () => {
    const run = buildFeatureRun(cards, EMPTY_TABLE, "c1");
    for (const [name, hash] of Object.entries(run.replay.outputHashes)) expect(sha256Hex(run.files[name])).toBe(hash);
    expect(Object.keys(run.replay.outputHashes).sort()).toEqual(["coverage.json", "features.json", "unclassified.json"]);
  });

  it("validates its own output against the schema (emitter gate)", () => {
    const run = buildFeatureRun(cards, EMPTY_TABLE, "c1");
    expect(run.result.cards).toHaveLength(3);
  });

  it("bans the seven non-deterministic calls in the grammar module and the script", () => {
    const dir = path.join(REPO_ROOT, "src/ability-grammar");
    const files = [
      ...readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => path.join(dir, f)),
      path.join(REPO_ROOT, "scripts/card-features.ts"),
      path.join(REPO_ROOT, "scripts/lib/raw-pages.ts"),
      path.join(REPO_ROOT, "scripts/lib/code-commit.ts"),
      path.join(REPO_ROOT, "scripts/lib/originals.ts"),
      path.join(REPO_ROOT, "src/scorer/rank.ts"),
    ];
    const banned = /Date\.now|new Date|Math\.random|localeCompare|Intl\.|toLocale|performance\.now/;
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"));
      expect(lines.filter((l) => banned.test(l)), file).toEqual([]);
    }
  });
});

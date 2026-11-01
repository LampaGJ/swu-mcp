import { decode } from "@toon-format/toon";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun, type CardRow, type CardStore } from "../../src/data.js";
import { aspectsEvidenceKey } from "../../src/meta/outcomes.js";
import { indexLeaderCards, SWUMETASTATS_SOURCE, type LeaderCardsFile, type WinRatesFile } from "../../src/meta/schema.js";
import { createSynergyContext } from "../../src/synergy/context.js";
import type { ScoreRow } from "../../src/scorer/scores-file.js";
import type { ToolResult } from "../../src/tools.js";
import { BUILD_DECK_TOOLS, buildDeck } from "../../src/tools/build-deck.js";
import { deckEnvOf, type DeckEnv } from "../../src/tools/deck.js";
import { swudbIdOf } from "../../src/tools/swudb.js";
import { COMMITTED_TABLE, mk } from "../synergy/fixtures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");

function body(result: ToolResult): Record<string, any> {
  expect(result.isError, result.content[0].text.slice(0, 400)).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

// ---------------------------------------------------------------------------------------------
// fixture package: one leader, two bases, staples, played cards, a measured-ok card, a measured-negative
// staple, a penalised staple, a rotated card, fillers and a token.

interface Spec {
  key: string;
  title: string;
  type?: string;
  cost?: number | null;
  icons?: string[];
  sets?: string;
  /** leaderInclusion and meanCopies in the leader's lists. */
  inc?: [number, number];
  play?: number;
}

const FILLERS: Spec[] = Array.from({ length: 12 }, (_, i) => ({
  key: `F${String(i + 1).padStart(2, "0")}`,
  title: `Filler ${i + 1}`,
  cost: (i % 6) + 1,
  icons: ["Cunning"],
  play: 2 - i * 0.1,
}));

const SPECS: Spec[] = [
  { key: "LW", title: "Test Warrior", type: "Leader", cost: 5, icons: ["Cunning", "Heroism"] },
  { key: "BO", title: "Tree Base", type: "Base", cost: null, icons: ["Command"] },
  { key: "BJ", title: "Sand Base", type: "Base", cost: null, icons: ["Aggression"] },
  { key: "S1", title: "Staple Two", cost: 2, icons: ["Cunning"], inc: [0.8, 2.4], play: 1 },
  { key: "S2", title: "Staple Three", cost: 3, icons: ["Heroism"], inc: [0.75, 2.2], play: 1 },
  { key: "S3", title: "Staple Five", cost: 5, icons: [], inc: [0.8, 2], play: 1 },
  { key: "P1", title: "Played One", cost: 1, icons: ["Cunning"], inc: [0.45, 1.3], play: 1 },
  { key: "P2", title: "Played One B", cost: 1, icons: ["Heroism"], inc: [0.4, 1.2], play: 1 },
  { key: "P3", title: "Played Two", cost: 2, icons: ["Command"], inc: [0.35, 0.9], play: 1 },
  { key: "P4", title: "Played Three", cost: 3, icons: ["Cunning"], inc: [0.3, 0.8], play: 1 },
  { key: "P5", title: "Played Four", cost: 4, icons: ["Heroism"], inc: [0.3, 0.6], play: 1 },
  { key: "P6", title: "Played Four B", cost: 4, icons: ["Cunning"], inc: [0.25, 0.5], play: 1 },
  { key: "P7", title: "Played Six", cost: 6, icons: ["Command"], inc: [0.2, 0.4], play: 1 },
  { key: "P8", title: "Played Three B", cost: 3, icons: ["Cunning", "Heroism"], inc: [0.2, 0.5], play: 1 },
  { key: "M1", title: "Measured Four", cost: 4, icons: ["Command"], inc: [0.03, 0.09], play: 1 },
  { key: "N1", title: "Negative Three", cost: 3, icons: ["Cunning"], inc: [0.55, 1.5], play: 3 },
  { key: "A1", title: "Penalised Two", cost: 2, icons: ["Aggression"], inc: [0.85, 2.5], play: 3 },
  { key: "RO", title: "Rotated Two", cost: 2, icons: [], sets: "SOR", inc: [0.5, 1.5], play: 3 },
  { key: "T1", title: "Spy Token", type: "Token Unit", cost: null, icons: [] },
  ...FILLERS,
];

const ORDER = new Map(SPECS.map((s, i) => [s.key, i + 1]));
const tst = (key: string): string => `TST_${String(ORDER.get(key)).padStart(3, "0")}`;

function leaderFile(): LeaderCardsFile {
  const cards = SPECS.filter((s) => s.inc !== undefined).map((s) => ({
    cardKey: s.key,
    title: s.title,
    inclusion: (s.inc as [number, number])[0],
    meanCopies: (s.inc as [number, number])[1],
    baselineInclusion: 0.1,
    lift: 0,
  }));
  return {
    schemaVersion: 1,
    window: { from: "2026-07-20", to: "2026-10-17", days: 90 },
    weighting: "test weighting",
    baseline: "test baseline",
    maxCards: 150,
    leaders: [
      {
        leader: { cardKey: "LW", title: "Test Warrior", aspects: ["Cunning", "Heroism"] },
        population: "community",
        fallback: true,
        decks: 18,
        weight: 18,
        window: { from: "2026-07-20", to: "2026-10-17" },
        topBase: { cardKey: "BJ", title: "Sand Base", decks: 15 },
        cards,
        baseDecks: [
          { cardKey: "BJ", title: "Sand Base", aspects: ["Aggression"], decks: 15 },
          { cardKey: "BO", title: "Tree Base", aspects: ["Command"], decks: 3 },
        ],
        splits: [],
      },
    ],
  };
}

function winrates(): WinRatesFile {
  return {
    schemaVersion: 2,
    minN: 20,
    matchups: null,
    deckEvidence: {
      source: SWUMETASTATS_SOURCE,
      label: "test evidence",
      basis: "test basis",
      opponents: "unknown",
      window: { from: "2026-07-20", to: "2026-10-17" },
      decks: 200,
      events: 10,
      matches: 2000,
      groups: [
        {
          level: "aspects",
          key: aspectsEvidenceKey(["Cunning", "Heroism", "Command"]),
          leader: null,
          baseAspects: null,
          aspects: ["Command", "Cunning", "Heroism"],
          decks: 200,
          wins: 1000,
          losses: 1000,
          draws: 0,
          cards: [
            { cardKey: "N1", decks: 40, wins: 150, losses: 250, draws: 0 },
            { cardKey: "M1", decks: 40, wins: 250, losses: 150, draws: 0 },
          ],
        },
      ],
    },
  };
}

function scoreRow(s: Spec): ScoreRow {
  return {
    cardKey: s.key,
    title: s.title,
    subtitle: null,
    type: s.type ?? "Unit",
    cost: s.cost ?? null,
    set: "SEC",
    scored: true,
    model: "unit",
    components: { expectedStats: null, statSurplus: 0, costTerm: 0, keywordPoints: 0, effectPoints: 0, modifiers: 0, playabilityT: 0, playabilityTStat: 0 },
    efficiency: null,
    total: s.play ?? null,
    playCalibrated: s.play ?? null,
    playCalibratedNoT: null,
    flags: [],
    unclassifiedClauses: 0,
    terms: [],
    percentile: { total: null, playCalibrated: null },
  };
}

function buildEnv(): DeckEnv {
  const pkg = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "swu-build-deck-"));
  mkdirSync(path.join(pkg, "meta"));
  writeFileSync(path.join(pkg, "meta", "winrates.json"), JSON.stringify(winrates()));
  const rows: CardRow[] = SPECS.map((s) => ({
    cardKey: s.key,
    title: s.title,
    subtitle: null,
    type: s.type ?? "Unit",
    cost: s.cost === undefined ? 2 : s.cost,
    power: s.type === undefined ? 2 : null,
    hp: null,
    aspects: (s.icons ?? []).join("|") || null,
    traits: null,
    keywords: null,
    arenas: null,
    text: null,
    sets: s.sets ?? "TST",
    rarity: "Common",
    firstSet: s.sets ?? "TST",
    expansion: s.sets ?? "TST",
    cardNumber: ORDER.get(s.key),
  }));
  const store: CardStore = {
    dataDir: pkg,
    cards: rows,
    byKey: new Map(rows.map((r) => [r.cardKey, r])),
    facets: new Map([
      [
        "expansion",
        [
          { value: "TST", cards: 0, definition: "Test Set. Main set 6. Premier legal as of 2026-10-07.", cardKeys: [] },
          { value: "SOR", cards: 0, definition: "Spark of Rebellion. Main set 1. Premier rotated it out.", cardKeys: [] },
        ],
      ],
    ]),
  };
  const synergy = SPECS.map((s) => mk(s.key, s.title, { type: s.type ?? "Unit", cost: s.cost, icons: s.icons ?? [], power: s.type === undefined ? 2 : undefined }));
  return {
    store,
    ctx: createSynergyContext(synergy, COMMITTED_TABLE),
    market: { prices: { priceImportId: 1, priceImportFinishedAt: "2026-10-16T00:00:00Z", coverage: "US", cards: [] }, play: { source: "t", note: "t", windows: [], cards: [] }, priceByKey: new Map(), playByKey: new Map() },
    scores: new Map(SPECS.filter((s) => s.play !== undefined).map((s) => [s.key, scoreRow(s)] as const)),
    clusters: null,
    dataVersion: "test/0",
    leaderCards: indexLeaderCards(leaderFile()),
  };
}

const env = buildEnv();
const build = (input: Record<string, unknown>): Record<string, any> => body(buildDeck(env, input));
const counts = (out: Record<string, any>): Map<string, number> => new Map(out.swudb.deck.map((e: { id: string; count: number }) => [e.id, e.count]));
const total = (out: Record<string, any>): number => out.swudb.deck.reduce((s: number, e: { count: number }) => s + e.count, 0);

describe("build_deck on fixtures (#186)", () => {
  it("builds exactly 50 cards, at most 3 copies each, legal, as a SWUDB document with set-code ids, status candidate", () => {
    const out = build({ leader: "LW", base: "BO" });
    expect(out.status).toBe("candidate");
    expect(total(out)).toBe(50);
    for (const e of out.swudb.deck) expect(e.count).toBeLessThanOrEqual(3);
    expect(out.swudb.leader).toEqual({ id: tst("LW"), count: 1 });
    expect(out.swudb.base).toEqual({ id: tst("BO"), count: 1 });
    for (const e of out.swudb.deck) expect(e.id).toMatch(/^TST_\d{3}$/);
    expect(out.legality.legal).toBe(true);
    expect(out.legality.counts.mainDeck).toBe(50);
    expect(out.penalty.total).toBe(0);
    for (const staple of ["S1", "S2", "S3"]) expect(counts(out).get(tst(staple)), staple).toBe(3);
  });

  it("gives every card an evidence line and is byte-identical across calls", () => {
    const a = buildDeck(env, { leader: "LW", base: "BO" });
    const b = buildDeck(env, { leader: "LW", base: "BO" });
    expect(a.content[0].text).toBe(b.content[0].text);
    const out = body(a);
    for (const c of out.cards) expect(typeof c.why === "string" && c.why.length > 0, c.cardKey).toBe(true);
    expect(out.cards.find((c: { cardKey: string }) => c.cardKey === "S1").why).toContain("80%");
    expect(out.cards.find((c: { cardKey: string }) => c.cardKey === "M1").why).toContain("+15.6 points");
  });

  it("leaves out a measured-negative card and says why, unless it is a must-include", () => {
    const out = build({ leader: "LW", base: "BO" });
    expect(counts(out).has(tst("N1"))).toBe(false);
    const left = out.leftOut.find((r: { cardKey: string }) => r.cardKey === "N1");
    expect(left.reason).toContain("negative");
    const forced = build({ leader: "LW", base: "BO", mustInclude: [{ card: "N1", count: 2 }] });
    expect(counts(forced).get(tst("N1"))).toBe(2);
    expect(forced.cards.find((c: { cardKey: string }) => c.cardKey === "N1").why).toMatch(/^must-include.*negative/);
    expect(total(forced)).toBe(50);
  });

  it("takes a penalised card only as a must-include and states the penalty", () => {
    const out = build({ leader: "LW", base: "BO" });
    expect(counts(out).has(tst("A1"))).toBe(false);
    expect(out.leftOut.find((r: { cardKey: string }) => r.cardKey === "A1").reason).toContain("+2");
    const forced = build({ leader: "LW", base: "BO", mustInclude: [{ card: "Penalised Two", count: 2 }] });
    expect(counts(forced).get(tst("A1"))).toBe(2);
    expect(forced.penalty.total).toBe(4);
    expect(forced.cards.find((c: { cardKey: string }) => c.cardKey === "A1").why).toContain("aspect penalty +2 each");
  });

  it("never picks a rotated card or a token", () => {
    const out = build({ leader: "LW", base: "BO" });
    expect(counts(out).has(tst("RO"))).toBe(false);
    expect(counts(out).has(tst("T1"))).toBe(false);
  });

  it("honours the sideboard exactly and checks it with the deck", () => {
    const out = build({ leader: "LW", base: "BO", sideboard: [{ card: "F01", count: 2 }] });
    expect(out.swudb.sideboard).toEqual([{ id: tst("F01"), count: 2 }]);
    expect(out.legality.counts.sideboard).toBe(2);
    expect(total(out)).toBe(50);
    const big = build({ leader: "LW", base: "BO", sideboard: [{ card: "F01", count: 3 }, { card: "F02", count: 3 }, { card: "F03", count: 3 }, { card: "F04", count: 2 }] });
    expect(big.legality.legal).toBe(false);
  });

  it("defaults the base to the one most of the leader's lists run and reports the runner-up", () => {
    const out = build({ leader: "LW" });
    expect(out.base.cardKey).toBe("BJ");
    expect(out.base.chosenBy).toContain("15 of 18");
    expect(out.baseRunnerUp.cardKey).toBe("BO");
    expect(build({ leader: "LW", base: "BO" }).baseRunnerUp).toBeNull();
  });

  it("honours exclude, and rejects a must-include over 3 copies or one that is also excluded", () => {
    const out = build({ leader: "LW", base: "BO", exclude: ["S1"] });
    expect(counts(out).has(tst("S1"))).toBe(false);
    expect(total(out)).toBe(50);
    expect(buildDeck(env, { leader: "LW", base: "BO", mustInclude: [{ card: "S1", count: 4 }] }).isError).toBe(true);
    expect(buildDeck(env, { leader: "LW", base: "BO", mustInclude: [{ card: "S1", count: 2 }], exclude: ["S1"] }).isError).toBe(true);
  });

  it("lists swaps against a starting list, and starting list plus swaps gives the result", () => {
    const start = [
      { card: "N1", count: 3 },
      { card: "S1", count: 3 },
      { card: "F12", count: 3 },
    ];
    const out = build({ leader: "LW", base: "BO", decklist: start });
    const after = new Map<string, number>([[tst("N1"), 3], [tst("S1"), 3], [tst("F12"), 3]]);
    for (const s of out.swaps.in) after.set(s.id, (after.get(s.id) ?? 0) + s.count);
    for (const s of out.swaps.out) after.set(s.id, (after.get(s.id) ?? 0) - s.count);
    for (const [id, n] of [...after]) if (n === 0) after.delete(id);
    expect(after).toEqual(counts(out));
    expect(out.swaps.out.find((s: { id: string }) => s.id === tst("N1")).why).toContain("negative");
  });

  it("takes the starting list as a swudb document and keeps its sideboard when no sideboard is given", () => {
    const swudb = { metadata: { name: "Start" }, leader: { id: tst("LW"), count: 1 }, base: { id: tst("BO"), count: 1 }, deck: [{ id: tst("S1"), count: 3 }], sideboard: [{ id: tst("F02"), count: 1 }] };
    const out = build({ swudb });
    expect(out.leader.cardKey).toBe("LW");
    expect(out.base.cardKey).toBe("BO");
    expect(out.swudb.sideboard).toEqual([{ id: tst("F02"), count: 1 }]);
    expect(build({ swudb, sideboard: [{ card: "F03", count: 2 }] }).swudb.sideboard).toEqual([{ id: tst("F03"), count: 2 }]);
  });

  it("names each evidence population on its own and never pools them (D21)", () => {
    const out = build({ leader: "LW", base: "BO" });
    expect(out.populations.leaderLists).toContain("community");
    expect(out.populations.leaderLists).toContain("18 decks");
    expect(out.populations.measured).toContain("swumetastats");
    expect(out.populations.simulated).toContain("not used");
  });

  it("returns the deck_audit headline and the curve against the caps", () => {
    const out = build({ leader: "LW", base: "BO" });
    expect(out.audit.penalty).toBe(0);
    expect(typeof out.curve.byCost).toBe("string");
    expect(out.curve.byCost).toMatch(/^1:\d+/);
  });

  it("is registered with a strict input shape", () => {
    expect(BUILD_DECK_TOOLS.build_deck.title).toBe("Build a deck");
    expect(buildDeck(env, { leader: "LW", base: "BO", bogus: 1 }).isError).toBe(true);
    expect(buildDeck(env, {}).isError).toBe(true);
  });

  it("maps a card row to its own SET_NNN printing", () => {
    expect(swudbIdOf(env.store.byKey.get("S1") as CardRow)).toBe(tst("S1"));
  });
});

// ---------------------------------------------------------------------------------------------
// the built data: The Warrior on Origin Tree against the hand-built most-valuable list

const builtRun = newestRun(path.join(REPO_ROOT, "data/runs"));
const hasData = builtRun !== undefined && existsSync(path.join(builtRun, "llm/cards.toon")) && existsSync(path.join(builtRun, "meta/leader-cards.json"));
const HAND_BUILT = JSON.parse(readFileSync(path.join(HERE, "../fixtures/decks/warrior-most-valuable.swudb.json"), "utf8")) as { deck: { id: string; count: number }[] };

describe.skipIf(!hasData)("build_deck on the built data: The Warrior on Origin Tree (#186)", () => {
  const real = hasData ? loadStore(builtRun as string) : (undefined as never);
  const out = hasData ? body(buildDeck(deckEnvOf(real), { leader: "09010018", base: "09010024", sideboard: [{ card: "LOF_213", count: 2 }] })) : ({} as Record<string, any>);

  it("is legal, 50 cards, penalty 0, with the 2x The Legacy Run sideboard exactly", () => {
    expect(out.legality.legal).toBe(true);
    expect(total(out)).toBe(50);
    expect(out.penalty.total).toBe(0);
    expect(out.swudb.sideboard).toEqual([{ id: "LOF_213", count: 2 }]);
    expect(out.swudb.leader).toEqual({ id: "HMW_018", count: 1 });
    expect(out.swudb.base).toEqual({ id: "HMW_024", count: 1 });
  });

  it("overlaps the hand-built most-valuable list on at least 60% of its copies", () => {
    const ours = counts(out);
    const shared = HAND_BUILT.deck.reduce((s, e) => s + Math.min(e.count, ours.get(e.id) ?? 0), 0);
    expect(shared / 50).toBeGreaterThanOrEqual(0.6);
  });

  it("keeps the leader-engine staples and the Chewbacca package whole", () => {
    const ours = counts(out);
    for (const id of ["HMW_212", "HMW_225", "HMW_224"]) expect(ours.get(id), id).toBe(3);
    for (const id of ["ASH_248", "HMW_127", "HMW_117"]) expect(ours.has(id), id).toBe(true);
    expect(out.packages.some((p: { cardKeys: string }) => ["08010248", "09010127", "09010117"].every((k) => p.cardKeys.includes(k)))).toBe(true);
  });

  it("auto-picks no measured-negative card (Lightmaker, The Legacy Run stay out of the deck)", () => {
    const ours = counts(out);
    expect(ours.has("SEC_207")).toBe(false);
    expect(ours.has("LOF_213")).toBe(false);
    for (const c of out.cards) expect(c.why, c.title).not.toContain("measured negative");
  });
});

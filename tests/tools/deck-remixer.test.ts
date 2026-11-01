import { decode } from "@toon-format/toon";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CardRow, CardStore } from "../../src/data.js";
import { buildDeckIndex, type RawIndexDeck } from "../../src/meta/deck-index.js";
import { analyseSleepers, DEFAULT_SLEEPER_OPTIONS } from "../../src/meta/sleepers.js";
import { sleepersFileSchema } from "../../src/meta/sleepers-schema.js";
import { createSynergyContext } from "../../src/synergy/context.js";
import type { ToolResult } from "../../src/tools.js";
import { DECK_REMIXER_TOOLS, deckRemixer } from "../../src/tools/deck-remixer.js";
import type { DeckEnv } from "../../src/tools/deck.js";
import { fixture } from "../meta/sleeper-fixtures.js";
import { COMMITTED_TABLE, mk } from "../synergy/fixtures.js";

function body(result: ToolResult): Record<string, any> {
  expect(result.isError, result.content[0].text.slice(0, 600)).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

// ---------------------------------------------------------------------------------------------
// fixture package: three leaders, three bases, 30 deck cards, popular cards of each tier, a penalised and a rotated popular card,
// sleeper cards (one legal, one of the wrong aspect, one rotated), a tournament index and a community index.

interface Spec {
  key: string;
  title: string;
  type?: string;
  cost?: number | null;
  icons?: string[];
  sets?: string;
}
const ASPECTS = [["Cunning"], ["Heroism"], ["Command"]];
const DECK_KEYS = Array.from({ length: 30 }, (_, i) => `D${String(i + 1).padStart(2, "0")}`);
const SPECS: Spec[] = [
  { key: "LW", title: "Test Warrior", type: "Leader", cost: 5, icons: ["Cunning", "Heroism"] },
  { key: "LX", title: "Test Twin", type: "Leader", cost: 5, icons: ["Cunning", "Heroism"] },
  { key: "LV", title: "Test Villain", type: "Leader", cost: 5, icons: ["Aggression", "Villainy"] },
  { key: "BO", title: "Tree Base", type: "Base", cost: null, icons: ["Command"] },
  { key: "BC", title: "Cave Base", type: "Base", cost: null, icons: ["Command"] },
  { key: "BJ", title: "Sand Base", type: "Base", cost: null, icons: ["Aggression"] },
  ...DECK_KEYS.map((key, i) => ({ key, title: `Deck Card ${i + 1}`, cost: (i % 6) + 1, icons: ASPECTS[i % 3] })),
  { key: "PT1", title: "Popular Tournament One", cost: 3, icons: ["Cunning"] },
  { key: "PT2", title: "Popular Tournament Two", cost: 2, icons: ["Heroism"] },
  { key: "PC1", title: "Popular Community One", cost: 4, icons: ["Command"] },
  { key: "PA", title: "Popular Penalised", cost: 2, icons: ["Aggression"] },
  { key: "PR", title: "Popular Rotated", cost: 2, icons: [], sets: "SOR" },
  { key: "SL1", title: "Sleeper Legal", cost: 4, icons: ["Command"] },
  { key: "SLA", title: "Sleeper Wrong Aspect", cost: 4, icons: ["Aggression"] },
  { key: "SLR", title: "Sleeper Rotated", cost: 4, icons: [], sets: "SOR" },
  { key: "N01", title: "Neutral One", cost: 1, icons: [] },
];
const ORDER = new Map(SPECS.map((s, i) => [s.key, i + 1]));
const tst = (key: string): string => `TST_${String(ORDER.get(key)).padStart(3, "0")}`;

const TARGET_CARDS: [string, number][] = DECK_KEYS.map((key, i) => [key, i < 20 ? 2 : 1]);
const TARGET = TARGET_CARDS.map(([card, count]) => ({ card, count }));
const SORTED_ASPECTS = ["Command", "Cunning", "Heroism"];

function tournamentDecks(): RawIndexDeck[] {
  return Array.from({ length: 10 }, (_, j) => {
    const dropped = new Set([DECK_KEYS[j % 30], DECK_KEYS[(j + 7) % 30]]);
    const cards = new Map<string, number>(TARGET_CARDS.filter(([k]) => !dropped.has(k)));
    const hasPt1 = j < 8;
    if (hasPt1) cards.set("PT1", 3);
    if (j % 2 === 0) cards.set("PT2", 2);
    cards.set("PA", 3);
    if (j < 7) cards.set("PR", 2);
    return {
      leader: "LW",
      base: "BO",
      aspects: SORTED_ASPECTS,
      event: `swumetastats:${100 + (j % 4)}`,
      date: `2026-09-${String(10 + j).padStart(2, "0")}`,
      record: hasPt1 ? "5-2-0" : "3-4-0",
      placement: j + 1,
      cards: [...cards],
    };
  });
}

function communityDecks(): RawIndexDeck[] {
  const make = (j: number, leader: string, base: string): RawIndexDeck => {
    const cards = new Map<string, number>(TARGET_CARDS.filter(([k]) => k !== DECK_KEYS[j % 30]));
    if (j < 6) cards.set("PC1", 2);
    return {
      leader,
      base,
      aspects: leader === "LV" ? ["Aggression", "Aggression", "Villainy"] : SORTED_ASPECTS,
      event: null,
      date: "2026-10-10",
      record: null,
      placement: null,
      cards: [...cards],
    };
  };
  return [
    ...[0, 1, 2].map((j) => make(j, "LW", "BO")),
    ...[3, 4, 5, 6, 7].map((j) => make(j, "LW", "BC")),
    ...[0, 1, 2, 3, 4, 5].map((j) => make(j, "LV", "BJ")),
  ];
}

function sleepersJson(): unknown {
  const decks = fixture(
    {
      SL1: { boost: 0.12, rate: 0.25 },
      SLA: { boost: 0.12, rate: 0.25 },
      SLR: { boost: 0.12, rate: 0.25 },
      N01: { rate: 0.5 },
      PT1: { rate: 0.3 },
    },
    "remix",
    60,
    40,
    400,
    ["LW"],
  ).map((d) => ({
    ...d,
    baseAspects: ["Command"],
    aspects: SORTED_ASPECTS,
  }));
  const analysis = analyseSleepers(decks, {
    ...DEFAULT_SLEEPER_OPTIONS,
    replicates: 100,
    nullReplicates: 50,
    cardInfo: (k) => ({ title: `title ${k}`, rotated: k === "SLR" }),
  });
  return sleepersFileSchema.parse({
    schemaVersion: 1,
    source: "swumetastats.com",
    population: "tournament decklists with their whole-event match record",
    precedence: "D21 tier 1",
    window: { from: "2026-01-01", to: "2026-03-01" },
    periods: [{ label: "P1", from: "2026-01-01", to: "2026-03-01", decks: analysis.counts.decks, events: analysis.counts.events }],
    counts: analysis.counts,
    method: {
      unit: "u",
      outcome: "o",
      comparison: "c",
      interval: "i",
      coverage: 0.95,
      test: "t",
      fdr: "f",
      q: 0.1,
      replicates: 100,
      seed: "s",
      minDecks: 20,
      minEvents: 5,
      minTierDecks: 10,
      minPlayers: 10,
      skill: { definition: "d", ...analysis.skill },
      nullCheck: analysis.nullCheck,
      verdicts: "v",
    },
    global: analysis.global,
    aspects: analysis.aspects,
    archetypes: analysis.archetypes,
    simulator: null,
  });
}

function buildEnv(withTournament = true): DeckEnv {
  const pkg = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "swu-remixer-"));
  mkdirSync(path.join(pkg, "deck-index"));
  mkdirSync(path.join(pkg, "sleepers"));
  const tiers = [
    ...(withTournament
      ? [
          {
            tier: "tournament" as const,
            source: "swumetastats.com",
            population: "tournament decklists with their whole-event match record (melee.gg Premier events via swumetastats.com)",
            capture: "swumetastats-decklists 2026-11-01",
            decks: tournamentDecks(),
          },
        ]
      : []),
    {
      tier: "community" as const,
      source: "swudb.com",
      population: "community decklists (SWUDB)",
      capture: "decks snapshot 2026-10-17",
      decks: communityDecks(),
    },
  ];
  writeFileSync(path.join(pkg, "deck-index", "decks.json"), `${JSON.stringify(buildDeckIndex(tiers))}\n`);
  writeFileSync(path.join(pkg, "sleepers", "sleepers.json"), `${JSON.stringify(sleepersJson())}\n`);
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
  const synergy = SPECS.map((s) =>
    mk(s.key, s.title, { type: s.type ?? "Unit", cost: s.cost, icons: s.icons ?? [], power: s.type === undefined ? 2 : undefined }),
  );
  return {
    store,
    ctx: createSynergyContext(synergy, COMMITTED_TABLE),
    market: {
      prices: { priceImportId: 1, priceImportFinishedAt: "2026-10-16T00:00:00Z", coverage: "US", cards: [] },
      play: { source: "t", note: "t", windows: [], cards: [] },
      priceByKey: new Map(),
      playByKey: new Map(),
    },
    scores: new Map(),
    clusters: null,
    dataVersion: "test/0",
    leaderCards: null,
  };
}

const env = buildEnv();
const remix = (input: Record<string, unknown>, e: DeckEnv = env): Record<string, any> =>
  body(deckRemixer(e, { decklist: TARGET, leader: "LW", base: "BO", ...input }));
const total = (out: Record<string, any>): number => out.swudb.deck.reduce((s: number, e: { count: number }) => s + e.count, 0);
const tierOf = (out: Record<string, any>, tier: string): Record<string, any> => out.tiers.find((t: { tier: string }) => t.tier === tier);

describe("deck_remixer on fixtures (#193)", () => {
  it("is registered with a strict input that rejects an unknown field", () => {
    expect(Object.keys(DECK_REMIXER_TOOLS)).toEqual(["deck_remixer"]);
    const result = deckRemixer(env, { decklist: TARGET, leader: "LW", base: "BO", player: "someone" });
    expect(result.isError).toBe(true);
  });

  it("reports each tier on its own, never pooled: tournament and community neighbours, counts and cards stay apart", () => {
    const out = remix({});
    expect(out.status).toBe("candidate");
    const t = tierOf(out, "tournament");
    const c = tierOf(out, "community");
    expect(t.neighbours.used).toBe(10);
    expect(c.neighbours.used).toBe(8);
    const tournamentCards = t.popular.map((r: { cardKey: string }) => r.cardKey);
    const communityCards = c.popular.map((r: { cardKey: string }) => r.cardKey);
    expect(tournamentCards).toEqual(expect.arrayContaining(["PT1", "PT2"]));
    expect(tournamentCards).not.toContain("PC1");
    expect(communityCards).toEqual(["PC1"]);
    const pt1 = t.popular.find((r: { cardKey: string }) => r.cardKey === "PT1");
    expect(pt1).toMatchObject({ decksWith: 8, of: 10, copies: 3 });
    expect(pt1.record.with).toMatchObject({ decks: 8, wins: 40, losses: 16 });
    expect(pt1.record.without).toMatchObject({ decks: 2, wins: 6, losses: 8 });
    expect(c.popular[0].decksWith).toBe(6);
    expect(c.popular[0].record).toBeUndefined();
    expect(t.population).toContain("swumetastats");
    expect(c.population).toContain("community");
  });

  it("leaves out a popular card that pays an aspect penalty or is rotated out, and counts what it left out", () => {
    const t = tierOf(remix({}), "tournament");
    const cards = t.popular.map((r: { cardKey: string }) => r.cardKey);
    expect(cards).not.toContain("PA");
    expect(cards).not.toContain("PR");
    expect(t.skipped).toMatchObject({ penalised: 1, notLegal: 1 });
  });

  it("states a widening in the output when the decks of this leader and base are too few", () => {
    const c = tierOf(remix({}), "community");
    expect(c.neighbours.reach).toBe("leader");
    expect(c.neighbours.widening.join(" ")).toContain("same leader");
    const t = tierOf(remix({}), "tournament");
    expect(t.neighbours.widening).toEqual([]);
    const twin = tierOf(remix({ leader: "LX" }), "tournament");
    expect(twin.neighbours.reach).toBe("aspects");
    expect(twin.neighbours.widening.join(" ")).toContain("same aspects");
    expect(twin.neighbours.used).toBe(10);
  });

  it("says plainly that a tier has no deck for this leader, base or aspects, and falls back to the community tier", () => {
    const out = remix({ leader: "LV", base: "BJ" });
    const t = tierOf(out, "tournament");
    expect(t.neighbours.used).toBe(0);
    expect(t.note).toMatch(/no tournament deck/);
    expect(out.applied.tier).toBe("community");
    expect(tierOf(out, "community").neighbours.reach).toBe("leader+base");
  });

  it("offers sleeper cards that are legal for the deck's aspects: not the wrong aspect, not a rotated card", () => {
    const out = remix({});
    const keys = out.sleepers.cards.map((r: { cardKey: string }) => r.cardKey);
    expect(keys).toContain("SL1");
    expect(keys).not.toContain("SLA");
    expect(keys).not.toContain("SLR");
    expect(out.sleepers.scope).toBeTypeOf("object");
    const sl1 = out.sleepers.cards.find((r: { cardKey: string }) => r.cardKey === "SL1");
    expect(sl1.status).toBe("candidate");
    expect(sl1).toHaveProperty("rangePts");
    expect(["held for the same players", "not shown by the same players", "not measured"]).toContain(sl1.samePlayer);
  });

  it("keeps 50 cards, at most 3 copies each and a legal list; each cut is from the deck and the counts match", () => {
    const out = remix({});
    expect(total(out)).toBe(50);
    for (const e of out.swudb.deck) expect(e.count).toBeLessThanOrEqual(3);
    expect(out.legality.legal).toBe(true);
    expect(out.legality.counts.mainDeck).toBe(50);
    expect(out.swaps.length).toBeGreaterThan(0);
    const inCopies = out.swaps.reduce((s: number, w: { in: { count: number } }) => s + w.in.count, 0);
    const outCopies = out.swaps.reduce((s: number, w: { out: { count: number }[] }) => s + w.out.reduce((a, o) => a + o.count, 0), 0);
    expect(inCopies).toBe(outCopies);
    const held = new Map(TARGET_CARDS);
    for (const w of out.swaps) for (const o of w.out) expect(held.has(o.cardKey), o.cardKey).toBe(true);
    for (const w of out.swaps) expect(typeof w.why === "string" && w.why.length > 0).toBe(true);
  });

  it("cuts the cards rarest among the nearest decks first, matched by type and cost", () => {
    const out = remix({ swaps: 1, sleepers: 0 });
    expect(out.swaps).toHaveLength(1);
    expect(out.swaps[0].in.cardKey).toBe("PT1");
    expect(["D08", "D09", "D10"]).toContain(out.swaps[0].out[0].cardKey);
  });

  it("never cuts a card named in keep", () => {
    const out = remix({ swaps: 1, sleepers: 0, keep: ["D08", "D09", "D10"] });
    expect(["D08", "D09", "D10"]).not.toContain(out.swaps[0].out[0].cardKey);
  });

  it("is byte-identical across calls", () => {
    const a = deckRemixer(env, { decklist: TARGET, leader: "LW", base: "BO" });
    const b = deckRemixer(env, { decklist: TARGET, leader: "LW", base: "BO" });
    expect(a.content[0].text).toBe(b.content[0].text);
  });

  it("takes the SWUDB document in place of decklist, leader and base and returns one with set-code ids", () => {
    const swudb = {
      leader: { id: tst("LW"), count: 1 },
      base: { id: tst("BO"), count: 1 },
      deck: TARGET_CARDS.map(([k, n]) => ({ id: tst(k), count: n })),
      sideboard: [{ id: tst("N01"), count: 2 }],
    };
    const out = body(deckRemixer(env, { swudb }));
    expect(out.swudb.leader).toEqual({ id: tst("LW"), count: 1 });
    for (const e of out.swudb.deck) expect(e.id).toMatch(/^TST_\d{3}$/);
    expect(out.swudb.sideboard).toEqual([{ id: tst("N01"), count: 2 }]);
    expect(total(out)).toBe(50);
  });

  it("names the data step to run when the package holds no deck index", () => {
    const bare = buildEnv();
    const pkg = bare.store.dataDir;
    const empty: DeckEnv = { ...bare, store: { ...bare.store, dataDir: path.join(pkg, "nowhere") } };
    const result = deckRemixer(empty, { decklist: TARGET, leader: "LW", base: "BO" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("deck-index");
  });
});

import { decode } from "@toon-format/toon";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { MissingDataError, loadStore, newestRun, type CardRow, type CardStore } from "../src/data.js";
import { membersSha256 } from "../src/embed/cluster-labels.js";
import type { ClustersFile } from "../src/embed/files.js";
import type { PlayFile, PricesFile } from "../src/market/build.js";
import { rulesFor } from "../src/rules/store.js";
import type { ScoreRow } from "../src/scorer/scores-file.js";
import { indexLeaderCards, type LeaderCardsFile } from "../src/meta/schema.js";
import { createSynergyContext } from "../src/synergy/context.js";
import type { ToolResult } from "../src/tools.js";
import {
  DECK_TOOLS,
  budgetAlternatives,
  deckAudit,
  deckEnvOf,
  deckLegalityCheck,
  fungibleInDeck,
  inPremierPool,
  leaderCardsOf,
  ownedVsNeeded,
  playValueVsPrice,
  playableCards,
  priceList,
  resolveRef,
  scoreVsPlay,
  suggestLeaderBase,
  tradeBalance,
  type DeckEnv,
} from "../src/tools/deck.js";
import { COMMITTED_TABLE, mk } from "./synergy/fixtures.js";

const rulesMode = vi.hoisted(() => ({ value: "real" as "real" | "missing" | "corrupt" }));

vi.mock("../src/rules/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/rules/store.js")>();
  const { MissingDataError: Missing } = await import("../src/data.js");
  return {
    ...actual,
    rulesFor: (dataDir: string) => {
      if (rulesMode.value === "missing") throw new Missing("no rules data");
      if (rulesMode.value === "corrupt") throw new SyntaxError("Unexpected token in sections.json");
      return actual.rulesFor(dataDir);
    },
  };
});

interface Spec {
  key: string;
  title: string;
  subtitle?: string;
  type?: string;
  cost?: number | null;
  icons?: string[];
  sets?: string;
  rarity?: string;
  text?: string;
  offers?: string[];
  wants?: string[];
  /** Printed keywords as structured.keywordsField carries them. */
  keywords?: string[];
  /** Tag -> the clause text behind it. */
  why?: Record<string, string>;
  price?: { normal: number | null; foil?: number | null; printings?: number[] };
  play?: { included: number; wins?: number };
  score?: { total: number | null; play: number | null; expectedStats?: number };
}

const WINDOW = "w0-55";
const PLAYER_GAMES = 100_000;

const DEFINITIONS: [string, string][] = [
  ["SEC", "Secrets of Power. Main set 6. Premier legal as of 2026-10-07."],
  ["SOR", "Spark of Rebellion. Main set 1. Premier rotated it out."],
  ["PRO", "2025 Promo: a promo or product expansion, not one of the nine main sets."],
];

const FILLERS: Spec[] = Array.from({ length: 17 }, (_, i) => ({
  key: `F${String(i + 1).padStart(2, "0")}`,
  title: `Filler ${i + 1}`,
  cost: 2,
}));

const SPECS: Spec[] = [
  { key: "L1", title: "Aggro Leader", subtitle: "The Hunter", type: "Leader", cost: 6, icons: ["Aggression", "Villainy"] },
  { key: "L2", title: "Green Leader", subtitle: "The Gardener", type: "Leader", cost: 5, icons: ["Command", "Heroism"] },
  { key: "BC", title: "Command Base", type: "Base", cost: null, icons: ["Command"] },
  { key: "BV", title: "Vigilance Base", type: "Base", cost: null, icons: ["Vigilance"] },
  { key: "BS", title: "Small Base", type: "Base", cost: null, icons: [], text: "Your minimum deck size is decreased by 5 cards." },
  { key: "BT1", title: "Twin Base", type: "Base", cost: null, icons: ["Command"] },
  { key: "BT2", title: "Twin Base", type: "Base", cost: null, icons: ["Vigilance"] },
  {
    key: "P1",
    title: "Pinger Red",
    cost: 3,
    icons: ["Aggression"],
    rarity: "Rare",
    offers: ["offers:damage-friendly-unit"],
    price: { normal: 1, printings: [1, 0.8] },
    play: { included: 5000, wins: 2600 },
    score: { total: 3, play: 2, expectedStats: 6 },
  },
  {
    key: "P2",
    title: "Pinger Green",
    cost: 3,
    icons: ["Command"],
    offers: ["offers:damage-friendly-unit"],
    price: { normal: 0.3, printings: [0.3] },
    play: { included: 3000, wins: 1500 },
    score: { total: 2, play: 1, expectedStats: 6 },
  },
  {
    key: "P3",
    title: "Pinger Blue",
    cost: 3,
    icons: ["Vigilance"],
    offers: ["offers:damage-friendly-unit"],
    price: { normal: 0.8, printings: [0.8] },
    play: { included: 50 },
    score: { total: 1, play: 0.5, expectedStats: 6 },
  },
  { key: "W1", title: "Grit Brute", cost: 3, icons: ["Aggression"], wants: ["wants:self-damaged"] },
  { key: "R1", title: "Old Guard", cost: 2, icons: [], sets: "SOR" },
  { key: "PR1", title: "Promo Only", cost: 2, icons: [], sets: "PRO" },
  { key: "T1", title: "Spy Token", type: "Token Unit", cost: null, icons: [] },
  ...FILLERS,
];

function buildEnv(specs: readonly Spec[] = SPECS, clusters: ClustersFile | null = null): DeckEnv {
  const rows: CardRow[] = specs.map((s) => ({
    cardKey: s.key,
    title: s.title,
    subtitle: s.subtitle ?? null,
    type: s.type ?? "Unit",
    cost: s.cost === undefined ? 2 : s.cost,
    power: null,
    hp: null,
    aspects: (s.icons ?? []).join("|") || null,
    traits: null,
    keywords: null,
    arenas: null,
    text: s.text ?? null,
    sets: s.sets ?? "SEC",
    rarity: s.rarity ?? "Common",
    firstSet: s.sets ?? "SEC",
  }));
  const store: CardStore = {
    dataDir: "/nonexistent/swu-deck-tools",
    cards: rows,
    byKey: new Map(rows.map((r) => [r.cardKey, r])),
    facets: new Map([["expansion", DEFINITIONS.map(([value, definition]) => ({ value, cards: 0, definition, cardKeys: [] }))]]),
  };
  const synergy = specs.map((s) =>
    mk(s.key, s.title, {
      type: s.type ?? "Unit",
      cost: s.cost,
      icons: s.icons ?? [],
      subtitle: s.subtitle ?? null,
      offers: s.offers,
      wants: s.wants,
      keywords: s.keywords,
      why: s.why,
    }),
  );
  const priced = specs.filter((s) => s.price !== undefined);
  const prices: PricesFile = {
    priceImportId: 1,
    priceImportFinishedAt: "2026-10-16T00:00:00Z",
    coverage: "US market only",
    cards: priced.map((s) => ({
      cardKey: s.key,
      normal: (s.price as NonNullable<Spec["price"]>).normal,
      foil: s.price?.foil ?? null,
      printings: (s.price?.printings ?? [s.price?.normal ?? 0]).map((normal, i) => ({
        cardId: `${s.key}-${i}`,
        variant: i === 0 ? "standard" : "hyperspace",
        productId: i,
        normal,
        foil: null,
        priceSource: null,
        conformance: null,
      })),
    })),
  };
  const played = specs.filter((s) => s.play !== undefined);
  const play: PlayFile = {
    source: "test capture",
    note: "test play note",
    windows: [
      {
        id: WINDOW,
        startWeek: 0,
        endWeek: 55,
        startDate: "2025-09-20",
        endDate: "2026-10-16",
        sha256: "0".repeat(64),
        playerGames: PLAYER_GAMES,
      },
    ],
    cards: played.map((s) => ({ cardKey: s.key, byWindow: { [WINDOW]: { included: s.play?.included ?? 0, wins: s.play?.wins ?? 0 } } })),
  };
  const scores = new Map<string, ScoreRow>(specs.filter((s) => s.score !== undefined).map((s) => [s.key, scoreRow(s)] as const));
  return {
    store,
    ctx: createSynergyContext(synergy, COMMITTED_TABLE),
    market: {
      prices,
      play,
      priceByKey: new Map(prices.cards.map((c) => [c.cardKey, c])),
      playByKey: new Map(play.cards.map((c) => [c.cardKey, c])),
    },
    scores,
    clusters,
    dataVersion: "test/0",
  };
}

function scoreRow(s: Spec): ScoreRow {
  const score = s.score as NonNullable<Spec["score"]>;
  return {
    cardKey: s.key,
    title: s.title,
    subtitle: s.subtitle ?? null,
    type: s.type ?? "Unit",
    cost: s.cost ?? null,
    set: "SEC",
    scored: true,
    model: "unit",
    components: {
      expectedStats: score.expectedStats ?? null,
      statSurplus: 0.5,
      costTerm: 0,
      keywordPoints: 0,
      effectPoints: 0,
      modifiers: 0,
      playabilityT: 0,
      playabilityTStat: 0,
    },
    efficiency: null,
    total: score.total,
    playCalibrated: score.play,
    playCalibratedNoT: null,
    flags: [],
    unclassifiedClauses: 0,
    terms: [],
    percentile: { total: null, playCalibrated: null },
  };
}

function body(result: ToolResult): Record<string, any> {
  expect(result.isError, result.content[0].text).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

const lines = (...entries: [string, number][]) => entries.map(([card, count]) => ({ card, count }));
const fillerDeck = (distinct: number, copies = 3) =>
  Array.from({ length: distinct }, (_, i) => ({ card: `F${String(i + 1).padStart(2, "0")}`, count: copies }));

const env = buildEnv();

describe("name resolution", () => {
  it("resolves cardKeys, titles in any case and 'Title, Subtitle' forms, and lists what it cannot resolve", () => {
    const out = body(
      deckAudit(env, {
        decklist: lines(["pinger red", 2], ["P1", 1], ["Nobody Home", 1], ["Aggro Leader", 1], ["Twin Base", 1]),
        leader: "aggro leader - the hunter",
        base: "Command Base",
      }),
    );
    expect(out.leader.cardKey).toBe("L1");
    expect(out.deck.cards).toBe(3);
    expect(out.deck.distinct).toBe(1);
    const reasons = Object.fromEntries(out.unresolved.map((u: { card: string; reason: string }) => [u.card, u.reason]));
    expect(reasons).toEqual({ "Nobody Home": "unknown", "Aggro Leader": "wrong type", "Twin Base": "wrong type" });
    expect(out.leader.title).toBe("Aggro Leader, The Hunter");
  });

  it("tells a title miss that the name may be a rotated-set card, and keeps the cardKey wording for a cardKey miss", () => {
    const out = body(deckAudit(env, { decklist: lines(["Vanquish", 1], ["ZZ99", 1], ["P1", 1]), leader: "L1", base: "BC" }));
    const detail = Object.fromEntries(out.unresolved.map((u: { card: string; detail: string }) => [u.card, u.detail]));
    expect(detail.Vanquish).toBe(
      "not in the data: this name is not a card from Jump to Lightspeed onward (the Premier pool), so it is either a card from a rotated set (Spark of Rebellion) or a misspelling",
    );
    expect(detail.Vanquish).not.toContain("check the spelling");
    expect(detail.ZZ99).toBe("no card with this cardKey or title");
  });

  it("reads the rotated set names from the expansion index in main-set order, leaving out legal sets and Weekly Play sets", () => {
    const expansion = (value: string, definition: string) => ({ value, cards: 0, definition, cardKeys: [] });
    const store: CardStore = {
      ...env.store,
      facets: new Map([
        [
          "expansion",
          [
            expansion("TWI", "Twilight of the Republic. Main set 3. Premier rotated it out when LAW released."),
            expansion("LAW", "A Lawless Time. Main set 7. Premier legal as of 2026-10-07."),
            expansion("SOR", "Spark of Rebellion. Main set 1. Premier rotated it out."),
            expansion("SORP", "Spark of Rebellion Weekly Play: the Weekly Play promo cards that go with main set 1 (SOR). Premier rotated."),
            expansion("SHD", "Shadows of the Galaxy. Main set 2. Premier rotated it out when LAW released."),
          ],
        ],
      ]),
    };
    const miss = resolveRef(store, "Vanquish", "main");
    expect(miss).toMatchObject({ ok: false, reason: "unknown" });
    expect(miss.ok ? "" : miss.detail).toContain("(Spark of Rebellion, Shadows of the Galaxy, Twilight of the Republic)");
    const none = resolveRef({ ...env.store, facets: new Map() }, "Vanquish", "main");
    expect(none.ok ? "" : none.detail).toBe(
      "not in the data: this name is not a card from Jump to Lightspeed onward (the Premier pool), so it is either a card from a rotated set or a misspelling",
    );
  });

  it("carries the pool wording into deck_legality_check's unresolved-card failure", () => {
    const out = body(deckLegalityCheck(env, { decklist: [{ card: "Vanquish", count: 1 }, { card: "P1", count: 1 }], leader: "L1", base: "BC" }));
    const failure = out.failures.find((f: { check: string }) => f.check === "unresolved card");
    expect(failure.detail).toContain('"Vanquish" x1: unknown, not in the data: this name is not a card from Jump to Lightspeed onward');
    expect(failure.detail).toContain("a card from a rotated set (Spark of Rebellion) or a misspelling");
    expect(failure.detail).not.toContain("check the spelling");
  });

  it("refuses to guess between cards that share a title", () => {
    const result = deckAudit(env, { decklist: lines(["P1", 1]), leader: "L1", base: "Twin Base" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("matches 2 cards");
    expect(result.content[0].text).toContain("BT1");
    expect(result.content[0].text).toContain("BT2");
  });

  it("returns an error when no card resolves", () => {
    const result = deckAudit(env, { decklist: lines(["Nobody Home", 1]), leader: "L1", base: "BC" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Nobody Home");
  });
});

describe("deck_audit", () => {
  const deck = lines(["P1", 3], ["P2", 2], ["P3", 1], ["W1", 2]);

  it("reports size, types, mean cost and the curve with the rubric's expected stats", () => {
    const out = body(deckAudit(env, { decklist: deck, leader: "L1", base: "BC" }));
    expect(out.deck).toMatchObject({ cards: 8, distinct: 4, averageCost: 3 });
    expect(out.deck.byType).toEqual({ Unit: 8 });
    expect(out.curve).toEqual([{ cost: "3", cards: 8, units: 8, avgExpectedStats: 6, avgStatSurplus: 0.5 }]);
    expect(out.score.scoredCards).toBe(6);
    expect(out.score.meanTotal).toBe(2.33);
  });

  it("counts the aspect penalty per copy: +2 per icon the leader and base do not supply", () => {
    const out = body(deckAudit(env, { decklist: deck, leader: "L1", base: "BC" }));
    expect(out.aspect.suppliedIcons).toBe("Aggression+Villainy+Command");
    expect(out.aspect.penalty).toBe(2);
    expect(out.aspect.uncovered).toEqual([
      { card: "Pinger Blue", cardKey: "P3", count: 1, icons: "Vigilance", penaltyEach: 2, penaltyTotal: 2 },
    ]);
    const doubled = body(deckAudit(env, { decklist: lines(["P3", 3]), leader: "L1", base: "BC" }));
    expect(doubled.aspect.penalty).toBe(6);
  });

  it("flags a card that wants what nothing in the deck offers, and clears it once a feeder is in the deck", () => {
    const orphan = body(deckAudit(env, { decklist: lines(["W1", 2], ["F01", 3]), leader: "L1", base: "BC" }));
    expect(orphan.orphanWants.map((o: { cardKey: string }) => o.cardKey)).toEqual(["W1"]);
    expect(orphan.orphanWants[0].wants).toContain("wants:self-damaged");
    const fed = body(deckAudit(env, { decklist: lines(["W1", 2], ["P1", 1]), leader: "L1", base: "BC" }));
    expect(fed.orphanWants).toEqual([]);
  });

  it("names the best three feeders an orphan's leader and base can play: penalty-free first, rotated and out-of-pool cards never", () => {
    const rotatedFeeder: Spec = { key: "R2", title: "Retired Pinger", cost: 3, icons: ["Aggression"], sets: "SOR", offers: ["offers:damage-friendly-unit"] };
    const withRotated = buildEnv([...SPECS, rotatedFeeder]);
    const out = body(deckAudit(withRotated, { decklist: lines(["W1", 2], ["F01", 3]), leader: "L1", base: "BC" }));
    expect(out.orphanWants).toHaveLength(1);
    expect(out.orphanWants[0].feeders).toBe("Pinger Red (3); Pinger Green (3); Pinger Blue (3, +2)");
    expect(out.orphanWants[0].feeders).not.toContain("Retired Pinger");
    expect(out.orphanWants[0].feedersInCardPool).toBe(4);
  });

  it("keeps only three feeders, dropping the penalised one once three penalty-free feeders exist, and leaves the string empty when none qualify", () => {
    const fourth: Spec = { key: "P4", title: "Pinger Gold", cost: 4, icons: ["Aggression"], offers: ["offers:damage-friendly-unit"] };
    const crowded = body(deckAudit(buildEnv([...SPECS, fourth]), { decklist: lines(["W1", 2], ["F01", 3]), leader: "L1", base: "BC" }));
    expect(crowded.orphanWants[0].feeders).toBe("Pinger Red (3); Pinger Green (3); Pinger Gold (4)");
    const none = body(
      deckAudit(buildEnv(SPECS.filter((s) => !s.key.startsWith("P"))), { decklist: lines(["W1", 2], ["F01", 3]), leader: "L1", base: "BC" }),
    );
    expect(none.orphanWants[0].feeders).toBe("");
    expect(none.orphanWants[0].feedersInCardPool).toBe(0);
  });

  it("says role clusters are unavailable without a similarity run", () => {
    const out = body(deckAudit(env, { decklist: deck, leader: "L1", base: "BC" }));
    expect(out.clusterGaps.note).toContain("unavailable");
  });

  it("lists clusters the penalty-free pool holds more of than the deck, scaled to the deck size", () => {
    const clusters: ClustersFile = {
      renderVersion: 1,
      k: 2,
      seed: 1,
      restarts: 1,
      maxIter: 1,
      inertia: 0,
      clusters: [
        { id: 0, size: 17, label: "fillers", members: FILLERS.map((f) => f.key) },
        { id: 1, size: 3, label: "pingers", members: ["P1", "P2", "W1"] },
      ],
    };
    const absent = path.join(mkdtempSync(path.join(tmpdir(), "swu-deck-labels-")), "absent.json");
    const out = body(deckAudit({ ...buildEnv(SPECS, clusters), clusterLabelsPath: absent }, { decklist: lines(["P1", 4], ["P2", 4]), leader: "L1", base: "BC" }));
    // pool: 17 fillers, 3 penalty-free named cards and the unverified promo card = 21; 17 / 21 * 8 main-deck cards
    expect(out.clusterGaps.clusters).toEqual([
      { clusterId: 0, label: "fillers", labelStatus: "unlabelled", deckCards: 0, expected: 6.48, gap: 6.48, poolCards: 17 },
    ]);
  });

  describe("pinned cluster labels", () => {
    const clusters: ClustersFile = {
      renderVersion: 1,
      k: 2,
      seed: 1,
      restarts: 1,
      maxIter: 1,
      inertia: 0,
      clusters: [
        { id: 0, size: 17, label: "word:filler(90%)", members: FILLERS.map((f) => f.key) },
        { id: 1, size: 3, label: "word:ping(80%)", members: ["P1", "P2", "W1"] },
      ],
    };
    const labelFile = (entries: { id: number; members: string[]; label: string }[]): string => {
      const file = path.join(mkdtempSync(path.join(tmpdir(), "swu-deck-labels-")), "cluster-labels.json");
      writeFileSync(
        file,
        JSON.stringify({
          labelsVersion: 1,
          capturedAt: "2026-10-30",
          capturedBy: "test",
          note: "test fixture",
          labels: entries.map((e) => ({ id: e.id, membersSha256: membersSha256(e.members), size: e.members.length, tokenLabel: "t", label: e.label })),
        }),
      );
      return file;
    };
    // 8 main-deck cards outside both clusters, so both clusters show a gap of at least 1
    const audit = (clusterLabelsPath: string) =>
      body(deckAudit({ ...buildEnv(SPECS, clusters), clusterLabelsPath }, { decklist: lines(["R1", 4], ["PR1", 4]), leader: "L1", base: "BC" })).clusterGaps.clusters;
    const fillerKeys = FILLERS.map((f) => f.key);

    it("shows the human label where the member hash matches and the token label marked stale where it does not", () => {
      const file = labelFile([
        { id: 0, members: fillerKeys, label: "filler bodies" },
        { id: 1, members: ["P1", "P2"], label: "pinger package" },
      ]);
      const rows = audit(file);
      expect(rows.map((r: Record<string, unknown>) => [r.clusterId, r.label, r.labelStatus])).toEqual([
        [0, "filler bodies", "pinned"],
        [1, "word:ping(80%)", "stale"],
      ]);
    });

    it("treats a cluster with no entry in the file as stale", () => {
      const rows = audit(labelFile([{ id: 0, members: fillerKeys, label: "filler bodies" }]));
      expect(rows.map((r: Record<string, unknown>) => [r.label, r.labelStatus])).toEqual([
        ["filler bodies", "pinned"],
        ["word:ping(80%)", "stale"],
      ]);
    });

    it("falls back to the token label and unlabelled when the file is missing", () => {
      const rows = audit(path.join(mkdtempSync(path.join(tmpdir(), "swu-deck-labels-")), "absent.json"));
      expect(rows.map((r: Record<string, unknown>) => [r.label, r.labelStatus])).toEqual([
        ["word:filler(90%)", "unlabelled"],
        ["word:ping(80%)", "unlabelled"],
      ]);
    });

    it("throws on a present but malformed file instead of guessing", () => {
      const file = labelFile([{ id: 0, members: fillerKeys, label: "" }]);
      expect(() => audit(file)).toThrow();
    });
  });
});

describe("deck_legality_check", () => {
  const legalDeck = fillerDeck(17);

  it("passes a 51-card list with exactly one leader and base and three copies at most", () => {
    const out = body(deckLegalityCheck(env, { decklist: legalDeck, leader: "L1", base: "BC" }));
    expect(out.legal).toBe(true);
    expect(out.failures).toEqual([]);
    expect(out.counts).toMatchObject({ mainDeck: 51, minimum: 50, maxCopies: 3 });
  });

  it("fails a short list, citing CR 9.2.2.a", () => {
    const out = body(deckLegalityCheck(env, { decklist: fillerDeck(10), leader: "L1", base: "BC" }));
    expect(out.legal).toBe(false);
    expect(out.failures).toEqual([{ rule: "9.2.2.a", check: "deck size", detail: "30 unit, event and upgrade cards; the minimum is 50" }]);
  });

  it("fails a fourth copy, citing CR 9.2.2.b and 8.5.5", () => {
    const out = body(deckLegalityCheck(env, { decklist: [...legalDeck, { card: "F01", count: 1 }], leader: "L1", base: "BC" }));
    expect(out.legal).toBe(false);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toMatchObject({ rule: "9.2.2.b, 8.5.5", check: "copy limit" });
    expect(out.failures[0].detail).toContain("Filler 1 x4");
  });

  it("applies a base that lowers the minimum deck size (CR 3.2.1.a)", () => {
    const out = body(deckLegalityCheck(env, { decklist: fillerDeck(15), leader: "L1", base: "BS" }));
    expect(out.counts.minimum).toBe(45);
    expect(out.legal).toBe(true);
    const short = body(deckLegalityCheck(env, { decklist: fillerDeck(14), leader: "L1", base: "BS" }));
    expect(short.failures[0]).toMatchObject({ rule: "9.2.2.a, 3.2.1.a" });
    expect(short.failures[0].detail).toContain("minimum is 45");
  });

  it("fails a missing leader or base, an unknown card, a token and a leader in the card list", () => {
    const out = body(
      deckLegalityCheck(env, {
        decklist: [...legalDeck, { card: "Nobody Home", count: 1 }, { card: "T1", count: 1 }, { card: "L2", count: 1 }],
      }),
    );
    const checks = out.failures.map((f: { check: string }) => f.check);
    expect(checks).toEqual(
      expect.arrayContaining(["leader", "base", "unresolved card", "token in deck", "leader or base in the card list"]),
    );
    expect(out.legal).toBe(false);
    const token = out.failures.find((f: { check: string }) => f.check === "token in deck");
    expect(token.rule).toBe("1.2.3");
  });

  it("fails a card that appears only in rotated sets in Premier (CR 9.2.2.d) but not in Eternal", () => {
    const decklist = [...legalDeck, { card: "R1", count: 1 }];
    const premier = body(deckLegalityCheck(env, { decklist, leader: "L1", base: "BC" }));
    expect(premier.failures).toEqual([expect.objectContaining({ rule: "9.2.2.d", check: "cardpool" })]);
    const eternal = body(deckLegalityCheck(env, { decklist, leader: "L1", base: "BC", format: "eternal" }));
    expect(eternal.legal).toBe(true);
  });

  it("warns, without failing, on a promo-only card the data cannot place in the Premier cardpool", () => {
    const out = body(deckLegalityCheck(env, { decklist: [...legalDeck, { card: "PR1", count: 1 }], leader: "L1", base: "BC" }));
    expect(out.legal).toBe(true);
    expect(out.warnings).toEqual([expect.objectContaining({ rule: "9.2.2.d", check: "cardpool" })]);
  });

  it("says the cited sections are unverified when no Comprehensive Rules are loaded", () => {
    rulesMode.value = "missing";
    try {
      const out = body(deckLegalityCheck(env, { decklist: legalDeck, leader: "L1", base: "BC" }));
      expect(out.rulesVersion).toBeNull();
      expect(out.dataLimits.join(" ")).toContain("No Comprehensive Rules are loaded in this package");
    } finally {
      rulesMode.value = "real";
    }
  });

  it("fails rather than reporting every section missing when the rules data is corrupt", () => {
    rulesMode.value = "corrupt";
    try {
      expect(() => deckLegalityCheck(env, { decklist: legalDeck, leader: "L1", base: "BC" })).toThrow(SyntaxError);
    } finally {
      rulesMode.value = "real";
    }
  });

  it("counts every listed copy in listedCopies, unresolved lines included (#105)", () => {
    const out = body(deckLegalityCheck(env, { decklist: [...legalDeck, { card: "Nobody Home", count: 2 }, { card: "Also Nobody", count: 3 }], leader: "L1", base: "BC" }));
    expect(out.counts).toMatchObject({ mainDeck: 51, listedCopies: 56 });
  });

  it("states the data limits", () => {
    const out = body(deckLegalityCheck(env, { decklist: legalDeck, leader: "L1", base: "BC" }));
    const limits = out.dataLimits.join(" ");
    expect(limits).toContain("ban or suspension");
    expect(limits).toContain("asOf");
    expect(limits).toContain("sideboard");
  });
});

describe("suggest_leader_base", () => {
  it("ranks leader and base icon pairs by total penalty, penalty-free first", () => {
    const out = body(suggestLeaderBase(env, { decklist: lines(["P1", 3], ["W1", 2]) }));
    expect(out.pairs[0]).toMatchObject({
      leaderIcons: "Aggression+Villainy",
      penalty: 0,
      leaders: 1,
      leaderExamples: "Aggro Leader, The Hunter",
    });
    const penalties = out.pairs.map((p: { penalty: number }) => p.penalty);
    expect([...penalties].sort((a, b) => a - b)).toEqual(penalties);
    expect(out.penaltyFree).toBeGreaterThan(0);
  });

  it("ranks only bases when the leader is fixed", () => {
    const out = body(suggestLeaderBase(env, { decklist: lines(["P3", 2]), leader: "L2" }));
    expect(out.pairs.every((p: { leaderIcons: string }) => p.leaderIcons === "Command+Heroism")).toBe(true);
    expect(out.pairs[0]).toMatchObject({ baseIcons: "Vigilance", penalty: 0 });
    expect(out.pairs[1].penalty).toBe(4);
  });
});

describe("playable_cards", () => {
  it("lists penalty-free cards ranked by play-calibrated score and leaves out rotated and off-aspect cards", () => {
    const out = body(playableCards(env, { leader: "L1", base: "BC", costs: [3], perCost: 5 }));
    expect(out.cards.map((c: { cardKey: string }) => c.cardKey)).toEqual(["P1", "P2", "W1"]);
    expect(out.cards[0]).toMatchObject({ playCalibrated: 2, penalty: 0, remainingCopies: 3, price: 1 });
    const all = body(playableCards(env, { leader: "L1", base: "BC", limit: 100, perCost: 20 }));
    const keys = all.cards.map((c: { cardKey: string }) => c.cardKey);
    expect(keys).not.toContain("P3");
    expect(keys).not.toContain("R1");
    expect(keys).not.toContain("T1");
  });

  it("admits a card with a penalty only when maxPenalty allows it, and shows the penalty", () => {
    const out = body(playableCards(env, { leader: "L1", base: "BC", costs: [3], maxPenalty: 2, perCost: 5 }));
    const blue = out.cards.find((c: { cardKey: string }) => c.cardKey === "P3");
    expect(blue.penalty).toBe(2);
  });

  it("skips cards at three copies and, with emptyCostsOnly, costs the pile already holds", () => {
    const pile = lines(["P1", 3]);
    const out = body(playableCards(env, { leader: "L1", base: "BC", decklist: pile, costs: [3], perCost: 5 }));
    expect(out.cards.map((c: { cardKey: string }) => c.cardKey)).toEqual(["P2", "W1"]);
    const empty = body(playableCards(env, { leader: "L1", base: "BC", decklist: pile, emptyCostsOnly: true, perCost: 2, limit: 50 }));
    expect(empty.cards.every((c: { cost: number }) => c.cost !== 3)).toBe(true);
    expect(empty.cards.length).toBeGreaterThan(0);
  });

  it("filters by tag", () => {
    const out = body(playableCards(env, { leader: "L1", base: "BC", tag: "wants:self-damaged" }));
    expect(out.cards.map((c: { cardKey: string }) => c.cardKey)).toEqual(["W1"]);
  });
});

/** A meta/leader-cards.json with one tournament entry per leader: [cardKey, inclusion, meanCopies = 2] rows. */
function leaderCardsFile(byLeader: Record<string, [string, number, number?][]>): LeaderCardsFile {
  return {
    schemaVersion: 1,
    window: { from: "2026-07-04", to: "2026-10-01", days: 90 },
    weighting: "test weighting",
    baseline: "test baseline",
    maxCards: 150,
    leaders: Object.entries(byLeader).map(([leader, cards]) => ({
      leader: { cardKey: leader, title: leader, aspects: [] },
      population: "tournament" as const,
      fallback: false,
      decks: 12,
      weight: 18,
      window: { from: "2026-07-04", to: "2026-10-01" },
      topBase: null,
      cards: cards.map(([cardKey, inclusion, meanCopies]) => ({ cardKey, title: cardKey, inclusion, meanCopies: meanCopies ?? 2, baselineInclusion: 0.1, lift: inclusion - 0.1 })),
    })),
  };
}

describe("playable_cards, leader-aware", () => {
  const file = leaderCardsFile({ L1: [["W1", 0.8], ["P2", 0.4]], L2: [["P3", 0.5]] });
  const leaderEnv: DeckEnv = { ...env, leaderCards: indexLeaderCards(file) };
  const keys = (out: Record<string, any>) => out.cards.map((c: { cardKey: string }) => c.cardKey);

  it("ranks within a cost by the leader's tournament inclusion, then play-calibrated score, and shows leaderInclusion", () => {
    const out = body(playableCards(leaderEnv, { leader: "L1", base: "BC", costs: [3], perCost: 5, includeUnplayed: true }));
    expect(keys(out)).toEqual(["W1", "P2", "P1"]);
    expect(out.cards.map((c: { leaderInclusion: number | null }) => c.leaderInclusion)).toEqual([0.8, 0.4, null]);
    expect(out.rankedBy).toBe("leader");
    expect(out.note).toContain("ranked by this leader's tournament decklist inclusion (tournament, 12 decks, 2026-07-04..2026-10-01)");
    expect(out.note).toContain("leaderInclusion null = unplayed in this leader's decks");
  });

  it("ranks by score with rankBy score, and falls back to score for a leader without data", () => {
    const byScore = body(playableCards(leaderEnv, { leader: "L1", base: "BC", costs: [3], perCost: 5, rankBy: "score" }));
    expect(keys(byScore)).toEqual(["P1", "P2", "W1"]);
    expect(byScore.rankedBy).toBe("score");
    expect(byScore.cards[2].leaderInclusion).toBe(0.8);
    const none = body(playableCards({ ...env, leaderCards: indexLeaderCards(leaderCardsFile({ L2: [] })) }, { leader: "L1", base: "BC", costs: [3], perCost: 5 }));
    expect(keys(none)).toEqual(["P1", "P2", "W1"]);
    expect(none.rankedBy).toBe("score");
    expect(none.cards[0]).not.toHaveProperty("leaderInclusion");
  });

  it("loads meta/leader-cards.json lazily from the package, and a package without it ranks by score", () => {
    const pkg = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "swu-leader-cards-"));
    mkdirSync(path.join(pkg, "llm"));
    const without: DeckEnv = { ...env, store: { ...env.store, dataDir: path.join(pkg, "llm") } };
    expect(leaderCardsOf(without)).toBeNull();
    expect(body(playableCards(without, { leader: "L1", base: "BC", costs: [3], perCost: 5 })).rankedBy).toBe("score");
    mkdirSync(path.join(pkg, "meta"));
    writeFileSync(path.join(pkg, "meta/leader-cards.json"), `${JSON.stringify(file)}\n`);
    const withFile: DeckEnv = { ...env, store: { ...env.store, dataDir: path.join(pkg, "llm") } };
    expect(leaderCardsOf(withFile)?.get("L1")?.byCard.get("W1")?.inclusion).toBe(0.8);
    expect(keys(body(playableCards(withFile, { leader: "L1", base: "BC", costs: [3], perCost: 5 })))).toEqual(["W1", "P2"]);
  });

  it("drops cards the leader's decks do not play unless includeUnplayed is true, and names a cost left with no played card", () => {
    const dropped = body(playableCards(leaderEnv, { leader: "L1", base: "BC", costs: [3], perCost: 5 }));
    expect(keys(dropped)).toEqual(["W1", "P2"]);
    expect(dropped.matched).toBe(2);
    expect(dropped.emptyCosts).toBe("none");
    expect(dropped.note).toContain("includeUnplayed: true lists them");

    const all = body(playableCards(leaderEnv, { leader: "L1", base: "BC", perCost: 5, limit: 100 }));
    expect(all.cards.every((c: { cost: number; leaderInclusion: number | null }) => c.cost === 3 && c.leaderInclusion !== null)).toBe(true);
    expect(all.emptyCosts).toBe("2: no tournament-played card at this cost; includeUnplayed: true lists score-ranked cards");

    const withUnplayed = body(playableCards(leaderEnv, { leader: "L1", base: "BC", perCost: 3, limit: 100, includeUnplayed: true }));
    expect(withUnplayed.emptyCosts).toBe("none");
    expect(withUnplayed.cards.some((c: { cost: number }) => c.cost === 2)).toBe(true);
    expect(withUnplayed.note).toContain("includeUnplayed: true lists the unplayed cards after the played ones in each cost");

    expect(body(playableCards(leaderEnv, { leader: "L1", base: "BC", costs: [9] })).emptyCosts).toContain("9: no tournament-played card");
  });

  it("answers emptyCostsOnly with one line naming the costs the leader's lists do not use, not a placeholder row each; includeUnplayed lists score-ranked cards there", () => {
    // The leader's lists hold 2 mean copies at cost 3 only, and the pile holds cost 3, so cost 2 is unused.
    const pile = lines(["P1", 1]);
    const out = body(playableCards(leaderEnv, { leader: "L1", base: "BC", decklist: pile, emptyCostsOnly: true, perCost: 3, limit: 50 }));
    expect(out.cards).toEqual([]);
    expect(out.emptyCosts).toBe("under 0.5 mean copies in the leader's lists at cost 2; includeUnplayed: true lists score-ranked cards");
    const listed = body(playableCards(leaderEnv, { leader: "L1", base: "BC", decklist: pile, emptyCostsOnly: true, perCost: 3, limit: 50, includeUnplayed: true }));
    expect(listed.cards.every((c: { cost: number; cardKey: string | null }) => c.cost === 2 && c.cardKey !== null)).toBe(true);
    expect(listed.cards).toHaveLength(3);
  });

  it("skips a cost whose best leaderInclusion is under 2% for emptyCostsOnly and reports it (D45)", () => {
    // Cost 2 holds only Filler 1, played in 0.89% of the leader's lists; cost 3 is held by the pile.
    const thin = { ...env, leaderCards: indexLeaderCards(leaderCardsFile({ L1: [["W1", 0.8], ["P2", 0.4], ["F01", 0.0089]] })) };
    const pile = lines(["P1", 1]);
    const out = body(playableCards(thin, { leader: "L1", base: "BC", decklist: pile, emptyCostsOnly: true, perCost: 3, limit: 50 }));
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]).toMatchObject({
      cardKey: null,
      cost: 2,
      title: "no tournament-played card (>= 2%) at cost 2; includeUnplayed: true lists score-ranked cards",
      leaderInclusion: null,
    });
    expect(out.emptyCosts).toContain("no tournament-played card (>= 2%) at cost 2");
    expect(out.matched).toBe(0);
    expect(out.note).toContain("2%");

    // A cost whose best card clears the floor lists its played cards; a card under the floor is dropped (#135).
    const mixed = { ...env, leaderCards: indexLeaderCards(leaderCardsFile({ L1: [["F01", 0.0089], ["F02", 0.03]] })) };
    const kept = body(playableCards(mixed, { leader: "L1", base: "BC", decklist: pile, emptyCostsOnly: true, perCost: 3, limit: 50 }));
    expect(keys(kept)).toEqual(["F02"]);
    expect(kept.emptyCosts).toBe("none");

    // includeUnplayed lists the score-ranked cards and lifts the floor; without it a thin card is dropped and the cost reads as thin.
    const listed = body(playableCards(thin, { leader: "L1", base: "BC", decklist: pile, emptyCostsOnly: true, perCost: 3, limit: 50, includeUnplayed: true }));
    expect(listed.cards.every((c: { cost: number; cardKey: string | null }) => c.cost === 2 && c.cardKey !== null)).toBe(true);
    const plain = body(playableCards(thin, { leader: "L1", base: "BC", costs: [2], perCost: 3 }));
    expect(keys(plain)).toEqual([]);
    expect(plain.emptyCosts).toContain("no tournament-played card (>= 2%) at cost 2");
    expect(keys(body(playableCards(thin, { leader: "L1", base: "BC", costs: [2], perCost: 3, includeUnplayed: true })))).toContain("F01");
  });

  describe("staples, the 2% floor and the costs a leader's lists use (#135)", () => {
    const extra = (key: string, title: string, cost: number, over: Partial<Spec> = {}): Spec => ({ key, title, cost, icons: ["Aggression"], ...over });
    const richEnv = buildEnv([
      ...SPECS,
      extra("N1", "Near Staple", 3),
      extra("N2", "Lesser Card", 3),
      extra("X1", "Four Cost A", 4),
      extra("X2", "Four Cost B", 4),
      extra("Y1", "Five Cost A", 5),
      extra("Y2", "Five Cost B", 5),
      extra("Z1", "Six Cost", 6),
      extra("E1", "Emergency", 1),
    ]);
    const withLeader = (rows: [string, number, number?][]): DeckEnv => ({ ...richEnv, leaderCards: indexLeaderCards(leaderCardsFile({ L1: rows })) });
    const staples = withLeader([
      ["W1", 0.8],
      ["P2", 0.75],
      ["P1", 0.6],
      ["N1", 0.59],
      ["N2", 0.5],
      ["F01", 0.5],
      ["F02", 0.4],
      ["F03", 0.3],
      ["E1", 0.0071],
    ]);

    it("keeps a card at 60% or more past perCost, marks it staple, and counts it outside perCost", () => {
      const out = body(playableCards(staples, { leader: "L1", base: "BC", costs: [3], perCost: 1 }));
      expect(keys(out)).toEqual(["W1", "P2", "P1", "N1"]);
      expect(out.cards.map((c: { staple: boolean }) => c.staple)).toEqual([true, true, true, false]);
      const wide = body(playableCards(staples, { leader: "L1", base: "BC", costs: [2], perCost: 2 }));
      expect(keys(wide)).toEqual(["F01", "F02"]);
      expect(wide.cards.every((c: { staple: boolean }) => c.staple === false)).toBe(true);
      expect(out.note).toContain("60%");
    });

    it("drops a card under the 2% floor from the normal listing unless includeUnplayed lifts it", () => {
      const cost1 = body(playableCards(staples, { leader: "L1", base: "BC", costs: [1], perCost: 3 }));
      expect(keys(cost1)).toEqual([]);
      expect(cost1.emptyCosts).toContain("no tournament-played card (>= 2%) at cost 1");
      const lifted = body(playableCards(staples, { leader: "L1", base: "BC", costs: [1], perCost: 3, includeUnplayed: true }));
      expect(keys(lifted)).toEqual(["E1"]);
    });

    it("has no staple field when ranking by score", () => {
      expect(body(playableCards(staples, { leader: "L1", base: "BC", costs: [3], perCost: 3, rankBy: "score" })).cards[0]).not.toHaveProperty("staple");
    });

    it("limit counts non-staple rows only: every staple is listed, even past the limit and past the costs the limit reaches (#136)", () => {
      const deep = withLeader([
        ["W1", 0.8],
        ["P2", 0.75],
        ["P1", 0.6],
        ["N1", 0.59],
        ["N2", 0.5],
        ["F01", 0.5],
        ["F02", 0.4],
        ["F03", 0.3],
        ["Y1", 0.7],
        ["Z1", 0.65],
        ["X1", 0.3],
      ]);
      const out = body(playableCards(deep, { leader: "L1", base: "BC", perCost: 3, limit: 2 }));
      expect(keys(out)).toEqual(["F01", "F02", "W1", "P2", "P1", "Y1", "Z1"]);
      expect(out.cards.map((c: { staple: boolean }) => c.staple)).toEqual([false, false, true, true, true, true, true]);
      expect(out.shown).toBe(7);
      expect(out.note).toContain("does not count toward perCost or limit");
      expect(body(playableCards(deep, { leader: "L1", base: "BC", perCost: 3, limit: 1, rankBy: "score" })).cards).toHaveLength(1);
    });

    it("emptyCostsOnly reports only costs holding 0.5 mean copies of the leader's lists and names the rest in one line", () => {
      // cost 2: F01 3 copies; cost 4: 0.25 + 0.2 = 0.45 (unused); cost 5: 0.25 + 0.25 = 0.5 (used); cost 6: no leader card; cost 3 is held.
      const use = withLeader([
        ["F01", 0.5, 3],
        ["X1", 0.4, 0.25],
        ["X2", 0.3, 0.2],
        ["Y1", 0.4, 0.25],
        ["Y2", 0.3, 0.25],
        ["W1", 0.8, 3],
      ]);
      const out = body(playableCards(use, { leader: "L1", base: "BC", decklist: lines(["P1", 1]), emptyCostsOnly: true, perCost: 3, limit: 50 }));
      expect(out.cards.map((c: { cardKey: string; cost: number }) => [c.cardKey, c.cost])).toEqual([
        ["F01", 2],
        ["Y1", 5],
        ["Y2", 5],
      ]);
      expect(out.emptyCosts).toBe("under 0.5 mean copies in the leader's lists at costs 1, 4, 6; includeUnplayed: true lists score-ranked cards");
      expect(out.cards.every((c: { cardKey: string | null }) => c.cardKey !== null)).toBe(true);
    });
  });

  it("is unaffected by includeUnplayed when ranking by score", () => {
    const byScore = body(playableCards(leaderEnv, { leader: "L1", base: "BC", costs: [3], perCost: 5, rankBy: "score" }));
    expect(keys(byScore)).toEqual(["P1", "P2", "W1"]);
    expect(byScore.emptyCosts).toBe("none");
  });
});

describe("deck_audit, leader-aware (#105)", () => {
  const file = leaderCardsFile({ L1: [["W1", 0.8], ["P2", 0.6], ["F01", 0.5], ["P3", 0.04]] });
  const leaderEnv: DeckEnv = { ...env, leaderCards: indexLeaderCards(file) };

  it("lists the leader's staples the deck lacks and the deck cards its decks rarely or never play, naming population and window", () => {
    const out = body(deckAudit(leaderEnv, { decklist: lines(["P1", 3], ["P3", 1], ["F02", 3]), leader: "L1", base: "BC" }));
    const lc = out.leaderComparison;
    expect(lc).toMatchObject({ population: "tournament", decks: 12, window: "2026-07-04..2026-10-01" });
    expect(lc.missingStaples).toEqual([
      { card: "Grit Brute", cardKey: "W1", inclusion: 0.8, meanCopies: 2, cost: 3 },
      { card: "Pinger Green", cardKey: "P2", inclusion: 0.6, meanCopies: 2, cost: 3 },
      { card: "Filler 1", cardKey: "F01", inclusion: 0.5, meanCopies: 2, cost: 2 },
    ]);
    expect(lc.rarelyPlayed).toEqual([
      { card: "Pinger Red", cardKey: "P1", count: 3, inclusion: null },
      { card: "Pinger Blue", cardKey: "P3", count: 1, inclusion: 0.04 },
      { card: "Filler 2", cardKey: "F02", count: 3, inclusion: null },
    ]);
  });

  it("says so when the package has no tournament data for the leader", () => {
    const out = body(deckAudit(env, { decklist: lines(["P1", 3]), leader: "L1", base: "BC" }));
    expect(out.leaderComparison.note).toContain("no leader decklist data");
    expect(out.leaderComparison.missingStaples).toBeUndefined();
  });

  const clusters: ClustersFile = {
    renderVersion: 1,
    k: 3,
    seed: 1,
    restarts: 1,
    maxIter: 1,
    inertia: 0,
    clusters: [
      { id: 0, size: 16, label: "fillers", members: FILLERS.slice(0, 16).map((f) => f.key) },
      { id: 1, size: 3, label: "pingers", members: ["P1", "P2", "W1"] },
      { id: 2, size: 5, label: "bases and a filler", members: ["BC", "BV", "BS", "BT1", "F17"] },
    ],
  };
  const absent = path.join(mkdtempSync(path.join(tmpdir(), "swu-deck-labels-")), "absent.json");
  const deck = lines(["R1", 4], ["PR1", 4]);

  it("measures cluster gaps against the leader's tournament cards, inclusion-weighted, and says so", () => {
    const file2 = leaderCardsFile({ L1: [["P2", 0.8], ["W1", 0.8], ["F01", 0.4], ["F17", 0.5]] });
    const out = body(deckAudit({ ...buildEnv(SPECS, clusters), clusterLabelsPath: absent, leaderCards: indexLeaderCards(file2) }, { decklist: deck, leader: "L1", base: "BC" }));
    // weights: pingers 1.6, fillers 0.4; the bases cluster is skipped, so its 0.5 is out of the total: 1.6 / 2 * 8 and 0.4 / 2 * 8
    expect(out.clusterGaps.norm).toContain("tournament");
    expect(out.clusterGaps.clusters.map((r: Record<string, unknown>) => [r.clusterId, r.expected, r.gap])).toEqual([
      [1, 6.4, 6.4],
      [0, 1.6, 1.6],
    ]);
  });

  it("skips a cluster made mostly of cards a main deck cannot hold, with or without leader data", () => {
    // the leader's lists play F17 heavily, but F17's cluster is four bases and one unit
    const file3 = leaderCardsFile({ L1: [["F17", 0.9], ["F01", 0.1]] });
    const led = body(deckAudit({ ...buildEnv(SPECS, clusters), clusterLabelsPath: absent, leaderCards: indexLeaderCards(file3) }, { decklist: deck, leader: "L1", base: "BC" }));
    expect(led.clusterGaps.clusters.map((r: Record<string, unknown>) => [r.clusterId, r.expected])).toEqual([[0, 8]]);
    const pool = body(deckAudit({ ...buildEnv(SPECS, clusters), clusterLabelsPath: absent }, { decklist: deck, leader: "L1", base: "BC" }));
    expect(pool.clusterGaps.clusters.map((r: Record<string, unknown>) => r.clusterId)).not.toContain(2);
    expect(pool.clusterGaps.norm).toContain("Premier-scope");
  });
});

describe("deck_audit, generic wants (#105)", () => {
  const extra: Spec[] = [
    { key: "WP1", title: "Entry Guy", cost: 2, icons: ["Aggression"], wants: ["wants:replay-when-played"] },
    { key: "WP2", title: "Mixed Guy", cost: 3, icons: ["Aggression"], wants: ["wants:replay-when-played", "wants:self-damaged"] },
  ];
  const genericEnv = buildEnv([...SPECS, extra[0], extra[1]]);

  it("collapses a When Played replay want into one genericWants line and keeps the specific wants as rows", () => {
    const out = body(deckAudit(genericEnv, { decklist: lines(["WP1", 3], ["WP2", 3], ["F01", 3]), leader: "L1", base: "BC" }));
    expect(out.orphanWants.map((o: { cardKey: string }) => o.cardKey)).toEqual(["WP2"]);
    expect(out.orphanWants[0].wants).toBe("wants:self-damaged");
    expect(out.genericWants).toContain("wants:replay-when-played");
    expect(out.genericWants).toContain("Entry Guy");
    expect(out.genericWants).toContain("Mixed Guy");
  });

  it("treats a want that more than a quarter of the main-deck pool can feed as generic", () => {
    // without the 17 fillers, 3 of the 6 main-deck cards offer damage to a friendly unit
    const small = buildEnv(SPECS.filter((s) => !s.key.startsWith("F")));
    const out = body(deckAudit(small, { decklist: lines(["W1", 2], ["R1", 3]), leader: "L1", base: "BC" }));
    expect(out.orphanWants).toEqual([]);
    expect(out.genericWants).toContain("wants:self-damaged");
  });

  it("reads none when no generic want is unfed", () => {
    const out = body(deckAudit(genericEnv, { decklist: lines(["W1", 2], ["F01", 3]), leader: "L1", base: "BC" }));
    expect(out.genericWants).toBe("none");
  });
});

describe("budget_alternatives, leader-aware", () => {
  const leaderEnv: DeckEnv = { ...env, leaderCards: indexLeaderCards(leaderCardsFile({ L1: [["P2", 0.4]], L2: [["P3", 0.5]] })) };

  it("lists only substitutes whose aspect penalty is no higher than the replaced card's, with leaderInclusion", () => {
    const out = body(budgetAlternatives(leaderEnv, { decklist: lines(["P1", 1]), leader: "L1", base: "BC", minSaving: 0.1 }));
    expect(out.slots[0].aspectPenalty).toBe(0);
    expect(out.slots[0].alternatives.map((a: { cardKey: string; penalty: number; leaderInclusion: number | null }) => [a.cardKey, a.penalty, a.leaderInclusion])).toEqual([
      ["P2", 0, 0.4],
    ]);
  });

  it("prefers substitutes the leader's tournament decks play", () => {
    const plain = body(budgetAlternatives(env, { decklist: lines(["P1", 1]), leader: "L2", base: "BV", minSaving: 0.1 }));
    expect(plain.slots[0].alternatives.map((a: { cardKey: string }) => a.cardKey)).toEqual(["P2", "P3"]);
    const out = body(budgetAlternatives(leaderEnv, { decklist: lines(["P1", 1]), leader: "L2", base: "BV", minSaving: 0.1 }));
    expect(out.slots[0].alternatives.map((a: { cardKey: string; leaderInclusion: number | null }) => [a.cardKey, a.leaderInclusion])).toEqual([
      ["P3", 0.5],
      ["P2", null],
    ]);
  });
});

describe("budget_alternatives, cap and ordering (#135)", () => {
  const cheap = (key: string, title: string, cost: number, normal: number, tag: string): Spec => ({
    key,
    title,
    cost,
    icons: ["Aggression"],
    offers: [tag],
    price: { normal },
  });
  const damage = "offers:damage-friendly-unit";
  const draw = "offers:draw-card";
  const capEnv = buildEnv([
    ...SPECS,
    cheap("C1", "Cheap Unplayed", 3, 0.05, damage),
    cheap("C2", "Cheap Played", 3, 0.4, damage),
    cheap("C3", "Cheap Barely Played", 3, 0.1, damage),
    cheap("Q1", "Costly Draw", 6, 3, draw),
    cheap("Q2", "Cheap Draw A", 6, 0.5, draw),
    cheap("Q3", "Cheap Draw B", 6, 0.45, draw),
    cheap("Q4", "Draw At Cap", 6, 0.5, draw),
  ]);
  const withRows = (rows: [string, number][]): DeckEnv => ({ ...capEnv, leaderCards: indexLeaderCards(leaderCardsFile({ L1: rows })) });
  const deck = lines(["P1", 2], ["P2", 1], ["Q4", 1], ["Q1", 1]);
  const run = (e: DeckEnv) => body(budgetAlternatives(e, { decklist: deck, leader: "L1", base: "BC", maxPrice: 0.5, minSaving: 0.1, perSlot: 5 }));

  it("skips a slot already at or under maxPrice and reports it in alreadyUnderCap", () => {
    const out = run(withRows([["C2", 0.639], ["C3", 0.0033]]));
    expect(out.alreadyUnderCap).toEqual([
      { card: "Pinger Green", price: 0.3 },
      { card: "Draw At Cap", price: 0.5 },
    ]);
    expect(out.slots.map((s: { cardKey: string }) => s.cardKey)).toEqual(["P1", "Q1"]);
  });

  it("orders alternatives by leaderInclusion, then saving, whatever the score or the saving", () => {
    const out = run(withRows([["C2", 0.639], ["C3", 0.0033], ["Q2", 0.3]]));
    expect(out.slots[0].alternatives.map((a: { cardKey: string; leaderInclusion: number | null }) => [a.cardKey, a.leaderInclusion])).toEqual([
      ["C2", 0.639],
      ["C3", 0.0033],
      ["C1", null],
    ]);
    expect(out.slots[0]).not.toHaveProperty("note");
    expect(out.slots[1].alternatives[0]).toMatchObject({ cardKey: "Q2", leaderInclusion: 0.3 });
    expect(out.totalSaving).toBe(1.2 + 2.5);
    expect(out.savingPerCopy).toBe(2.55);
  });

  it("writes a note on a slot where no listed substitute is tournament-played, and still lists the score-ranked ones", () => {
    const out = run(withRows([["C2", 0.639]]));
    expect(out.slots[0]).not.toHaveProperty("note");
    expect(out.slots[1].note).toBe("no tournament-played substitute under the cap");
    expect(out.slots[1].alternatives.map((a: { cardKey: string }) => a.cardKey)).toEqual(["Q3", "Q2"]);
  });

  it("gives alreadyUnderCap an empty list and no slot note without a maxPrice or a leader", () => {
    const plain = body(budgetAlternatives(capEnv, { decklist: deck, minSaving: 0.1 }));
    expect(plain.alreadyUnderCap).toEqual([]);
    expect(plain.slots.every((s: { note?: string }) => s.note === undefined)).toBe(true);
  });

  describe("every main-deck card lands in slots, alreadyUnderCap or noAlternative (#136)", () => {
    const hkEnv = buildEnv([
      ...SPECS,
      cheap("H1", "HK Like", 6, 6.48, "offers:hk-role"),
      cheap("H2", "Far Cost Twin", 2, 0.5, "offers:hk-role"),
      cheap("J1", "Dear Slot", 5, 4, draw),
      cheap("J2", "Dearer Twin", 5, 7, draw),
      { key: "K1", title: "Roleless", cost: 4, icons: ["Aggression"], price: { normal: 3 } },
      cheap("M1", "Pennies", 3, 0.05, damage),
    ]);
    const pile = lines(["H1", 1], ["J1", 2], ["K1", 1], ["P1", 1], ["P2", 1], ["M1", 1]);
    const out = body(budgetAlternatives(hkEnv, { decklist: pile, maxPrice: 2, minSaving: 0.1, perSlot: 3 }));
    const landed = (): string[] =>
      [...out.slots.map((s: { card: string }) => s.card), ...out.alreadyUnderCap.map((s: { card: string }) => s.card), ...out.noAlternative.map((s: { card: string }) => s.card)];

    it("lists a card with a role but no card in its cost band, with its price and reason", () => {
      expect(out.noAlternative).toContainEqual({ card: "HK Like", price: 6.48, reason: "no card within the cost band" });
    });

    it("lists a card whose same-slot cards are all dearer, and a card with no role", () => {
      expect(out.noAlternative).toContainEqual({ card: "Dear Slot", price: 4, reason: "no cheaper same-slot card" });
      expect(out.noAlternative).toContainEqual({ card: "Roleless", price: 3, reason: "no cheaper same-slot card" });
    });

    it("puts each priced deck card in exactly one of the three lists", () => {
      expect(landed().sort()).toEqual(["Dear Slot", "HK Like", "Pennies", "Pinger Green", "Pinger Red", "Roleless"]);
      expect(new Set(landed()).size).toBe(landed().length);
      expect(out.noAlternative.every((r: Record<string, unknown>) => Object.keys(r).sort().join() === "card,price,reason")).toBe(true);
    });

    it("gives noAlternative an empty list when every card has a swap", () => {
      const swap = body(budgetAlternatives(capEnv, { decklist: lines(["P1", 1]), minSaving: 0.1 }));
      expect(swap.noAlternative).toEqual([]);
    });
  });
});

describe("fungible_in_deck", () => {
  it("lists same-role substitutes per slot, least aspect penalty first, and not cards already in the deck", () => {
    const out = body(fungibleInDeck(env, { decklist: lines(["P1", 2]), leader: "L2", base: "BC" }));
    const slot = out.slots[0];
    expect(slot).toMatchObject({ cardKey: "P1", count: 2, penalty: 2, roles: "offers:damage-friendly-unit" });
    expect(slot.substitutes.map((s: { cardKey: string; penalty: number }) => [s.cardKey, s.penalty])).toEqual([
      ["P2", 0],
      ["P3", 2],
    ]);
    const inDeck = body(fungibleInDeck(env, { decklist: lines(["P1", 2], ["P2", 1]), leader: "L2", base: "BC" }));
    expect(inDeck.slots[0].substitutes.map((s: { cardKey: string }) => s.cardKey)).not.toContain("P2");
  });

  it("lists cards with no role and honours onlyPenalised", () => {
    const out = body(fungibleInDeck(env, { decklist: lines(["P2", 1], ["F01", 3]), leader: "L2", base: "BC" }));
    expect(out.noRole).toEqual(["Filler 1"]);
    expect(out.slots.map((s: { cardKey: string }) => s.cardKey)).toEqual(["P2"]);
    const penalised = body(fungibleInDeck(env, { decklist: lines(["P2", 1], ["P1", 1]), leader: "L2", base: "BC", onlyPenalised: true }));
    expect(penalised.slots.map((s: { cardKey: string }) => s.cardKey)).toEqual(["P1"]);
  });
});

describe("budget_alternatives", () => {
  it("lists cheaper fungible substitutes with the saving and the score change", () => {
    const out = body(budgetAlternatives(env, { decklist: lines(["P1", 2], ["F01", 1]), minSaving: 0.25 }));
    expect(out.slotsWithAlternatives).toBe(1);
    const slot = out.slots[0];
    expect(slot).toMatchObject({ cardKey: "P1", count: 2, price: 1, aspectPenalty: null });
    expect(slot.alternatives).toEqual([
      {
        cardKey: "P2",
        title: "Pinger Green",
        cost: 3,
        aspects: "Command",
        fills: 1,
        price: 0.3,
        saved: 0.7,
        scoreDelta: -1,
        penalty: null,
      },
    ]);
    expect(out).not.toHaveProperty("bestSavingPerCopy");
    expect(out.savingPerCopy).toBe(0.7);
    expect(out.totalSaving).toBe(1.4);
    expect(out.unpriced).toEqual(["Filler 1"]);
  });

  describe("same cost band", () => {
    const costly = (key: string, title: string, cost: number, normal: number): Spec => ({
      key,
      title,
      cost,
      icons: ["Command"],
      offers: ["offers:draw-card"],
      price: { normal },
    });
    const bandEnv = buildEnv([
      ...SPECS,
      costly("Q1", "Costly Seven", 7, 10),
      costly("Q2", "Costly Six", 6, 3),
      costly("Q3", "Costly Eleven", 11, 1),
      costly("Q4", "Costly Eight", 8, 2),
      costly("Q5", "Costly Nine", 9, 0.5),
    ]);
    const deck = lines(["Q1", 2], ["P1", 3]);

    it("offers only substitutes within one cost of the replaced card, though they share its role class", () => {
      const out = body(budgetAlternatives(bandEnv, { decklist: deck, minSaving: 0.25 }));
      const slot = out.slots.find((s: { cardKey: string }) => s.cardKey === "Q1");
      expect(slot.alternatives.map((a: { cardKey: string; cost: number }) => [a.cardKey, a.cost])).toEqual([
        ["Q4", 8],
        ["Q2", 6],
      ]);
      expect(out.note).toContain("cost within 1 of the card it replaces");
    });

    it("reports the best single swap per copy apart from the total over all copies", () => {
      const out = body(budgetAlternatives(bandEnv, { decklist: deck, minSaving: 0.25 }));
      expect(out.slots.map((s: { cardKey: string; count: number; alternatives: { saved: number }[] }) => [s.cardKey, s.count, s.alternatives[0].saved])).toEqual([
        ["Q1", 2, 8],
        ["P1", 3, 0.7],
      ]);
      expect(out.savingPerCopy).toBe(8);
      expect(out.totalSaving).toBe(18.1);
    });
  });

  it("adds the aspect penalty under a leader and base, and honours maxPrice and a smaller minSaving", () => {
    const out = body(budgetAlternatives(env, { decklist: lines(["P1", 1]), leader: "L2", base: "BC", minSaving: 0.1 }));
    expect(out.slots[0].aspectPenalty).toBe(2);
    expect(out.slots[0].alternatives.map((a: { cardKey: string; penalty: number }) => [a.cardKey, a.penalty])).toEqual([
      ["P2", 0],
      ["P3", 2],
    ]);
    expect(body(budgetAlternatives(env, { decklist: lines(["P1", 1]), maxPrice: 0.2 })).slotsWithAlternatives).toBe(0);
  });

  it("needs a leader and base together", () => {
    expect(budgetAlternatives(env, { decklist: lines(["P1", 1]), leader: "L1" }).isError).toBe(true);
  });

  it("lists no substitute outside the Premier pool: neither a rotated card nor one whose sets are not verified legal (#119)", () => {
    const cheap = (key: string, title: string, sets: string): Spec => ({ key, title, cost: 3, icons: ["Aggression"], sets, offers: ["offers:damage-friendly-unit"], price: { normal: 0.1 } });
    const poolEnv = buildEnv([...SPECS, cheap("R3", "Retired Pinger", "SOR"), cheap("PR2", "Promo Pinger", "PRO"), cheap("RP", "Reprinted Pinger", "SOR|SEC")]);
    const keys = body(budgetAlternatives(poolEnv, { decklist: lines(["P1", 1]), minSaving: 0.1, perSlot: 10 })).slots[0].alternatives.map((a: { cardKey: string }) => a.cardKey);
    expect(keys).not.toContain("R3");
    expect(keys).not.toContain("PR2");
    expect(keys).toContain("RP");
    expect(keys).toContain("P2");
  });
});

describe("inPremierPool (#119)", () => {
  it("admits a card with a Premier-legal printing and nothing else", () => {
    const pool = inPremierPool(env.store);
    expect(pool("P1")).toBe(true);
    expect(pool("R1")).toBe(false);
    expect(pool("PR1")).toBe(false);
    expect(pool("nope")).toBe(false);
  });

  it("checks nothing when the package has no expansion index", () => {
    const bare = { ...env.store, facets: new Map() };
    expect(inPremierPool(bare)("R1")).toBe(true);
  });
});

describe("price_list", () => {
  const items = lines(["P1", 2], ["P2", 1], ["F01", 1], ["Nobody Home", 1]);

  it("totals the canonical price, lists unpriced and unresolved cards, and reports the top share", () => {
    const out = body(priceList(env, { items, topN: 1 }));
    expect(out.total).toBe(2.3);
    expect(out.cards).toBe(4);
    expect(out.pricedCards).toBe(3);
    expect(out.unpriced).toEqual([{ card: "Filler 1", cardKey: "F01", count: 1 }]);
    expect(out.unresolved[0].card).toBe("Nobody Home");
    expect(out.top).toEqual({ n: 1, total: 2, share: 0.8696 });
    expect(out.lines[0]).toMatchObject({ cardKey: "P1", unit: 1, total: 2 });
    expect(out.coverage).toContain("US");
  });

  it("prices the cheapest printing and groups by rarity", () => {
    const out = body(priceList(env, { items, basis: "cheapest", groupBy: "rarity" }));
    expect(out.total).toBe(1.9);
    expect(out.groups).toEqual([
      { group: "Rare", cards: 2, total: 1.6, share: 0.8421 },
      { group: "Common", cards: 1, total: 0.3, share: 0.1579 },
    ]);
  });

  it("treats a missing foil price as unpriced and accepts leaders and bases", () => {
    const out = body(priceList(env, { items: lines(["P1", 1], ["L1", 1]), basis: "foil" }));
    expect(out.total).toBe(0);
    expect(out.unpriced).toHaveLength(2);
  });
});

describe("trade_balance", () => {
  it("compares market, low and rubric totals both ways", () => {
    const out = body(tradeBalance(env, { sideA: lines(["P1", 1]), sideB: lines(["P2", 2]) }));
    expect(out.sideA).toMatchObject({ cards: 1, market: 1, low: 0.8, rubric: 2 });
    expect(out.sideB).toMatchObject({ cards: 2, market: 0.6, low: 0.6, rubric: 2 });
    expect(out.difference).toMatchObject({ market: 0.4, low: 0.2, rubric: 0, marketView: "A holds more", rubricView: "even" });
  });

  it("lists unpriced cards and unresolved names per side", () => {
    const out = body(tradeBalance(env, { sideA: lines(["F01", 1], ["P1", 1]), sideB: lines(["Nobody Home", 1], ["P2", 1]) }));
    expect(out.sideA.unpriced).toEqual(["Filler 1"]);
    expect(out.unresolved.sideB[0].card).toBe("Nobody Home");
  });

  it("errors when neither side resolves", () => {
    expect(tradeBalance(env, { sideA: lines(["Nobody Home", 1]), sideB: lines(["Nobody Else", 1]) }).isError).toBe(true);
  });
});

describe("owned_vs_needed", () => {
  const owned = lines(["P1", 1], ["P2", 2], ["P3", 3]);

  it("lists missing copies, the cost to complete and spare owned substitutes", () => {
    const out = body(ownedVsNeeded(env, { decklist: lines(["P1", 3], ["P2", 2]), owned }));
    expect(out.complete).toBe(false);
    expect(out.missingCopies).toBe(2);
    expect(out.costToComplete).toBe(1.6);
    expect(out.missing).toHaveLength(1);
    const line = out.missing[0];
    expect(line).toMatchObject({ cardKey: "P1", needed: 3, owned: 1, missing: 2, unit: 0.8, lineCost: 1.6 });
    expect(line.ownedSubstitutes).toEqual([
      { cardKey: "P3", title: "Pinger Blue", spareCopies: 3, cost: 3, aspects: "Vigilance", fills: 1, penalty: null },
    ]);
  });

  it("does not offer an owned card the deck itself needs as a substitute", () => {
    const out = body(ownedVsNeeded(env, { decklist: lines(["P1", 3], ["P2", 2]), owned: lines(["P2", 2]) }));
    expect(out.missing[0].ownedSubstitutes).toEqual([]);
  });

  it("is complete when every copy is owned", () => {
    const out = body(ownedVsNeeded(env, { decklist: lines(["P1", 1]), owned: lines(["P1", 2]) }));
    expect(out).toMatchObject({ complete: true, missingCopies: 0, costToComplete: 0 });
  });

  it("adds penalties for owned substitutes under a leader and base", () => {
    const out = body(ownedVsNeeded(env, { decklist: lines(["P1", 1]), owned: lines(["P3", 1]), leader: "L1", base: "BC" }));
    expect(out.missing[0].ownedSubstitutes[0].penalty).toBe(2);
  });
});

describe("play_value_vs_price", () => {
  it("ranks by inclusion rate per dollar, cheap first or dear first, and applies the minimum sample", () => {
    const cheap = body(playValueVsPrice(env, { minSampleSize: 100 }));
    expect(cheap.window).toBe(WINDOW);
    expect(cheap.cards.map((c: { cardKey: string }) => c.cardKey)).toEqual(["P2", "P1"]);
    expect(cheap.cards[0]).toMatchObject({ included: 3000, inclusionRate: 0.03, winShare: 0.5, price: 0.3, inclusionPerDollar: 0.1 });
    const dear = body(playValueVsPrice(env, { minSampleSize: 100, direction: "dear" }));
    expect(dear.cards.map((c: { cardKey: string }) => c.cardKey)).toEqual(["P1", "P2"]);
    expect(body(playValueVsPrice(env, { minSampleSize: 10 })).matched).toBe(3);
  });

  it("applies price bounds, rejects an unknown window and carries the capture caveats", () => {
    const out = body(playValueVsPrice(env, { minSampleSize: 100, maxPrice: 0.5 }));
    expect(out.cards.map((c: { cardKey: string }) => c.cardKey)).toEqual(["P2"]);
    expect(out.note).toBe("test play note");
    expect(out.caveat).toContain("US prices");
    expect(playValueVsPrice(env, { window: "w1-2" }).isError).toBe(true);
  });
});

describe("score_vs_play", () => {
  const specs: Spec[] = [
    { key: "A", title: "Card A", score: { total: 4, play: 4 }, play: { included: 0 } },
    { key: "B", title: "Card B", score: { total: 3, play: 3 }, play: { included: 100 } },
    { key: "C", title: "Card C", score: { total: 2, play: 2 }, play: { included: 200 } },
    { key: "D", title: "Card D", score: { total: 1, play: 1 }, play: { included: 300 } },
  ];
  const small = buildEnv(specs);

  it("ranks cards whose score percentile is above their play percentile as underplayed", () => {
    const out = body(scoreVsPlay(small, {}));
    expect(out.cards.map((c: { cardKey: string; residual: number }) => [c.cardKey, c.residual])).toEqual([
      ["A", 75],
      ["B", 25],
      ["C", -25],
      ["D", -75],
    ]);
    expect(out.scoreUsed).toBe("total");
    expect(out.caution).toContain("not fitted to play");
  });

  it("reverses for overplayed and says the play-calibrated score is circular", () => {
    const out = body(scoreVsPlay(small, { direction: "overplayed", score: "playCalibrated", limit: 1 }));
    expect(out.cards.map((c: { cardKey: string }) => c.cardKey)).toEqual(["D"]);
    expect(out.caution).toContain("circular");
  });

  it("rejects a window with too few player-games and an unknown window", () => {
    expect(scoreVsPlay(small, { minSampleSize: PLAYER_GAMES + 1 }).isError).toBe(true);
    expect(scoreVsPlay(small, { window: "w1-2" }).isError).toBe(true);
  });

  it("is deterministic", () => {
    expect(scoreVsPlay(small, {})).toEqual(scoreVsPlay(small, {}));
  });
});

describe("against the test fixtures", () => {
  const fixtureStore = loadStore(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures"));

  it("audits and prices a list through the registered handlers", () => {
    const audit = body(
      DECK_TOOLS.deck_audit.handler(fixtureStore, {
        decklist: lines(["Death Trooper", 3], ["0101074", 2]),
        leader: "04010001",
        base: "0101030",
      }),
    );
    expect(audit.deck.cards).toBe(5);
    expect(audit.aspect.penalty).toBe(0);
    expect(audit.leader.title).toBe("Asajj Ventress, I Work Alone");
    const priced = body(DECK_TOOLS.price_list.handler(fixtureStore, { items: lines(["Death Trooper", 3]) }));
    expect(priced.total).toBe(0.24);
  });

  it("loads one environment per store", () => {
    expect(deckEnvOf(fixtureStore)).toBe(deckEnvOf(fixtureStore));
  });

  const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
  const copyWithSimilarity = (clustersJson: string | null): CardStore => {
    const dir = mkdtempSync(path.join(tmpdir(), "deck-similarity-"));
    cpSync(fixturesDir, dir, { recursive: true });
    if (clustersJson !== null) {
      mkdirSync(path.join(dir, "similarity"), { recursive: true });
      for (const name of ["similar.json", "kin.json", "replay.json"]) writeFileSync(path.join(dir, "similarity", name), "{}");
      writeFileSync(path.join(dir, "similarity", "clusters.json"), clustersJson);
    }
    return loadStore(dir);
  };

  it("reports no similarity run as a note when the similarity directory is absent", () => {
    const store = copyWithSimilarity(null);
    expect(deckEnvOf(store).clusters).toBeNull();
    const out = body(
      DECK_TOOLS.deck_audit.handler(store, { decklist: lines(["Death Trooper", 3]), leader: "04010001", base: "0101030" }),
    );
    expect(out.clusterGaps.note).toContain("unavailable");
  });

  it("fails the deck environment when clusters.json is corrupt instead of returning empty clusters", () => {
    const store = copyWithSimilarity("{ not json");
    expect(() => deckEnvOf(store)).toThrow(SyntaxError);
    expect(MissingDataError.name).toBe("MissingDataError");
  });
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builtRun = newestRun(path.join(REPO_ROOT, "data/runs"));
const hasRules = builtRun !== undefined && existsSync(path.join(builtRun, "rules/sections.json"));

describe.skipIf(!hasRules)("deck construction rules against the Comprehensive Rules in the built data", () => {
  const cited: [string, RegExp][] = [
    ["1.2.1", /minimum number of cards in a deck varies by format/],
    ["1.2.2", /Leaders and bases are considered part of a deck for deckbuilding/],
    ["1.2.3", /Tokens are not part of a player.s deck/],
    ["3.2.1.a", /overrides the typical limitations on deck construction/],
    ["8.5.5", /up to 3 copies of any non-leader, non-base card/],
    ["9.2.2.a", /Exactly 1 leader.*Exactly 1 base.*minimum of 50 other cards/s],
    ["9.2.2.b", /cannot include more than 3 copies/],
    ["9.2.2.c", /sideboard of up to 10 cards/],
    ["9.2.2.d", /two most recent rotation symbols/],
  ];

  it.each(cited)("section %s says what the tool descriptions rely on", (id, pattern) => {
    const rules = rulesFor(builtRun as string);
    expect(rules.byId.get(id)?.text).toMatch(pattern);
  });

  it("verifies the cited sections at run time and applies the Data Vault minimum from the real card text", () => {
    const store = loadStore(builtRun as string);
    const out = body(
      DECK_TOOLS.deck_legality_check.handler(store, { decklist: lines(["0101033", 3]), leader: "04010001", base: "Data Vault" }),
    );
    expect(out.rulesVersion).toBe("8.0");
    expect(out.dataLimits.join(" ")).not.toContain("not found");
    expect(out.counts.minimum).toBe(60);
    expect(out.failures[0].detail).toContain("50 + 10 from Data Vault");
  });
});

describe("deck_audit, feeders and cluster gaps read the leader's lists (#140)", () => {
  const absent = path.join(mkdtempSync(path.join(tmpdir(), "swu-deck-labels-")), "absent.json");

  describe("orphan feeders in leader mode", () => {
    // Grit Brute (W1) wants self-damaged; Pinger Red (P1), Green (P2) and Blue (P3) offer it. Under Aggression+Villainy and
    // a Command base, Red and Green carry no penalty and Blue carries +2.
    const feedersOf = (leaderEnv: DeckEnv): string => body(deckAudit(leaderEnv, { decklist: lines(["W1", 3]), leader: "L1", base: "BC" })).orphanWants[0].feeders;

    it("names the feeders the leader's lists play first, most played first, and marks the unplayed ones", () => {
      const file = leaderCardsFile({ L1: [["P3", 0.5], ["P2", 0.3], ["P1", 0.01]] });
      expect(feedersOf({ ...env, leaderCards: indexLeaderCards(file) })).toBe("Pinger Blue (3, +2, 50%); Pinger Green (3, 30%); Pinger Red (3, unplayed)");
    });

    it("breaks a tie in inclusion by aspect penalty, then by pair edge", () => {
      const file = leaderCardsFile({ L1: [["P3", 0.3], ["P2", 0.3]] });
      expect(feedersOf({ ...env, leaderCards: indexLeaderCards(file) })).toBe("Pinger Green (3, 30%); Pinger Blue (3, +2, 30%); Pinger Red (3, unplayed)");
    });

    it("keeps the penalty-first order when the package holds no lists for the leader", () => {
      expect(feedersOf(env)).toBe(feedersOf({ ...env, leaderCards: indexLeaderCards(leaderCardsFile({ L2: [["P3", 0.5]] })) }));
      expect(feedersOf(env)).not.toContain("unplayed");
    });
  });

  describe("cluster gaps count a card the clusters file places elsewhere when it carries the cluster's defining tag", () => {
    // Six hand-disruption cards (offers:discard-opponent) form cluster 1; Ninth Sister carries the same tag but sits in cluster 2.
    const hand = Array.from({ length: 6 }, (_, i): Spec => ({ key: `H0${i + 1}`, title: `Hand Taker ${i + 1}`, cost: 2, icons: [], offers: ["offers:discard-opponent"] }));
    const ninth: Spec = { key: "NS", title: "Ninth Sister", cost: 3, icons: [], offers: ["offers:discard-opponent"] };
    const specs = [...SPECS, ...hand, ninth];
    const clusters: ClustersFile = {
      renderVersion: 1,
      k: 3,
      seed: 1,
      restarts: 1,
      maxIter: 1,
      inertia: 0,
      clusters: [
        { id: 0, size: 17, label: "fillers", members: FILLERS.map((f) => f.key) },
        { id: 1, size: 6, label: "hand disruption and disclose", members: hand.map((h) => h.key) },
        { id: 2, size: 2, label: "sisters", members: ["NS", "P1"] },
      ],
    };
    const file = leaderCardsFile({ L1: hand.map((h): [string, number] => [h.key, 0.5]) });
    const clusterEnv: DeckEnv = { ...buildEnv(specs, clusters), clusterLabelsPath: absent, leaderCards: indexLeaderCards(file) };
    const gaps = (decklist: ReturnType<typeof lines>) => body(deckAudit(clusterEnv, { decklist, leader: "L1", base: "BC" })).clusterGaps;
    const rowOf = (out: { clusters: Record<string, unknown>[] }, id: number) => out.clusters.find((r) => r.clusterId === id);

    it("counts Ninth Sister x2 in the hand-disruption cluster although the clusters file places her in another", () => {
      const out = gaps(lines(["NS", 2], ["R1", 4], ["PR1", 4]));
      expect(rowOf(out, 1)).toMatchObject({ label: "hand disruption and disclose", deckCards: 2, expected: 10, gap: 8 });
    });

    it("counts a card the clusters file places in the cluster as before, and a card with neither placement nor tag as nothing", () => {
      expect(rowOf(gaps(lines(["H01", 2], ["R1", 4], ["PR1", 4])), 1)).toMatchObject({ deckCards: 2 });
      expect(rowOf(gaps(lines(["R1", 5], ["PR1", 5])), 1)).toMatchObject({ deckCards: 0 });
    });

    it("documents the rule in the norm", () => {
      const norm = gaps(lines(["NS", 2], ["R1", 4])).norm as string;
      expect(norm).toContain("defining tag");
      expect(norm).toContain("deckCards");
    });
  });
});

describe("deck_audit, keyword clusters and wide-board wants (#152)", () => {
  const absent = path.join(mkdtempSync(path.join(tmpdir(), "swu-deck-labels-")), "absent.json");

  describe("a card that prints the keyword naming a cluster counts in it", () => {
    // Six printed-Raid units form cluster 1, six cards that only grant Raid form cluster 2 (both labels name kw:Raid at 100%),
    // and Raid Elsewhere prints Raid but sits in the fillers' cluster 0.
    const raiders = Array.from({ length: 6 }, (_, i): Spec => ({ key: `RD${i + 1}`, title: `Raider ${i + 1}`, cost: 2, icons: [], keywords: ["Raid"] }));
    const granters = Array.from({ length: 6 }, (_, i): Spec => ({ key: `RG${i + 1}`, title: `Granter ${i + 1}`, cost: 2, icons: [], offers: ["offers:grant-raid"] }));
    const elsewhere: Spec = { key: "RE", title: "Raid Elsewhere", cost: 2, icons: [], keywords: ["Raid"] };
    const specs = [...SPECS, ...raiders, ...granters, elsewhere];
    const clusters: ClustersFile = {
      renderVersion: 1,
      k: 3,
      seed: 1,
      restarts: 1,
      maxIter: 1,
      inertia: 0,
      clusters: [
        { id: 0, size: 18, label: "fillers", members: [...FILLERS.map((f) => f.key), "RE"] },
        { id: 1, size: 6, label: "kw:Raid(100%) word:raid(100%) word:attacking(97%)", members: raiders.map((r) => r.key) },
        { id: 2, size: 6, label: "kw:Raid(100%) word:raid(100%) word:while(50%)", members: granters.map((g) => g.key) },
      ],
    };
    const file = leaderCardsFile({ L1: [...raiders, ...granters].map((c): [string, number] => [c.key, 0.5]) });
    const clusterEnv: DeckEnv = { ...buildEnv(specs, clusters), clusterLabelsPath: absent, leaderCards: indexLeaderCards(file) };
    const gaps = (decklist: ReturnType<typeof lines>) => body(deckAudit(clusterEnv, { decklist, leader: "L1", base: "BC" })).clusterGaps;
    const rowOf = (out: { clusters: Record<string, unknown>[] }, id: number) => out.clusters.find((r) => r.clusterId === id);

    it("counts Raid Elsewhere x2 in the cluster with the most printed Raid, although the clusters file places it in cluster 0", () => {
      const out = gaps(lines(["RE", 2], ["R1", 4], ["PR1", 4]));
      expect(rowOf(out, 1)).toMatchObject({ deckCards: 2, expected: 5, gap: 3 });
    });

    it("leaves the granters cluster to the cards that grant Raid: printed Raid does not count there", () => {
      const out = gaps(lines(["RE", 2], ["RD1", 2], ["R1", 4], ["PR1", 2]));
      expect(rowOf(out, 1)).toMatchObject({ deckCards: 4 });
      expect(rowOf(out, 2)).toMatchObject({ deckCards: 0 });
    });

    it("counts a granter in its own cluster and states the keyword rule in the norm", () => {
      const out = gaps(lines(["RG1", 3], ["R1", 4], ["PR1", 3]));
      expect(rowOf(out, 2)).toMatchObject({ deckCards: 3 });
      expect(out.norm).toContain("prints the keyword naming a cluster");
    });
  });

  describe("a wide-board want is fed by the deck's own unit count", () => {
    const wide = (key: string, why: string): Spec => ({ key, title: `Wide ${key}`, cost: 3, icons: [], wants: ["wants:wide-board"], why: { "wants:wide-board": why } });
    const wideEnv = buildEnv([...SPECS, wide("WB3", "text: If you control 3 or more units, you may resource the top card of your deck."), wide("WB5", "text: While you control 5 or more units, this unit gets +2/+0."), wide("WBN", "curated cur-0001"), { key: "EV1", title: "Quiet Event", type: "Event", cost: 1, icons: [] }]);
    const orphans = (...entries: [string, number][]) => body(deckAudit(wideEnv, { decklist: lines(...entries), leader: "L1", base: "BC" })).orphanWants.map((o: { cardKey: string }) => o.cardKey);

    it("is no orphan at the clause's number of units, the card itself counted", () => {
      expect(orphans(["WB3", 1], ["F01", 2])).toEqual([]);
      expect(orphans(["WB5", 1], ["F01", 4])).toEqual([]);
    });

    it("stays an orphan below the clause's number", () => {
      expect(orphans(["WB3", 1], ["F01", 1])).toEqual(["WB3"]);
      expect(orphans(["WB5", 1], ["F01", 3])).toEqual(["WB5"]);
    });

    it("asks for 3 units when the clause names no number", () => {
      expect(orphans(["WBN", 1], ["F01", 1])).toEqual(["WBN"]);
      expect(orphans(["WBN", 1], ["F01", 2])).toEqual([]);
    });

    it("does not count a non-unit card toward the unit count", () => {
      expect(orphans(["WB3", 1], ["F01", 1], ["EV1", 2])).toEqual(["WB3"]);
    });
  });
});

import { decode } from "@toon-format/toon";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { MissingDataError, loadStore, newestRun, type CardRow, type CardStore } from "../src/data.js";
import type { ClustersFile } from "../src/embed/files.js";
import type { PlayFile, PricesFile } from "../src/market/build.js";
import { rulesFor } from "../src/rules/store.js";
import type { ScoreRow } from "../src/scorer/scores-file.js";
import { createSynergyContext } from "../src/synergy/context.js";
import type { ToolResult } from "../src/tools.js";
import {
  DECK_TOOLS,
  budgetAlternatives,
  deckAudit,
  deckEnvOf,
  deckLegalityCheck,
  fungibleInDeck,
  ownedVsNeeded,
  playValueVsPrice,
  playableCards,
  priceList,
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
    const out = body(deckAudit(buildEnv(SPECS, clusters), { decklist: lines(["P1", 4], ["P2", 4]), leader: "L1", base: "BC" }));
    // pool: 17 fillers, 3 penalty-free named cards and the unverified promo card = 21; 17 / 21 * 8 main-deck cards
    expect(out.clusterGaps.clusters).toEqual([{ clusterId: 0, label: "fillers", deckCards: 0, expected: 6.48, gap: 6.48, poolCards: 17 }]);
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
    expect(out.bestSavingPerCopy).toBe(1.4);
    expect(out.unpriced).toEqual(["Filler 1"]);
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

import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import type { CardRow, CardStore } from "../../src/data.js";
import { buildMeta, cardFacts, DEFAULT_META_OPTIONS } from "../../src/meta/build.js";
import { loadCounterTable } from "../../src/meta/counters.js";
import { SWUMETASTATS_SOURCE } from "../../src/meta/schema.js";
import { createSynergyContext } from "../../src/synergy/context.js";
import { synergyCardsSchema } from "../../src/synergy/schema.js";
import type { ToolResult } from "../../src/tools.js";
import { deckAudit, playableCards, type DeckEnv } from "../../src/tools/deck.js";
import {
  compareAnswerRank,
  costBand,
  createMetaEnv,
  evidenceClassOf,
  metaAnswers,
  metaArchetypes,
  metaThreats,
  type AnswerRank,
} from "../../src/tools/meta.js";
import { COMMITTED_TABLE, mk } from "../synergy/fixtures.js";
import { COUNTER_CARDS, deck } from "./fixtures.js";

const ENEMY_LEADER = mk("EL", "Enemy Leader", { type: "Leader", icons: ["Aggression", "Villainy"], cost: 6 });
const OUR_LEADER = mk("OL", "Our Leader", { type: "Leader", icons: ["Vigilance", "Heroism"], cost: 6, subtitle: "Defender" });
const OUR_BASE = mk("OB", "Our Base", { type: "Base", icons: ["Command"], cost: null });
const ENEMY_BASE = mk("EB", "Enemy Base", { type: "Base", icons: ["Cunning"], cost: null });
const AGGRESSION_BASE = mk("AB", "Aggression Base", { type: "Base", icons: ["Aggression"], cost: null });
const ENEMY_BASE_2 = mk("EB2", "Other Enemy Base", { type: "Base", icons: ["Cunning"], cost: null });

function featureRecord(card: ReturnType<typeof mk>, stats: { power: number | null; hp: number | null; arenas: string[] }) {
  return { ...card, structured: { ...card.structured, ...stats }, keywords: [] };
}

const extra = [
  featureRecord(ENEMY_LEADER, { power: 4, hp: 7, arenas: ["Ground"] }),
  featureRecord(OUR_LEADER, { power: 3, hp: 6, arenas: ["Ground"] }),
  featureRecord(OUR_BASE, { power: null, hp: 25, arenas: [] }),
  featureRecord(ENEMY_BASE, { power: null, hp: 25, arenas: [] }),
  featureRecord(ENEMY_BASE_2, { power: null, hp: 25, arenas: [] }),
  featureRecord(AGGRESSION_BASE, { power: null, hp: 25, arenas: [] }),
];
const features = [...COUNTER_CARDS, ...extra];
const synergy = synergyCardsSchema.parse(features);

const rows: CardRow[] = synergy.map((s) => ({
  cardKey: s.cardKey,
  title: s.title,
  subtitle: s.subtitle,
  type: s.type,
  cost: s.structured.cost,
  power: null,
  hp: null,
  aspects: s.structured.aspectIcons.join("|") || null,
  traits: null,
  keywords: null,
  arenas: null,
  text: null,
  sets: "SEC",
}));
const store: CardStore = {
  dataDir: "/nonexistent/swu-meta-tools",
  cards: rows,
  byKey: new Map(rows.map((r) => [r.cardKey, r])),
  facets: new Map([["expansion", [{ value: "SEC", cards: 0, definition: "Secrets of Power. Premier legal.", cardKeys: [] }]]]),
};
const deckEnv: DeckEnv = {
  store,
  ctx: createSynergyContext(synergy, COMMITTED_TABLE),
  market: {
    prices: { priceImportId: 1, priceImportFinishedAt: "", coverage: "", cards: [] },
    play: { source: "", note: "", windows: [], cards: [] },
    priceByKey: new Map(),
    playByKey: new Map(),
  },
  scores: new Map(),
  clusters: null,
  dataVersion: "test/0",
};

const RUSH_UNIT = "0101250"; // Corellian Freighter, a 4/4 space unit, stands in as the enemy's key unit.
const enemyDecks = Array.from({ length: 6 }, (_, i) =>
  deck(`e${i}`, { leader: "EL", base: i < 4 ? "EB" : "EB2", cards: [[RUSH_UNIT, 3]], placement: i + 1, field: 16 }),
);
const facts = cardFacts(features);
const meta = buildMeta(enemyDecks, facts, { ...DEFAULT_META_OPTIONS, minDecks: 2, minTournamentDecks: 1 });
const winrates = {
  schemaVersion: 2,
  minN: 10,
  matchups: {
    source: SWUMETASTATS_SOURCE,
    label: "tournament matchups",
    period: { from: "2026-07-19", to: "2026-10-17" },
    rows: 2,
    unresolvedRows: 0,
    matches: 12,
    pairs: [
      { leader: "OL", baseAspects: ["Command"], oppLeader: "EL", oppBaseAspects: ["Cunning"], wins: 7, losses: 5, draws: 0 },
      { leader: "EL", baseAspects: ["Cunning"], oppLeader: "OL", oppBaseAspects: ["Command"], wins: 5, losses: 7, draws: 0 },
    ],
  },
  deckEvidence: {
    source: SWUMETASTATS_SOURCE,
    label: "tournament decklists with their match record",
    basis: "card in the main deck",
    opponents: "unknown",
    window: { from: "2026-07-20", to: "2026-10-17" },
    decks: 30,
    events: 3,
    matches: 150,
    groups: [
      {
        level: "archetype",
        key: "OL|Command",
        leader: "OL",
        baseAspects: ["Command"],
        aspects: ["Command", "Heroism", "Vigilance"],
        decks: 30,
        wins: 80,
        losses: 66,
        draws: 4,
        cards: [{ cardKey: "05010264", decks: 12, wins: 36, losses: 23, draws: 1 }],
      },
    ],
  },
};
const env = createMetaEnv(deckEnv, meta, winrates, loadCounterTable(), features);

const body = (result: ToolResult): any => {
  expect(result.isError, result.content[0].text).not.toBe(true);
  return decode(result.content[0].text);
};

describe("meta_archetypes", () => {
  it("lists archetypes with share, window, threats, tournament record and the sources it rests on", () => {
    const out = body(metaArchetypes(env, {}));
    expect(out.sources.population).toBe("tournament");
    expect(out.sources.tournamentMatchups).toContain(SWUMETASTATS_SOURCE);
    expect(out.sources.answerEvidence).toContain("opponents unknown");
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].share).toBe(1);
    expect(out.rows[0].threats).toContain("key-units");
    expect(out.rows[0].tournamentRecord).toEqual({
      record: "5-7-0",
      n: 12,
      winRate: 0.4167,
      ci95: "0.1933..0.6805",
      source: SWUMETASTATS_SOURCE,
      window: "2026-07-19..2026-10-17",
    });
  });

  it("carries the most-played base as topBase, and that title resolves as the base of the next call", () => {
    const archetype = meta.archetypes[0];
    expect(archetype.bases.map((b) => b.decks)).toEqual([4, 2]);
    const out = body(metaArchetypes(env, {}));
    expect(out.rows[0].topBase).toEqual({ cardKey: archetype.bases[0].cardKey, title: archetype.bases[0].title });
    expect(out.rows[0].topBase).toEqual({ cardKey: "EB", title: "Enemy Base" });
    const base = out.rows[0].topBase.title;
    expect(body(playableCards(deckEnv, { leader: "OL", base, maxPenalty: 4 })).base.cardKey).toBe("EB");
    expect(body(deckAudit(deckEnv, { decklist: [{ card: "05010264", count: 1 }], leader: "OL", base })).base.cardKey).toBe("EB");
    expect(body(metaAnswers(env, { leader: "OL", base, maxPenalty: 4 })).base.cardKey).toBe("EB");
  });
});

describe("meta_threats", () => {
  it("describes one archetype by id or by leader, with key unit stats", () => {
    const id = meta.archetypes[0].id;
    const out = body(metaThreats(env, { archetype: id }));
    expect(out.archetype.id).toBe(id);
    expect(out.keyUnits[0]).toMatchObject({ cardKey: RUSH_UNIT, power: 4, hp: 4, arenas: "Space" });
    expect(body(metaThreats(env, { archetype: "Enemy Leader" })).archetype.id).toBe(id);
    expect(metaThreats(env, { archetype: "nope" }).isError).toBe(true);
  });
});

describe("meta_answers ordering", () => {
  // Our leader plus an Aggression base supplies every icon of It's Worse (7, neutral) and Charged with Treason (4,
  // Aggression), so both are penalty-free and answer the same threat with coverage 1; Corellian Freighter (5) and Profundity (9) cover 0.5.
  const IT_IS_WORSE = "05010264";
  const CHARGED = "06010182";
  const FREIGHTER = "0101250";
  const PROFUNDITY = "04010154"; // Aggression, cost 9, coverage 0.5 like the Freighter
  const withCards = (cards: { cardKey: string; decks: number; wins: number; losses: number; draws: number }[]) =>
    createMetaEnv(
      deckEnv,
      meta,
      {
        ...winrates,
        deckEvidence: {
          ...winrates.deckEvidence,
          groups: [
            {
              level: "archetype",
              key: "OL|Aggression",
              leader: "OL",
              baseAspects: ["Aggression"],
              aspects: ["Aggression", "Heroism", "Vigilance"],
              decks: 100,
              wins: 500,
              losses: 500,
              draws: 0,
              cards,
            },
          ],
        },
      },
      loadCounterTable(),
      features,
    );
  const order = (e: typeof env) => {
    const out = body(metaAnswers(e, { leader: "OL", base: "AB", maxPenalty: 0, limit: 20 }));
    return {
      keys: out.answers.map((a: { cardKey: string }) => a.cardKey),
      classes: Object.fromEntries(out.answers.map((a: { cardKey: string; evidenceClass: string }) => [a.cardKey, a.evidenceClass])),
      note: out.note as string,
    };
  };

  it("puts an answer with a clearly worse deck record after an unmeasured one of the same coverage, whatever its cost", () => {
    const got = order(withCards([{ cardKey: CHARGED, decks: 20, wins: 10, losses: 30, draws: 0 }]));
    expect(got.keys).toEqual([IT_IS_WORSE, CHARGED, FREIGHTER, PROFUNDITY]);
    expect(got.classes).toEqual({ [IT_IS_WORSE]: "ok", [CHARGED]: "negative", [FREIGHTER]: "ok", [PROFUNDITY]: "ok" });
    expect(got.note).toContain("evidenceClass");
    expect(got.note).toContain("-0.05");
    expect(got.note).toContain("association, not effect");
  });

  it("orders two ok answers of the same coverage by cost band, including one with a positive record", () => {
    const got = order(withCards([{ cardKey: CHARGED, decks: 20, wins: 30, losses: 10, draws: 0 }]));
    expect(got.keys).toEqual([CHARGED, IT_IS_WORSE, FREIGHTER, PROFUNDITY]);
    expect(got.classes[CHARGED]).toBe("ok");
  });

  it("classes a gap measured on fewer than minN decisive matches as ok", () => {
    const got = order(withCards([{ cardKey: CHARGED, decks: 20, wins: 2, losses: 6, draws: 0 }]));
    expect(got.keys).toEqual([CHARGED, IT_IS_WORSE, FREIGHTER, PROFUNDITY]);
    expect(got.classes[CHARGED]).toBe("ok");
  });

  it("classes an unmeasured answer as ok", () => {
    const got = order(withCards([]));
    expect(got.keys).toEqual([CHARGED, IT_IS_WORSE, FREIGHTER, PROFUNDITY]);
    expect(Object.values(got.classes)).toEqual(["ok", "ok", "ok", "ok"]);
  });
});

describe("answer rank", () => {
  const rank = (spec: Partial<AnswerRank> & { cardKey: string }): AnswerRank => ({
    penalty: 0,
    coverage: 0.3927,
    evidenceClass: "ok",
    cost: 5,
    threatCount: 1,
    ...spec,
  });
  const sorted = (list: AnswerRank[]) => [...list].sort(compareAnswerRank).map((a) => a.cardKey);

  it("bands cost as 0-2, 3-4, 5-6 and 7+, with an unknown cost last", () => {
    expect([0, 2, 3, 4, 5, 6, 7, 11].map(costBand)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(costBand(null)).toBe(4);
  });

  it("sorts on penalty, coverage band, evidence class, cost band, coverage, threats, then card key", () => {
    expect(sorted([rank({ cardKey: "b", penalty: 2 }), rank({ cardKey: "a", penalty: 0, evidenceClass: "negative", coverage: 0.01 })])).toEqual(["a", "b"]);
    // 0.3927 and 0.40 share the 0.40 band; 0.3499 falls in the 0.35 band below it.
    expect(sorted([rank({ cardKey: "low", coverage: 0.3499 }), rank({ cardKey: "high", coverage: 0.3927 })])).toEqual(["high", "low"]);
    expect(sorted([rank({ cardKey: "neg", cost: 2, evidenceClass: "negative" }), rank({ cardKey: "ok", cost: 11 })])).toEqual(["ok", "neg"]);
    expect(sorted([rank({ cardKey: "seven", cost: 7 }), rank({ cardKey: "six", cost: 6 }), rank({ cardKey: "three", cost: 3 })])).toEqual(["three", "six", "seven"]);
    expect(sorted([rank({ cardKey: "b", cost: 5, coverage: 0.3925 }), rank({ cardKey: "a", cost: 6, coverage: 0.3927 })])).toEqual(["a", "b"]);
    expect(sorted([rank({ cardKey: "a", cost: 5 }), rank({ cardKey: "b", cost: 6, threatCount: 2 })])).toEqual(["b", "a"]);
    expect(sorted([rank({ cardKey: "b" }), rank({ cardKey: "a" })])).toEqual(["a", "b"]);
  });

  it("calls a difference below -0.05 negative only when both sides reach minN decisive matches", () => {
    const evidence = (difference: number | null, withN: number, withoutN: number) => ({
      withCard: { n: withN },
      withoutCard: { n: withoutN },
      difference,
    });
    expect(evidenceClassOf(evidence(-0.1154, 45, 13217), 10)).toBe("negative");
    expect(evidenceClassOf(evidence(-0.0443, 45, 13217), 10)).toBe("ok");
    expect(evidenceClassOf(evidence(-0.05, 45, 13217), 10)).toBe("ok");
    expect(evidenceClassOf(evidence(-0.3, 9, 13217), 10)).toBe("ok");
    expect(evidenceClassOf(evidence(-0.3, 45, 9), 10)).toBe("ok");
    expect(evidenceClassOf(evidence(null, 45, 9000), 10)).toBe("ok");
    expect(evidenceClassOf("no tournament decklists captured", 10)).toBe("ok");
  });
});

describe("meta_answers", () => {
  it("returns penalty-free answers first with clause evidence, candidate status, coverage and win rate with n", () => {
    const out = body(metaAnswers(env, { leader: "OL", base: "OB", maxPenalty: 4, limit: 20 }));
    expect(out.defendingAgainst[0].ourTournamentRecord).toMatchObject({ record: "7-5-0", n: 12, winRate: 0.5833, source: SWUMETASTATS_SOURCE });
    const penalties = out.answers.map((a: { penalty: number }) => a.penalty);
    expect(penalties).toEqual([...penalties].sort((a, b) => a - b));
    const itsWorse = out.answers.find((a: { cardKey: string }) => a.cardKey === "05010264");
    expect(itsWorse.status).toBe("candidate");
    expect(itsWorse.coverage).toBe(1);
    expect(itsWorse.answers[0]).toMatchObject({
      threat: "key-units",
      relation: "defeat-key-unit",
      evidence: "text: Defeat a non-leader unit.",
    });
    expect(itsWorse.deckEvidence).toEqual({
      comparable: "Our Leader, Defender / Command base decks",
      withCard: { decks: 12, record: "36-23-1", n: 59, winRate: 0.6102, ci95: "0.4827..0.7242" },
      withoutCard: { decks: 18, record: "44-43-3", n: 87, winRate: 0.5057, ci95: "0.4027..0.6083" },
      difference: 0.1045,
      opponents: "unknown",
      source: SWUMETASTATS_SOURCE,
      window: "2026-07-20..2026-10-17",
    });
    const noEvidence = out.answers.find((a: { cardKey: string; deckEvidence: unknown }) => typeof a.deckEvidence === "string");
    expect(noEvidence.deckEvidence).toContain("fewer than 10 decisive matches");
    const allClear = out.answers.find((a: { cardKey: string }) => a.cardKey === "04010055");
    expect(allClear).toBeUndefined();
  });

  it("marks cards already in the deck, takes the leader and base from the decklist, and drops evidence on request", () => {
    const out = body(
      metaAnswers(env, {
        decklist: [
          { card: "OL", count: 1 },
          { card: "OB", count: 1 },
          { card: "05010264", count: 2 },
        ],
        maxPenalty: 4,
        evidence: false,
      }),
    );
    expect(out.leader.cardKey).toBe("OL");
    expect(out.answers.find((a: { cardKey: string }) => a.cardKey === "05010264").inDeck).toBe(2);
    expect(out.answers.flatMap((a: { answers: object[] }) => a.answers).filter((x: object) => "evidence" in x)).toEqual([]);
  });

  it("asks for a leader and base when neither is given", () => {
    expect(metaAnswers(env, {}).isError).toBe(true);
  });
});

describe("tool output carries no Karabast number (D22)", () => {
  it("names only swumetastats as a win-rate source in all three meta tools", () => {
    const outputs = [
      metaArchetypes(env, {}),
      metaThreats(env, { archetype: meta.archetypes[0].id }),
      metaAnswers(env, { leader: "OL", base: "OB", maxPenalty: 4, limit: 60 }),
    ].map((r) => r.content[0].text);
    for (const text of outputs) {
      expect(text.toLowerCase()).not.toContain("karabast");
      expect(text).toContain(SWUMETASTATS_SOURCE);
    }
  });
});

import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import type { CardRow, CardStore } from "../../src/data.js";
import { buildLeaderCards, buildMeta, cardFacts, DEFAULT_META_OPTIONS } from "../../src/meta/build.js";
import { loadCounterTable } from "../../src/meta/counters.js";
import { indexLeaderCards, LEADER_CARDS_MAX, leaderCardsFileSchema, SWUMETASTATS_SOURCE, type MetaFile } from "../../src/meta/schema.js";
import { createSynergyContext } from "../../src/synergy/context.js";
import { synergyCardsSchema } from "../../src/synergy/schema.js";
import type { ToolResult } from "../../src/tools.js";
import { deckAudit, playableCards, type DeckEnv } from "../../src/tools/deck.js";
import {
  compareAnswerRank,
  costBand,
  createMetaEnv,
  evidenceClassOf,
  leaderCards,
  metaAnswers,
  metaArchetypes,
  metaThreats,
  primaryThreatOf,
  type AnswerRank,
} from "../../src/tools/meta.js";
import { COMMITTED_TABLE, mk } from "../synergy/fixtures.js";
import { COUNTER_CARDS, deck, fact, LEADER_CARDS_DECKS, LEADER_CARDS_FACTS } from "./fixtures.js";

const ENEMY_LEADER = mk("EL", "Enemy Leader", { type: "Leader", icons: ["Aggression", "Villainy"], cost: 6 });
const OUR_LEADER = mk("OL", "Our Leader", { type: "Leader", icons: ["Vigilance", "Heroism"], cost: 6, subtitle: "Defender" });
const OUR_BASE = mk("OB", "Our Base", { type: "Base", icons: ["Command"], cost: null });
const ENEMY_BASE = mk("EB", "Enemy Base", { type: "Base", icons: ["Cunning"], cost: null });
const AGGRESSION_BASE = mk("AB", "Aggression Base", { type: "Base", icons: ["Aggression"], cost: null });
const ENEMY_BASE_2 = mk("EB2", "Other Enemy Base", { type: "Base", icons: ["Cunning"], cost: null });
const BOUNTY_BOSS = mk("LC", "Bounty Boss", { type: "Leader", icons: ["Command", "Heroism"], cost: 5 });
const CASUAL_LEADER = mk("CL", "Casual Leader", { type: "Leader", icons: ["Cunning"], cost: 4 });

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
  featureRecord(BOUNTY_BOSS, { power: 3, hp: 6, arenas: ["Ground"] }),
  featureRecord(CASUAL_LEADER, { power: 2, hp: 5, arenas: ["Ground"] }),
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
/** The fixture's one 4-cost rush unit is no heavy unit (D63), so its archetypes are marked as leaning on two, which is what fires key-units. */
const leaningOnHeavyUnits = (file: MetaFile): MetaFile => ({
  ...file,
  archetypes: file.archetypes.map((a) => ({ ...a, profile: { ...a.profile, heavyKeyUnits: 2 } })),
});
const meta = leaningOnHeavyUnits(buildMeta(enemyDecks, facts, { ...DEFAULT_META_OPTIONS, minDecks: 2, minTournamentDecks: 1 }));
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
/** meta_answers lists its rows as staples then additions (D46); the rank tests read them as one page. */
const pageOf = (out: { staples: any[]; additions: any[] }): any[] => [...out.staples, ...out.additions];

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

describe("meta_threats falls back to the leader's community decks (#144)", () => {
  // Casual Leader (CL) has three community lists and no tournament deck; Our Leader (OL) has none in either population.
  const communityDecks = Array.from({ length: 3 }, (_, i) =>
    deck(`c${i}`, { leader: "CL", base: "OB", cards: [[RUSH_UNIT, 3]], population: "community", source: "swudb", event: null, placement: null }),
  );
  const mixed = leaningOnHeavyUnits(buildMeta([...enemyDecks, ...communityDecks], facts, { ...DEFAULT_META_OPTIONS, minDecks: 2, minTournamentDecks: 1 }));
  const casualFile = leaderCardsFileSchema.parse({
    schemaVersion: 1,
    window: { from: "2026-07-04", to: "2026-10-01", days: 90 },
    weighting: "test weighting",
    baseline: "test baseline",
    maxCards: 150,
    leaders: [
      {
        leader: { cardKey: "CL", title: "Casual Leader", aspects: ["Cunning"] },
        population: "community",
        fallback: true,
        decks: 3,
        weight: 3,
        window: { from: "2026-07-04", to: "2026-10-01" },
        topBase: null,
        cards: [{ cardKey: RUSH_UNIT, title: RUSH_UNIT, inclusion: 1, meanCopies: 3, baselineInclusion: 0.1, lift: 0.9 }],
      },
    ],
  });
  const withCommunity = createMetaEnv({ ...deckEnv, leaderCards: indexLeaderCards(casualFile) }, mixed, winrates, loadCounterTable(), features);

  it("builds the profile from the community archetype and labels it population community, fallback true, with the leader's deck count", () => {
    expect(mixed.archetypes.filter((a) => a.leader.cardKey === "CL").map((a) => a.population)).toEqual(["community"]);
    const out = body(metaThreats(withCommunity, { archetype: "CL", coreLimit: 8 }));
    expect(out.archetype.population).toBe("community");
    expect(out.archetype.decks).toBe(3);
    expect(out.leaderSource).toEqual({ population: "community", fallback: true, decks: 3, window: "2026-07-04..2026-10-01" });
    expect(out.sources.population).toBe("community");
    expect(out.note).toContain("community");
    expect(out.keyUnits[0]).toMatchObject({ cardKey: RUSH_UNIT });
  });

  it("keeps the tournament archetype, with no fallback label, for a leader that has one", () => {
    const out = body(metaThreats(withCommunity, { archetype: "EL" }));
    expect(out.archetype.population).toBe("tournament");
    expect(out.leaderSource).toBeNull();
  });

  it("reports one consistent source: sources.fallback agrees with leaderSource.fallback, and a tournament answer keeps both false/null (#152)", () => {
    const fallback = body(metaThreats(withCommunity, { archetype: "CL", coreLimit: 8 }));
    expect(fallback.sources.fallback).toBe(true);
    expect(fallback.leaderSource.fallback).toBe(true);
    const tournament = body(metaThreats(withCommunity, { archetype: "EL" }));
    expect(tournament.sources.fallback).toBe(false);
    expect(tournament.leaderSource).toBeNull();
  });

  it("claims a tournament record in the note only when tournamentRecord holds one (#152)", () => {
    const out = body(metaThreats(withCommunity, { archetype: "CL", coreLimit: 8 }));
    expect(out.archetype.tournamentRecord).toBeNull();
    expect(out.note).toContain("tournamentRecord is null");
    expect(out.note).not.toContain("still tournament data");
  });

  it("profiles the leader's archetype with the given base when the leader is a cardKey, and errors for a base it has no list with", () => {
    expect(body(metaThreats(withCommunity, { archetype: "CL", base: "OB" })).archetype.population).toBe("community");
    const miss = metaThreats(withCommunity, { archetype: "CL", base: "AB" });
    expect(miss.isError).toBe(true);
    expect(miss.content[0].text).toContain("Aggression");
    expect(metaThreats(withCommunity, { archetype: meta.archetypes[0].id, base: "OB" }).isError).toBe(true);
  });

  it("errors only when neither population holds a deck for the leader, naming both counts and the window", () => {
    const none = metaThreats(withCommunity, { archetype: "OL" });
    expect(none.isError).toBe(true);
    expect(none.content[0].text).toContain(`0 tournament decks, 0 community decks in ${mixed.window.from}..${mixed.window.to}`);
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
      keys: pageOf(out).map((a: { cardKey: string }) => a.cardKey),
      classes: Object.fromEntries(pageOf(out).map((a: { cardKey: string; evidenceClass: string }) => [a.cardKey, a.evidenceClass])),
      note: out.note as string,
    };
  };

  // D85 (#167): a negative addition takes no page slot; it is listed apart under negativeAdditions.
  it("takes an answer with a clearly worse deck record off the page and lists it under negativeAdditions, whatever its cost", () => {
    const e = withCards([{ cardKey: CHARGED, decks: 20, wins: 10, losses: 30, draws: 0 }]);
    const got = order(e);
    expect(got.keys).toEqual([IT_IS_WORSE, FREIGHTER, PROFUNDITY]);
    expect(got.classes).toEqual({ [IT_IS_WORSE]: "unmeasured", [FREIGHTER]: "unmeasured", [PROFUNDITY]: "unmeasured" });
    const out = body(metaAnswers(e, { leader: "OL", base: "AB", maxPenalty: 0, limit: 20 }));
    expect((out.negativeAdditions as { cardKey: string; evidenceClass: string }[]).map((a) => [a.cardKey, a.evidenceClass])).toEqual([[CHARGED, "negative"]]);
    expect(got.note).toContain("evidenceClass");
    expect(got.note).toContain("-0.05");
    expect(got.note).toContain("association, not effect");
  });

  it("orders two ok answers of the same coverage by cost band, including one with a positive record", () => {
    const got = order(withCards([{ cardKey: CHARGED, decks: 20, wins: 30, losses: 10, draws: 0 }]));
    expect(got.keys).toEqual([CHARGED, IT_IS_WORSE, FREIGHTER, PROFUNDITY]);
    expect(got.classes[CHARGED]).toBe("ok");
  });

  it("classes a gap measured on fewer than minN decisive matches as unmeasured, still sorted with ok", () => {
    const got = order(withCards([{ cardKey: CHARGED, decks: 20, wins: 2, losses: 6, draws: 0 }]));
    expect(got.keys).toEqual([CHARGED, IT_IS_WORSE, FREIGHTER, PROFUNDITY]);
    expect(got.classes[CHARGED]).toBe("unmeasured");
  });

  it("classes an answer with no deck evidence as unmeasured, still sorted with ok", () => {
    const got = order(withCards([]));
    expect(got.keys).toEqual([CHARGED, IT_IS_WORSE, FREIGHTER, PROFUNDITY]);
    expect(Object.values(got.classes)).toEqual(["unmeasured", "unmeasured", "unmeasured", "unmeasured"]);
  });

  it("classes a card with 8 decks on one side as unmeasured however many matches they played, and says which side is thin", () => {
    // 92 of the group's 100 decks include the card, so 8 do not; both sides still have more than minN decisive matches.
    const e = withCards([{ cardKey: CHARGED, decks: 92, wins: 460, losses: 400, draws: 0 }]);
    const out = body(metaAnswers(e, { leader: "OL", base: "AB", maxPenalty: 0, limit: 20 }));
    const charged = pageOf(out).find((a: { cardKey: string }) => a.cardKey === CHARGED);
    expect(charged.deckEvidence.withoutCard.decks).toBe(8);
    expect(charged.deckEvidence.withoutCard.n).toBeGreaterThanOrEqual(10);
    expect(charged.deckEvidence.difference).toBeGreaterThan(-0.05);
    expect(charged.evidenceClass).toBe("unmeasured");
    expect(charged.deckEvidence.unmeasured).toContain("withoutCard has 8 decks");
    expect(charged.deckEvidence.unmeasured).toContain("needs 10");
    expect(pageOf(out).map((a: { cardKey: string }) => a.cardKey)).toEqual([CHARGED, IT_IS_WORSE, FREIGHTER, PROFUNDITY]);
    expect(out.note).toContain("unmeasured");
  });

  it("keeps a clearly negative gap negative on a thin deck count, demoted and marked thin", () => {
    // 5 decks with the card, 15 decisive matches, win rate 0.2 against about 0.5 without it.
    const e = withCards([{ cardKey: CHARGED, decks: 5, wins: 3, losses: 12, draws: 0 }]);
    const out = body(metaAnswers(e, { leader: "OL", base: "AB", maxPenalty: 0, limit: 20 }));
    // D85 (#167): the negative row leaves the page for negativeAdditions, its evidence unchanged.
    const charged = (out.negativeAdditions as { cardKey: string }[]).find((a) => a.cardKey === CHARGED) as any;
    expect(charged.evidenceClass).toBe("negative");
    expect(charged.deckEvidence.withCard.decks).toBe(5);
    expect(charged.deckEvidence.thin).toBe("(thin: 5 decks with the card)");
    expect(charged.deckEvidence.unmeasured).toBeUndefined();
    expect(pageOf(out).map((a: { cardKey: string }) => a.cardKey)).toEqual([IT_IS_WORSE, FREIGHTER, PROFUNDITY]);
  });

  it("keeps the class when both sides have 10 decks and minN decisive matches", () => {
    const e = withCards([{ cardKey: CHARGED, decks: 90, wins: 100, losses: 400, draws: 0 }]);
    const out = body(metaAnswers(e, { leader: "OL", base: "AB", maxPenalty: 0, limit: 20 }));
    // D85 (#167): a negative addition is listed under negativeAdditions.
    const charged = (out.negativeAdditions as { cardKey: string }[]).find((a) => a.cardKey === CHARGED) as any;
    expect(charged.evidenceClass).toBe("negative");
    expect(charged.deckEvidence.unmeasured).toBeUndefined();
    expect(charged.deckEvidence.thin).toBeUndefined();
  });
});

describe("meta_answers per-threat diversity", () => {
  // The fixture archetype fires only key-units and space-heavy. A table copy that also fires shields and go-wide (meanCost
  // is always read, so min 0 always holds) lets Insurgent Saboteurs and System Shock (defeat-upgrade) answer shields,
  // while no penalty-free card in the pool is a sweeper for go-wide.
  const SYSTEM_SHOCK = "04010175";
  const table = loadCounterTable();
  const alwaysOn = { ...table, threats: table.threats.map((t) => (t.id === "shields" || t.id === "go-wide" ? { ...t, metrics: ["meanCost"], min: 0 } : t)) };
  const wide = createMetaEnv(deckEnv, meta, winrates, alwaysOn, features);
  const run = (extra: object) => body(metaAnswers(wide, { leader: "OL", base: "AB", maxPenalty: 0, limit: 20, ...extra }));

  it("names the primary threat of an answer as the one adding the most share-weighted coverage, a tie going to the lower id", () => {
    const hit = (threat: string, weight: number, fraction = 1) => ({ archetype: { share: 0.5 }, hit: { threat, weight, fraction } });
    expect(primaryThreatOf([hit("shields", 1), hit("key-units", 0.5)])).toBe("shields");
    expect(primaryThreatOf([hit("shields", 0.5), hit("key-units", 0.5)])).toBe("key-units");
    expect(primaryThreatOf([hit("shields", 1, 0.2), hit("key-units", 0.5), hit("key-units", 0.5)])).toBe("key-units");
  });

  it("moves an answer to a threat the page lacks ahead of a second answer to a threat it already lists", () => {
    // Uncapped rank: System Shock (shields), Charged with Treason (key-units), Insurgent Saboteurs (shields),
    // It's Worse (key-units), Rebel Pathfinder (shields), Corellian Freighter (space-heavy), Profundity (space-heavy).
    const uncapped = run({ perThreat: 60, limit: 3, minPerThreat: 0 });
    expect(uncapped.capped).toBe(0);
    expect(pageOf(uncapped).map((a: { primaryThreat: string }) => a.primaryThreat)).toEqual(["shields", "key-units", "shields"]);

    const capped = run({ perThreat: 1, limit: 3 });
    expect(pageOf(capped).map((a: { cardKey: string; primaryThreat: string }) => [a.cardKey, a.primaryThreat])).toEqual([
      [SYSTEM_SHOCK, "shields"],
      ["06010182", "key-units"],
      ["0101250", "space-heavy"],
    ]);
    expect(capped.capped).toBe(4);
    expect(capped.note).toContain("perThreat 1");
  });

  it("defers the rows past the cap in rank order behind the kept ones, and drops none", () => {
    const out = run({ perThreat: 1 });
    expect(pageOf(out).map((a: { cardKey: string }) => a.cardKey)).toEqual([SYSTEM_SHOCK, "06010182", "0101250", "04010168", "05010264", "0101239", "04010154"]);
    expect(out.shown).toBe(out.matched);
    expect(run({ perThreat: 2 }).capped).toBe(1);
  });

  it("lists every fired threat with its shown-answer count, 0 for a threat nothing answers", () => {
    const out = run({ perThreat: 1, limit: 3 });
    expect(out.threatsCovered).toMatch(/key-units [1-9]\d* \(share 1\)/);
    expect(out.threatsCovered).toMatch(/shields [1-9]\d* \(share 1\)/);
    expect(out.threatsCovered).toContain("go-wide 0 (share 1)");
  });

  it("rejects a perThreat outside 1-60", () => {
    expect(() => metaAnswers(wide, { leader: "OL", base: "AB", perThreat: 0 })).toThrow();
    expect(() => metaAnswers(wide, { leader: "OL", base: "AB", perThreat: 61 })).toThrow();
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

  it("breaks a tie on the leader's decklist inclusion after evidence class and cost band, before exact coverage (D45)", () => {
    // Same band 0.40, same class, same cost band 2: the more-played card leads although its exact coverage is lower.
    expect(
      sorted([
        rank({ cardKey: "rare", cost: 5, coverage: 0.3927, leaderInclusion: 0.03 }),
        rank({ cardKey: "staple", cost: 6, coverage: 0.3925, leaderInclusion: 0.4 }),
      ]),
    ).toEqual(["staple", "rare"]);
    // An unplayed card (null) sorts behind every played one, and a card with no leader data ties as before.
    expect(
      sorted([rank({ cardKey: "none", leaderInclusion: null }), rank({ cardKey: "some", leaderInclusion: 0.001 })]),
    ).toEqual(["some", "none"]);
    expect(sorted([rank({ cardKey: "b" }), rank({ cardKey: "a" })])).toEqual(["a", "b"]);
    // Cost band, evidence class and coverage band still outrank inclusion.
    expect(sorted([rank({ cardKey: "late", cost: 11, leaderInclusion: 0.9 }), rank({ cardKey: "early", cost: 3, leaderInclusion: 0.1 })])).toEqual(["early", "late"]);
    expect(sorted([rank({ cardKey: "neg", evidenceClass: "negative", leaderInclusion: 0.9 }), rank({ cardKey: "ok", leaderInclusion: 0.1 })])).toEqual(["ok", "neg"]);
    expect(sorted([rank({ cardKey: "low", coverage: 0.3499, leaderInclusion: 0.9 }), rank({ cardKey: "high", coverage: 0.3927, leaderInclusion: 0.1 })])).toEqual(["high", "low"]);
  });

  it("calls a difference below -0.05 negative on minN decisive matches per side, and ok only with 10 decks per side too", () => {
    const evidence = (difference: number | null, withN: number, withoutN: number, withDecks = 40, withoutDecks = 4000) => ({
      withCard: { n: withN, decks: withDecks },
      withoutCard: { n: withoutN, decks: withoutDecks },
      difference,
    });
    expect(evidenceClassOf(evidence(-0.1154, 45, 13217), 10)).toBe("negative");
    expect(evidenceClassOf(evidence(-0.0443, 45, 13217), 10)).toBe("ok");
    expect(evidenceClassOf(evidence(-0.05, 45, 13217), 10)).toBe("ok");
    expect(evidenceClassOf(evidence(-0.3, 9, 13217), 10)).toBe("unmeasured");
    expect(evidenceClassOf(evidence(-0.3, 45, 9), 10)).toBe("unmeasured");
    expect(evidenceClassOf(evidence(-0.3, 45, 13217, 40, 8), 10)).toBe("negative");
    expect(evidenceClassOf(evidence(-0.1154, 45, 13217, 9, 2140), 10)).toBe("negative");
    expect(evidenceClassOf(evidence(0.3, 45, 13217, 9, 4000), 10)).toBe("unmeasured");
    expect(evidenceClassOf(evidence(-0.0443, 45, 13217, 40, 8), 10)).toBe("unmeasured");
    expect(evidenceClassOf(evidence(-0.3, 9, 13217, 40, 4000), 10)).toBe("unmeasured");
    expect(evidenceClassOf(evidence(0.3, 45, 13217, 10, 10), 10)).toBe("ok");
    expect(evidenceClassOf(evidence(null, 45, 9000), 10)).toBe("unmeasured");
    expect(evidenceClassOf("no tournament decklists captured", 10)).toBe("unmeasured");
  });

  describe("thin-control (#139)", () => {
    const evidence = (difference: number, withDecks: number, withoutDecks: number) => ({
      withCard: { n: 400, decks: withDecks },
      withoutCard: { n: 400, decks: withoutDecks },
      difference,
    });

    it("does not call a withoutCard group of 10 decks among 310 comparable decks ok: Marrok's figure is not card impact", () => {
      expect(evidenceClassOf(evidence(0.1385, 300, 10), 10)).toBe("thin-control");
    });

    it("needs the without-card side to hold the smaller of 10% of the comparable decks and 50 decks", () => {
      expect(evidenceClassOf(evidence(0.1251, 284, 16), 10)).toBe("thin-control");
      expect(evidenceClassOf(evidence(0.1, 450, 50), 10)).toBe("ok");
      expect(evidenceClassOf(evidence(0.1, 460, 49), 10)).toBe("thin-control");
      expect(evidenceClassOf(evidence(0.1, 90, 10), 10)).toBe("ok");
      expect(evidenceClassOf(evidence(0.1, 91, 9), 10)).toBe("unmeasured");
    });

    it("does not hold the with-card side to the control rule", () => {
      expect(evidenceClassOf(evidence(0.1, 12, 4000), 10)).toBe("ok");
    });

    it("leaves a negative gap negative and a side under 10 decks unmeasured", () => {
      expect(evidenceClassOf(evidence(-0.2, 300, 10), 10)).toBe("negative");
      expect(evidenceClassOf(evidence(0.2, 300, 9), 10)).toBe("unmeasured");
    });

    it("labels the answer thin-control with the counts and sorts it with ok, not behind the negatives", () => {
      const thin = createMetaEnv(
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
                decks: 400,
                wins: 210,
                losses: 190,
                draws: 0,
                cards: [{ cardKey: "06010182", decks: 390, wins: 200, losses: 150, draws: 0 }],
              },
            ],
          },
        },
        loadCounterTable(),
        features,
      );
      const out = body(metaAnswers(thin, { leader: "OL", base: "AB", maxPenalty: 0, limit: 20 }));
      const charged = pageOf(out).find((a: { cardKey: string }) => a.cardKey === "06010182");
      expect(charged.deckEvidence.withoutCard.decks).toBe(10);
      expect(charged.deckEvidence.difference).toBeGreaterThan(0.1);
      expect(charged.evidenceClass).toBe("thin-control");
      expect(charged.deckEvidence.thinControl).toBe("the decks without this card are 10 of 400 comparable decks: not a control group");
      expect(out.note).toContain("thin-control");
    });
  });

  it("sorts unmeasured with ok and only negative behind them", () => {
    expect(
      sorted([
        rank({ cardKey: "neg", cost: 2, evidenceClass: "negative" }),
        rank({ cardKey: "unm", cost: 11, evidenceClass: "unmeasured" }),
        rank({ cardKey: "ok", cost: 11 }),
      ]),
    ).toEqual(["ok", "unm", "neg"]);
    expect(sorted([rank({ cardKey: "unm", cost: 5, evidenceClass: "unmeasured" }), rank({ cardKey: "ok", cost: 7 })])).toEqual(["unm", "ok"]);
  });
});

describe("meta_answers", () => {
  it("returns penalty-free answers first with clause evidence, candidate status, coverage and win rate with n", () => {
    const out = body(metaAnswers(env, { leader: "OL", base: "OB", maxPenalty: 4, limit: 20 }));
    expect(out.defendingAgainst[0].ourTournamentRecord).toMatchObject({ record: "7-5-0", n: 12, winRate: 0.5833, source: SWUMETASTATS_SOURCE });
    const penalties = pageOf(out).map((a: { penalty: number }) => a.penalty);
    expect(penalties).toEqual([...penalties].sort((a, b) => a - b));
    const itsWorse = pageOf(out).find((a: { cardKey: string }) => a.cardKey === "05010264");
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
    const noEvidence = pageOf(out).find((a: { cardKey: string; deckEvidence: unknown }) => typeof a.deckEvidence === "string");
    expect(noEvidence.deckEvidence).toContain("fewer than 10 decisive matches");
    const allClear = pageOf(out).find((a: { cardKey: string }) => a.cardKey === "04010055");
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
    expect(pageOf(out).find((a: { cardKey: string }) => a.cardKey === "05010264").inDeck).toBe(2);
    expect(pageOf(out).flatMap((a: { answers: object[] }) => a.answers).filter((x: object) => "evidence" in x)).toEqual([]);
  });

  it("asks for a leader and base when neither is given", () => {
    expect(metaAnswers(env, {}).isError).toBe(true);
  });
});

describe("meta_answers respects what the leader plays (D45)", () => {
  // Penalty-free under Our Leader plus the Aggression base: It's Worse (7) and Charged with Treason (4) cover 1, the
  // Freighter (5) and Profundity (9) cover 0.5. The leader's decks play It's Worse (30%), the Freighter (2.5%) and
  // Charged with Treason (1%, under the 2% floor); Profundity is unplayed.
  const IT_IS_WORSE = "05010264";
  const CHARGED = "06010182";
  const FREIGHTER = "0101250";
  const PROFUNDITY = "04010154";
  const leaderFile = (rows: [string, number][]) =>
    leaderCardsFileSchema.parse({
      schemaVersion: 1,
      window: { from: "2026-07-04", to: "2026-10-01", days: 90 },
      weighting: "test weighting",
      baseline: "test baseline",
      maxCards: 150,
      leaders: [
        {
          leader: { cardKey: "OL", title: "Our Leader", aspects: ["Vigilance", "Heroism"] },
          population: "tournament",
          fallback: false,
          decks: 12,
          weight: 18,
          window: { from: "2026-07-04", to: "2026-10-01" },
          topBase: null,
          cards: rows.map(([cardKey, inclusion]) => ({ cardKey, title: cardKey, inclusion, meanCopies: 2, baselineInclusion: 0.1, lift: inclusion - 0.1 })),
        },
      ],
    });
  const played = createMetaEnv(
    { ...deckEnv, leaderCards: indexLeaderCards(leaderFile([[IT_IS_WORSE, 0.3], [FREIGHTER, 0.025], [CHARGED, 0.01]])) },
    meta,
    winrates,
    loadCounterTable(),
    features,
  );
  const run = (extra: object = {}) => body(metaAnswers(played, { leader: "OL", base: "AB", maxPenalty: 0, limit: 20, perThreat: 60, ...extra }));
  const keys = (out: any): string[] => pageOf(out).map((a: { cardKey: string }) => a.cardKey);

  it("keeps on the page only answers the leader's decks play at 2% or more, and counts the rest in capped", () => {
    const out = run();
    expect(keys(out)).toEqual([IT_IS_WORSE, FREIGHTER]);
    expect(pageOf(out).map((a: { leaderInclusion: number | null }) => a.leaderInclusion)).toEqual([0.3, 0.025]);
    expect(out.matched).toBe(4);
    expect(out.shown).toBe(2);
    expect(out.capped).toBe(2);
    expect(out.leaderSource).toMatchObject({ population: "tournament", decks: 12, window: "2026-07-04..2026-10-01" });
    expect(out.note).toContain("includeUnplayed");
    expect(out.note).toContain("leaderInclusion");
  });

  it("lists every answer with leaderInclusion null for an unplayed card when includeUnplayed is true", () => {
    const out = run({ includeUnplayed: true });
    expect(new Set(keys(out))).toEqual(new Set([IT_IS_WORSE, CHARGED, FREIGHTER, PROFUNDITY]));
    const byKey = Object.fromEntries(pageOf(out).map((a: { cardKey: string; leaderInclusion: number | null }) => [a.cardKey, a.leaderInclusion]));
    expect(byKey).toEqual({ [IT_IS_WORSE]: 0.3, [CHARGED]: 0.01, [FREIGHTER]: 0.025, [PROFUNDITY]: null });
    expect(out.capped).toBe(0);
  });

  it("keeps a card already in the deck even when the leader's decks do not play it", () => {
    const out = run({
      decklist: [
        { card: "OL", count: 1 },
        { card: "AB", count: 1 },
        { card: PROFUNDITY, count: 1 },
      ],
    });
    expect(keys(out)).toContain(PROFUNDITY);
    expect(keys(out)).not.toContain(CHARGED);
    expect(out.capped).toBe(1);
  });

  it("does not filter when the package has no decklist data for the leader", () => {
    const out = body(metaAnswers(env, { leader: "OL", base: "AB", maxPenalty: 0, limit: 20, perThreat: 60 }));
    expect(keys(out)).toHaveLength(4);
    expect(pageOf(out)[0].leaderInclusion).toBeNull();
    expect(out.leaderSource).toBeNull();
  });

  it("lists Marrok as a sentinel-wall answer with the condition, so the threat shows an answer", () => {
    const sentinel = { ...loadCounterTable(), threats: loadCounterTable().threats.map((t) => (t.id === "sentinel-wall" ? { ...t, metrics: ["meanCost"], min: 0 } : t)) };
    const walled = createMetaEnv(deckEnv, meta, winrates, sentinel, features);
    const out = body(metaAnswers(walled, { leader: "OL", base: "AB", maxPenalty: 4, limit: 60, perThreat: 60 }));
    const marrok = pageOf(out).find((a: { cardKey: string }) => a.cardKey === "08010030");
    expect(marrok.answers).toContainEqual(
      expect.objectContaining({ threat: "sentinel-wall", relation: "sentinel-bypass-conditional", offer: "offers:gain-saboteur-self" }),
    );
    expect(marrok.answers.find((x: { threat: string }) => x.threat === "sentinel-wall").evidence).toContain("While this unit is upgraded");
    expect(out.threatsCovered).toMatch(/sentinel-wall [1-9]\d* \(share 1\)/);
  });

  it("does not let hidden unplayed rows use up a perThreat slot", () => {
    // Charged with Treason (hidden, 1%) and It's Worse share the key-units threat; the hidden one must not defer the played one.
    const out = run({ perThreat: 1 });
    expect(keys(out)).toEqual([IT_IS_WORSE, FREIGHTER]);
    expect(out.capped).toBe(2);
  });
});

describe("meta_answers reserves a slot per threat, marks symmetric sweeps, and separates staples from additions (D46)", () => {
  const IT_IS_WORSE = "05010264";
  const CHARGED = "06010182";
  const FREIGHTER = "0101250";
  const PROFUNDITY = "04010154";
  const REACTOR = "00SYM"; // "Defeat all units.", cost 2: undemoted it would lead its coverage band.

  const itsWorse = COUNTER_CARDS.find((c) => (c as { cardKey: string }).cardKey === IT_IS_WORSE) as any;
  const reactor = {
    ...itsWorse,
    cardKey: REACTOR,
    title: "Reactor Ignition",
    structured: { ...itsWorse.structured, cost: 2 },
    faces: {
      text: [
        {
          ...itsWorse.faces.text[0],
          clauses: [
            {
              ...itsWorse.faces.text[0].clauses[0],
              text: "Defeat all units.",
              effects: [
                { rule: "defeat_all", cat: "defeat", n: "all", target: { side: "any", kind: "unit", arena: "any", quant: "all", restrict: [], text: "all units" } },
              ],
            },
          ],
        },
      ],
    },
    tags: { offers: [{ tag: "offers:defeat-any-unit", why: "text: Defeat all units." }], wants: [] },
  };
  const sweepFeatures = [...features, reactor];
  const sweepSynergy = synergyCardsSchema.parse(sweepFeatures);
  const sweepRows: CardRow[] = sweepSynergy.map((s) => ({ ...(rows.find((r) => r.cardKey === s.cardKey) ?? rows[0]), cardKey: s.cardKey, title: s.title, subtitle: s.subtitle, type: s.type, cost: s.structured.cost, aspects: s.structured.aspectIcons.join("|") || null }));
  const sweepStore: CardStore = { ...store, cards: sweepRows, byKey: new Map(sweepRows.map((r) => [r.cardKey, r])) };
  const sweepDeck: DeckEnv = { ...deckEnv, store: sweepStore, ctx: createSynergyContext(sweepSynergy, COMMITTED_TABLE) };

  const UNITS = ["0101239", "0101250", "04010033", "04010154", "04010168", "05010101", "05010185", "08010030"];
  const leaderEnv = (rowsIn: [string, number, number?][], base: DeckEnv = sweepDeck, feats: unknown[] = sweepFeatures) =>
    createMetaEnv(
      {
        ...base,
        leaderCards: indexLeaderCards(
          leaderCardsFileSchema.parse({
            schemaVersion: 1,
            window: { from: "2026-07-04", to: "2026-10-01", days: 90 },
            weighting: "test weighting",
            baseline: "test baseline",
            maxCards: 150,
            leaders: [
              {
                leader: { cardKey: "OL", title: "Our Leader", aspects: ["Vigilance", "Heroism"] },
                population: "tournament",
                fallback: false,
                decks: 12,
                weight: 18,
                window: { from: "2026-07-04", to: "2026-10-01" },
                topBase: null,
                cards: rowsIn.map(([cardKey, inclusion, meanCopies]) => ({ cardKey, title: cardKey, inclusion, meanCopies: meanCopies ?? 2, baselineInclusion: 0.1, lift: inclusion - 0.1 })),
              },
            ],
          }),
        ),
      },
      meta,
      winrates,
      loadCounterTable(),
      feats,
    );
  const heavy: [string, number, number][] = UNITS.map((u) => [u, 0.05, 4]); // eight units x 4 copies = 32 units
  const light: [string, number, number][] = UNITS.map((u) => [u, 0.05, 1]); // 8 units
  const run = (e: ReturnType<typeof leaderEnv>, extra: object = {}) => body(metaAnswers(e, { leader: "OL", base: "AB", maxPenalty: 0, limit: 20, perThreat: 60, ...extra }));
  const keys = (rowsIn: { cardKey: string }[]): string[] => rowsIn.map((a) => a.cardKey);

  describe("minPerThreat", () => {
    // The leader plays It's Worse and Charged with Treason (key-units) and the Freighter at 2.5% (space-heavy).
    const e = leaderEnv([[IT_IS_WORSE, 0.3], [CHARGED, 0.3], [FREIGHTER, 0.025]]);

    it("puts the best answer of an uncovered threat on a short page and marks it reserved", () => {
      const off = run(e, { limit: 2, minPerThreat: 0 });
      expect(keys(off.additions)).toEqual([CHARGED, IT_IS_WORSE]);
      expect(off.threatsCovered).toContain("space-heavy 0 (share 1)");
      const on = run(e, { limit: 2 });
      expect(keys(on.additions)).toEqual([CHARGED, FREIGHTER]);
      expect(on.additions[1]).toMatchObject({ reserved: true });
      expect(on.additions[1].hiddenByFloor).toBeUndefined();
      expect(on.additions[0].reserved).toBeUndefined();
      expect(on.threatsCovered).toMatch(/space-heavy 1 \(share 1\)/);
      expect(on.threatsCovered).toMatch(/key-units 1 \(share 1\)/);
    });

    it("defaults to 1 and takes up to 5 per threat", () => {
      expect(keys(run(e, { limit: 2 }).additions)).toEqual(keys(run(e, { limit: 2, minPerThreat: 1 }).additions));
      expect(keys(run(e, { limit: 3, minPerThreat: 2 }).additions)).toEqual([CHARGED, IT_IS_WORSE, FREIGHTER]);
      expect(() => metaAnswers(e, { leader: "OL", base: "AB", minPerThreat: 6 })).toThrow();
      expect(() => metaAnswers(e, { leader: "OL", base: "AB", minPerThreat: -1 })).toThrow();
    });

    it("includes the best hidden answer for a threat whose every answer fails the leader-inclusion floor, flagged hiddenByFloor", () => {
      const noSpace = leaderEnv([[IT_IS_WORSE, 0.3], [CHARGED, 0.3]]);
      const out = run(noSpace, { limit: 2 });
      expect(keys(out.additions)).toEqual([CHARGED, FREIGHTER]);
      expect(out.additions[1]).toMatchObject({ reserved: true, hiddenByFloor: true, leaderInclusion: null });
      expect(out.threatsCovered).toMatch(/space-heavy 1 \(share 1\)/);
      expect(out.capped).toBe(2); // Reactor Ignition and Profundity stay left out; the Freighter is on the page
      expect(out.note).toContain("minPerThreat");
      expect(run(noSpace, { limit: 2, minPerThreat: 0 }).threatsCovered).toContain("space-heavy 0 (share 1)");
      const all = run(noSpace, { limit: 20, includeUnplayed: true });
      expect(all.additions.some((a: { hiddenByFloor?: boolean }) => a.hiddenByFloor)).toBe(false);
    });

    it("counts a staple toward the threat, so no addition is reserved for it", () => {
      const out = run(e, { limit: 1, decklist: [{ card: "OL", count: 1 }, { card: "AB", count: 1 }, { card: FREIGHTER, count: 1 }] });
      expect(keys(out.staples)).toEqual([FREIGHTER]);
      expect(keys(out.additions)).toEqual([CHARGED]);
      expect(out.additions[0].reserved).toBeUndefined();
    });
  });

  describe("symmetric sweeps", () => {
    it("marks an all-units offer symmetric and sorts it after the non-symmetric answers of its band when the leader's lists run more than 30 units", () => {
      const out = run(leaderEnv([[IT_IS_WORSE, 0.3], [CHARGED, 0.3], [REACTOR, 0.3], ...heavy]));
      const order = keys(out.additions);
      expect(order.indexOf(REACTOR)).toBeGreaterThan(order.indexOf(IT_IS_WORSE));
      expect(order.indexOf(REACTOR)).toBeGreaterThan(order.indexOf(CHARGED));
      const flagged = out.additions.filter((a: { symmetric?: boolean }) => a.symmetric).map((a: { cardKey: string }) => a.cardKey);
      expect(flagged).toEqual([REACTOR]);
      expect(out.symmetricSweeps).toMatchObject({ demoted: true, units: 32 });
      expect(out.note).toContain("symmetric");
    });

    it("marks it but keeps rank when the leader's lists run 30 units or fewer", () => {
      const out = run(leaderEnv([[IT_IS_WORSE, 0.3], [CHARGED, 0.3], [REACTOR, 0.3], ...light]));
      const order = keys(out.additions);
      expect(order.indexOf(REACTOR)).toBeLessThan(order.indexOf(CHARGED));
      expect(out.additions.find((a: { cardKey: string }) => a.cardKey === REACTOR).symmetric).toBe(true);
      expect(out.symmetricSweeps).toMatchObject({ demoted: false, units: 8 });
    });

    it("reads the unit count of a decklist: 30 or more demotes, 29 does not", () => {
      const e = leaderEnv([[IT_IS_WORSE, 0.3], [CHARGED, 0.3], [REACTOR, 0.3], ...light]);
      const withUnits = (n: number) => ({ decklist: [{ card: "OL", count: 1 }, { card: "AB", count: 1 }, { card: FREIGHTER, count: n }] });
      const thirty = run(e, withUnits(30));
      expect(thirty.symmetricSweeps).toMatchObject({ demoted: true, units: 30 });
      expect(keys(thirty.additions).indexOf(REACTOR)).toBeGreaterThan(keys(thirty.additions).indexOf(CHARGED));
      const short = run(e, withUnits(29));
      expect(short.symmetricSweeps).toMatchObject({ demoted: false, units: 29 });
      expect(keys(short.additions).indexOf(REACTOR)).toBeLessThan(keys(short.additions).indexOf(CHARGED));
    });

    it("does not mark a single-target removal", () => {
      const out = run(leaderEnv([[IT_IS_WORSE, 0.3], [CHARGED, 0.3], [REACTOR, 0.3], ...heavy]));
      expect(out.additions.find((a: { cardKey: string }) => a.cardKey === IT_IS_WORSE).symmetric).toBeUndefined();
    });

    it("keeps the rank order when the package has no unit count to read", () => {
      const out = run(createMetaEnv(sweepDeck, meta, winrates, loadCounterTable(), sweepFeatures));
      expect(out.symmetricSweeps).toMatchObject({ demoted: false, units: null });
    });
  });

  describe("staples and additions", () => {
    const e = leaderEnv([[IT_IS_WORSE, 0.3], [CHARGED, 0.6], [FREIGHTER, 0.3], [PROFUNDITY, 0.1]]);

    it("lists inDeck cards and cards the leader plays at 50% or more as staples, the rest as additions", () => {
      const out = run(e, { decklist: [{ card: "OL", count: 1 }, { card: "AB", count: 1 }, { card: PROFUNDITY, count: 1 }] });
      expect(new Set(keys(out.staples))).toEqual(new Set([CHARGED, PROFUNDITY]));
      expect(keys(out.additions)).toEqual([IT_IS_WORSE, FREIGHTER]);
      expect(out.answers).toBeUndefined();
      expect(out.shown).toBe(4);
      expect(out.staples[0]).toHaveProperty("evidenceClass");
      expect(out.note).toContain("staples");
    });

    it("applies limit to the additions only, and threatsCovered counts both lists", () => {
      const out = run(e, { limit: 1, minPerThreat: 0 });
      expect(keys(out.staples)).toEqual([CHARGED]);
      expect(keys(out.additions)).toHaveLength(1);
      expect(out.shown).toBe(2);
      expect(out.threatsCovered).toMatch(/key-units 2 \(share 1\)/);
    });

    it("keeps staples out of the perThreat cap that spreads the additions", () => {
      const out = run(e, { perThreat: 1, limit: 20, minPerThreat: 0 });
      expect(keys(out.additions)).toEqual([IT_IS_WORSE, FREIGHTER, PROFUNDITY]);
      expect(out.capped).toBe(2); // Profundity repeats space-heavy (deferred) and Reactor Ignition is unplayed (left out); Charged with Treason, a staple, took no key-units slot
    });
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

describe("leader cards build (meta/leader-cards.json)", () => {
  const file = buildLeaderCards(LEADER_CARDS_DECKS, LEADER_CARDS_FACTS);

  it("gives each leader's placement-weighted inclusion, mean copies and lift over aspect-eligible decks", () => {
    const lc = file.leaders.find((l) => l.leader.cardKey === "LC");
    expect(lc).toMatchObject({
      leader: { cardKey: "LC", title: "Bounty Boss", aspects: ["Command", "Heroism"] },
      population: "tournament",
      fallback: false,
      decks: 2,
      window: { from: file.window.from, to: "2026-10-01" },
      topBase: { cardKey: "CB", title: "Command Base", decks: 2 },
    });
    expect(lc?.cards).toEqual([
      { cardKey: "A", title: "Card A", inclusion: 1, meanCopies: 2.5, baselineInclusion: 1, lift: 0 },
      { cardKey: "N", title: "Card N", inclusion: 1, meanCopies: 1.5, baselineInclusion: 0.6, lift: 0.4 },
      { cardKey: "B", title: "Card B", inclusion: 0.5, meanCopies: 1, baselineInclusion: 0.5, lift: 0 },
    ]);
  });

  it("falls back to community lists only for a leader with no tournament deck, and says so", () => {
    const cl = file.leaders.find((l) => l.leader.cardKey === "CL");
    expect(cl).toMatchObject({ population: "community", fallback: true, decks: 1 });
    expect(cl?.cards.map((c) => c.cardKey)).toEqual(["N"]);
    expect(file.leaders.map((l) => l.leader.cardKey)).toEqual(["AX", "CL", "LC", "OX"]);
  });

  it("is deterministic and independent of deck order, and parses as its strict schema", () => {
    const again = buildLeaderCards([...LEADER_CARDS_DECKS].reverse(), LEADER_CARDS_FACTS);
    expect(JSON.stringify(again)).toBe(JSON.stringify(file));
    expect(() => leaderCardsFileSchema.parse({ ...file, extra: 1 })).toThrow();
  });

  it("caps each leader at LEADER_CARDS_MAX cards", () => {
    const keys = Array.from({ length: LEADER_CARDS_MAX + 10 }, (_, i) => `K${String(i).padStart(3, "0")}`);
    const facts = new Map([...LEADER_CARDS_FACTS, ...keys.map((k) => [k, fact(k)] as const)]);
    const big = deck("big", { leader: "LC", base: "CB", cards: keys.map((k) => [k, 1] as [string, number]) });
    const out = buildLeaderCards([big], facts);
    expect(out.leaders[0].cards).toHaveLength(LEADER_CARDS_MAX);
  });
});

describe("leader_cards", () => {
  const file = buildLeaderCards(LEADER_CARDS_DECKS, LEADER_CARDS_FACTS);
  const leaderEnv = createMetaEnv({ ...deckEnv, leaderCards: indexLeaderCards(file) }, meta, winrates, loadCounterTable(), features);
  const keys = (out: { cards: { cardKey: string }[] }) => out.cards.map((c) => c.cardKey);

  it("lists the leader's cards by inclusion with population, window, deck count and status fact", () => {
    const out = body(leaderCards(leaderEnv, { leader: "LC" }));
    expect(out).toMatchObject({
      leader: { cardKey: "LC", title: "Bounty Boss" },
      population: "tournament",
      fallback: false,
      window: `${file.window.from}..2026-10-01`,
      decks: 2,
      topBase: { cardKey: "CB", title: "Command Base", decks: 2 },
      status: "fact",
      matched: 3,
      shown: 3,
    });
    expect(keys(out)).toEqual(["A", "N", "B"]);
    expect(out.cards[1]).toEqual({ cardKey: "N", title: "Card N", inclusion: 1, meanCopies: 1.5, baselineInclusion: 0.6, lift: 0.4 });
    expect(out.note).toContain("tournament");
  });

  it("sorts by lift, filters by minInclusion, honours limit and resolves an exact title", () => {
    expect(keys(body(leaderCards(leaderEnv, { leader: "LC", sortBy: "lift" })))).toEqual(["N", "A", "B"]);
    expect(keys(body(leaderCards(leaderEnv, { leader: "LC", minInclusion: 0.6 })))).toEqual(["A", "N"]);
    const one = body(leaderCards(leaderEnv, { leader: "Bounty Boss", limit: 1 }));
    expect(one).toMatchObject({ matched: 3, shown: 1 });
    expect(keys(one)).toEqual(["A"]);
  });

  it("names the community fallback, and fails for a leader with no decks or a package without the file", () => {
    const cl = body(leaderCards(leaderEnv, { leader: "CL" }));
    expect(cl).toMatchObject({ population: "community", fallback: true, decks: 1 });
    expect(cl.note).toContain("no tournament decklist");
    expect(leaderCards(leaderEnv, { leader: "OL" }).isError).toBe(true);
    expect(leaderCards(createMetaEnv({ ...deckEnv, leaderCards: null }, meta, winrates, loadCounterTable(), features), { leader: "LC" }).isError).toBe(
      true,
    );
  });

  it("carries no Karabast mention (D22)", () => {
    expect(leaderCards(leaderEnv, { leader: "LC" }).content[0].text.toLowerCase()).not.toContain("karabast");
  });
});

describe("locks are honoured in playable_cards, meta_answers and deck_audit (#147, #150, D59)", () => {
  const WORSE = COUNTER_CARDS.find((c) => (c as { cardKey: string }).cardKey === "05010264");
  const clone = (cardKey: string, title: string, clause: string): Record<string, unknown> =>
    JSON.parse(JSON.stringify(WORSE).replaceAll("Defeat a non-leader unit.", clause).replace("05010264", cardKey).replace("It's Worse", title));
  const LOCKED_BASE = clone("LK1", "Tatooine Defeater", "If you control a Tatooine base, defeat a non-leader unit.");
  const LOCKED_ASPECT = clone("LK2", "Aggression Defeater", "Aggression unit, defeat a non-leader unit.");
  const OPEN = clone("LK3", "Open Defeater", "Defeat a non-leader unit.");
  // D71 (#159): an open offer on one clause and a locked clause that answers nothing (Ritual Dragon: printed Saboteur, a Tatooine clause).
  const PARTLY = ((): Record<string, unknown> => {
    const card = clone("LK4", "Defeater With A Tatooine Clause", "Defeat a non-leader unit.") as { faces: { text: Record<string, unknown>[] } };
    card.faces.text.push({
      kind: "ability",
      triggers: [{ trigger: "event_resolve", repeat: "once_on_play" }],
      repeat: "once_on_play",
      granted: false,
      clauses: [{ path: "text.p1s0", text: "If you control a Tatooine base, draw a card.", source: "grammar", effects: [], conditions: [], structure: [], modifiers: [], residue: [] }],
      grantedAbilities: [],
      options: [],
    });
    return card;
  })();
  const TATOOINE_BASE = mk("TB", "Jundland Wastes", { type: "Base", icons: ["Command"], cost: null, traits: ["Tatooine"] });
  const KASHYYYK_BASE = mk("KB", "Origin Tree", { type: "Base", icons: ["Command"], cost: null, traits: ["Kashyyyk"] });
  const AGGRO_BASE = mk("AB2", "Aggro Base", { type: "Base", aspects: ["Aggression"], icons: ["Aggression"], cost: null });
  const AGGRESSION_UNIT = mk("AU", "Aggression Unit", { aspects: ["Aggression"], cost: 2 });

  const build = () => {
    const all = [...features, featureRecord(TATOOINE_BASE, { power: null, hp: 25, arenas: [] }), featureRecord(KASHYYYK_BASE, { power: null, hp: 25, arenas: [] }), featureRecord(AGGRESSION_UNIT, { power: 2, hp: 2, arenas: ["Ground"] }), featureRecord(AGGRO_BASE, { power: null, hp: 25, arenas: [] }), LOCKED_BASE, LOCKED_ASPECT, OPEN, PARTLY];
    const syn = synergyCardsSchema.parse(all);
    const rowsOf: CardRow[] = syn.map((s) => ({
      cardKey: s.cardKey, title: s.title, subtitle: s.subtitle, type: s.type, cost: s.structured.cost, power: null, hp: null,
      aspects: s.structured.aspectIcons.join("|") || null, traits: null, keywords: null, arenas: null, text: null, sets: "SEC",
    }));
    const denv: DeckEnv = {
      ...deckEnv,
      store: { ...store, cards: rowsOf, byKey: new Map(rowsOf.map((r) => [r.cardKey, r])) },
      ctx: createSynergyContext(syn, COMMITTED_TABLE),
    };
    return { denv, menv: createMetaEnv(denv, meta, winrates, loadCounterTable(), all) };
  };
  const { denv, menv } = build();
  const answer = (out: any, key: string) => [...pageOf(out), ...out.lockedAnswers].find((a: { cardKey: string }) => a.cardKey === key);
  const run = (base: string, decklist: { card: string; count: number }[] = []) =>
    body(metaAnswers(menv, { leader: "OL", base, ...(decklist.length === 0 ? {} : { decklist }), maxPenalty: 4, limit: 60, perThreat: 60, minPerThreat: 0 }));

  it("meta_answers: a base-locked offer answers nothing under another base, is named, and is listed after the open answers", () => {
    const out = run("OB");
    expect(answer(out, "LK3")).toMatchObject({ coverage: 1 });
    expect(answer(out, "LK1")).toMatchObject({ baseLocked: "Tatooine", lockedOut: true, coverage: 0, threatsAnswered: 0 });
    expect(answer(out, "LK1").answers).toContainEqual(expect.objectContaining({ threat: "key-units", evidence: "text: If you control a Tatooine base, defeat a non-leader unit." }));
    // It takes no slot among the additions: it is listed apart, after them.
    expect(out.additions.map((x: { cardKey: string }) => x.cardKey)).not.toContain("LK1");
    expect(out.lockedAnswers.map((x: { cardKey: string }) => x.cardKey)).toContain("LK1");
    expect(out.lockedAnswers.every((x: { lockedOut?: boolean }) => x.lockedOut === true)).toBe(true);
    const open = out.threatsCovered.match(/key-units (\d+)/)[1];
    const pageWithout = pageOf(out).filter((a: { answers: { threat: string }[] }) => a.answers.some((x) => x.threat === "key-units")).length;
    expect(Number(open)).toBe(pageWithout);
  });

  it("meta_answers: a base of the named location clears the lock and the offer covers the threat again", () => {
    const out = run("TB");
    expect(answer(out, "LK1")).toMatchObject({ coverage: 1 });
    expect(answer(out, "LK1")).not.toHaveProperty("baseLocked");
    expect(answer(out, "LK1")).not.toHaveProperty("lockedOut");
    expect(answer(run("KB"), "LK1")).toMatchObject({ baseLocked: "Tatooine", lockedOut: true });
  });

  it("meta_answers: a locked card already in the decklist stays among the staples with its lock named and covers nothing", () => {
    const out = run("OB", [{ card: "LK1", count: 1 }]);
    expect(out.staples.find((x: { cardKey: string }) => x.cardKey === "LK1")).toMatchObject({ inDeck: 1, baseLocked: "Tatooine", lockedOut: true, coverage: 0 });
    expect(out.lockedAnswers.map((x: { cardKey: string }) => x.cardKey)).not.toContain("LK1");
  });

  it("meta_answers: a locked clause that no answering offer rests on still flags the card and ranks it after every unlocked answer (D71)", () => {
    const out = run("OB");
    expect(answer(out, "LK4")).toMatchObject({ coverage: 1, baseLocked: "Tatooine" });
    expect(answer(out, "LK4")).not.toHaveProperty("lockedOut");
    const rows = out.additions as { cardKey: string; baseLocked?: string }[];
    const at = rows.findIndex((r) => r.cardKey === "LK4");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(rows.slice(0, at).every((r) => r.baseLocked === undefined)).toBe(true);
    expect(rows.findIndex((r) => r.cardKey === "LK3")).toBeLessThan(at);
    const under = answer(run("TB"), "LK4");
    expect(under).toMatchObject({ coverage: 1 });
    expect(under).not.toHaveProperty("baseLocked");
  });

  it("meta_answers: a card already in the decklist stays a staple and carries the lock of its unrelated clause (D71)", () => {
    const staple = run("OB", [{ card: "LK4", count: 1 }]).staples.find((x: { cardKey: string }) => x.cardKey === "LK4");
    expect(staple).toMatchObject({ inDeck: 1, baseLocked: "Tatooine" });
  });

  it("meta_answers: an aspect-unit clause is locked until the leader or a deck unit supplies that aspect; a base is no unit", () => {
    expect(answer(run("OB"), "LK2")).toMatchObject({ needsUnitAspect: "Aggression", lockedOut: true, coverage: 0 });
    const supplied = run("OB", [{ card: "AU", count: 1 }]);
    expect(answer(supplied, "LK2")).toMatchObject({ coverage: 1 });
    expect(answer(supplied, "LK2")).not.toHaveProperty("needsUnitAspect");
    expect(answer(run("AB2"), "LK2")).toMatchObject({ needsUnitAspect: "Aggression", lockedOut: true, coverage: 0 });
  });

  it("playable_cards: a locked card keeps its place in the list but follows the open cards of its cost, with the lock named", () => {
    const out = body(playableCards(denv, { leader: "OL", base: "OB", costs: [7], maxPenalty: 4, perCost: 20, limit: 50, rankBy: "score" }));
    const keys = out.cards.map((c: { cardKey: string }) => c.cardKey);
    expect(keys.indexOf("LK3")).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf("LK1")).toBeGreaterThan(keys.indexOf("LK3"));
    expect(keys.indexOf("LK2")).toBeGreaterThan(keys.indexOf("LK3"));
    expect(out.cards.find((c: { cardKey: string }) => c.cardKey === "LK1")).toMatchObject({ baseLocked: "Tatooine" });
    expect(out.cards.find((c: { cardKey: string }) => c.cardKey === "LK2")).toMatchObject({ needsUnitAspect: "Aggression" });
    expect(out.cards.find((c: { cardKey: string }) => c.cardKey === "LK3")).not.toHaveProperty("baseLocked");
    expect(out.note).toContain("baseLocked");
    const under = body(playableCards(denv, { leader: "OL", base: "TB", costs: [7], maxPenalty: 4, perCost: 20, limit: 50, rankBy: "score" }));
    expect(under.cards.find((c: { cardKey: string }) => c.cardKey === "LK1")).not.toHaveProperty("baseLocked");
  });

  it("playable_cards: a unit in the partial decklist supplies the aspect", () => {
    const out = body(playableCards(denv, { leader: "OL", base: "OB", costs: [7], maxPenalty: 4, perCost: 20, limit: 50, rankBy: "score", decklist: [{ card: "AU", count: 1 }] }));
    expect(out.cards.find((c: { cardKey: string }) => c.cardKey === "LK2")).not.toHaveProperty("needsUnitAspect");
  });

  it("deck_audit: lists the deck cards whose clause the leader, base and deck cannot meet", () => {
    const decklist = [{ card: "LK1", count: 2 }, { card: "LK2", count: 1 }, { card: "LK3", count: 3 }];
    const out = body(deckAudit(denv, { leader: "OL", base: "OB", decklist }));
    expect(out.lockedCards.cards).toEqual([
      { card: "Tatooine Defeater", cardKey: "LK1", count: 2, baseLocked: "Tatooine" },
      { card: "Aggression Defeater", cardKey: "LK2", count: 1, needsUnitAspect: "Aggression" },
    ]);
    expect(out.lockedCards.note).toContain("needsUnitAspect");
    const met = body(deckAudit(denv, { leader: "OL", base: "TB", decklist: [...decklist, { card: "AU", count: 1 }] }));
    expect(met.lockedCards.cards).toEqual([]);
  });
});

describe("leader lists by base (D60, #148)", () => {
  // OL (Vigilance, Heroism) has 11 community lists on the Aggression base and 10 on the Command base. Profundity
  // carries an Aggression icon: penalty-free under the Aggression base, +2 under any other.
  const PROFUNDITY = "04010154";
  const IT_IS_WORSE = "05010264";
  const lists = [
    ...Array.from({ length: 11 }, (_, i) => deck(`ag${i}`, { leader: "OL", base: "AB", cards: [[PROFUNDITY, 3], [IT_IS_WORSE, 1]], population: "community", source: "swudb", event: null, placement: null })),
    ...Array.from({ length: 10 }, (_, i) => deck(`cm${i}`, { leader: "OL", base: "OB", cards: [[IT_IS_WORSE, 2]], population: "community", source: "swudb", event: null, placement: null })),
    ...Array.from({ length: 3 }, (_, i) => deck(`cx${i}`, { leader: "OL", base: "EB", cards: [[PROFUNDITY, 1]], population: "community", source: "swudb", event: null, placement: null })),
  ];
  const file = buildLeaderCards(lists, facts);
  const split = createMetaEnv({ ...deckEnv, leaderCards: indexLeaderCards(file) }, meta, winrates, loadCounterTable(), features);

  it("leader_cards with a base reports that base's lists, labelled, and marks a penalised staple instead of hiding it", () => {
    const own = body(leaderCards(split, { leader: "OL", base: "OB", minInclusion: 0 }));
    expect(own).toMatchObject({ decks: 10, base: "Our Base", listsOfLeader: 24 });
    expect(own.populationNote).toBe("10 Our Base lists of 24 community Our Leader, Defender lists");
    expect(own.cards.map((c: { cardKey: string }) => c.cardKey)).toEqual([IT_IS_WORSE]);
    const aggro = body(leaderCards(split, { leader: "OL", base: "AB", minInclusion: 0 }));
    expect(aggro).toMatchObject({ decks: 11, base: "Aggression Base" });
    expect(aggro.cards.every((c: { penalty?: number }) => c.penalty === undefined)).toBe(true);
  });

  it("falls back to every list under the 10-deck floor, names the counts and the dominant base, and still shows each row's penalty", () => {
    const out = body(leaderCards(split, { leader: "OL", base: "EB", minInclusion: 0 }));
    expect(out.decks).toBe(24);
    expect(out.populationNote).toBe("3 Enemy Base lists is under the 10-deck floor; using all 24 Our Leader, Defender lists, 11 of which run Aggression Base (Aggression)");
    const freighter = out.cards.find((c: { cardKey: string }) => c.cardKey === PROFUNDITY);
    expect(freighter).toMatchObject({ penalty: 2, penalised: true });
    expect(out.note).toContain("penalty");
  });

  it("leaves leader_cards without a base exactly as before", () => {
    const out = body(leaderCards(split, { leader: "OL", minInclusion: 0 }));
    expect(out.decks).toBe(24);
    expect(out).not.toHaveProperty("populationNote");
    expect(out.cards.every((c: object) => !("penalty" in c))).toBe(true);
  });

  it("meta_answers weights by the base's lists and names them in leaderSource", () => {
    const out = body(metaAnswers(split, { leader: "OL", base: "OB", maxPenalty: 4, limit: 60, perThreat: 60, includeUnplayed: true }));
    expect(out.leaderSource).toMatchObject({ population: "community", decks: 10, base: "Our Base" });
    const byKey = Object.fromEntries([...out.staples, ...out.additions].map((a: { cardKey: string; leaderInclusion: number | null }) => [a.cardKey, a.leaderInclusion]));
    expect(byKey[IT_IS_WORSE]).toBe(1);
    expect(byKey[PROFUNDITY] ?? null).toBeNull();
  });
});

describe("meta_threats faces and a key-units threat that carries information (#154, D63)", () => {
  const opponents = [
    ...Array.from({ length: 4 }, (_, i) => deck(`lc${i}`, { leader: "LC", base: "AB", cards: [[RUSH_UNIT, 3]], placement: 10 + i, field: 16 })),
    ...Array.from({ length: 3 }, (_, i) => deck(`cl${i}`, { leader: "CL", base: "EB", cards: [[RUSH_UNIT, 3]], placement: 14 + i, field: 16 })),
  ];
  const options = { ...DEFAULT_META_OPTIONS, minDecks: 2, minTournamentDecks: 1 };
  const field = buildMeta([...enemyDecks, ...opponents], facts, options);
  const pair = (leader: string, baseAspects: string[], oppLeader: string, oppBaseAspects: string[], wins: number, losses: number, draws = 0) => ({
    leader,
    baseAspects,
    oppLeader,
    oppBaseAspects,
    wins,
    losses,
    draws,
  });
  const withPairs = (pairs: ReturnType<typeof pair>[] | null) =>
    createMetaEnv(
      deckEnv,
      leaningOnHeavyUnits(field),
      { ...winrates, matchups: pairs === null ? null : { ...winrates.matchups, pairs } },
      loadCounterTable(),
      features,
    );
  const measuredEnv = withPairs([pair("EL", ["Cunning"], "LC", ["Aggression"], 14, 6, 1), pair("EL", ["Cunning"], "CL", ["Cunning"], 4, 3)]);
  const facesOf = (e: typeof measuredEnv, extra: object = {}) => body(metaThreats(e, { archetype: "EL", ...extra })).faces;

  it("lists the largest archetypes by share, leaving out the leader's own, with the record where n meets minN", () => {
    const faces = facesOf(measuredEnv);
    expect(faces.population).toBe("tournament");
    expect(faces.source).toContain(SWUMETASTATS_SOURCE);
    expect(faces.minN).toBe(10);
    expect(faces.rows.map((r: any) => r.name.split(" / ")[0])).toEqual(["Bounty Boss", "Casual Leader"]);
    expect(faces.rows[0].share).toBeGreaterThan(faces.rows[1].share);
    expect(faces.rows[0]).toMatchObject({ record: "14-6-1", wins: 14, losses: 6, draws: 1, n: 20, winRate: 0.7 });
    expect(faces.rows[0].ci95).toMatch(/^0\.\d+\.\.0\.\d+$/);
    expect(faces.measured).toBe(1);
  });

  it("says no measured matchup, with the n it has, under minN, and for an opponent with no match at all", () => {
    const faces = facesOf(measuredEnv);
    expect(faces.rows[1]).toMatchObject({ record: "no measured matchup (n < 10)", wins: null, losses: null, draws: null, n: 7, winRate: null, ci95: null });
    const none = facesOf(withPairs([pair("EL", ["Cunning"], "LC", ["Aggression"], 1, 0)]));
    expect(none.rows.map((r: any) => [r.record, r.n])).toEqual([
      ["no measured matchup (n < 10)", 1],
      ["no measured matchup (n < 10)", 0],
    ]);
    expect(none.measured).toBe(0);
  });

  it("names no source captured when the package holds no matchups, and still states every row", () => {
    const faces = facesOf(withPairs(null));
    expect(faces.source).toBe("none captured");
    expect(faces.rows.every((r: any) => r.record === "no measured matchup (n < 10)")).toBe(true);
  });

  it("takes facesLimit and leaves the block out at 0", () => {
    expect(facesOf(measuredEnv, { facesLimit: 1 }).rows).toHaveLength(1);
    expect(body(metaThreats(measuredEnv, { archetype: "EL", facesLimit: 0 }))).not.toHaveProperty("faces");
  });

  it("a community archetype found by fallback faces the tournament meta, never the community one (D21)", () => {
    const communityDecks = Array.from({ length: 3 }, (_, i) =>
      deck(`cc${i}`, { leader: "OL", base: "OB", cards: [[RUSH_UNIT, 3]], population: "community", source: "swudb", event: null, placement: null }),
    );
    const mixed = leaningOnHeavyUnits(buildMeta([...enemyDecks, ...opponents, ...communityDecks], facts, options));
    const e = createMetaEnv(deckEnv, mixed, winrates, loadCounterTable(), features);
    const out = body(metaThreats(e, { archetype: "OL" }));
    expect(out.archetype.population).toBe("community");
    expect(out.faces.population).toBe("tournament");
    expect(out.faces.rows.map((r: any) => r.name.split(" / ")[0])).toEqual(["Enemy Leader", "Bounty Boss", "Casual Leader"]);
    expect(out.faces.rows[0]).toMatchObject({ record: "7-5-0", wins: 7, losses: 5, n: 12 });
  });

  it("key-units marks an archetype that leans on heavy units and not one whose key units are all cheap", () => {
    const cheap = createMetaEnv(deckEnv, buildMeta(enemyDecks, facts, options), winrates, loadCounterTable(), features);
    const bare = body(metaThreats(cheap, { archetype: "EL" }));
    expect(bare.keyUnits.length).toBeGreaterThan(0);
    expect(bare.threats.map((t: any) => t.id)).not.toContain("key-units");
    expect(body(metaArchetypes(cheap, {})).rows[0].threats).not.toContain("key-units");
    expect(body(metaThreats(measuredEnv, { archetype: "EL" })).threats.map((t: any) => t.id)).toContain("key-units");
  });
});

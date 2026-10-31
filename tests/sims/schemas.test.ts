import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../../src/swu/canonical.js";
import {
  compactDecisionSchema,
  deckSha256,
  fullDecisionSchema,
  legalActionsSha256,
  matchFooterSchema,
  matchHeaderSchema,
  matchId,
  matchRecordSchema,
  type FullDecision,
  type MatchFooter,
  type MatchHeader,
} from "../../src/sims/schemas.js";

const engineList = (leader: string) => ({ leader: { id: leader, count: 1 }, base: { id: "SOR_025", count: 1 }, deck: [{ id: "SOR_100", count: 3 }], sideboard: [] });

function header(): MatchHeader {
  const decks: MatchHeader["decks"] = [
    { seat: 1, leader: "0101005", base: "0101025", cards: [{ cardKey: "0101100", count: 3 }], engineList: engineList("SOR_005"), deckSha256: deckSha256(engineList("SOR_005")), source: "file:a.json" },
    { seat: 2, leader: "0101006", base: "0101025", cards: [{ cardKey: "0101100", count: 3 }], engineList: engineList("SOR_006"), deckSha256: deckSha256(engineList("SOR_006")), source: "file:b.json" },
  ];
  const policy = { rung: 0, policyId: "rung0-random", policyVersion: "1", paramsSha256: sha256Hex("{}"), inputs: {} };
  const engine = {
    repo: "https://github.com/SWU-Karabast/forceteki.git",
    commit: "445792e6185c10ca66c27a95893474c25256f3cc",
    cardDataVersion: "20260423_00",
    cardDataSha256: "b".repeat(64),
    cardKeyMapSha256: "c".repeat(64),
    node: "v26.4.0",
    nodeEnv: "test" as const,
    undoMode: "disabled" as const,
  };
  const h = {
    schemaVersion: 1 as const,
    matchId: "",
    seed: "7",
    engine,
    rng: { engineSeed: "engine:7", botScheme: "sha256-counter-v1" as const },
    decks,
    policies: [policy, policy] as MatchHeader["policies"],
    branch: null,
    codeCommit: "9f224cf",
    recordMode: "full" as const,
  };
  return { ...h, matchId: matchId(h) };
}

const actions = [
  { i: 0, kind: "pass" as const, cardKey: null, engineCardId: null, controller: null, zone: null, ordinal: 0, targets: [], descriptor: "pass|-|-|0|Pass", label: "Pass" },
  { i: 1, kind: "play" as const, cardKey: "0101100", engineCardId: "x#y", controller: 1 as const, zone: "hand", ordinal: 0, targets: [], descriptor: "play|0101100|p1.hand|0", label: "x#y" },
];

function decision(k: number): FullDecision {
  return {
    k,
    round: 1,
    phase: "action",
    actor: 1,
    promptKind: "mainAction",
    legalActions: actions,
    legalActionsSha256: legalActionsSha256(actions.map((a) => a.descriptor)),
    chosen: { i: 1, descriptor: "play|0101100|p1.hand|0" },
    rngCursor: { engineDraws: 12, engineStateSha: "0123456789abcdef", botDraws: 3 },
    evaluator: { rung: 0, version: "1", sha256: null },
    utilities: null,
    fallback: null,
  };
}

const footer = (decisions: number): MatchFooter => ({
  result: { winner: 1, endCondition: "base_destroyed", rounds: 9, decisions },
  error: null,
  coverage: { decisions: [decisions, 0], answered: [decisions, 0] },
  gaps: { cardRefs: 4, nullCardKey: 1 },
  cardsPlayed: [[{ cardKey: "0101100", engineCardId: "x#y", count: 2 }], []],
  baseDamage: [3, 30],
  endBoard: [["0101100"], []],
  finalRngCursor: { engineDraws: 20, engineStateSha: "fedcba9876543210", botDraws: 9 },
  traceSha256: "d".repeat(64),
});

describe("match header", () => {
  it("parses and round-trips through canonical JSON", () => {
    const h = header();
    const parsed = matchHeaderSchema.parse(JSON.parse(JSON.stringify(h)));
    expect(canonicalJson(parsed)).toBe(canonicalJson(h));
  });

  it("refuses an unknown field (strict) and any wall-clock field", () => {
    expect(() => matchHeaderSchema.parse({ ...header(), timestamp: "2026-10-31T00:00:00Z" })).toThrow();
    expect(() => matchHeaderSchema.parse({ ...header(), engine: { ...header().engine, startedAt: 0 } })).toThrow();
  });

  it("pins the engine text mode: a record made under another NODE_ENV is refused", () => {
    const h = header();
    expect(() => matchHeaderSchema.parse({ ...h, engine: { ...h.engine, nodeEnv: "production" } })).toThrow();
  });

  it("refuses a matchId that is not the hash of seed, decks, policies and engine", () => {
    expect(() => matchHeaderSchema.parse({ ...header(), seed: "8" })).toThrow(/matchId/);
  });

  it("refuses a deck whose deckSha256 does not hash its engine list", () => {
    const h = header();
    const decks = [{ ...h.decks[0], deckSha256: "e".repeat(64) }, h.decks[1]];
    expect(() => matchHeaderSchema.parse({ ...h, decks })).toThrow(/deckSha256/);
  });

  it("refuses seats out of order and an engine seed that is not engine:<seed>", () => {
    const h = header();
    expect(() => matchHeaderSchema.parse({ ...h, decks: [h.decks[1], h.decks[0]] })).toThrow();
    expect(() => matchHeaderSchema.parse({ ...h, rng: { ...h.rng, engineSeed: "x" } })).toThrow(/engineSeed/);
  });
});

describe("decision record", () => {
  it("parses a full record and its compact form", () => {
    expect(fullDecisionSchema.parse(decision(0))).toEqual(decision(0));
    const d = decision(3);
    const compact = { k: 3, actor: 1, legalActionsSha256: d.legalActionsSha256, chosen: d.chosen.descriptor, rngCursor: d.rngCursor };
    expect(compactDecisionSchema.parse(compact)).toEqual(compact);
  });

  it("fails when chosen index and descriptor disagree", () => {
    expect(() => fullDecisionSchema.parse({ ...decision(0), chosen: { i: 0, descriptor: "play|0101100|p1.hand|0" } })).toThrow(/chosen/);
    expect(() => fullDecisionSchema.parse({ ...decision(0), chosen: { i: 5, descriptor: "x" } })).toThrow(/chosen/);
  });

  it("fails when legal actions are not sorted by descriptor or the hash does not cover them", () => {
    const reversed = [...actions].reverse().map((a, i) => ({ ...a, i }));
    expect(() => fullDecisionSchema.parse({ ...decision(0), legalActions: reversed, chosen: { i: 0, descriptor: "play|0101100|p1.hand|0" } })).toThrow(/sorted/);
    expect(() => fullDecisionSchema.parse({ ...decision(0), legalActionsSha256: "f".repeat(64) })).toThrow(/legalActionsSha256/);
  });

  it("refuses a 15-character engine state fingerprint and a prompt uuid field", () => {
    expect(() => fullDecisionSchema.parse({ ...decision(0), rngCursor: { engineDraws: 0, engineStateSha: "0123456789abcde", botDraws: 0 } })).toThrow();
    expect(() => fullDecisionSchema.parse({ ...decision(0), promptUuid: "a" })).toThrow();
  });
});

describe("footer and whole record", () => {
  it("never lets an error read as a win", () => {
    expect(() => matchFooterSchema.parse({ ...footer(2), result: { winner: 1, endCondition: "error", rounds: 3, decisions: 2 }, error: "boom" })).toThrow(/winner/);
    expect(() => matchFooterSchema.parse({ ...footer(2), result: { winner: null, endCondition: "error", rounds: 3, decisions: 2 }, error: null })).toThrow(/error/);
    expect(matchFooterSchema.parse({ ...footer(2), result: { winner: null, endCondition: "error", rounds: 3, decisions: 2 }, error: "boom" }).result.winner).toBeNull();
  });

  it("parses a full record with contiguous k and refuses gaps or a wrong decision count", () => {
    const rec = { header: header(), decisions: [decision(0), decision(1)], footer: footer(2) };
    expect(matchRecordSchema.parse(JSON.parse(JSON.stringify(rec)))).toEqual(rec);
    expect(() => matchRecordSchema.parse({ ...rec, decisions: [decision(0), decision(2)] })).toThrow(/contiguous/);
    expect(() => matchRecordSchema.parse({ ...rec, footer: footer(3) })).toThrow(/decisions/);
  });

  it("refuses compact decisions under a full header", () => {
    const d = decision(0);
    const compact = { k: 0, actor: 1, legalActionsSha256: d.legalActionsSha256, chosen: d.chosen.descriptor, rngCursor: d.rngCursor };
    expect(() => matchRecordSchema.parse({ header: header(), decisions: [compact], footer: footer(1) })).toThrow(/recordMode/);
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { seededRandom } from "../../scripts/bench/stats.js";
import {
  aggregateAction,
  assertInputsAllowed,
  BRANCH_LABEL,
  branchManifestSchema,
  branchRecordSchema,
  branchTaskResultSchema,
  branchTaskSchema,
  candidateResultSchema,
  candidateTaskSchema,
  continuationOutcome,
  DETERMINIZE_PRIMITIVE,
  isCandidate,
  keyedUniform,
  type Outcome,
  seedKeys,
  selectDecisions,
  sourceOutcomeOf,
  splitSeedRange,
} from "../../src/sims/branches.js";
import { encodeState } from "../../src/sims/state.js";
import { buildVocab, compileVocab } from "../../src/sims/vocab.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const vocab = compileVocab(
  buildVocab({
    dataVersion: "test.r1",
    buildHash: "a".repeat(64),
    cardsToonSha256: "b".repeat(64),
    engineCommit: "0000000",
    cards: [
      ...["0101001", "0101002", "0101003", "0101004", "0101005", "0101006", "0101030", "0101031"].map((cardKey) => ({ cardKey, type: "Unit", title: cardKey })),
      { cardKey: "04010t04", type: "Token Upgrade", title: "Shield" },
      { cardKey: "05010t02", type: "Token Upgrade", title: "Shield" },
    ],
    engineKeywords: ["sentinel", "raid", "overwhelm", "shielded"],
    parent: null,
  }),
);
const state = encodeState(JSON.parse(readFileSync(path.join(HERE, "../fixtures/sims/state-views/basic.json"), "utf8")), vocab);
const grid = (rows: Outcome[][]): Outcome[][] => rows;
const action = (descriptor: string, outcomes: Outcome[][]) => ({
  descriptor,
  kind: "play",
  cardKey: null,
  ...aggregateAction(outcomes),
  afterState: state,
  afterTerminal: "none" as const,
});
const record = (): Record<string, any> => ({
  schemaVersion: 1,
  gameId: "5000007",
  seed: 5000007,
  k: 41,
  round: 3,
  phase: "action",
  actor: 1,
  promptKind: "mainAction",
  state,
  legalActions: [
    action(
      "attack|0101002",
      grid([
        ["win", "loss"],
        ["win", "error"],
      ]),
    ),
    action(
      "pass",
      grid([
        ["loss", "loss"],
        ["draw", "timeout"],
      ]),
    ),
  ],
  chosen: { descriptor: "pass", index: 1 },
  sourceOutcome: 1,
  rngCursor: "12:abcdef0123456789:3",
  rootMatched: true,
  determinization: { mode: "multiset", K: 2, N: 2 },
});
const ladder = { step: "rung1-pilot-vs-rung0", file: "data/pinned/sim-ladder-v1/rung1-pilot-vs-rung0.json", sha256: "6".repeat(64), passed: true };
const manifest = (): Record<string, any> => ({
  schemaVersion: 1,
  label: BRANCH_LABEL,
  purpose: "pilot",
  trainingEligible: true,
  parameters: { runSeed: "pilot-1", rate: 1, target: 2000, K: 4, N: 4, rung: 1, maxContinuationDecisions: 2000, maxSourceDecisions: 2000, date: "2026-11-01" },
  determinization: { mode: "multiset", primitive: DETERMINIZE_PRIMITIVE },
  engine: { commit: "445792e61", cardDataSha256: "c".repeat(64), node: "v26.4.0", undoMode: "free" },
  continuationPolicy: { rung: 1, spec: "rung1:sacGuard=1,handCap=1", policyId: "rung1-rules", version: "1", paramsSha256: "d".repeat(64), evaluatorManifestSha256: null, ladder },
  vocab: { dataVersion: "test.r1", contentSha256: "e".repeat(64) },
  state: { stateVersion: 1, layoutSha256: "f".repeat(64) },
  source: {
    batchSha256: "1".repeat(64),
    generator: "in-run",
    policy: "rung1:sacGuard=1,handCap=1",
    seedRanges: [{ from: 5_000_000, count: 500 }],
    splits: splitSeedRange({ from: 5_000_000, count: 500 }),
    evaluationSeedRange: { from: 9_000_000, count: 2_000 },
    deckSources: ["melee"],
  },
  counts: {
    sourceGames: 500,
    sourceErrors: 0,
    sourceTimeouts: 0,
    sourceReplayMismatch: 0,
    candidates: 60000,
    singleAnswerSkipped: 2000,
    sampled: 2000,
    sampledGames: 480,
    testGames: 75,
    records: 2000,
    rootMismatch: 0,
    actions: 12800,
    continuations: 204800,
    draws: 3,
    timeouts: 1,
    afterTerminal: 4,
    errors: {},
    unknownCards: 0,
    unitOverflow: 0,
  },
  humanDerivedInputs: [],
  outputs: { records: 2000, jsonlSha256: "2".repeat(64), gzSha256: "3".repeat(64) },
  replay: { inputHash: "4".repeat(64), codeCommit: "0000000", outputHash: "5".repeat(64) },
});

describe("seeds and selection", () => {
  it("keyedUniform equals seededRandom(key)() from scripts/bench/stats.ts", () => {
    for (const key of ["branch-sample|r|g|1", "det|r|g|1|2", ""]) expect(keyedUniform(key)).toBe(seededRandom(key)());
  });

  it("keys continuations by (run, game, k, j, i) only, so every action shares them", () => {
    expect(seedKeys.sample("r", "g", 4)).toBe("branch-sample|r|g|4");
    expect(seedKeys.after("r", "g", 4)).toBe("after|r|g|4");
    expect(seedKeys.det("r", "g", 4, 1)).toBe("det|r|g|4|1");
    expect(seedKeys.engine("r", "g", 4, 1, 2)).toBe("branch|r|g|4|1|2");
    expect(seedKeys.cont("r", "g", 4, 1, 2)).toBe("cont|r|g|4|1|2");
  });

  it("selects the same decisions for any input order or split, and exactly `target` of them", () => {
    const candidates = Array.from({ length: 300 }, (_, i) => ({ gameId: `g${i % 30}`, k: i }));
    const a = selectDecisions("run", candidates, 0.5, 40);
    const b = selectDecisions("run", [...candidates].reverse(), 0.5, 40);
    const halves = selectDecisions("run", [...candidates.slice(150), ...candidates.slice(0, 150)], 0.5, 40);
    expect(b).toEqual(a);
    expect(halves).toEqual(a);
    expect(a).toHaveLength(40);
    expect(selectDecisions("run", candidates, 0.01, 1000).length).toBeLessThan(40);
  });

  it("treats only action-phase main-action timepoints with two or more answers as candidates", () => {
    expect(isCandidate(4, 5, "action", "mainAction", 2)).toBe(true);
    expect(isCandidate(5, 5, "action", "mainAction", 6)).toBe(false);
    expect(isCandidate(4, 5, "regroup", "mainAction", 6)).toBe(false);
    expect(isCandidate(4, 5, "action", "target", 6)).toBe(false);
    expect(isCandidate(4, 5, "action", "mainAction", 1)).toBe(false);
  });

  it("splits a contiguous source range 70/15/15 into disjoint seed ranges", () => {
    expect(splitSeedRange({ from: 100, count: 500 })).toEqual({ train: { from: 100, count: 350 }, validation: { from: 450, count: 75 }, test: { from: 525, count: 75 } });
    const s = splitSeedRange({ from: 0, count: 601 });
    expect(s.train.count + s.validation.count + s.test.count).toBe(601);
    expect(s.test.from + s.test.count).toBe(601);
  });
});

describe("outcomes", () => {
  it("maps a continuation's end to the acting seat's outcome", () => {
    expect(continuationOutcome("base_destroyed", 1, 1)).toBe("win");
    expect(continuationOutcome("base_destroyed", 2, 1)).toBe("loss");
    expect(continuationOutcome("draw", null, 2)).toBe("draw");
    expect(continuationOutcome("timeout", null, 2)).toBe("timeout");
    expect(continuationOutcome("stuck", null, 2)).toBe("timeout");
    expect(continuationOutcome("error", null, 2)).toBe("error");
  });

  it("scores the source game from the actor's seat: 1, 0, 0.5 for a draw or timeout, null on an error end", () => {
    expect(sourceOutcomeOf("base_destroyed", 2, 2)).toBe(1);
    expect(sourceOutcomeOf("base_destroyed", 1, 2)).toBe(0);
    expect(sourceOutcomeOf("draw", null, 1)).toBe(0.5);
    expect(sourceOutcomeOf("timeout", null, 1)).toBe(0.5);
    expect(sourceOutcomeOf("error", null, 1)).toBeNull();
  });
});

describe("aggregation and the record schema", () => {
  it("excludes errors from the mean and scores draws and timeouts as one half", () => {
    expect(
      aggregateAction(
        grid([
          ["win", "error"],
          ["draw", "timeout"],
        ]),
      ),
    ).toEqual({ n: 3, nWin: 1, nDraw: 2, nTimeout: 1, nErr: 1, mean: 0.666667, perDet: [1, 0.5] });
    expect(aggregateAction(grid([["error"], ["error"]]))).toMatchObject({ n: 0, mean: null, perDet: [null, null] });
  });

  it("accepts a valid record", () => {
    expect(() => branchRecordSchema.parse(record())).not.toThrow();
  });

  it("refuses a mean above 1, a broken count, a duplicate descriptor, a chosen index that points elsewhere and a one-action record", () => {
    const high = record();
    high.legalActions[0].mean = 1.2;
    expect(branchRecordSchema.safeParse(high).success).toBe(false);
    const counts = record();
    counts.legalActions[0].nErr = 0;
    expect(branchRecordSchema.safeParse(counts).success).toBe(false);
    const dup = record();
    dup.legalActions[1].descriptor = dup.legalActions[0].descriptor;
    expect(branchRecordSchema.safeParse(dup).success).toBe(false);
    const chosen = record();
    chosen.chosen.index = 0;
    expect(branchRecordSchema.safeParse(chosen).success).toBe(false);
    const single = record();
    single.legalActions = [single.legalActions[0]];
    expect(branchRecordSchema.safeParse(single).success).toBe(false);
  });

  it("refuses a source outcome other than 0, 0.5, 1 or null, and an afterstate on a terminal action", () => {
    const outcome = record();
    outcome.sourceOutcome = 0.75;
    expect(branchRecordSchema.safeParse(outcome).success).toBe(false);
    const missing = record();
    delete missing.sourceOutcome;
    expect(branchRecordSchema.safeParse(missing).success).toBe(false);
    const terminal = record();
    terminal.legalActions[0].afterTerminal = "win";
    expect(branchRecordSchema.safeParse(terminal).success).toBe(false);
    terminal.legalActions[0].afterState = null;
    expect(branchRecordSchema.safeParse(terminal).success).toBe(true);
    const errored = record();
    errored.legalActions[1].afterTerminal = "error";
    errored.legalActions[1].afterState = null;
    expect(branchRecordSchema.safeParse(errored).success).toBe(true);
  });

  it("keeps an all-error action as mean null with n 0", () => {
    const r = record();
    r.legalActions[0] = action(
      "attack|0101002",
      grid([
        ["error", "error"],
        ["error", "error"],
      ]),
    );
    expect(branchRecordSchema.parse(r).legalActions[0]).toMatchObject({ mean: null, n: 0, nErr: 4 });
  });
});

describe("manifest and input refusals", () => {
  it("accepts a valid manifest", () => {
    expect(() => branchManifestSchema.parse(manifest())).not.toThrow();
  });

  it("refuses training eligibility without a passed ladder step or at rung 0, overlapping seeds, a human-derived input and a Karabast deck source", () => {
    const noLadder = manifest();
    noLadder.continuationPolicy.ladder = null;
    expect(branchManifestSchema.safeParse(noLadder).success).toBe(false);
    const failed = manifest();
    failed.continuationPolicy.ladder.passed = false;
    expect(branchManifestSchema.safeParse(failed).success).toBe(false);
    const low = manifest();
    low.parameters.rung = 0;
    low.continuationPolicy.rung = 0;
    expect(branchManifestSchema.safeParse(low).success).toBe(false);
    const notForTraining = manifest();
    notForTraining.trainingEligible = false;
    notForTraining.continuationPolicy.ladder = null;
    expect(branchManifestSchema.safeParse(notForTraining).success).toBe(true);
    const overlap = manifest();
    overlap.source.seedRanges = [{ from: 8_999_990, count: 20 }];
    expect(branchManifestSchema.safeParse(overlap).success).toBe(false);
    const human = manifest();
    human.humanDerivedInputs = [{ kind: "deck", id: "x", reason: "karabast" }];
    expect(branchManifestSchema.safeParse(human).success).toBe(false);
    const karabast = manifest();
    karabast.source.deckSources = ["karabast"];
    expect(branchManifestSchema.safeParse(karabast).success).toBe(false);
  });

  it("throws before any game runs on a disallowed deck source, an overlapping range or a quarantined evaluator", () => {
    const ok = {
      deckSources: ["melee", "swudb"],
      seedRanges: [{ from: 1, count: 10 }],
      evaluationSeedRange: { from: 9_000_000, count: 2_000 },
      evaluatorD22: null,
    };
    expect(() => assertInputsAllowed(ok)).not.toThrow();
    expect(() => assertInputsAllowed({ ...ok, deckSources: ["karabast"] })).toThrow(/karabast/);
    expect(() => assertInputsAllowed({ ...ok, seedRanges: [{ from: 9_000_100, count: 5 }] })).toThrow(/overlap/);
    expect(() => assertInputsAllowed({ ...ok, evaluatorD22: "quarantined" })).toThrow(/quarantined/);
  });
});

describe("worker seam schemas", () => {
  const deck = {
    list: { leader: { id: "SOR_005", count: 1 }, base: { id: "SOR_026", count: 1 }, deck: [{ id: "SOR_100", count: 3 }], sideboard: [] },
    leader: "0101005",
    base: "0101026",
    cards: [{ cardKey: "0101100", count: 3 }],
    source: "melee|opponents-v1|seed|proportional|0|t001|list",
  };
  const spec = { seed: "5000007", decks: [deck, deck], policies: ["rung1:sacGuard=1,handCap=1", "rung1:sacGuard=1,handCap=1"], recordMode: "none", undo: true, codeCommit: "0000000" };

  it("parses a candidate task and result, and refuses an unknown field", () => {
    expect(() => candidateTaskSchema.parse({ gameId: "5000007", spec, maxSourceDecisions: 2000 })).not.toThrow();
    const result = { gameId: "5000007", endCondition: "base_destroyed", winner: 1, decisions: 90, traceSha256: "a".repeat(64), candidates: [{ k: 4, actor: 1, chosen: "pass", legalActionsSha256: "b".repeat(64), rngCursor: "3:0123456789abcdef:1" }], singleAnswer: 3 };
    expect(() => candidateResultSchema.parse(result)).not.toThrow();
    expect(candidateResultSchema.safeParse({ ...result, extra: 1 }).success).toBe(false);
  });

  it("parses a branch task and result whose records satisfy the record schema", () => {
    const task = { gameId: "5000007", spec, ks: [{ k: 41, actor: 1, chosen: "pass", legalActionsSha256: "b".repeat(64), rngCursor: "12:abcdef0123456789:3" }], traceSha256: "a".repeat(64), sourceOutcome: { endCondition: "base_destroyed", winner: 1 }, K: 2, N: 2, runSeed: "r", maxContinuationDecisions: 2000, maxSourceDecisions: 2000 };
    expect(() => branchTaskSchema.parse(task)).not.toThrow();
    const stats = { rollbackMs: [3.1], determinizeMs: [0.4], afterstateMs: [12], continuationMs: 100, continuations: 8, decks10: 1, decksDistinctTop5: 1, multisetViolations: 0, dealDrift: 0, rootDrift: 0 };
    const result = { gameId: "5000007", replayMismatchAt: null, traceMatched: true, records: [record()], errors: { "continuation: boom": 1 }, stats };
    expect(() => branchTaskResultSchema.parse(result)).not.toThrow();
    const bad = { ...result, records: [{ ...record(), sourceOutcome: 2 }] };
    expect(branchTaskResultSchema.safeParse(bad).success).toBe(false);
  });
});

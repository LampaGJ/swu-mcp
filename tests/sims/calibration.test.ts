import { describe, expect, it } from "vitest";
import {
  CALIBRATION_THRESHOLDS,
  averageRanks,
  choosePilot,
  externalGate,
  failedGateSentence,
  healthGate,
  ladderStep,
  signTestGreater,
  spearman,
  tournamentRecord,
  type CalibrationRow,
  type GateRecord,
} from "../../src/sims/calibration.js";

const row = (simShare: number, tourShare: number, tourN = 200, simN = 40): CalibrationRow => {
  const tw = Math.round(tourShare * tourN);
  const sw = Math.round(simShare * simN);
  return {
    a: "A",
    b: "B",
    aName: "A",
    bName: "B",
    tournament: { wins: tw, losses: tourN - tw, n: tourN, share: tw / tourN, low: null, high: null, excludesHalf: Math.abs(tourShare - 0.5) > 0.1 },
    sim: { wins: sw, n: simN, share: sw / simN, low: null, high: null, nonDecisive: 0 },
  };
};

describe("calibration statistics", () => {
  it("ranks ties at their average rank", () => {
    expect(averageRanks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
  });

  it("computes Spearman as Pearson on average ranks", () => {
    expect(spearman([1, 2, 3, 4, 5], [5, 6, 7, 8, 7.5])).toBeCloseTo(0.9, 10);
    expect(spearman([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 10);
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(spearman([1, 2], [1, 2])).toBeNull();
  });

  it("computes the exact one-sided sign test P(X >= k)", () => {
    expect(signTestGreater(10, 10)).toBeCloseTo(1 / 1024, 12);
    expect(signTestGreater(0, 10)).toBe(1);
    expect(signTestGreater(9, 10)).toBeCloseTo(11 / 1024, 12);
    expect(signTestGreater(0, 0)).toBe(1);
  });

  it("reads a tournament matchup by leader and sorted base aspects, draws left out", () => {
    const pairs = [
      { leader: "L1", baseAspects: ["Vigilance"], oppLeader: "L2", oppBaseAspects: [], wins: 30, losses: 10, draws: 2 },
      { leader: "L2", baseAspects: [], oppLeader: "L1", oppBaseAspects: ["Vigilance"], wins: 10, losses: 30, draws: 2 },
    ];
    const r = tournamentRecord(pairs, { leader: "L1", baseAspects: "Vigilance" }, { leader: "L2", baseAspects: "" }, 10);
    expect(r).toMatchObject({ wins: 30, losses: 10, n: 40, share: 0.75, excludesHalf: true });
    expect(tournamentRecord(pairs, { leader: "L1", baseAspects: "Vigilance" }, { leader: "L2", baseAspects: "" }, 41)).toBeNull();
    expect(tournamentRecord(pairs, { leader: "L1", baseAspects: "" }, { leader: "L2", baseAspects: "" }, 10)).toBeNull();
  });
});

describe("external calibration gate", () => {
  it("passes when ranks agree and the favourite matches significantly often", () => {
    const shares = [0.2, 0.25, 0.3, 0.35, 0.38, 0.62, 0.65, 0.7, 0.75, 0.8];
    const g = externalGate(shares.map((s) => row(s, s)), CALIBRATION_THRESHOLDS);
    expect(g.spearman).toBeCloseTo(1, 10);
    expect(g.favourite.counted).toBe(10);
    expect(g.favourite.agree).toBe(10);
    expect(g.favourite.pValue).toBeCloseTo(1 / 1024, 6);
    expect(g.pass).toBe(true);
    expect(g.failed).toEqual([]);
  });

  it("fails and names both checks when the sim reverses the tournament", () => {
    const shares = [0.2, 0.25, 0.3, 0.35, 0.38, 0.62, 0.65, 0.7, 0.75, 0.8];
    const g = externalGate(shares.map((s) => row(1 - s, s)), CALIBRATION_THRESHOLDS);
    expect(g.pass).toBe(false);
    expect(g.failed).toEqual(["spearman", "favourite"]);
    expect(g.favourite.agree).toBe(0);
  });

  it("counts only matchups whose tournament interval excludes 50%, and a sim tie is no agreement", () => {
    const rows = [row(0.6, 0.55), row(0.5, 0.8), row(0.7, 0.8), row(0.3, 0.2)];
    const g = externalGate(rows, CALIBRATION_THRESHOLDS);
    expect(g.favourite.counted).toBe(3);
    expect(g.favourite.agree).toBe(2);
    expect(g.favourite.simTies).toBe(1);
  });
});

describe("health gate and ladder steps", () => {
  it("fails above 2% non-decisive or 5% fallback", () => {
    expect(healthGate({ games: 100, nonDecisive: 2, decisions: 1000, fallback: 50 }, CALIBRATION_THRESHOLDS).pass).toBe(true);
    expect(healthGate({ games: 100, nonDecisive: 3, decisions: 1000, fallback: 0 }, CALIBRATION_THRESHOLDS).pass).toBe(false);
    expect(healthGate({ games: 100, nonDecisive: 0, decisions: 1000, fallback: 51 }, CALIBRATION_THRESHOLDS).pass).toBe(false);
  });

  it("accepts a ladder record only for the same candidate, engine and tables", () => {
    const rec = {
      candidate: { spec: "rung1" },
      baseline: { spec: "random-spike" },
      engine: { commit: "e1" },
      inputs: { scoresSha256: "s", coefficientsSha256: "c", featuresSha256: "f" },
      summary: { pass: true, pooled: { share: 0.99 }, discordant: { pValue: 1e-9 } },
    };
    const want = { candidate: "rung1", baseline: "random-spike", engineCommit: "e1", inputs: { scoresSha256: "s", coefficientsSha256: "c", featuresSha256: "f" } };
    expect(ladderStep("rung1-vs-rung0.json", rec, "sha", want)).toMatchObject({ pass: true, stale: null, share: 0.99 });
    expect(ladderStep("x.json", { ...rec, engine: { commit: "e2" } }, "sha", want)).toMatchObject({ pass: false, stale: "engine commit e2, not e1" });
    expect(ladderStep("x.json", rec, "sha", { ...want, candidate: "rung3:k=8" })).toMatchObject({ pass: false });
    expect(ladderStep("x.json", null, null, want)).toMatchObject({ pass: false, stale: "no ladder record" });
  });
});

const gateRecord = (spec: string, rung: number, external: boolean, extra: Partial<GateRecord["gates"]> = {}): Pick<GateRecord, "policy" | "gates" | "pass" | "servesWinShare" | "failedGates" | "engine"> => {
  const gates = {
    replay: { pass: true },
    health: { pass: true },
    ladder: { pass: true },
    external: { pass: external, spearman: external ? 0.7 : 0.1, favourite: { counted: 30, agree: external ? 25 : 14, pValue: external ? 0.001 : 0.7 } },
    ...extra,
  } as unknown as GateRecord["gates"];
  const failedGates = (["replay", "health", "ladder", "external"] as const).filter((g) => !(gates[g] as { pass: boolean }).pass);
  return {
    policy: { spec, rung } as GateRecord["policy"],
    engine: { commit: "e1" } as GateRecord["engine"],
    gates,
    pass: failedGates.length === 0,
    servesWinShare: failedGates.length === 0,
    failedGates,
  };
};

describe("pilot choice", () => {
  it("serves the requested policy when its record passes", () => {
    const records = [gateRecord("rung1", 1, true), gateRecord("rung3:k=8", 3, true)];
    expect(choosePilot(records as GateRecord[], "rung1", "e1")).toMatchObject({ spec: "rung1" });
  });

  it("defaults to the highest passing rung", () => {
    const records = [gateRecord("rung1", 1, true), gateRecord("rung3:k=8", 3, true)];
    expect(choosePilot(records as GateRecord[], undefined, "e1")).toMatchObject({ spec: "rung3:k=8" });
    const onlyRung1 = [gateRecord("rung1", 1, true), gateRecord("rung3:k=8", 3, false)];
    expect(choosePilot(onlyRung1 as GateRecord[], undefined, "e1")).toMatchObject({ spec: "rung1" });
  });

  it("refuses a failing policy with a plain sentence naming the gate (D9)", () => {
    const records = [gateRecord("rung1", 1, false), gateRecord("rung3:k=8", 3, false)];
    const r = choosePilot(records as GateRecord[], "rung3:k=8", "e1");
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(/rung3:k=8 failed the external calibration gate/);
    expect((r as { error: string }).error).toMatch(/Spearman 0\.1/);
    const none = choosePilot(records as GateRecord[], undefined, "e1");
    expect((none as { error: string }).error).toMatch(/no bot rung has passed every calibration gate/);
  });

  it("refuses a policy with no record and a record for another engine commit", () => {
    expect((choosePilot([], "rung3mc", "e1") as { error: string }).error).toMatch(/rung3mc has no calibration gate record/);
    const stale = [gateRecord("rung1", 1, true)];
    expect((choosePilot(stale as GateRecord[], "rung1", "e9") as { error: string }).error).toMatch(/engine commit e1, not the pinned e9/);
  });

  it("names the failed gate in one sentence", () => {
    expect(failedGateSentence(gateRecord("rung1", 1, true, { health: { pass: false, nonDecisiveShare: 0.05, fallbackShare: 0 } as never }) as GateRecord)).toMatch(/rung1 failed the health gate/);
    expect(failedGateSentence(gateRecord("rung1", 1, true) as GateRecord)).toBeNull();
  });
});

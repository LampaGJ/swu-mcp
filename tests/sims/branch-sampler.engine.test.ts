import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { branchContext, runBranchTask, runCandidateTask } from "../../scripts/sims/branch-worker.js";
import { DEFAULTS, prepareSources, sampleBranches, type SampleOptions } from "../../scripts/sims/sample-branches.js";
import { branchRecordSchema } from "../../src/sims/branches.js";
import { DEFAULT_FORCETEKI } from "../../src/sims/engine-pin.js";

/** [engine] tests: they need the pinned clone, the 2026-10-31 run, the mault originals, the deck snapshot and the pinned vocabulary, and skip without them. */
const RUN = "data/runs/2026-10-31";
const ORIGINALS = "/Volumes/Local Files/Projects/mault/data/swu-originals/2026-10-16";
const hasEngine =
  existsSync(path.join(DEFAULT_FORCETEKI, "build/server/game/core/Game.js")) &&
  existsSync(path.join(RUN, "meta/archetypes.json")) &&
  existsSync(path.join(DEFAULTS.release, "llm/cards.toon")) &&
  existsSync(ORIGINALS) &&
  existsSync(DEFAULTS.decks) &&
  existsSync(DEFAULTS.vocab) &&
  existsSync(DEFAULTS.inventory);
const SCRATCH = path.resolve("tmp/branch-sampler-test");
const T = { timeout: 600_000 };

const fixture = (out: string, workers: number, extra: Partial<SampleOptions> = {}): SampleOptions => ({
  purpose: "fixture",
  date: "2026-11-01",
  runSeed: "fixture-2026-11-01",
  seedFrom: 7_100_000,
  games: 6,
  rate: 1,
  target: 20,
  K: 2,
  N: 1,
  workers,
  out: path.join(SCRATCH, out),
  job: `branch-sampler-test-${out}`,
  ...extra,
});
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

describe.skipIf(!hasEngine)("branch sampler on the engine", () => {
  if (hasEngine) {
    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(SCRATCH, { recursive: true });
  }

  it("gives byte-identical jsonl and outputHash for a 20-decision fixture run twice, with 1 and 4 workers", T, async () => {
    const a = await sampleBranches(fixture("w1", 1));
    const b = await sampleBranches(fixture("w4", 4));
    const c = await sampleBranches(fixture("w4-again", 4));
    const bytes = (r: { outDir: string }): Buffer => gunzipSync(readFileSync(path.join(r.outDir, "branches.jsonl.gz")));
    expect(a.manifest.counts.records).toBe(20);
    expect(sha(bytes(b))).toBe(sha(bytes(a)));
    expect(sha(bytes(c))).toBe(sha(bytes(a)));
    expect(b.manifest.replay.outputHash).toBe(a.manifest.replay.outputHash);
    expect(c.manifest.outputs.gzSha256).toBe(a.manifest.outputs.gzSha256);
    for (const line of bytes(a).toString("utf8").trim().split("\n")) branchRecordSchema.parse(JSON.parse(line));

    // Root survival: after every continuation the root restored with the root's descriptor set.
    const instrument = a.report.instrument as Record<string, number>;
    expect(a.manifest.counts.continuations).toBeGreaterThan(0);
    expect(instrument.rootDrift).toBe(0);
    // Determinization instrument: the K deals reorder the actor's deck, never change the opponent's hand-plus-deck
    // multiset, and every action of one deal sees the same deal (common random numbers).
    expect(instrument.distinctTop5Share).toBeGreaterThanOrEqual(0.9);
    expect(instrument.multisetViolations).toBe(0);
    expect(instrument.dealDrift).toBe(0);
    expect(a.manifest.trainingEligible).toBe(false);
  });

  it("skips and counts a source game whose replay reaches another RNG cursor, and finishes the run", T, async () => {
    const src = prepareSources(fixture("tamper", 1, { games: 1 }));
    const ctx = branchContext(src.init, src.ctx.engine);
    const cand = await runCandidateTask(ctx, { gameId: src.specs[0].seed, spec: src.specs[0], maxSourceDecisions: 2000 });
    expect(cand.candidates.length).toBeGreaterThan(1);
    const ks = cand.candidates.slice(0, 2);
    const task = { gameId: cand.gameId, spec: src.specs[0], ks, traceSha256: cand.traceSha256, sourceOutcome: { endCondition: cand.endCondition, winner: cand.winner }, K: 1, N: 1, runSeed: "tamper", maxContinuationDecisions: 2000, maxSourceDecisions: 2000 };
    const tampered = await runBranchTask(ctx, { ...task, ks: [ks[0], { ...ks[1], rngCursor: `9${ks[1].rngCursor}` }] });
    expect(tampered.replayMismatchAt).toBe(ks[1].k);
    expect(tampered.records.map((r) => r.k)).toEqual([ks[0].k]);
    expect(tampered.traceMatched).toBe(false);
    // A source game past the decision cap ends as a timeout, which the sampler excludes from candidates like an error.
    const capped = await runCandidateTask(ctx, { gameId: src.specs[0].seed, spec: src.specs[0], maxSourceDecisions: 10 });
    expect(capped.endCondition).toBe("timeout");
  });

  it("refuses an output directory holding different bytes, and an evaluation-range overlap before any game", T, async () => {
    const out = path.join(SCRATCH, "occupied");
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, "branches.jsonl.gz"), "not this dataset");
    await expect(sampleBranches(fixture("occupied", 1, { games: 1, target: 1, K: 1 }))).rejects.toThrow(/different bytes/);
    expect(() => prepareSources(fixture("overlap", 1, { seedFrom: 8_999_990, games: 20 }))).toThrow(/overlap/);
  });
});

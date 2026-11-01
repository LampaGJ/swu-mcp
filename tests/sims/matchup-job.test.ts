import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadStore } from "../../src/data.js";
import { REPO_ROOT } from "../../src/paths.js";
import { BUILT_MARKER, DEFAULT_FORCETEKI, readPin } from "../../src/sims/engine-pin.js";
import { canonicalInput, inputHash, jobKey, jobResultSchema, jobStatusSchema, parseMatchupInput, plannedGames } from "../../src/sims/matchup.js";
import { swudbCandidates } from "../../src/tools/swudb.js";

const RECORD = "data/pinned/sim-calibration-v1/calibration-rung1.json";
const RUN = path.join(REPO_ROOT, "data/runs/2026-10-31");
const ready = existsSync(path.join(DEFAULT_FORCETEKI, BUILT_MARKER)) && existsSync(path.join(REPO_ROOT, RECORD)) && existsSync(path.join(RUN, "llm"));

/** The owner's SWUDB deck by cardKey, resolved through the card table. */
function ownerDeck() {
  const store = loadStore(path.join(RUN, "llm"));
  const doc = JSON.parse(readFileSync(path.join(REPO_ROOT, "tests/fixtures/decks/warrior-chewie-raid.swudb.json"), "utf8")) as { leader: { id: string }; base: { id: string }; deck: { id: string; count: number }[] };
  const one = (id: string, ok: (t: string) => boolean): string => [...new Set(swudbCandidates(store, id).filter((c) => ok(String(c.type))).map((c) => c.cardKey))][0];
  return { leader: one(doc.leader.id, (t) => t === "Leader"), base: one(doc.base.id, (t) => t === "Base"), cards: doc.deck.map((e) => ({ cardKey: one(e.id, (t) => t !== "Leader" && t !== "Base"), count: e.count })) };
}

describe.skipIf(!ready)("simulate_matchup job runner on the engine", () => {
  it("plays a head-to-head job to a labelled result, byte-identical on a rerun", () => {
    const deck = ownerDeck();
    const out = deck.cards[0].cardKey;
    const parsed = parseMatchupInput({ deck, variant: [`${out}>${deck.cards[1].cardKey}`], games: 2, seed: "job-test" });
    if (!parsed.ok) throw new Error(parsed.error);
    const canon = canonicalInput(parsed.input, "rung1");
    const pin = readPin();
    const pins = { codeCommit: "test-commit", engineCommit: pin.commit, cardDataSha256: pin.cardDataSha256, gateRecordSha256: createHash("sha256").update(readFileSync(path.join(REPO_ROOT, RECORD))).digest("hex") };
    const results: string[] = [];
    for (const attempt of [0, 1]) {
      mkdirSync(path.join(REPO_ROOT, "tmp"), { recursive: true });
      const dir = mkdtempSync(path.join(REPO_ROOT, `tmp/matchup-job-test-${attempt}-`));
      const jobFile = path.join(dir, "job.json");
      writeFileSync(jobFile, JSON.stringify({ key: jobKey(canon, pins), inputHash: inputHash(canon), input: canon, gateRecord: RECORD, pins, workers: 2, plannedGames: plannedGames(parsed.input) }));
      const run = spawnSync(process.execPath, ["--import", "tsx", "--import=./scripts/sims/ladder-preload.ts", "scripts/sims/matchup-job.ts", jobFile], { cwd: REPO_ROOT, encoding: "utf8", timeout: 110_000, env: { ...process.env, TMPDIR: path.join(REPO_ROOT, "tmp") } });
      const status = jobStatusSchema.parse(JSON.parse(readFileSync(path.join(dir, "status.json"), "utf8")));
      expect(status.error, run.stderr.slice(-400)).toBeNull();
      expect(status.state).toBe("done");
      results.push(readFileSync(path.join(dir, "result.json"), "utf8"));
    }
    expect(results[1]).toBe(results[0]);
    const result = jobResultSchema.parse(JSON.parse(results[0])) as unknown as Record<string, unknown> & { mirror: { games: number }; n: number };
    expect(result.label).toBe("bot play (forceteki rung1), not human results");
    expect(result.status).toBe("candidate");
    expect(result.mode).toBe("h2h");
    expect(result.mirror.games).toBe(2);
    expect(result.n).toBeGreaterThan(0);
  }, 120_000);
});

/** Writes a job file for the owner's deck and runs the job runner on it; returns the job directory. */
function runJob(raw: unknown, record: string, workers: number, tag: string): { dir: string; stderr: string } {
  const parsed = parseMatchupInput(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  const canon = canonicalInput(parsed.input, "rung1");
  const pin = readPin();
  const pins = { codeCommit: "test-commit", engineCommit: pin.commit, cardDataSha256: pin.cardDataSha256, gateRecordSha256: createHash("sha256").update(readFileSync(path.join(REPO_ROOT, record))).digest("hex") };
  mkdirSync(path.join(REPO_ROOT, "tmp"), { recursive: true });
  const dir = mkdtempSync(path.join(REPO_ROOT, `tmp/matchup-job-test-${tag}-`));
  const jobFile = path.join(dir, "job.json");
  writeFileSync(jobFile, JSON.stringify({ key: jobKey(canon, pins), inputHash: inputHash(canon), input: canon, gateRecord: record, pins, workers, plannedGames: plannedGames(parsed.input) }));
  const run = spawnSync(process.execPath, ["--import", "tsx", "--import=./scripts/sims/ladder-preload.ts", "scripts/sims/matchup-job.ts", jobFile], { cwd: REPO_ROOT, encoding: "utf8", timeout: 110_000, env: { ...process.env, TMPDIR: path.join(REPO_ROOT, "tmp") } });
  return { dir, stderr: run.stderr };
}

describe.skipIf(!ready)("simulate_matchup relative job on the engine (D108)", () => {
  it("plays the head-to-head, the mirror and the paired field comparison to a relative result, byte-identical on a rerun, with no absolute win share", () => {
    const deck = ownerDeck();
    const request = { deck, variant: [`${deck.cards[0].cardKey}>${deck.cards[1].cardKey}`], opponent: "field", relative: true, games: 2, seed: "relative-job-test" };
    const results: string[] = [];
    for (const attempt of ["a", "b"]) {
      const { dir, stderr } = runJob(request, RECORD, 2, attempt);
      const status = jobStatusSchema.parse(JSON.parse(readFileSync(path.join(dir, "status.json"), "utf8")));
      expect(status.error, stderr.slice(-400)).toBeNull();
      expect(status.state).toBe("done");
      results.push(readFileSync(path.join(dir, "result.json"), "utf8"));
    }
    expect(results[1]).toBe(results[0]);
    const result = jobResultSchema.parse(JSON.parse(results[0])) as unknown as Record<string, any>;
    expect(result.label).toBe("bot play (forceteki rung1), relative comparison on identical shuffles, not a human or tournament win rate");
    expect(result.status).toBe("candidate");
    expect(result.mode).toBe("relative");
    expect(result.headToHead).toMatchObject({ pairs: 2, games: 4, mirror: { games: 2 } });
    expect(result.headToHead.seedsWonBothOrders).toHaveProperty("pValue");
    expect(result.field.games).toBe(14);
    expect(result.field.deckMinusVariant).toHaveProperty("ci95");
    expect(result.field.perArchetype).toHaveLength(7);
    expect(result.notes).toEqual([]);
    expect(Object.keys(result).filter((k) => ["winShare", "wilson95", "deck", "variantDeck", "perArchetype"].includes(k))).toEqual([]);
    expect(result.health.games).toBe(4 + 2 + 28);
  }, 260_000);

  it("refuses a relative job whose record fails a gate the claim rests on, before any game", () => {
    const record = JSON.parse(readFileSync(path.join(REPO_ROOT, RECORD), "utf8"));
    record.gates.ladder.pass = false;
    mkdirSync(path.join(REPO_ROOT, "tmp"), { recursive: true });
    const holder = mkdtempSync(path.join(REPO_ROOT, "tmp/matchup-job-test-record-"));
    writeFileSync(path.join(holder, "record.json"), JSON.stringify(record));
    const deck = ownerDeck();
    const { dir } = runJob({ deck, variant: [`${deck.cards[0].cardKey}>${deck.cards[1].cardKey}`], relative: true, games: 2 }, path.relative(REPO_ROOT, path.join(holder, "record.json")), 2, "gate");
    const status = jobStatusSchema.parse(JSON.parse(readFileSync(path.join(dir, "status.json"), "utf8")));
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/rung1 failed the ladder gate, so it may not report a relative comparison/);
    expect(existsSync(path.join(dir, "result.json"))).toBe(false);
  }, 120_000);
});

describe("simulate_matchup job runner on a bad job file", () => {
  it("records a failed status naming the job file, so the tool reports it instead of waiting", () => {
    mkdirSync(path.join(REPO_ROOT, "tmp"), { recursive: true });
    const dir = mkdtempSync(path.join(REPO_ROOT, "tmp/matchup-job-bad-"));
    const jobFile = path.join(dir, "job.json");
    writeFileSync(jobFile, JSON.stringify({ key: "nope" }));
    spawnSync(process.execPath, ["--import", "tsx", "--import=./scripts/sims/ladder-preload.ts", "scripts/sims/matchup-job.ts", jobFile], { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000 });
    const status = jobStatusSchema.parse(JSON.parse(readFileSync(path.join(dir, "status.json"), "utf8")));
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/does not parse/);
  }, 60_000);
});

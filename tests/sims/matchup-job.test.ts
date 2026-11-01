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

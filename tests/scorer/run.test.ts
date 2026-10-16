import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCoefficients } from "../../src/scorer/coefficients.js";
import { runScoring } from "../../src/scorer/run.js";
import { scoresFileSchema, scoresReplaySchema } from "../../src/scorer/scores-file.js";
import { sha256Hex } from "../../src/swu/canonical.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = path.join(REPO_ROOT, "tests/fixtures");
const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), "utf8");
const coefficientsText = read("data/rubric-coefficients.json");

describe("committed coefficients", () => {
  it("parse against the schema", () => {
    const { coefficients } = parseCoefficients(coefficientsText);
    expect(coefficients.designer.powerWeight).toBeGreaterThan(coefficients.designer.hpWeight);
    expect(coefficients.play.perStatPoint).toBeGreaterThan(0);
  });

  it("were fitted by the current fit script and feature builder", () => {
    const { source } = parseCoefficients(coefficientsText).coefficients;
    expect(source.scriptSha256, "scripts/fit-coefficients.ts changed: run pnpm fit:coefficients").toBe(sha256Hex(read("scripts/fit-coefficients.ts")));
    expect(source.featuresModuleSha256, "src/scorer/features.ts changed: run pnpm fit:coefficients").toBe(sha256Hex(read("src/scorer/features.ts")));
  });

  it("record the pinned SWU Stats capture they were fitted on", () => {
    const { source } = parseCoefficients(coefficientsText).coefficients;
    expect(source.swuStatsCaptureSha256).toBe(sha256Hex(read(source.swuStatsCapture)));
  });
});

describe("scoring run", () => {
  const first = runScoring(FIXTURES, coefficientsText, "fixture");

  it("gives identical bytes on a second run", () => {
    const second = runScoring(FIXTURES, coefficientsText, "fixture");
    expect(second.scoresText).toBe(first.scoresText);
    expect(second.replayText).toBe(first.replayText);
  });

  it("matches the committed fixture scores, so a coefficient change cannot go unnoticed", () => {
    expect(first.scoresText, "run: pnpm tsx scripts/make-test-fixture.ts").toBe(read("tests/fixtures/scores/scores.json"));
    expect(first.replayText).toBe(read("tests/fixtures/scores/replay.json"));
  });

  it("writes a replay record that chains the inputs, coefficients and output", () => {
    const replay = scoresReplaySchema.parse(JSON.parse(first.replayText));
    expect(replay.outputHash).toBe(sha256Hex(first.scoresText));
    expect(replay.coefficientsSha256).toBe(sha256Hex(coefficientsText));
    expect(replay.inputHashes.featuresJson).toBe(sha256Hex(read("tests/fixtures/features/features.json")));
    expect(replay.inputHashes.cardsToon).toBe(sha256Hex(read("tests/fixtures/llm/cards.toon")));
  });

  it("scores every fixture card and orders rows by cardKey", () => {
    const file = scoresFileSchema.parse(JSON.parse(first.scoresText));
    expect(file.cards.map((c) => c.cardKey)).toEqual(["0101030", "0101033", "0101070", "0101074", "0101165", "04010001", "04010087", "09010004", "09010218"]);
    expect(file.cards.every((c) => c.scored)).toBe(true);
  });
});

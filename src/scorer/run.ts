import { readFileSync } from "node:fs";
import path from "node:path";
import { sha256Hex } from "../swu/canonical.js";
import { parseCoefficients } from "./coefficients.js";
import { loadScorerInputs } from "./inputs.js";
import { scoreCard } from "./score.js";
import { scoresFileSchema, scoresReplaySchema, toScoreRows, type ScoresReplay } from "./scores-file.js";

/**
 * @displayName Scoring run
 * @strategicPurpose One pure function from (package directory, coefficients text, code commit) to
 * the bytes of scores.json and its replay record, so the script and the determinism test run the same code.
 * @tacticalObjective Reads files but writes none; the caller decides where the bytes go.
 */
export interface ScoringRun {
  scoresText: string;
  replay: ScoresReplay;
  replayText: string;
}

export function runScoring(dataDir: string, coefficientsText: string, codeCommit: string): ScoringRun {
  const loaded = parseCoefficients(coefficientsText);
  const inputs = loadScorerInputs(dataDir);
  const featuresReplay = JSON.parse(readFileSync(path.join(dataDir, "features/replay.json"), "utf8")) as { inputHash: string };
  const rows = toScoreRows(inputs.cards.map((card) => scoreCard(card, loaded.coefficients)));
  const scoresText = `${JSON.stringify(scoresFileSchema.parse({ rubricVersion: loaded.coefficients.rubricVersion, coefficientsSha256: loaded.sha256, cards: rows }), null, 1)}\n`;
  const replay = scoresReplaySchema.parse({
    rubricVersion: loaded.coefficients.rubricVersion,
    inputHashes: {
      featuresJson: inputs.featuresJsonSha256,
      cardsToon: inputs.cardsToonSha256,
      featuresReplayInputHash: featuresReplay.inputHash,
      coefficientsFile: loaded.sha256,
      swuStatsCapture: loaded.coefficients.source.swuStatsCaptureSha256,
    },
    codeCommit,
    coefficientsSha256: loaded.sha256,
    scoredCards: rows.filter((r) => r.scored).length,
    outputHash: sha256Hex(scoresText),
  });
  return { scoresText, replay, replayText: `${JSON.stringify(replay, null, 1)}\n` };
}

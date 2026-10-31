/**
 * @displayName Engine id coverage report
 * @strategicPurpose Show, list by list, which tournament decks reach the forceteki engine directly and which need the
 * identity translation (#109), so no list is silently dropped from a battle test.
 * @tacticalObjective Runs `deckCoverage` over a deck folder and writes the full report (every list that hit a
 * translated or unmapped id, by file name) to reports/sims/bridge-coverage.json; prints the counts.
 *
 * Usage: tsx scripts/sims/bridge-coverage.ts [--decks <dir>] [--run <dir>] [--originals <dir>] [--forceteki <dir>] [--out <file>]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "../../src/paths.js";
import { DEFAULT_FORCETEKI } from "../../src/sims/engine-pin.js";
import { DEFAULT_ORIGINALS_ROOT } from "../bench/card-map.js";
import { isMain } from "../bench/code-commit.js";
import { deckCoverage, loadCardBridge } from "./card-bridge.js";

function main(): void {
  const { values } = parseArgs({
    options: {
      decks: { type: "string", default: path.join(REPO_ROOT, "data/originals/decks/2026-10-17") },
      run: { type: "string", default: path.join(REPO_ROOT, "data/runs/2026-10-31") },
      originals: { type: "string", default: path.join(DEFAULT_ORIGINALS_ROOT, "2026-10-16") },
      forceteki: { type: "string", default: DEFAULT_FORCETEKI },
      out: { type: "string", default: path.join(REPO_ROOT, "reports/sims/bridge-coverage.json") },
    },
  });
  const report = deckCoverage(loadCardBridge(values.run, values.originals, values.forceteki), values.decks);
  mkdirSync(path.dirname(values.out), { recursive: true });
  writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
  const fullyDirect = report.files - report.filesWithTranslation.length - new Set(report.unmappedAfterTranslation.flatMap((u) => u.files)).size;
  console.log(
    JSON.stringify({
      out: values.out,
      files: report.files,
      slots: report.slots,
      directSlots: report.directSlots,
      translatedIds: report.translatedIds,
      filesWithTranslation: report.filesWithTranslation.length,
      filesFullyDirect: fullyDirect,
      unmappedAfterTranslation: report.unmappedAfterTranslation.map((u) => ({ id: u.id, slots: u.slots, files: u.files.length })),
      roundTrip: { cardKeys: report.roundTrip.cardKeys, viaSlug: report.roundTrip.viaSlug.length, mismatches: report.roundTrip.mismatches.length },
    }),
  );
  if (report.unmappedAfterTranslation.length > 0 || report.roundTrip.mismatches.length > 0) process.exitCode = 1;
}

if (isMain(import.meta.url)) main();

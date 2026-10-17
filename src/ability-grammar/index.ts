import { z } from "zod";
import {
  swuCardFeaturesCoverageSchema,
  swuCardFeaturesReplaySchema,
  swuCardFeaturesSchema,
  swuFeatureInputCardSchema,
  type SwuCardFeaturesReplay,
  type SwuFeatureInputCard,
} from "./deps.js";
import { compareCodePoints, sha256Hex } from "./deps.js";
import { StaleCuratedEntriesError, loadCuratedTable } from "./curated.js";
import { extractFeatures, type ExtractionResult } from "./extract.js";
import { GRAMMAR_VERSION } from "./vocab.js";

export { extractFeatures, sortKeysDeep, type ExtractionResult } from "./extract.js";
export { CuratedTableError, StaleCuratedEntriesError, curatedReport, loadCuratedTable } from "./curated.js";
export { SWU_PRODUCTIONS, parseClause, parseTarget } from "./grammar.js";
export { extractGranted, isKeywordLine, normalizeText, parseHeader, parseKeywordList, splitHeader, splitSentences, stripReminders, unwrapParenthetical } from "./segment.js";
export { buildTags } from "./tags.js";
export { walkAbilities, walkKeywords } from "./walk.js";
export { GRAMMAR_VERSION } from "./vocab.js";

export interface FeatureRun {
  files: Record<string, string>;
  replay: SwuCardFeaturesReplay;
  result: ExtractionResult;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 1)}\n`;

/** The projection the extractor reads, as canonical text: the input hash must not move when an unread column does. */
function inputText(cards: readonly SwuFeatureInputCard[]): string {
  const projected = cards
    .map((c) => ({
      cardKey: c.cardKey, title: c.title, subtitle: c.subtitle ?? null, type: c.type, type2: c.type2 ?? null,
      cost: c.cost ?? null, power: c.power ?? null, hp: c.hp ?? null, upgradePower: c.upgradePower ?? null,
      upgradeHp: c.upgradeHp ?? null, arenas: c.arenas ?? null, aspects: c.aspects ?? null,
      aspectDuplicates: c.aspectDuplicates ?? null, traits: c.traits ?? null, keywords: c.keywords ?? null,
      unique: c.unique ?? null, text: c.text ?? null, deployBox: c.deployBox ?? null, epicAction: c.epicAction ?? null,
    }))
    .sort((a, b) => compareCodePoints(a.cardKey, b.cardKey));
  return JSON.stringify(projected);
}

/**
 * @displayName SWU card-features run
 * @strategicPurpose The manipulation node that turns card rows plus the
 * committed curated table into features.json, coverage.json and
 * unclassified.json with a replay record (LampaGJ/mault#322), so any later
 * commit can prove it reproduces the same bytes.
 * @tacticalObjective Consumer gate: parses the card rows and the curated
 * table. Emitter gate: parses every card record, the coverage report and the
 * replay record before returning. Throws StaleCuratedEntriesError after the
 * run if a curated entry matches no clause, with the files already built.
 * No clock, no randomness: outputs are a pure function of the arguments.
 */
export function buildFeatureRun(rawCards: readonly unknown[], curatedJson: string, codeCommit: string): FeatureRun {
  const cards = z.array(swuFeatureInputCardSchema).parse(rawCards);
  const { table, index } = loadCuratedTable(curatedJson);
  const result = extractFeatures(cards, index);
  z.array(swuCardFeaturesSchema).parse(result.cards);
  swuCardFeaturesCoverageSchema.parse(result.coverage);

  const files: Record<string, string> = {
    "features.json": json(result.cards),
    "coverage.json": json(result.coverage),
    "unclassified.json": json(result.shapes),
  };
  const outputHashes = Object.fromEntries(Object.keys(files).sort(compareCodePoints).map((name) => [name, sha256Hex(files[name])]));
  const replay = swuCardFeaturesReplaySchema.parse({
    inputHash: sha256Hex(inputText(cards)),
    codeCommit,
    curatedTableSha256: sha256Hex(curatedJson),
    curatedTableVersion: table.tableVersion,
    grammarVersion: GRAMMAR_VERSION,
    outputHashes,
  });
  files["replay.json"] = json(replay);
  return { files, replay, result };
}

export function assertNoStaleCurated(run: FeatureRun): void {
  if (run.result.curated.stale.length > 0) throw new StaleCuratedEntriesError(run.result.curated.stale);
}

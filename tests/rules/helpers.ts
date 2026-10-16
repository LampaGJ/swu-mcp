import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRulesRun, type RulesRun } from "../../src/rules/build.js";
import { buildCardRulings } from "../../src/rules/rulings.js";
import type { RulesCoreFile } from "../../src/rules/schemas.js";
import type { RawCardRecord } from "../../src/swu/llm-flatten.js";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const FIXTURES = path.join(REPO_ROOT, "tests/fixtures/rules");
export const SLICE = readFileSync(path.join(FIXTURES, "cr-slice.txt"), "utf8");
export const PDF_SHA = "a".repeat(64);

export function fixtureRecords(): RawCardRecord[] {
  return (JSON.parse(readFileSync(path.join(FIXTURES, "raw-pages/page-0001.json"), "utf8")) as { data: RawCardRecord[] }).data;
}

export const countByLength = (text: string): number => Math.ceil(text.length / 4);

export function fixtureRun(core: RulesCoreFile, maxTokens = 100000): RulesRun {
  return buildRulesRun({
    text: SLICE,
    pdfSha256: PDF_SHA,
    glossaryVersion: 1,
    glossaryKeywords: [
      { value: "Deck", definition: "The pile of cards a player draws from." },
      { value: "Ready", definition: null },
      { value: "Nonexistent", definition: null },
    ],
    core,
    cardRulings: buildCardRulings(fixtureRecords(), { originalsRun: "fixture", rawPagesManifestSha256: "b".repeat(64) }),
    primerMaxTokens: maxTokens,
    countTokens: countByLength,
  });
}

/** Writes a rules run for the fixture slice under the repo's git-ignored tmp/ and returns its directory. */
export function writeFixtureRulesDir(core: RulesCoreFile): string {
  const base = path.join(REPO_ROOT, "tmp");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, "rules-test-"));
  const run = fixtureRun(core);
  for (const [name, content] of Object.entries(run.files)) writeFileSync(path.join(dir, name), content);
  writeFileSync(
    path.join(dir, "replay.json"),
    JSON.stringify({
      schemaVersion: 1,
      source: { url: "https://example.invalid/cr.pdf", fetchedAt: "2026-10-16", pdfSha256: PDF_SHA, pdfBytes: 1 },
      tool: { pdftotext: "test", codeCommit: "test" },
      rulesVersion: run.parsed.version,
      textSha256: "c".repeat(64),
      rulings: { originalsRun: "fixture", rawPagesManifestSha256: "b".repeat(64) },
      outputs: run.hashes,
    }),
  );
  return dir;
}

export function writeCore(entries: { id: string }[]): string {
  const dir = mkdtempSync(path.join(REPO_ROOT, "tmp/core-"));
  const file = path.join(dir, "rules-core.json");
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, entries: entries.map((e) => ({ id: e.id, topic: "t", why: "w" })) }));
  return file;
}

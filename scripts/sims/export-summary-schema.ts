/**
 * @displayName sims:summary JSON Schema export
 * @strategicPurpose Gives consumers in other repos (schickso, TerminalWidget) a file to validate the summary against
 * without importing this repo's code (#179 of #104, D100).
 * @tacticalObjective Serialises z.toJSONSchema(simsSummarySchema) to docs/schemas/sims-summary.v1.schema.json,
 * deterministically (two-space JSON, a trailing newline, no clock). tests/sims/summary.test.ts fails when the committed
 * file differs from this output. `--check` writes nothing and exits 1 when the file is stale.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/sims/export-summary-schema.ts [--check]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "../../src/paths.js";
import { simsSummaryJsonSchema } from "../../src/sims/summary.js";

const file = path.join(REPO_ROOT, "docs/schemas/sims-summary.v1.schema.json");
const want = `${JSON.stringify(simsSummaryJsonSchema(), null, 2)}\n`;
const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } });

if (values.check === true) {
  const same = existsSync(file) && readFileSync(file, "utf8") === want;
  process.stdout.write(same ? "up to date\n" : "stale: run the export without --check\n");
  process.exitCode = same ? 0 : 1;
} else {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, want);
  process.stdout.write(`wrote ${path.relative(REPO_ROOT, file)}\n`);
}

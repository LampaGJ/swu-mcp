/**
 * @displayName Tournament matchup capture
 * @strategicPurpose The one network read behind tournament win rates (LampaGJ/swu-mcp#25, #26): swumetastats.com's
 * aggregate leader+base matchups over melee.gg Premier events, captured once and pinned by sha256 so every later step
 * replays from the same bytes. Tournament outcomes are the primary win-rate source (owner direction 2026-10-17).
 * @tacticalObjective Fetches /api/matchups for one window and writes the raw body plus capture.json (url, window,
 * sha256, bytes, fetch time) to the git-ignored data/originals/tournaments/<to>/. Refuses to overwrite a capture.
 *
 * Usage: pnpm meta:capture-matchups --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--min-players <n>] [--out <dir>]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { REPO_ROOT } from "../../src/paths.js";
import { matchupResponseSchema } from "../../src/meta/outcomes.js";

const API = "https://swumetastats.com/api/matchups";
const USER_AGENT = "swu-mcp-research/0.1 (meta defense PoC; tournament win rates)";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { from: { type: "string" }, to: { type: "string" }, "min-players": { type: "string" }, out: { type: "string" } },
  });
  const from = z.iso.date().parse(values.from);
  const to = z.iso.date().parse(values.to);
  const minPlayers = z.coerce
    .number()
    .int()
    .min(1)
    .parse(values["min-players"] ?? "1");
  const outDir = path.resolve(values.out ?? path.join(REPO_ROOT, "data/originals/tournaments", to));
  const rawFile = path.join(outDir, "matchups.json");
  if (existsSync(rawFile)) throw new Error(`${rawFile} exists; a capture is pinned once and never overwritten`);

  const url = `${API}?format=Premier&startDate=${from}&endDate=${to}&minPlayers=${minPlayers}`;
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}`);
  const body = Buffer.from(await response.arrayBuffer());
  const parsed = matchupResponseSchema.parse(JSON.parse(body.toString("utf8")));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(rawFile, body);
  const capture = {
    kind: "swumetastats-matchups",
    url,
    window: { from, to },
    minPlayers,
    fetchedAt: new Date().toISOString(),
    sha256: createHash("sha256").update(body).digest("hex"),
    bytes: body.length,
    rows: parsed.matchups.length,
    population: "tournament (melee.gg Premier events tracked by swumetastats.com)",
  };
  writeFileSync(path.join(outDir, "capture.json"), `${JSON.stringify(capture, null, 1)}\n`);
  console.log(JSON.stringify(capture, null, 1));
}

await main();

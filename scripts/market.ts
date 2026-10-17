/**
 * @displayName Market data script
 * @strategicPurpose Manipulation node: mault price originals, the raw card pages and the pinned SWU Stats
 * captures in; <package>/market/{prices,play,replay}.json out, byte-identical on a rerun.
 * @tacticalObjective Flattens the raw pages to map price rows (serialCode) and capture rows (cardUid) to
 * logical cards, then calls src/market/build.ts. Refuses originals whose raw manifest differs from the
 * one the package was built from.
 *
 * Usage: pnpm market [--data <package dir>] [--originals <dir>] [--captures <dir>]
 *   --data       default: newest dated dir under data/runs (SWU_MCP_DATA wins)
 *   --originals  default: mault originals dir with the package's date
 *   --captures   default: <repo>/data/pinned/gt
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadStore, packageDirOf, resolveDataDir } from "../src/data.js";
import { buildPlay, buildPrices, captureRowSchema, priceRowSchema } from "../src/market/build.js";
import { compareCodePoints, sha256Hex } from "../src/swu/canonical.js";
import { printingCardKeys } from "../src/swu/llm-flatten.js";
import { codeCommit } from "./lib/code-commit.js";
import { DEFAULT_ORIGINALS_ROOT } from "./lib/originals.js";
import { loadRawPrintings, packageRawManifestSha256 } from "./lib/raw-pages.js";
import { REPO_ROOT } from "../src/paths.js";


const importSchema = z.looseObject({ id: z.number().int(), finished_at: z.string().nullable().optional() });


function main(): void {
  const { values } = parseArgs({ options: { data: { type: "string" }, originals: { type: "string" }, captures: { type: "string" } } });
  const store = loadStore(path.resolve(values.data ?? resolveDataDir()));
  const packageDir = packageDirOf(store);
  const originals = path.resolve(values.originals ?? path.join(DEFAULT_ORIGINALS_ROOT, path.basename(packageDir)));
  const capturesDir = path.resolve(values.captures ?? path.join(REPO_ROOT, "data/pinned/gt"));

  const packageManifestSha = packageRawManifestSha256(path.join(packageDir, "replay.json"));
  const { printings } = loadRawPrintings(path.join(originals, "swu-cards/raw-pages"), packageManifestSha);
  const cardKeyOfPrinting = printingCardKeys(printings);
  const cardKeyOfUid = new Map<string, string>();
  for (const row of printings) {
    const key = cardKeyOfPrinting.get(String(row.serialCode));
    if (key !== undefined && row.cardUid !== null && row.cardUid !== undefined) cardKeyOfUid.set(String(row.cardUid), key);
  }
  const leaderKeys = new Set(printings.filter((row) => row.type === "Leader" && cardKeyOfPrinting.get(String(row.serialCode)) === row.serialCode).map((row) => String(row.serialCode)));

  const pricesDir = path.join(originals, "tcgplayer-prices");
  const importBytes = readFileSync(path.join(pricesDir, "price-import.json"));
  const printingsBytes = readFileSync(path.join(pricesDir, "printings.json"));
  const importRow = importSchema.parse(JSON.parse(importBytes.toString("utf8")));
  const prices = buildPrices({
    rows: z.array(priceRowSchema).parse(JSON.parse(printingsBytes.toString("utf8"))),
    cardKeyOfPrinting,
    importId: importRow.id,
    importFinishedAt: importRow.finished_at ?? null,
  });

  const captureFiles = readdirSync(capturesDir).filter((name) => /^swustats-premier-w\d+-\d+\.json$/.test(name)).sort(compareCodePoints);
  if (captureFiles.length === 0) throw new Error(`no swustats-premier-w*.json under ${capturesDir}`);
  const captureBytes = captureFiles.map((file) => ({ file, bytes: readFileSync(path.join(capturesDir, file)) }));
  const play = buildPlay({
    captures: captureBytes.map(({ file, bytes }) => ({ file, sha256: sha256Hex(bytes), rows: z.array(captureRowSchema).parse(JSON.parse(bytes.toString("utf8"))) })),
    cardKeyOfUid,
    leaderKeys,
  });

  const pricesText = `${JSON.stringify(prices)}\n`;
  const playText = `${JSON.stringify(play)}\n`;
  const replay = {
    inputs: {
      rawManifestSha256: packageManifestSha,
      priceImportId: importRow.id,
      priceImportFileSha256: sha256Hex(importBytes),
      priceRowsFileSha256: sha256Hex(printingsBytes),
      captures: Object.fromEntries(captureBytes.map(({ file, bytes }) => [file, sha256Hex(bytes)])),
      originalsPath: originals,
    },
    codeCommit: codeCommit(["src", "scripts", "package.json"]),
    outputs: { "market/prices.json": sha256Hex(pricesText), "market/play.json": sha256Hex(playText) },
  };

  const outDir = path.join(packageDir, "market");
  mkdirSync(outDir, { recursive: true });
  if (!existsSync(outDir)) throw new Error(`cannot create ${outDir}`);
  writeFileSync(path.join(outDir, "prices.json"), pricesText);
  writeFileSync(path.join(outDir, "play.json"), playText);
  writeFileSync(path.join(outDir, "replay.json"), `${JSON.stringify(replay, null, 2)}\n`);
  console.log(JSON.stringify({ outDir, priceCards: prices.cards.length, playCards: play.cards.length, windows: play.windows.map((w) => ({ id: w.id, playerGames: w.playerGames })), outputs: replay.outputs }, null, 1));
}

main();

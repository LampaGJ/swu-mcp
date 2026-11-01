/**
 * @displayName Bot-vs-bot games over a local karabast gamenode (phase 2)
 * @strategicPurpose Proves the live client end to end over real sockets before any live game (#182 phase 2): two
 * rung 1 bots play each other through the pinned clone's own gamenode on loopback, with zero protocol errors, and
 * every decision replays from the recorded stream.
 * @tacticalObjective Loads the loopback guard into this process, starts the gamenode (scripts/karabast/local-run.ts),
 * plays `--games` games over every ordered pair of the ladder panel plus the owner's deck, autoSingleTarget off on
 * even games and on on odd ones, in open format (premier suspends a ladder leader, ASH_011), and writes
 * `<out>/report.json` next to the scrubbed streams `<out>/game-<n>-seat<s>.jsonl.gz`. Heartbeat:
 * reports/.progress/karabast-local-games.json.
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { progress } from "../lib/progress.mjs";
import { contextOptions, loadContext } from "../sims/context.js";
import { REPO_ROOT } from "../../src/paths.js";
import { loadSocketIoClient } from "../../src/karabast/client.js";
import { loadCardIndex } from "../../src/karabast/player-view.js";
import { DEFAULT_DECKS, ladderDecks, ownDeckOf, rung1Bot, rung1Tables } from "./context.js";
import { LOOPBACK_GUARD, playLocalGame, startLocalGamenode, type GameRow } from "./local-run.js";

createRequire(import.meta.url)(LOOPBACK_GUARD);

const { values } = parseArgs({
  options: {
    ...contextOptions,
    games: { type: "string", default: "50" },
    port: { type: "string", default: "9517" },
    decks: { type: "string", default: DEFAULT_DECKS },
    out: { type: "string" },
    "stall-ms": { type: "string", default: "30000" },
    "game-ms": { type: "string", default: "600000" },
    format: { type: "string", default: "open" },
    "card-pool": { type: "string", default: "unlimited" },
  },
});
const games = Number(values.games);
const out = path.resolve(values.out ?? path.join(REPO_ROOT, "tmp/karabast/local", `run-${games}`));

const ctx = loadContext(values);
const tables = rung1Tables(values.run);
const index = loadCardIndex(values.forceteki);
const decks = ladderDecks(ctx, values.run, path.resolve(values.decks), values.forceteki);
const owns = decks.map((d) => ownDeckOf(d.list, values.forceteki));
const pairs: [number, number][] = [];
for (let a = 0; a < decks.length; a++) for (let b = 0; b < decks.length; b++) if (a !== b) pairs.push([a, b]);
const { io, version: ioVersion } = loadSocketIoClient(values.forceteki);

const node = await startLocalGamenode({ forceteki: values.forceteki, port: Number(values.port), out });
const env = {
  node,
  io,
  tables,
  index,
  cardKeys: ctx.bridge.engineCardKeys,
  makeBot: () => rung1Bot(tables),
  forcetekiCommit: ctx.engine.pin.commit,
  out,
  stallMs: Number(values["stall-ms"]),
  gameMs: Number(values["game-ms"]),
  format: values.format,
  cardPool: values["card-pool"],
};
const p = progress("karabast-local-games", { total: games, everyN: 1 });
const rows: GameRow[] = [];
for (let i = 0; i < games; i++) {
  const [a, b] = pairs[i % pairs.length];
  rows.push(await playLocalGame(env, i, [{ deck: decks[a], own: owns[a] }, { deck: decks[b], own: owns[b] }], i % 2 === 1));
  p.tick(i + 1, { protocolErrors: rows.reduce((n, r) => n + r.protocolErrors.length + r.serverRejects, 0), replayIdentical: rows.filter((r) => r.replay.every((x) => x.identical)).length });
}
node.stop();
const report = {
  games,
  launch: { command: node.display, cwd: path.relative(REPO_ROOT, node.cwd) },
  socketIoClient: ioVersion,
  format: values.format,
  cardPool: values["card-pool"],
  forcetekiCommit: env.forcetekiCommit,
  completed: rows.filter((r) => r.winner !== null).length,
  protocolErrors: rows.reduce((n, r) => n + r.protocolErrors.length, 0),
  serverRejects: rows.reduce((n, r) => n + r.serverRejects, 0),
  replayIdentical: rows.filter((r) => r.replay.every((x) => x.identical)).length,
  leaks: rows.reduce((n, r) => n + r.leaks, 0),
  decisions: rows.reduce((n, r) => n + r.decisions[0] + r.decisions[1], 0),
  winsSeat1: rows.filter((r) => r.winner === 1).length,
  autoSingleTarget: { off: rows.filter((r) => !r.autoSingleTarget).length, on: rows.filter((r) => r.autoSingleTarget).length },
  streamBytes: rows.reduce((n, r) => n + r.streamBytes[0] + r.streamBytes[1], 0),
  msPerGame: Math.round(rows.reduce((n, r) => n + r.ms, 0) / Math.max(1, rows.length)),
  rows: rows.map((r) => ({ ...r, files: r.files.map((f) => path.relative(REPO_ROOT, f)) })),
};
writeFileSync(path.join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
p.done({ completed: report.completed, protocolErrors: report.protocolErrors, serverRejects: report.serverRejects, replayIdentical: report.replayIdentical });
console.log(JSON.stringify({ ...report, rows: undefined }));
process.exit(0);

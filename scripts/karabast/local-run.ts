/**
 * @displayName Local karabast gamenode and one bot-vs-bot game
 * @strategicPurpose The pieces of phase 2 (#182) that both the 50-game CLI and the engine test run: start the pinned
 * clone's gamenode on loopback without writing into the clone, and play one recorded, replayed game over sockets.
 * @tacticalObjective `startLocalGamenode` links the clone's card data into a git-ignored working directory (dev mode
 * reads ./test/json, forceteki test/helpers/GameStateBuilder.js:12), launches the gamenode with the loopback guard
 * and the env from src/karabast/gamenode.ts, and waits for /api/health. `playLocalGame`: host creates a private
 * best-of-one lobby, joiner joins, connects, then sets its deck (the server finds it only once connected), both
 * ready, host starts; each seat records its scrubbed stream, which is then gzipped, written, replayed and scanned
 * for leaked identifiers; rejected commands are counted from the gamenode log.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { REPO_ROOT } from "../../src/paths.js";
import { LiveBot } from "../../src/karabast/bot.js";
import { SeatClient, type IoFactory, type SwudbDeck } from "../../src/karabast/client.js";
import { gamenodeLaunch } from "../../src/karabast/gamenode.js";
import type { CardIndex } from "../../src/karabast/player-view.js";
import { Scrubber } from "../../src/karabast/scrub.js";
import { parseStream, replayStream, type StreamHeader, type StreamLine } from "../../src/karabast/stream.js";
import type { DeckInput } from "../../src/sims/match.js";
import type { CardTables } from "../../src/sims/policies/tables.js";
import type { BotPolicy } from "../../src/sims/policies/types.js";

export const LOOPBACK_GUARD = path.join(REPO_ROOT, "scripts/karabast/loopback-guard.cjs");

export interface LocalGamenode {
  baseUrl: string;
  logPath: string;
  display: string;
  cwd: string;
  stop(): void;
  /** Commands the server rejected so far ("Game: error processing game message", forceteki Lobby.ts:1744-1746). */
  serverRejects(): number;
}

export async function startLocalGamenode(o: { forceteki: string; port: number; out: string; healthMs?: number }): Promise<LocalGamenode> {
  const cwd = path.join(o.out, "gamenode-cwd");
  mkdirSync(path.join(cwd, "test"), { recursive: true });
  if (!existsSync(path.join(cwd, "test/json"))) symlinkSync(path.join(o.forceteki, "test/json"), path.join(cwd, "test/json"));
  const launch = gamenodeLaunch({ forcetekiRoot: o.forceteki, guard: LOOPBACK_GUARD, port: o.port, node: process.execPath });
  const logPath = path.join(o.out, "gamenode.log");
  const log = createWriteStream(logPath);
  const child = spawn(launch.command, launch.args, { cwd, env: launch.env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const stop = (): void => {
    if (child.exitCode === null) child.kill("SIGTERM");
  };
  process.on("exit", stop);
  const baseUrl = `http://127.0.0.1:${o.port}`;
  const limit = o.healthMs ?? 180_000;
  const t0 = performance.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`gamenode exited with ${child.exitCode}; see ${logPath}`);
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) break;
    } catch {
      // not listening yet
    }
    if (performance.now() - t0 > limit) {
      stop();
      throw new Error(`gamenode not healthy after ${limit} ms; see ${logPath}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const serverRejects = (): number => (readFileSync(logPath, "utf8").match(/error processing game message/gi) ?? []).length;
  return { baseUrl, logPath, display: launch.display, cwd, stop, serverRejects };
}

/** A v4-shaped uuid derived from a label, so a run's user ids are reproducible. */
export function uuidOf(label: string): string {
  const h = createHash("sha256").update(label).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const swudb = (d: DeckInput, name: string): SwudbDeck => ({ metadata: { name }, leader: d.list.leader, base: d.list.base, deck: d.list.deck, sideboard: d.list.sideboard });

export interface LocalGameEnv {
  node: LocalGamenode;
  io: IoFactory;
  tables: CardTables;
  index: CardIndex;
  cardKeys: Readonly<Record<string, string>>;
  makeBot: () => BotPolicy;
  forcetekiCommit: string;
  out: string;
  stallMs: number;
  gameMs: number;
  format: string;
  cardPool: string;
}

export interface LocalSeatDeck {
  deck: DeckInput;
  own: readonly string[];
}

export interface GameRow {
  game: number;
  decks: [string, string];
  autoSingleTarget: boolean;
  winner: number | null;
  decisions: [number, number];
  protocolErrors: string[];
  serverRejects: number;
  replay: { identical: boolean; decisions: number; mismatches: number }[];
  leaks: number;
  files: [string, string];
  streamSha256: [string, string];
  streamBytes: [number, number];
  ms: number;
}

export async function playLocalGame(env: LocalGameEnv, i: number, decks: readonly [LocalSeatDeck, LocalSeatDeck], autoSingleTarget: boolean): Promise<GameRow> {
  const t0 = performance.now();
  const seed = `local:${i}`;
  const ids = [uuidOf(`swu-mcp-local:${env.out}:${i}:1`), uuidOf(`swu-mcp-local:${env.out}:${i}:2`)] as const;
  const seatIds = ["seat1", "seat2"] as const;
  const scrubber = new Scrubber([
    { id: ids[0], token: seatIds[0] },
    { id: ids[1], token: seatIds[1] },
  ]);
  const lines: [StreamLine[], StreamLine[]] = [[], []];
  const rejectsBefore = env.node.serverRejects();
  const client = (seat: 1 | 2): SeatClient => {
    const header: StreamHeader = { kind: "header", version: 1, seat, seatIds: [...seatIds], seed, policy: "rung1", ownDeck: [...decks[seat - 1].own], autoSingleTarget, forcetekiCommit: env.forcetekiCommit };
    const bot = new LiveBot({ seat, seatIds, seed, policy: env.makeBot(), tables: env.tables, index: env.index, cardKeys: env.cardKeys, ownDeck: header.ownDeck });
    return new SeatClient({ baseUrl: env.node.baseUrl, io: env.io, userId: ids[seat - 1], header, scrubber, bot, write: (l) => lines[seat - 1].push(l), stallMs: env.stallMs });
  };
  const host = client(1);
  const joiner = client(2);
  const errors: string[] = [];
  const timer = setTimeout(() => {
    host.end("game timeout");
    joiner.end("game timeout");
  }, env.gameMs);
  try {
    await host.createLobby(swudb(decks[0].deck, "host"), env.format, env.cardPool);
    host.connect();
    await host.waitLobby((l) => l.users.length >= 1);
    if (host.rawLobbyId === null) throw new Error("no lobby id");
    await joiner.joinLobby(host.rawLobbyId);
    joiner.connect();
    await joiner.waitLobby((l) => l.users.length === 2);
    await joiner.changeDeck(host.rawLobbyId, swudb(decks[1].deck, "joiner"));
    await host.waitLobby((l) => l.users.length === 2);
    host.ready();
    joiner.ready();
    await host.waitLobby((l) => l.users.length === 2 && l.users.every((u) => u.ready === true));
    host.start();
  } catch (e) {
    errors.push(`lobby: ${scrubber.scrub(String((e as Error)?.message ?? e))}`);
    host.end("lobby setup failed");
    joiner.end("lobby setup failed");
  }
  const [r1, r2] = await Promise.all([host.done, joiner.done]);
  clearTimeout(timer);
  const winnerName = r1.winners.length === 1 ? r1.winners[0] : null;
  const winner = winnerName === "seat1" ? 1 : winnerName === "seat2" ? 2 : null;
  const results = [r1, r2];
  const row: GameRow = {
    game: i,
    decks: [decks[0].deck.source, decks[1].deck.source],
    autoSingleTarget,
    winner,
    decisions: [r1.decisions, r2.decisions],
    protocolErrors: [...errors],
    serverRejects: 0,
    replay: [],
    leaks: 0,
    files: ["", ""],
    streamSha256: ["", ""],
    streamBytes: [0, 0],
    ms: 0,
  };
  for (const seat of [1, 2] as const) {
    const r = results[seat - 1];
    for (const e of r.protocolErrors) row.protocolErrors.push(`seat${seat}: ${e}`);
    lines[seat - 1].push({ kind: "footer", winner, decisions: r.decisions, traceSha256: r.traceSha256, protocolErrors: r.protocolErrors });
    const text = `${lines[seat - 1].map((l) => JSON.stringify(l)).join("\n")}\n`;
    row.leaks += scrubber.leaks(text).length;
    const gz = gzipSync(text);
    const file = path.join(env.out, `game-${String(i).padStart(3, "0")}-seat${seat}.jsonl.gz`);
    writeFileSync(file, gz);
    row.files[seat - 1] = file;
    row.streamSha256[seat - 1] = createHash("sha256").update(gz).digest("hex");
    row.streamBytes[seat - 1] = gz.length;
    const replay = replayStream(parseStream(gunzipSync(readFileSync(file)).toString("utf8")), { tables: env.tables, index: env.index, cardKeys: env.cardKeys, makePolicy: env.makeBot });
    row.replay.push({ identical: replay.mismatches.length === 0 && replay.traceSha256 === replay.recordedTraceSha256 && replay.decisions === r.decisions, decisions: replay.decisions, mismatches: replay.mismatches.length });
  }
  if (winner === null && row.protocolErrors.length === 0) row.protocolErrors.push("game ended without a single winner");
  row.serverRejects = env.node.serverRejects() - rejectsBefore;
  row.ms = Math.round(performance.now() - t0);
  return row;
}

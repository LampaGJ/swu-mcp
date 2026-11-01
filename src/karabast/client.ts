import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";
import { decidable, type LiveBot } from "./bot.js";
import { gameCommandSchema, gameStateSchema, httpReplySchema, lobbyCommandSchema, lobbyStateSchema, type LobbyState } from "./schemas.js";
import type { Scrubber } from "./scrub.js";
import type { StreamHeader, StreamLine } from "./stream.js";

/**
 * @displayName Karabast socket client (one seat)
 * @strategicPurpose The transport half of the live client (#182 phase 2): the browser client's lobby and game
 * protocol (recon section 3a, forceteki GameServer.ts and Lobby.ts), driven by the decision layer instead of a
 * person, against a local gamenode only in this phase.
 * @tacticalObjective Anonymous user by client-minted uuid (query.user, no token); `POST /api/create-lobby`, `POST
 * /api/join-lobby` and `POST /api/lobby/:id/change-deck` with SWUDB JSON; socket.io on path `/ws`; `setReadyStatus`,
 * `startGameAsync` and `reportScreenResolution` on the `lobby` channel; `toggleOptionSetting` once at game start and
 * the bot's commands on the `game` channel, each checked against the allowlist shapes before it is sent. Every
 * received event is scrubbed of identifiers, then recorded, then parsed; the bot sees only the scrubbed state.
 * socket.io-client comes from the pinned clone's node_modules (the version its own tests use), like the engine.
 */

export interface SocketLike {
  on(event: string, fn: (...args: unknown[]) => void): unknown;
  onAny(fn: (event: string, ...args: unknown[]) => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
  disconnect(): unknown;
}
export type IoFactory = (url: string, opts: Record<string, unknown>) => SocketLike;

export function loadSocketIoClient(forcetekiRoot: string): { io: IoFactory; version: string } {
  const req = createRequire(path.join(forcetekiRoot, "package.json"));
  const mod = req("socket.io-client") as { io: IoFactory };
  const pkg = packageVersionSchema.parse(req("socket.io-client/package.json"));
  return { io: mod.io, version: pkg.version };
}

// The raw id is read before the payload is scrubbed, so the scrubber can learn it; the full parse comes after.
const idHolderSchema = z.looseObject({ id: z.string() });
const packageVersionSchema = z.looseObject({ version: z.string() });

export interface SwudbDeck {
  metadata: { name: string };
  leader: { id: string; count: number };
  base: { id: string; count: number };
  deck: { id: string; count: number }[];
  sideboard: { id: string; count: number }[];
}

export interface SeatClientOptions {
  baseUrl: string;
  io: IoFactory;
  userId: string;
  header: StreamHeader;
  scrubber: Scrubber;
  bot: LiveBot;
  write: (line: StreamLine) => void;
  /** No event for this long while the game runs counts as a stall (a rejected command produces no gamestate). */
  stallMs: number;
}

export interface SeatResult {
  winners: string[];
  protocolErrors: string[];
  decisions: number;
  traceSha256: string;
}

export class SeatClient {
  private socket: SocketLike | null = null;
  private seq = 0;
  private toggled = false;
  private ended = false;
  private stall: NodeJS.Timeout | null = null;
  private finish: ((r: SeatResult) => void) | null = null;
  readonly protocolErrors: string[] = [];
  lobby: LobbyState | null = null;
  /** The raw lobby id, kept in memory only so the host can hand it to the joiner. */
  rawLobbyId: string | null = null;
  private lobbyWaiters: ((l: LobbyState) => boolean)[] = [];
  readonly done: Promise<SeatResult>;

  constructor(private readonly o: SeatClientOptions) {
    o.write(o.header);
    this.done = new Promise((resolve) => (this.finish = resolve));
  }

  private error(message: string): void {
    this.protocolErrors.push(message);
  }

  async post(route: string, body: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.o.baseUrl}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, user: { id: this.o.userId, username: this.o.header.seatIds[this.o.header.seat - 1] } }) });
    const reply = httpReplySchema.safeParse(await res.json());
    if (!reply.success || !reply.data.success) throw new Error(`${route} failed (${res.status}): ${this.o.scrubber.scrub(JSON.stringify(reply.success ? reply.data : reply.error.issues)).slice(0, 300)}`);
  }

  /** A private best-of-one lobby; format and card pool use the server's enum values (forceteki Constants.ts SwuGameFormat, CardPool). */
  createLobby(deck: SwudbDeck, format = "premier", cardPool = "current"): Promise<void> {
    return this.post("/api/create-lobby", { deck, lobbyName: "swu-mcp local", format, cardPool, gamesToWinMode: "bestOfOne", isPrivate: true });
  }

  joinLobby(lobbyId: string): Promise<void> {
    return this.post("/api/join-lobby", { lobbyId });
  }

  /** Only once this seat's socket is in the lobby: the server looks the user up among connected lobby users. */
  changeDeck(lobbyId: string, deck: SwudbDeck): Promise<void> {
    return this.post(`/api/lobby/${encodeURIComponent(lobbyId)}/change-deck`, { deck });
  }

  private send(channel: "game" | "lobby", args: unknown[], decision: { k: number; descriptor: string } | null = null): void {
    const parsed = channel === "game" ? gameCommandSchema.safeParse(args) : lobbyCommandSchema.safeParse(args);
    if (!parsed.success) {
      this.error(`refused to send ${channel} ${JSON.stringify(args).slice(0, 200)}: not an allowlisted shape`);
      return;
    }
    this.o.write({ kind: "out", seq: this.seq++, channel, args: parsed.data as unknown[], k: decision?.k ?? null, descriptor: decision?.descriptor ?? null });
    this.socket?.emit(channel, ...(parsed.data as unknown[]));
  }

  /** Resolves when a lobbystate satisfying `test` arrives (or one already has). */
  waitLobby(test: (l: LobbyState) => boolean): Promise<LobbyState> {
    if (this.lobby !== null && test(this.lobby)) return Promise.resolve(this.lobby);
    return new Promise((resolve) => this.lobbyWaiters.push((l) => (test(l) ? (resolve(l), true) : false)));
  }

  connect(): void {
    const s = this.o.io(this.o.baseUrl, {
      path: "/ws",
      transports: ["websocket"],
      reconnection: false,
      query: { user: JSON.stringify({ id: this.o.userId, username: this.o.header.seatIds[this.o.header.seat - 1] }), lobby: JSON.stringify({ lobbyId: null }), spectator: "false" },
    });
    this.socket = s;
    s.onAny((event, ...args) => this.onEvent(event, args[0]));
    s.on("disconnect", (reason) => {
      if (!this.ended) this.end(`disconnected before the game ended: ${String(reason)}`);
    });
    s.on("connect_error", (e) => this.end(`connect_error: ${String((e as Error)?.message ?? e)}`));
  }

  ready(): void {
    this.send("lobby", ["setReadyStatus", true]);
  }

  start(): void {
    this.send("lobby", ["startGameAsync"]);
  }

  private armStall(): void {
    if (this.stall !== null) clearTimeout(this.stall);
    this.stall = setTimeout(() => this.end(`stall: no event for ${this.o.stallMs} ms`), this.o.stallMs);
  }

  private onEvent(event: string, raw: unknown): void {
    if (this.ended) return;
    this.armStall();
    const named = idHolderSchema.safeParse(raw);
    if (event === "lobbystate" && named.success) {
      this.rawLobbyId = named.data.id;
      this.o.scrubber.learn(this.rawLobbyId, "lobby");
    }
    if (event === "gamestate" && named.success) this.o.scrubber.learn(named.data.id, "game");
    const payload = this.o.scrubber.scrub(raw);
    this.o.write({ kind: "in", seq: this.seq++, event, payload });
    switch (event) {
      case "lobbystate": {
        const l = lobbyStateSchema.safeParse(payload);
        if (!l.success) return this.error(`lobbystate failed the schema: ${l.error.message.slice(0, 300)}`);
        this.lobby = l.data;
        this.lobbyWaiters = this.lobbyWaiters.filter((w) => !w(l.data));
        return;
      }
      case "gamestate":
        return this.onGameState(payload);
      case "requestScreenResolution":
        return this.send("lobby", ["reportScreenResolution", { width: 1920, height: 1080 }]);
      case "connection_error":
      case "inactiveDisconnect":
      case "matchmakingFailed":
        return this.end(`${event}: ${JSON.stringify(payload).slice(0, 200)}`);
      default:
        return;
    }
  }

  private onGameState(payload: unknown): void {
    const parsed = gameStateSchema.safeParse(payload);
    if (!parsed.success) return this.error(`gamestate failed the schema: ${parsed.error.message.slice(0, 300)}`);
    const state = parsed.data;
    if (Object.keys(state.players).length < 2) return;
    if (!this.toggled) {
      this.toggled = true;
      this.send("game", ["toggleOptionSetting", "autoSingleTarget", this.o.header.autoSingleTarget]);
    }
    if ((state.winners?.length ?? 0) > 0) return this.end(null, state.winners ?? []);
    if (!decidable(state)) return;
    let d;
    try {
      d = this.o.bot.onState(state);
    } catch (e) {
      return this.end(`decision layer threw: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    }
    if (d !== null) this.send("game", d.command as unknown[], { k: d.k, descriptor: d.descriptor });
  }

  end(error: string | null, winners: string[] = []): void {
    if (this.ended) return;
    this.ended = true;
    if (error !== null) this.error(error);
    if (this.stall !== null) clearTimeout(this.stall);
    this.socket?.disconnect();
    this.finish?.({ winners, protocolErrors: [...this.protocolErrors], decisions: this.o.bot.k, traceSha256: this.o.bot.traceSha256() });
  }
}

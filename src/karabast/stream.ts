import { z } from "zod";
import type { CardTables } from "../sims/policies/tables.js";
import type { BotPolicy } from "../sims/policies/types.js";
import { decidable, LiveBot } from "./bot.js";
import type { CardIndex } from "./player-view.js";
import { gameCommandSchema, gameStateSchema } from "./schemas.js";

/**
 * @displayName Karabast game stream and decision replay
 * @strategicPurpose A live game cannot be replayed (the server never seeds its RNG, gap G7), so the recorded stream
 * of what one seat received is the pinned input, and the decision layer must reproduce every command it sent from
 * that stream alone (#182 phase 2; data doctrine: replayable from a pinned input to a byte-identical output).
 * @tacticalObjective The JSONL line schemas (one header, then every received event and sent command in order, then
 * a footer), and `replayStream`: feeds the recorded gamestates through a fresh LiveBot with the header's seed, seat
 * and deck and compares its commands, one by one, with the recorded game commands.
 */

const seatSchema = z.literal([1, 2]);

export const streamHeaderSchema = z.strictObject({
  kind: z.literal("header"),
  version: z.literal(1),
  seat: seatSchema,
  seatIds: z.tuple([z.string(), z.string()]),
  seed: z.string(),
  policy: z.string(),
  ownDeck: z.array(z.string()),
  autoSingleTarget: z.boolean(),
  forcetekiCommit: z.string(),
});

export const streamEventSchema = z.strictObject({ kind: z.literal("in"), seq: z.int().nonnegative(), event: z.string(), payload: z.unknown().optional() });
export const streamCommandSchema = z.strictObject({ kind: z.literal("out"), seq: z.int().nonnegative(), channel: z.enum(["game", "lobby"]), args: z.array(z.unknown()), k: z.int().nonnegative().nullable(), descriptor: z.string().nullable() });
export const streamFooterSchema = z.strictObject({ kind: z.literal("footer"), winner: seatSchema.nullable(), decisions: z.int().nonnegative(), traceSha256: z.string(), protocolErrors: z.array(z.string()) });
export const streamLineSchema = z.discriminatedUnion("kind", [streamHeaderSchema, streamEventSchema, streamCommandSchema, streamFooterSchema]);

export type StreamHeader = z.infer<typeof streamHeaderSchema>;
export type StreamLine = z.infer<typeof streamLineSchema>;

export function parseStream(text: string): StreamLine[] {
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => streamLineSchema.parse(JSON.parse(l)));
}

export interface ReplayResult {
  decisions: number;
  recorded: number;
  mismatches: { k: number; recorded: string; replayed: string }[];
  traceSha256: string;
  recordedTraceSha256: string | null;
}

export interface ReplayContext {
  tables: CardTables;
  index: CardIndex;
  cardKeys: Readonly<Record<string, string>>;
  makePolicy: (spec: string) => BotPolicy;
}

/** Replays one seat's stream: same received gamestates in, the same game commands out, byte for byte. */
export function replayStream(lines: readonly StreamLine[], ctx: ReplayContext): ReplayResult {
  const header = lines[0];
  if (header?.kind !== "header") throw new Error("stream does not start with a header");
  const bot = new LiveBot({ seat: header.seat, seatIds: header.seatIds, seed: header.seed, policy: ctx.makePolicy(header.policy), tables: ctx.tables, index: ctx.index, cardKeys: ctx.cardKeys, ownDeck: header.ownDeck });
  const replayed: string[] = [];
  const recorded: string[] = [];
  let footerTrace: string | null = null;
  for (const line of lines) {
    if (line.kind === "in" && line.event === "gamestate") {
      // The client's gates, in its order: a gamestate failing the schema is skipped, one with fewer than two players or a winner is not answered.
      const parsed = gameStateSchema.safeParse(line.payload);
      if (!parsed.success || !decidable(parsed.data)) continue;
      const d = bot.onState(parsed.data);
      if (d !== null) replayed.push(JSON.stringify(gameCommandSchema.parse(d.command)));
    } else if (line.kind === "out" && line.channel === "game" && line.k !== null) recorded.push(JSON.stringify(line.args));
    else if (line.kind === "footer") footerTrace = line.traceSha256;
  }
  const mismatches: ReplayResult["mismatches"] = [];
  for (let k = 0; k < Math.max(replayed.length, recorded.length); k++) {
    if (replayed[k] !== recorded[k]) mismatches.push({ k, recorded: recorded[k] ?? "(none)", replayed: replayed[k] ?? "(none)" });
  }
  return { decisions: replayed.length, recorded: recorded.length, mismatches, traceSha256: bot.traceSha256(), recordedTraceSha256: footerTrace };
}

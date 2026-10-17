/**
 * @displayName Human-game decision-row folder
 * @strategicPurpose The Karabast spectator rows are one row per inferred decision, duplicated across overlapping
 * files, with board and discard lists keyed to a fixed seat rather than the acting player; benchmarks need one
 * clean record per game side.
 * @tacticalObjective Buffers the rows of one (file, game) chunk, votes which player holds seat 1 from where played
 * units land, and folds every chunk into per-side card sets, first-seen turns, played-while-in-play events and
 * win labels. Set union makes the fold order-free, so a game split across files merges to the same record.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { compareCodePoints } from "../../src/swu/canonical.js";

const namedList = z.array(z.looseObject({ name: z.string() }));

export const humanRowSchema = z.looseObject({
  label: z.number(),
  metadata: z.looseObject({
    gameId: z.string().min(1),
    turn: z.number().int(),
    timestamp: z.string(),
    actionType: z.string(),
    cardName: z.string().nullish(),
    cardId: z.string().nullish(),
    cardSetId: z.object({ set: z.string(), number: z.number().int().optional() }).nullish(),
    cardPrintedType: z.string().nullish(),
    targetId: z.string().nullish(),
    activePlayerId: z.string().min(1),
    opponentPlayerId: z.string().min(1),
    activePlayerLeader: z.string().nullish(),
    activePlayerBase: z.string().nullish(),
    opponentLeader: z.string().nullish(),
    opponentBase: z.string().nullish(),
    activePlayerUnits: namedList.optional(),
    opponentUnits: namedList.optional(),
    activePlayerDiscard: namedList.optional(),
    opponentDiscard: namedList.optional(),
  }),
});
export type HumanRow = z.infer<typeof humanRowSchema>;

/** Card reference before availability-aware resolution: "k:<cardKey>", "n:<normalised name>", "t:<token>", "x:<set_number>". */
export type CardToken = string;

export interface TokenResolver {
  setId(set: string, number: number): CardToken;
  name(name: string): CardToken;
}

const PLAY_ACTIONS = new Set(["play_unit", "play_event"]);

export const sha = (text: string, chars = 16): string => createHash("sha256").update(text, "utf8").digest("hex").slice(0, chars);

export function rowKey(m: HumanRow["metadata"]): string {
  return sha([m.gameId, m.timestamp, m.actionType, m.activePlayerId, m.cardId ?? "", m.targetId ?? "", String(m.turn)].join("\u0001"), 20);
}

export interface SideState {
  leaderName: string | null;
  baseName: string | null;
  cards: Map<CardToken, number>;
  played: Set<CardToken>;
  leaderTokens: Set<CardToken>;
  baseTokens: Set<CardToken>;
  co: Set<string>;
  labels: Set<number>;
}

export interface GameState {
  files: Set<number>;
  rows: number;
  maxTurn: number;
  sides: Map<string, SideState>;
  forfeitLabels: number[];
  seatVotes: { agree: number; disagree: number };
  chunksWithoutSeat: number;
}

const newSide = (): SideState => ({
  leaderName: null,
  baseName: null,
  cards: new Map(),
  played: new Set(),
  leaderTokens: new Set(),
  baseTokens: new Set(),
  co: new Set(),
  labels: new Set(),
});

const observe = (side: SideState, token: CardToken, turn: number): void => {
  const seen = side.cards.get(token);
  if (seen === undefined || turn < seen) side.cards.set(token, turn);
};

export const CO_SEP = "\u0000";

/**
 * Seat 1 is the player whose board `activePlayerUnits` lists. Each played unit that lands on exactly one board is a
 * vote; returns the winning player id and how many votes disagreed with it, or null when no row voted.
 */
export function voteSeatOne(rows: readonly HumanRow[]): { seatOne: string; agree: number; disagree: number } | null {
  const votes = new Map<string, number>();
  for (const { metadata: m } of rows) {
    if (m.actionType !== "play_unit" || !m.cardName || m.cardPrintedType === "basicUpgrade") continue;
    const onA = (m.activePlayerUnits ?? []).some((u) => u.name === m.cardName || u.name.startsWith(`${m.cardName},`));
    const onB = (m.opponentUnits ?? []).some((u) => u.name === m.cardName || u.name.startsWith(`${m.cardName},`));
    if (onA === onB) continue;
    const id = onA ? m.activePlayerId : m.opponentPlayerId;
    votes.set(id, (votes.get(id) ?? 0) + 1);
  }
  if (votes.size === 0) return null;
  const ranked = [...votes].sort((a, b) => b[1] - a[1] || compareCodePoints(a[0], b[0]));
  const total = ranked.reduce((n, [, v]) => n + v, 0);
  return { seatOne: ranked[0][0], agree: ranked[0][1], disagree: total - ranked[0][1] };
}

export function newGame(): GameState {
  return {
    files: new Set(),
    rows: 0,
    maxTurn: 0,
    sides: new Map(),
    forfeitLabels: [],
    seatVotes: { agree: 0, disagree: 0 },
    chunksWithoutSeat: 0,
  };
}

/** Folds one (file, game) chunk of de-duplicated rows into the game. */
export function foldChunk(game: GameState, file: number, rows: readonly HumanRow[], resolve: TokenResolver): void {
  if (rows.length === 0) return;
  game.files.add(file);
  game.rows += rows.length;
  const side = (id: string): SideState => {
    let s = game.sides.get(id);
    if (s === undefined) {
      s = newSide();
      game.sides.set(id, s);
    }
    return s;
  };
  const hasLists = rows.some((r) => r.metadata.activePlayerUnits !== undefined);
  const seat = hasLists ? voteSeatOne(rows) : null;
  if (seat !== null) {
    game.seatVotes.agree += seat.agree;
    game.seatVotes.disagree += seat.disagree;
  } else if (hasLists) game.chunksWithoutSeat += 1;

  for (const row of rows) {
    const m = row.metadata;
    game.maxTurn = Math.max(game.maxTurn, m.turn);
    const actor = side(m.activePlayerId);
    const other = side(m.opponentPlayerId);
    actor.labels.add(row.label);
    actor.leaderName ??= m.activePlayerLeader ?? null;
    actor.baseName ??= m.activePlayerBase ?? null;
    other.leaderName ??= m.opponentLeader ?? null;
    other.baseName ??= m.opponentBase ?? null;
    if (m.actionType === "forfeit") game.forfeitLabels.push(row.label);

    const playedToken = m.cardSetId?.number !== undefined ? resolve.setId(m.cardSetId.set, m.cardSetId.number) : null;
    if (playedToken !== null) {
      observe(actor, playedToken, m.turn);
      if (m.cardPrintedType === "leader") actor.leaderTokens.add(playedToken);
      if (m.cardPrintedType === "base") actor.baseTokens.add(playedToken);
    }
    if (seat === null) continue;
    const seatOneId = seat.seatOne;
    const seatTwoId = seatOneId === m.activePlayerId ? m.opponentPlayerId : m.activePlayerId;
    if (seatOneId !== m.activePlayerId && seatOneId !== m.opponentPlayerId) continue;
    const boards: [string, string[]][] = [
      [seatOneId, (m.activePlayerUnits ?? []).map((u) => resolve.name(u.name))],
      [seatTwoId, (m.opponentUnits ?? []).map((u) => resolve.name(u.name))],
    ];
    for (const [id, tokens] of boards) for (const t of tokens) observe(side(id), t, m.turn);
    for (const [id, list] of [
      [seatOneId, m.activePlayerDiscard],
      [seatTwoId, m.opponentDiscard],
    ] as const) {
      for (const card of list ?? []) observe(side(id), resolve.name(card.name), m.turn);
    }
    if (playedToken !== null && PLAY_ACTIONS.has(m.actionType)) {
      actor.played.add(playedToken);
      const board = boards.find(([id]) => id === m.activePlayerId)?.[1] ?? [];
      for (const present of new Set(board)) if (present !== playedToken) actor.co.add(`${present}${CO_SEP}${playedToken}`);
    }
  }
}

export type WinnerStatus = "resolved" | "one-sided" | "conflict" | "no-label";

/** Each side's labels must be one constant 0/1 and the two sides complementary; one labelled side implies the other. */
export function resolveWinner(game: GameState): { status: WinnerStatus; won: Map<string, 0 | 1 | null> } {
  const won = new Map<string, 0 | 1 | null>([...game.sides.keys()].map((id) => [id, null]));
  const labelled = [...game.sides].filter(([, s]) => s.labels.size > 0);
  if (labelled.length === 0) return { status: "no-label", won };
  const single = (s: SideState): 0 | 1 | null => {
    if (s.labels.size !== 1) return null;
    const [v] = [...s.labels];
    return v === 0 || v === 1 ? v : null;
  };
  const values = labelled.map(([id, s]) => [id, single(s)] as const);
  if (values.some(([, v]) => v === null) || game.sides.size !== 2) return { status: "conflict", won };
  if (values.length === 2) {
    if (values[0][1] === values[1][1]) return { status: "conflict", won };
    for (const [id, v] of values) won.set(id, v);
    return { status: "resolved", won };
  }
  const [id, v] = values[0];
  for (const other of game.sides.keys()) won.set(other, other === id ? v : ((1 - (v as number)) as 0 | 1));
  return { status: "one-sided", won };
}

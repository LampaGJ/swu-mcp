/**
 * Hand-written synthetic Karabast-shaped rows: placeholder players, ids and cards only (D22, D102). Nothing here is
 * drawn from the captured games.
 */
import type { CardResolver } from "../../scripts/human-priors/decisions.js";

export interface UnitIn {
  name: string;
  cost?: number;
  power?: number;
  hp?: number;
  damage?: number;
  exhausted?: boolean;
  arena?: "ground" | "space";
  keywords?: string[];
  upgradeCount?: number;
}

export const unit = (name: string, o: Omit<UnitIn, "name"> = {}) => ({
  name,
  cost: 2,
  power: 2,
  hp: 3,
  damage: 0,
  exhausted: false,
  arena: "ground",
  keywords: [] as string[],
  upgradeCount: 0,
  ...o,
});

const side = (prefix: string, n: Record<string, unknown>) => Object.fromEntries(Object.entries(n).map(([k, v]) => [prefix + k, v]));

export interface RowIn {
  game?: string;
  actor?: "A" | "B";
  ts: string;
  turn?: number;
  phase?: string;
  actionType: string;
  label?: number;
  card?: { name: string; set: string; number: number; type?: string };
  target?: { name: string } | "base";
  /** Lists keyed to the fixed seat (the engine's first player key), whichever player acts. */
  seat1Units?: ReturnType<typeof unit>[];
  seat2Units?: ReturnType<typeof unit>[];
  seat1Discard?: string[];
  seat2Discard?: string[];
  meBaseDamage?: number;
  oppBaseDamage?: number;
  extra?: Record<string, unknown>;
}

export const PLAYERS = { A: { id: "PID-AAAA", name: "NAME-ALPHA" }, B: { id: "PID-BBBB", name: "NAME-BRAVO" } } as const;

/** One raw row as the old spectator converter wrote it: scalars actor-relative, lists fixed-seat. */
export function rawRow(r: RowIn): Record<string, unknown> {
  const actor = r.actor ?? "A";
  const other = actor === "A" ? "B" : "A";
  const meta: Record<string, unknown> = {
    gameId: r.game ?? "GID-0001",
    turn: r.turn ?? 1,
    phase: r.phase ?? "action",
    timestamp: r.ts,
    actionType: r.actionType,
    ...side("activePlayer", { Resources: 3, BaseDamage: r.meBaseDamage ?? 0, HandSize: 4, BoardPower: 2, UnitsGround: 1, UnitsSpace: 0, DeckSize: 40, DiscardSize: 0, Credits: 0, Captured: 0, OutsideGame: 0, ResourceCards: 3, Disconnected: false, TimeStatus: "None" }),
    ...side("opponent", { Resources: 3, BaseDamage: r.oppBaseDamage ?? 0, HandSize: 5, BoardPower: 2, UnitsGround: 1, UnitsSpace: 0, DeckSize: 41, DiscardSize: 0, Credits: 0, Captured: 0, OutsideGame: 0, ResourceCards: 3, Disconnected: false, TimeStatus: "None" }),
    hasInitiative: actor === "A",
    activePlayerId: PLAYERS[actor].id,
    activePlayerName: PLAYERS[actor].name,
    opponentPlayerId: PLAYERS[other].id,
    opponentPlayerName: PLAYERS[other].name,
    activePlayerAspects: actor === "A" ? ["command", "villainy"] : ["aggression", "heroism"],
    opponentAspects: actor === "A" ? ["aggression", "heroism"] : ["command", "villainy"],
    activePlayerLeader: actor === "A" ? "Leader Alpha" : "Leader Bravo",
    activePlayerBase: actor === "A" ? "Base Alpha" : "Base Bravo",
    opponentLeader: actor === "A" ? "Leader Bravo" : "Leader Alpha",
    opponentBase: actor === "A" ? "Base Bravo" : "Base Alpha",
    activePlayerUnits: r.seat1Units ?? [],
    opponentUnits: r.seat2Units ?? [],
    activePlayerLeaderState: { exhausted: false, damage: 0, deployed: false },
    opponentLeaderState: { exhausted: false, damage: 0, deployed: false },
    activePlayerDiscard: (r.seat1Discard ?? []).map((name) => ({ name, cost: 1, type: "event" })),
    opponentDiscard: (r.seat2Discard ?? []).map((name) => ({ name, cost: 1, type: "event" })),
    activePlayerResourceCardsList: [{ name: "Unknown", cost: 0, keywords: [] }],
    opponentResourceCardsList: [{ name: "Unknown", cost: 0, keywords: [] }],
    ...r.extra,
  };
  if (r.card !== undefined) {
    meta.cardName = r.card.name;
    meta.cardId = "100000" + String(r.card.number);
    meta.cardSetId = { set: r.card.set, number: r.card.number };
    meta.cardPrintedType = r.card.type ?? "basicUnit";
  }
  if (r.target === "base") {
    meta.targetName = "Base";
    meta.targetIsBase = true;
  } else if (r.target !== undefined) {
    meta.targetName = r.target.name;
    meta.targetId = "2000000001";
    meta.targetIsBase = false;
  }
  return { features: [0.1, 0.2], label: r.label ?? (actor === "A" ? 1 : 0), weight: 0.6, metadata: meta };
}

const CARDS: Record<string, string> = {
  "Alpha Trooper": "T1000001",
  "Beta Fighter": "T1000002",
  "Gamma Wall": "T1000003",
  "Omega Gate, Second Face": "T1000006",
  "Delta Scout": "T1000004",
  "Epsilon Event": "T1000005",
};
const SETS: Record<string, string> = { TST_001: "T1000001", TST_002: "T1000002", TST_003: "T1000003", TST_004: "T1000004", TST_005: "T1000005", TST_009: "TL000009" };

export const resolver: CardResolver = {
  setId: (set, number) => SETS[set + "_" + String(number).padStart(3, "0")] ?? null,
  name: (name) => CARDS[name] ?? null,
  leader: (title) => (title === "Leader Alpha" ? "TL000001" : title === "Leader Bravo" ? "TL000002" : null),
  upgradeToken: (name) => name === "Shield" || name === "Experience",
  base: (title) => (title === "Base Alpha" ? "TB000001" : title === "Base Bravo" ? "TB000002" : null),
};

/** JSONL text of rows, one per line. */
export const jsonl = (rows: RowIn[]): string => rows.map((r) => JSON.stringify(rawRow(r))).join("\n") + "\n";

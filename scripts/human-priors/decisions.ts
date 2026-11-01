/**
 * @displayName Human-game decision records
 * @strategicPurpose The Karabast spectator rows (private, D22, D102) are state diffs, not decisions: their unit lists
 * are keyed to a fixed seat, their scalars come from before the update while their lists come from after it, rows
 * repeat across files, undone actions stay in, and attacks carry no alternatives. A model can only learn from them
 * once each row is one actor-relative decision with the board it was made on.
 * @tacticalObjective `boundaryRow` picks the needed fields, parses them strictly and drops player names and ids
 * (game ids are hashed, players become per-game tags). `decisionsForGame` dedupes and orders one game's rows, votes
 * which player holds seat 1 (scripts/bench/games.ts voteSeatOne, ported to tags), re-orients the lists to the actor,
 * takes the previous row's lists as the before-board, rebuilds the legal attacks from it, flags likely undos and
 * double-logged combats, and labels every row with the actor's game result.
 */
import { z } from "zod";
import { compareCodePoints } from "../../src/swu/canonical.js";
import { sha } from "../bench/games.js";

export const ACTION_KINDS = [
  "attack",
  "play_unit",
  "play_event",
  "unit_ability",
  "leader_ability",
  "base_ability",
  "ability",
  "pass",
  "resource",
  "claim_initiative",
  "target_selection",
  "mulligan",
  "name_card",
  "forfeit",
  "trigger_response",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export const PHASES = ["setup", "action", "regroup"] as const;

const num = z.number().refine(Number.isFinite, { error: "not a finite number" });
const ARENAS = ["ground", "space"] as const;

/** Resolves the rows' card references to cardKeys; null when unknown. */
export interface CardResolver {
  setId(set: string, number: number): string | null;
  name(name: string): string | null;
  /** A title names several leaders or bases; the side's aspects (leader plus base icons) may tell them apart. */
  leader(title: string, aspects: readonly string[]): string | null;
  base(title: string, aspects: readonly string[]): string | null;
  /** The spectator listed token upgrades (Experience, Shield) as board entries; they are not units. */
  upgradeToken(name: string): boolean;
}

const UNIT_KEYS = ["name", "cost", "power", "hp", "damage", "exhausted", "arena", "keywords", "upgradeCount"] as const;
const rawUnitSchema = z.strictObject({
  name: z.string(),
  cost: num,
  power: num,
  hp: num,
  damage: num,
  exhausted: z.boolean(),
  arena: z.enum(ARENAS),
  keywords: z.array(z.string()),
  upgradeCount: num,
});
const leaderStateSchema = z.strictObject({ exhausted: z.boolean(), damage: num, deployed: z.boolean() });

const SCALARS = { Resources: "resources", BaseDamage: "baseDamage", HandSize: "hand", DeckSize: "deck", DiscardSize: "discard", Credits: "credits", UnitsGround: "ground", UnitsSpace: "space", BoardPower: "power", ResourceCards: "totalResources" } as const;
const scalarsSchema = z.strictObject({ resources: num, baseDamage: num, hand: num, deck: num, discard: num, credits: num, ground: num, space: num, power: num, totalResources: num });
export type Scalars = z.infer<typeof scalarsSchema>;

const META_KEYS = [
  "gameId",
  "turn",
  "phase",
  "timestamp",
  "actionType",
  "cardName",
  "cardId",
  "cardSetId",
  "cardPrintedType",
  "targetName",
  "targetId",
  "targetIsBase",
  "isSmuggle",
  "activePlayerId",
  "opponentPlayerId",
  "hasInitiative",
  "activePlayerAspects",
  "opponentAspects",
  "activePlayerLeader",
  "activePlayerBase",
  "opponentLeader",
  "opponentBase",
  "activePlayerUnits",
  "opponentUnits",
  "activePlayerLeaderState",
  "opponentLeaderState",
  "activePlayerDiscard",
  "opponentDiscard",
  ...Object.keys(SCALARS).flatMap((k) => ["activePlayer" + k, "opponent" + k]),
] as const;

/** The picked raw metadata. Player names are never picked; player ids and the game id leave in the transform below. */
const pickedMetaSchema = z.strictObject({
  gameId: z.string().min(1),
  turn: z.int(),
  phase: z.enum(PHASES),
  timestamp: z.string().min(1),
  actionType: z.enum(ACTION_KINDS),
  cardName: z.string().nullish(),
  cardId: z.string().nullish(),
  cardSetId: z.strictObject({ set: z.string().min(1), number: z.int().optional() }).nullish(),
  cardPrintedType: z.string().nullish(),
  targetName: z.string().nullish(),
  targetId: z.string().nullish(),
  targetIsBase: z.boolean().nullish(),
  isSmuggle: z.boolean().nullish(),
  activePlayerId: z.string().min(1),
  opponentPlayerId: z.string().min(1),
  hasInitiative: z.boolean(),
  activePlayerAspects: z.array(z.string()).nullish(),
  opponentAspects: z.array(z.string()).nullish(),
  activePlayerLeader: z.string().nullish(),
  activePlayerBase: z.string().nullish(),
  opponentLeader: z.string().nullish(),
  opponentBase: z.string().nullish(),
  activePlayerUnits: z.array(rawUnitSchema).nullish(),
  opponentUnits: z.array(rawUnitSchema).nullish(),
  activePlayerLeaderState: leaderStateSchema.nullish(),
  opponentLeaderState: leaderStateSchema.nullish(),
  activePlayerDiscard: z.array(z.strictObject({ name: z.string() })).nullish(),
  opponentDiscard: z.array(z.strictObject({ name: z.string() })).nullish(),
  ...Object.fromEntries(Object.keys(SCALARS).flatMap((k) => [["activePlayer" + k, num], ["opponent" + k, num]])),
});

const hex = (n: number) => z.string().regex(new RegExp("^[0-9a-f]{" + String(n) + "}$"));

/** One raw row after the boundary: no player name or id, a hashed game key, per-game player tags. */
export const parsedRowSchema = z.strictObject({
  game: hex(16),
  actor: hex(12),
  other: hex(12),
  key: hex(20),
  file: z.int().min(0),
  line: z.int().min(0),
  ts: z.string(),
  turn: z.int(),
  phase: z.enum(PHASES),
  kind: z.enum(ACTION_KINDS),
  label: num,
  card: z.strictObject({ set: z.string(), number: z.int() }).nullable(),
  cardName: z.string().nullable(),
  cardType: z.string().nullable(),
  targetName: z.string().nullable(),
  targetIsBase: z.boolean().nullable(),
  smuggle: z.boolean().nullable(),
  me: scalarsSchema,
  opp: scalarsSchema,
  initiative: z.boolean(),
  meLeader: z.string().nullable(),
  meBase: z.string().nullable(),
  oppLeader: z.string().nullable(),
  oppBase: z.string().nullable(),
  meAspects: z.array(z.string()),
  oppAspects: z.array(z.string()),
  a: z.array(rawUnitSchema).nullable(),
  b: z.array(rawUnitSchema).nullable(),
  aLeader: leaderStateSchema.nullable(),
  bLeader: leaderStateSchema.nullable(),
  aDiscard: z.array(z.string()).nullable(),
  bDiscard: z.array(z.string()).nullable(),
});
export type ParsedRow = z.infer<typeof parsedRowSchema>;
type RawUnit = z.infer<typeof rawUnitSchema>;

const pick = (o: unknown, keys: readonly string[]): Record<string, unknown> | null => {
  if (o === null || typeof o !== "object" || Array.isArray(o)) return null;
  const src = o as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
};
const pickList = (v: unknown, keys: readonly string[]): unknown => (Array.isArray(v) ? v.map((x) => pick(x, keys) ?? x) : v);

/** Parses one raw row; null when it does not match the boundary schema. */
export function boundaryRow(raw: unknown, at: { file: number; line: number }): ParsedRow | null {
  const top = pick(raw, ["label", "metadata"]);
  if (top === null || typeof top.label !== "number") return null;
  const meta = pick(top.metadata, META_KEYS);
  if (meta === null) return null;
  for (const k of ["activePlayerUnits", "opponentUnits"]) if (meta[k] !== undefined) meta[k] = pickList(meta[k], UNIT_KEYS);
  for (const k of ["activePlayerDiscard", "opponentDiscard"]) if (meta[k] !== undefined) meta[k] = pickList(meta[k], ["name"]);
  for (const k of ["activePlayerLeaderState", "opponentLeaderState"]) if (meta[k] !== undefined && meta[k] !== null) meta[k] = pick(meta[k], ["exhausted", "damage", "deployed"]);
  const parsed = pickedMetaSchema.safeParse(meta);
  if (!parsed.success) return null;
  const m = parsed.data as z.infer<typeof pickedMetaSchema> & Record<string, number>;
  const scalars = (prefix: string): Scalars => Object.fromEntries(Object.entries(SCALARS).map(([k, v]) => [v, m[prefix + k]])) as Scalars;
  const tag = (playerId: string) => sha(m.gameId + "\u0001" + playerId, 12);
  const row: ParsedRow = {
    game: sha(m.gameId),
    actor: tag(m.activePlayerId),
    other: tag(m.opponentPlayerId),
    key: sha([m.gameId, m.timestamp, m.actionType, m.activePlayerId, m.cardId ?? "", m.targetId ?? "", String(m.turn)].join("\u0001"), 20),
    file: at.file,
    line: at.line,
    ts: m.timestamp,
    turn: m.turn,
    phase: m.phase,
    kind: m.actionType,
    label: top.label,
    card: m.cardSetId?.number !== undefined && m.cardSetId !== null ? { set: m.cardSetId.set, number: m.cardSetId.number } : null,
    cardName: m.cardName ?? null,
    cardType: m.cardPrintedType ?? null,
    targetName: m.targetName ?? null,
    targetIsBase: m.targetIsBase ?? null,
    smuggle: m.isSmuggle ?? null,
    me: scalars("activePlayer"),
    opp: scalars("opponent"),
    initiative: m.hasInitiative,
    meLeader: m.activePlayerLeader ?? null,
    meBase: m.activePlayerBase ?? null,
    oppLeader: m.opponentLeader ?? null,
    oppBase: m.opponentBase ?? null,
    meAspects: m.activePlayerAspects ?? [],
    oppAspects: m.opponentAspects ?? [],
    a: m.activePlayerUnits ?? null,
    b: m.opponentUnits ?? null,
    aLeader: m.activePlayerLeaderState ?? null,
    bLeader: m.opponentLeaderState ?? null,
    aDiscard: m.activePlayerDiscard?.map((d) => d.name) ?? null,
    bDiscard: m.opponentDiscard?.map((d) => d.name) ?? null,
  };
  return parsedRowSchema.parse(row);
}

const boardUnitSchema = z.strictObject({
  card: z.string().nullable(),
  cost: num,
  power: num,
  hp: num,
  damage: num,
  exhausted: z.boolean(),
  arena: z.enum(ARENAS),
  kw: z.array(z.string()),
  up: num,
});
export type BoardUnit = z.infer<typeof boardUnitSchema>;
const sideRecordSchema = scalarsSchema.extend({ leader: z.string().nullable(), base: z.string().nullable(), aspects: z.array(z.string()) });
const boardSchema = z.strictObject({ me: z.array(boardUnitSchema), opp: z.array(boardUnitSchema), meLeader: leaderStateSchema.nullable(), oppLeader: leaderStateSchema.nullable() });
export type Board = z.infer<typeof boardSchema>;
const attackOptionSchema = z.tuple([z.string(), z.enum(ARENAS), z.string()]);
export type AttackOption = z.infer<typeof attackOptionSchema>;
/** The card slot of an option whose unit name did not resolve. */
export const UNKNOWN_CARD = "?";

/** One actor-relative decision. Strict: the emitter gate in serializeRecords refuses any extra field. */
export const decisionRecordSchema = z.strictObject({
  g: hex(16),
  i: z.int().min(0),
  seat: z.union([z.literal(1), z.literal(2)]).nullable(),
  turn: z.int(),
  phase: z.enum(PHASES),
  kind: z.enum(ACTION_KINDS),
  card: z.string().nullable(),
  cardType: z.string().nullable(),
  /** The row named a card (resolved or not). */
  cardRef: z.boolean(),
  target: z.string().nullable(),
  targetRef: z.boolean(),
  smuggle: z.boolean().nullable(),
  initiative: z.boolean(),
  me: sideRecordSchema,
  opp: sideRecordSchema,
  before: boardSchema.nullable(),
  after: z.strictObject({ me: z.array(boardUnitSchema), opp: z.array(boardUnitSchema) }).nullable().optional(),
  next: z.strictObject({ meBaseDamage: num, oppBaseDamage: num }).nullable().optional(),
  attacks: z.strictObject({ options: z.array(attackOptionSchema), chosen: z.int().min(0).nullable() }).optional(),
  won: z.union([z.literal(0), z.literal(1)]).nullable(),
  forfeit: z.boolean(),
  flags: z.strictObject({ undone: z.boolean(), revert: z.boolean(), repeat: z.boolean() }),
});
export type DecisionRecord = z.infer<typeof decisionRecordSchema>;

const compareRows = (x: ParsedRow, y: ParsedRow): number => compareCodePoints(x.ts, y.ts) || x.file - y.file || x.line - y.line;

const landsOn = (list: readonly RawUnit[] | null, name: string): boolean => (list ?? []).some((u) => u.name === name || u.name.startsWith(name + ","));

/** scripts/bench/games.ts voteSeatOne over tags: the player whose board the first (activePlayer*) lists show. */
export function voteSeatOneTag(rows: readonly ParsedRow[]): string | null {
  const votes = new Map<string, number>();
  for (const r of rows) {
    if (r.kind !== "play_unit" || r.cardName === null || r.cardType === "basicUpgrade") continue;
    const onA = landsOn(r.a, r.cardName);
    const onB = landsOn(r.b, r.cardName);
    if (onA === onB) continue;
    const tag = onA ? r.actor : r.other;
    votes.set(tag, (votes.get(tag) ?? 0) + 1);
  }
  if (votes.size === 0) return null;
  return [...votes].sort((p, q) => q[1] - p[1] || compareCodePoints(p[0], q[0]))[0][0];
}

/** Every distinct (attacker, arena, target) a ready unit may declare; a Sentinel in the arena hides the rest unless the attacker is a Saboteur. */
export function rebuildAttacks(me: readonly BoardUnit[], opp: readonly BoardUnit[]): AttackOption[] {
  const out: AttackOption[] = [];
  const seen = new Set<string>();
  for (const att of me) {
    if (att.exhausted) continue;
    const there = opp.filter((u) => u.arena === att.arena);
    const sentinels = there.filter((u) => u.kw.includes("Sentinel"));
    const targets = sentinels.length > 0 && !att.kw.includes("Saboteur") ? sentinels.map((u) => u.card ?? UNKNOWN_CARD) : [...there.map((u) => u.card ?? UNKNOWN_CARD), "base"];
    for (const target of targets) {
      const opt: AttackOption = [att.card ?? UNKNOWN_CARD, att.arena, target];
      const key = opt.join("\u0001");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(opt);
    }
  }
  return out;
}

const afterSignature = (r: ParsedRow): string | null => (r.a === null || r.b === null ? null : sha(JSON.stringify([r.a, r.b, r.aLeader, r.bLeader, r.aDiscard, r.bDiscard]), 20));

/** Builds one game's records from its parsed rows, in any order and with duplicates. */
export function decisionsForGame(input: readonly ParsedRow[], resolve: CardResolver): DecisionRecord[] {
  const seen = new Set<string>();
  const rows = [...input].sort(compareRows).filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)));
  if (rows.length === 0) return [];
  const seatOne = voteSeatOneTag(rows.filter((r) => r.a !== null));

  const labels = new Map<string, Set<number>>();
  for (const r of rows) labels.set(r.actor, (labels.get(r.actor) ?? new Set()).add(r.label));
  const single = (tag: string): 0 | 1 | null => {
    const s = labels.get(tag);
    if (s === undefined || s.size !== 1) return null;
    const [v] = [...s];
    return v === 0 || v === 1 ? v : null;
  };
  const tags = [...labels.keys()];
  const conflict = tags.length === 2 && single(tags[0]) !== null && single(tags[0]) === single(tags[1]);
  const forfeit = rows.some((r) => r.kind === "forfeit");

  const unitCache = new Map<RawUnit, BoardUnit>();
  const units = (list: readonly RawUnit[]): RawUnit[] => list.filter((u) => !resolve.upgradeToken(u.name));
  const toUnit = (u: RawUnit): BoardUnit => {
    let b = unitCache.get(u);
    if (b === undefined) {
      b = { card: resolve.name(u.name), cost: u.cost, power: u.power, hp: u.hp, damage: u.damage, exhausted: u.exhausted, arena: u.arena, kw: u.keywords, up: u.upgradeCount };
      unitCache.set(u, b);
    }
    return b;
  };
  // A side's own leader or base rows carry exact set numbers, which beat the title-only identity fields.
  const evidence = (type: string): Map<string, string | null> => {
    const seen = new Map<string, Set<string>>();
    for (const r of rows) {
      if (r.cardType !== type || r.card === null) continue;
      const key = resolve.setId(r.card.set, r.card.number);
      if (key !== null) seen.set(r.actor, (seen.get(r.actor) ?? new Set()).add(key));
    }
    return new Map([...seen].map(([tag, keys]) => [tag, keys.size === 1 ? [...keys][0] : null]));
  };
  const leaders = evidence("leader");
  const bases = evidence("base");
  const rawSides = (r: ParsedRow, actor: string): { me: readonly RawUnit[]; opp: readonly RawUnit[] } | null =>
    seatOne === null || r.a === null || r.b === null ? null : actor === seatOne ? { me: units(r.a), opp: units(r.b) } : { me: units(r.b), opp: units(r.a) };
  const orient = (r: ParsedRow, actor: string): Board | null => {
    if (seatOne === null || r.a === null || r.b === null) return null;
    const mine = actor === seatOne;
    return {
      me: units(mine ? r.a : r.b).map(toUnit),
      opp: units(mine ? r.b : r.a).map(toUnit),
      meLeader: mine ? r.aLeader : r.bLeader,
      oppLeader: mine ? r.bLeader : r.aLeader,
    };
  };

  /** A title-only target ("Han Solo") is the defender's before-board unit of that title when every such unit is one card. */
  const boardTarget = (prev: ParsedRow | null, r: ParsedRow): string | null => {
    const sides = prev === null || r.targetName === null ? null : rawSides(prev, r.actor);
    if (sides === null) return null;
    const keys = new Set(sides.opp.filter((u) => u.name === r.targetName || u.name.startsWith(r.targetName + ",")).map((u) => toUnit(u).card));
    const [only] = [...keys];
    return keys.size === 1 && only !== null ? only : null;
  };

  const undone = new Array<boolean>(rows.length).fill(false);
  const revert = new Array<boolean>(rows.length).fill(false);
  const sigs = rows.map(afterSignature);
  let lastAt = new Map<string, number>();
  for (let j = 0; j < rows.length; j++) {
    if (j > 0 && rows[j].turn !== rows[j - 1].turn) lastAt = new Map();
    const sig = sigs[j];
    if (sig === null) continue;
    const i = lastAt.get(sig);
    if (i !== undefined && i < j - 1 && sig !== sigs[j - 1]) {
      for (let k = i + 1; k < j; k++) undone[k] = true;
      revert[j] = true;
    }
    lastAt.set(sig, j);
  }

  const out: DecisionRecord[] = [];
  for (const [j, r] of rows.entries()) {
    const prev = j > 0 ? rows[j - 1] : null;
    const before = prev === null ? null : orient(prev, r.actor);
    const card = r.card !== null ? resolve.setId(r.card.set, r.card.number) ?? (r.cardName !== null ? resolve.name(r.cardName) : null) : r.cardName !== null ? resolve.name(r.cardName) : null;
    const target = r.targetIsBase === true ? "base" : r.targetName !== null ? resolve.name(r.targetName) ?? boardTarget(prev, r) : null;
    const side = (tag: string, s: Scalars, leader: string | null, base: string | null, aspects: string[]) => ({
      ...s,
      leader: leaders.get(tag) ?? (leader === null ? null : resolve.leader(leader, aspects)),
      base: bases.get(tag) ?? (base === null ? null : resolve.base(base, aspects)),
      aspects,
    });
    const rec: DecisionRecord = {
      g: r.game,
      i: j,
      seat: seatOne === null ? null : r.actor === seatOne ? 1 : 2,
      turn: r.turn,
      phase: r.phase,
      kind: r.kind,
      card,
      cardType: r.cardType,
      cardRef: r.card !== null || r.cardName !== null,
      target,
      targetRef: r.targetIsBase === true || r.targetName !== null,
      smuggle: r.smuggle,
      initiative: r.initiative,
      me: side(r.actor, r.me, r.meLeader, r.meBase, r.meAspects),
      opp: side(r.other, r.opp, r.oppLeader, r.oppBase, r.oppAspects),
      before,
      won: conflict ? null : single(r.actor),
      forfeit,
      flags: { undone: undone[j], revert: revert[j], repeat: false },
    };
    if (r.kind === "attack") {
      const after = orient(r, r.actor);
      rec.after = after === null ? null : { me: after.me, opp: after.opp };
      const nx = j + 1 < rows.length ? rows[j + 1] : null;
      rec.next = nx === null ? null : nx.actor === r.actor ? { meBaseDamage: nx.me.baseDamage, oppBaseDamage: nx.opp.baseDamage } : { meBaseDamage: nx.opp.baseDamage, oppBaseDamage: nx.me.baseDamage };
      const options = before === null ? [] : rebuildAttacks(before.me, before.opp);
      const at = card === null || target === null ? -1 : options.findIndex((o) => o[0] === card && o[2] === target);
      rec.attacks = { options, chosen: at < 0 ? null : at };
      const p = prev;
      rec.flags.repeat = at < 0 && p !== null && p.kind === "attack" && p.actor === r.actor && p.turn === r.turn && p.cardName === r.cardName && p.targetName === r.targetName && p.targetIsBase === r.targetIsBase;
    }
    out.push(rec);
  }
  return out;
}

/** Emitter gate plus canonical text: every record is parsed strictly before it is written. */
export function serializeRecords(records: readonly DecisionRecord[]): string {
  return records.map((r) => JSON.stringify(decisionRecordSchema.parse(r)) + "\n").join("");
}

/**
 * @displayName Evaluator state encoding
 * @strategicPurpose Dataset generation, training and inference must see one layout of the game state from the
 * acting seat, with hidden information unrepresentable, so a drift is a thrown schema error instead of a silently
 * shifted column.
 * @tacticalObjective Parses a viewer-relative RawStateView (the extractor's output) and encodes it into fixed-size
 * integer arrays (scalars, unit slots, hand) plus sparse histograms, against a compiled vocabulary. Pure: no engine,
 * no clock, no randomness.
 */
import { z } from "zod";
import { hex64 } from "../schemas/hash.js";
import { canonicalJson, compareCodePoints, sha256Hex } from "../swu/canonical.js";
import { type CompiledVocab, RESERVED } from "./vocab.js";

export const STATE_VERSION = 1;
/** Units per side, both arenas together. Changing it changes the layout hash and needs a STATE_VERSION bump. */
export const U = 16;
/** Hand slots for the viewer's own hand. Same rule as U. */
export const H = 12;
export const MAX_UPGRADES = 3;
export const HIDDEN_CARD_KEY = "@hidden";
export const KEYWORD_OTHER_BIT = 0;

export const GLOBAL_SCALARS = [
  "round",
  "phaseSetup",
  "phaseAction",
  "phaseRegroup",
  "hasInitiative",
  "initiativeClaimed",
  "activeMe",
  "activeOpp",
] as const;
export const SIDE_SCALARS = [
  "baseDamage",
  "baseHp",
  "resourcesTotal",
  "resourcesReady",
  "handCount",
  "deckCount",
  "discardCount",
  "leaderDeployed",
  "leaderExhausted",
  "groundUnits",
  "spaceUnits",
  "groundPower",
  "spacePower",
  "remainingHp",
  "damage",
  "readyUnits",
  "sentinelUnits",
  "shieldedUnits",
  "hasForceToken",
  "credits",
  "capturedCards",
] as const;
export const SCALAR_NAMES = [...GLOBAL_SCALARS, ...SIDE_SCALARS.map((n) => `me_${n}`), ...SIDE_SCALARS.map((n) => `opp_${n}`)];
export const SCALAR_COUNT = 50;
export const SLOT_NAMES = [
  "cardIndex",
  "arena",
  "power",
  "hp",
  "damage",
  "exhausted",
  "upgradeCount",
  "keywordMask",
  "shields",
  "capturedCount",
  "isLeaderUnit",
  "isToken",
  "upgrade1",
  "upgrade2",
  "upgrade3",
] as const;
/** Per side, the base and leader vocabulary indices; leader deployment and exhaustion are scalars. */
export const IDENTITY_NAMES = ["baseIndex", "leaderIndex"] as const;

export const STATE_LAYOUT = {
  stateVersion: STATE_VERSION,
  scalarNames: SCALAR_NAMES,
  slotNames: SLOT_NAMES,
  identityNames: IDENTITY_NAMES,
  unitsPerSide: U,
  handSlots: H,
  maxUpgrades: MAX_UPGRADES,
  reserved: RESERVED,
  hiddenCardKey: HIDDEN_CARD_KEY,
  keywordBits: "bit 0 = keyword absent from the vocabulary; bit i+1 = vocabulary keywords[i]",
  unitOrder:
    "arena (ground first), cardKey by code point, power, damage, upgrade keys joined by code point; overflow keeps the U highest power + remaining hp",
  handOrder: "cardKey by code point; the first H are encoded, the rest counted in overflow.hand",
  histograms: "[vocabulary index, count] sorted by index",
} as const;
export const STATE_LAYOUT_SHA256 = "74c8292c3f21a2575bb06a6ee578993f5121b64bbacda92aa38c7d459a8efc35";

const cardKey = z.string().min(1);
const unitSchema = z.strictObject({
  cardKey,
  arena: z.enum(["ground", "space"]),
  power: z.int(),
  hp: z.int().positive(),
  damage: z.int().min(0),
  exhausted: z.boolean(),
  upgrades: z.array(cardKey),
  keywords: z.array(z.string().min(1)),
  shields: z.int().min(0),
  capturedCount: z.int().min(0),
  isLeaderUnit: z.boolean(),
  isToken: z.boolean(),
});
const sideShape = {
  baseCardKey: cardKey,
  baseDamage: z.int().min(0),
  baseHp: z.int().positive(),
  leader: z.strictObject({ cardKey, deployed: z.boolean(), exhausted: z.boolean() }),
  resourcesTotal: z.int().min(0),
  resourcesReady: z.int().min(0),
  handCount: z.int().min(0),
  deckCount: z.int().min(0),
  discardCount: z.int().min(0),
  discard: z.array(cardKey),
  units: z.array(unitSchema),
  hasForceToken: z.boolean(),
  credits: z.int().min(0),
  capturedCards: z.int().min(0),
};
type SideCommon = { resourcesReady: number; resourcesTotal: number; discard: string[]; discardCount: number };
const checkSide = (side: SideCommon, ctx: z.RefinementCtx): void => {
  if (side.resourcesReady > side.resourcesTotal)
    ctx.addIssue({ code: "custom", message: "resourcesReady exceeds resourcesTotal", path: ["resourcesReady"] });
  if (side.discard.length !== side.discardCount)
    ctx.addIssue({ code: "custom", message: "discard length differs from discardCount", path: ["discard"] });
};
const mySideSchema = z
  .strictObject({ ...sideShape, hand: z.array(cardKey), library: z.array(z.strictObject({ cardKey, count: z.int().positive() })) })
  .superRefine((side, ctx) => {
    checkSide(side, ctx);
    if (side.hand.length !== side.handCount)
      ctx.addIssue({ code: "custom", message: "hand length differs from handCount", path: ["hand"] });
    if (side.library.reduce((sum, row) => sum + row.count, 0) !== side.deckCount) {
      ctx.addIssue({ code: "custom", message: "library counts do not sum to deckCount", path: ["library"] });
    }
  });
/** No hand and no library: an opponent's hidden zones in the input are an unrecognized-key error. */
const oppSideSchema = z.strictObject(sideShape).superRefine(checkSide);

export const rawStateViewSchema = z.strictObject({
  schemaVersion: z.literal(1),
  round: z.int().min(0),
  /** Null between phases (forceteki currentPhase is null there); it encodes as an all-zero phase one-hot. */
  phase: z.enum(["setup", "action", "regroup"]).nullable(),
  hasInitiative: z.boolean(),
  initiativeClaimed: z.boolean(),
  activeSeat: z.enum(["me", "opp"]).nullable(),
  me: mySideSchema,
  opp: oppSideSchema,
});
export type RawStateView = z.infer<typeof rawStateViewSchema>;

const slotRow = z.array(z.int()).length(SLOT_NAMES.length);
const histogram = z
  .array(z.tuple([z.int().min(0), z.int().positive()]))
  .refine((rows) => rows.every((row, i) => i === 0 || rows[i - 1][0] < row[0]), {
    error: "histogram rows must be sorted by strictly increasing index",
  });
export const encodedStateSchema = z.strictObject({
  stateVersion: z.literal(STATE_VERSION),
  layoutSha256: hex64,
  vocabSha256: hex64,
  scalars: z.array(z.int()).length(SCALAR_COUNT),
  slots: z.strictObject({ me: z.array(slotRow).length(U), opp: z.array(slotRow).length(U) }),
  hand: z.array(z.int().min(0)).length(H),
  discardHist: z.strictObject({ me: histogram, opp: histogram }),
  libraryHist: histogram,
  identity: z.strictObject({
    me: z.array(z.int().min(0)).length(IDENTITY_NAMES.length),
    opp: z.array(z.int().min(0)).length(IDENTITY_NAMES.length),
  }),
  unknown: z.int().min(0),
  unknownKeywords: z.int().min(0),
  overflow: z.strictObject({ me: z.int().min(0), opp: z.int().min(0), hand: z.int().min(0) }),
});
export type EncodedState = z.infer<typeof encodedStateSchema>;

type Unit = z.infer<typeof unitSchema>;
type Side = RawStateView["opp"];

const b = (flag: boolean): number => (flag ? 1 : 0);
const unitOrder = (x: Unit, y: Unit): number =>
  compareCodePoints(x.arena, y.arena) ||
  compareCodePoints(x.cardKey, y.cardKey) ||
  x.power - y.power ||
  x.damage - y.damage ||
  compareCodePoints([...x.upgrades].sort(compareCodePoints).join(","), [...y.upgrades].sort(compareCodePoints).join(","));

export function encodeState(view: unknown, vocab: CompiledVocab): EncodedState {
  const v = rawStateViewSchema.parse(view);
  let unknown = 0;
  let unknownKeywords = 0;
  const idx = (key: string): number => {
    if (key === HIDDEN_CARD_KEY) return RESERVED.hidden;
    const found = vocab.index.get(key);
    if (found === undefined) {
      unknown += 1;
      return RESERVED.unknown;
    }
    return found;
  };
  const mask = (keywords: readonly string[]): number => {
    let m = 0;
    for (const keyword of keywords) {
      const bit = vocab.keywordBit.get(keyword);
      if (bit === undefined) unknownKeywords += 1;
      m |= 1 << (bit ?? KEYWORD_OTHER_BIT);
    }
    return m;
  };
  const histogramOf = (rows: readonly (readonly [string, number])[]): [number, number][] => {
    const counts = new Map<number, number>();
    for (const [key, count] of rows) {
      const i = idx(key);
      counts.set(i, (counts.get(i) ?? 0) + count);
    }
    return [...counts].sort((x, y) => x[0] - y[0]);
  };
  const slots = (units: readonly Unit[]): { rows: number[][]; overflow: number } => {
    const ordered = [...units].sort(unitOrder);
    const kept =
      ordered.length <= U
        ? ordered
        : ordered
            .map((unit, i) => ({ unit, i, strength: unit.power + unit.hp - unit.damage }))
            .sort((x, y) => y.strength - x.strength || x.i - y.i)
            .slice(0, U)
            .sort((x, y) => x.i - y.i)
            .map((row) => row.unit);
    const rows = kept.map((unit) => {
      const upgrades = [...unit.upgrades].sort(compareCodePoints).map(idx);
      const shown = [...upgrades.slice(0, MAX_UPGRADES), ...new Array<number>(MAX_UPGRADES).fill(RESERVED.pad)].slice(0, MAX_UPGRADES);
      return [
        idx(unit.cardKey),
        unit.arena === "space" ? 1 : 0,
        unit.power,
        unit.hp,
        unit.damage,
        b(unit.exhausted),
        unit.upgrades.length,
        mask(unit.keywords),
        unit.shields,
        unit.capturedCount,
        b(unit.isLeaderUnit),
        b(unit.isToken),
        ...shown,
      ];
    });
    while (rows.length < U) rows.push(new Array<number>(SLOT_NAMES.length).fill(0));
    return { rows, overflow: ordered.length - kept.length };
  };
  const sideScalars = (side: Side): number[] => {
    const sum = (f: (u: Unit) => number): number => side.units.reduce((total, unit) => total + f(unit), 0);
    return [
      side.baseDamage,
      side.baseHp,
      side.resourcesTotal,
      side.resourcesReady,
      side.handCount,
      side.deckCount,
      side.discardCount,
      b(side.leader.deployed),
      b(side.leader.exhausted),
      sum((u) => b(u.arena === "ground")),
      sum((u) => b(u.arena === "space")),
      sum((u) => (u.arena === "ground" ? u.power : 0)),
      sum((u) => (u.arena === "space" ? u.power : 0)),
      sum((u) => u.hp - u.damage),
      sum((u) => u.damage),
      sum((u) => b(!u.exhausted)),
      sum((u) => b(u.keywords.includes("sentinel"))),
      sum((u) => b(u.shields > 0)),
      b(side.hasForceToken),
      side.credits,
      side.capturedCards,
    ];
  };

  const identity = { me: [idx(v.me.baseCardKey), idx(v.me.leader.cardKey)], opp: [idx(v.opp.baseCardKey), idx(v.opp.leader.cardKey)] };
  const me = slots(v.me.units);
  const opp = slots(v.opp.units);
  const handIndices = [...v.me.hand].sort(compareCodePoints).map(idx);
  const encoded: EncodedState = {
    stateVersion: STATE_VERSION,
    layoutSha256: STATE_LAYOUT_SHA256,
    vocabSha256: vocab.sha256,
    scalars: [
      v.round,
      b(v.phase === "setup"),
      b(v.phase === "action"),
      b(v.phase === "regroup"),
      b(v.hasInitiative),
      b(v.initiativeClaimed),
      b(v.activeSeat === "me"),
      b(v.activeSeat === "opp"),
      ...sideScalars(v.me),
      ...sideScalars(v.opp),
    ],
    slots: { me: me.rows, opp: opp.rows },
    hand: [...handIndices.slice(0, H), ...new Array<number>(Math.max(0, H - handIndices.length)).fill(RESERVED.pad)],
    discardHist: { me: histogramOf(v.me.discard.map((k) => [k, 1] as const)), opp: histogramOf(v.opp.discard.map((k) => [k, 1] as const)) },
    libraryHist: histogramOf(v.me.library.map((row) => [row.cardKey, row.count] as const)),
    identity,
    unknown: 0,
    unknownKeywords: 0,
    overflow: { me: me.overflow, opp: opp.overflow, hand: Math.max(0, handIndices.length - H) },
  };
  encoded.unknown = unknown;
  encoded.unknownKeywords = unknownKeywords;
  return encodedStateSchema.parse(encoded);
}

export function stateSha256(state: EncodedState): string {
  return sha256Hex(canonicalJson(state));
}

export function layoutSha256(): string {
  return sha256Hex(canonicalJson(STATE_LAYOUT));
}

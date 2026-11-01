import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { decode } from "@toon-format/toon";
import { z } from "zod";
import { indexLeaderCards, type LeaderCardsIndex } from "../../meta/schema.js";
import { scoresFileSchema } from "../../scorer/scores-file.js";
import { LINK_KINDS } from "../../synergy/schema.js";
import { compareCodePoints } from "../../swu/canonical.js";
import type { AbilityProfile, EffectProfile } from "./types.js";

/**
 * @displayName Bot policy lookup tables
 * @strategicPurpose Gives the rung 1 and rung 2 bots the project's own card judgements (play-calibrated score, parsed
 * card text, the leader's tournament lists, the pair graph weighted by measured row precision) as pinned, hashed Map reads.
 * @tacticalObjective Parses scores.json, features.json, meta/leader-cards.json, synergy/pairs.toon (checked against
 * synergy/replay.json), verify/pair-precision.json and data/complementarity.json at the boundary, and exposes
 * name-to-cardKey, score (null at its type's median), effect profile, leader inclusion and directed edge weight.
 */

/** D42's mechanical pairing precision on pairs-v1, the shrinkage target for a row's measured precision (#114). */
export const MECHANICAL_PRIOR = 0.7267;
/** Pseudo-items of MECHANICAL_PRIOR added to each row's fixture count (estimate, #114). */
export const ROW_PSEUDO_ITEMS = 10;

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

export function normalizeCardName(title: string, subtitle: string | null | undefined): string {
  const full = subtitle ? `${title}, ${subtitle}` : title;
  return full
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const faceEntrySchema = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("ability"),
    triggers: z.array(z.looseObject({ trigger: z.string(), cost: z.looseObject({ other: z.array(z.string()).optional() }).optional() })),
    clauses: z.array(z.looseObject({ text: z.string() })),
  }),
  z.looseObject({ kind: z.literal("keyword") }),
]);
const facesSchema = z.looseObject({ text: z.array(faceEntrySchema).optional(), deployBox: z.array(faceEntrySchema).optional() });
export type CardFaces = z.infer<typeof facesSchema>;

const featureRowSchema = z.looseObject({
  cardKey: z.string().min(1),
  type: z.string(),
  structured: z.looseObject({ upgradePower: z.number().nullable(), upgradeHp: z.number().nullable(), aspects: z.array(z.string()) }),
  vector: z.looseObject({ effects: z.record(z.string(), z.looseObject({ byTarget: z.record(z.string(), z.number()) })) }),
  faces: facesSchema.optional(),
});

const NO_ABILITY: AbilityProfile = { sacrificeAction: false, whenDefeated: false, takeInitiativeCost: null };
const SACRIFICE_COST = /^defeat (a|another) friendly unit$/i;

/** The pilot rules' ability facts from one parsed face; a leader's `text` face is its leader side, `deployBox` its unit side. */
export function abilityProfileOf(faces: CardFaces | undefined, face: "text" | "deployBox"): AbilityProfile {
  const abilities = faces?.[face] ?? [];
  let sacrificeAction = false;
  let whenDefeated = false;
  let takeInitiativeCost: number | null = null;
  for (const a of abilities) {
    if (a.kind !== "ability") continue;
    for (const t of a.triggers) {
      if (t.trigger === "action" && (t.cost?.other ?? []).some((o) => SACRIFICE_COST.test(o))) sacrificeAction = true;
      if (t.trigger === "when_defeated") whenDefeated = true;
      if (t.trigger === "take_initiative") {
        const pay = a.clauses.map((c) => /pay (\d+) resources?/i.exec(c.text)).find((m) => m !== null);
        takeInitiativeCost = pay ? Number(pay[1]) : 0;
      }
    }
  }
  return { sacrificeAction, whenDefeated, takeInitiativeCost };
}
const featuresSchema = z.array(featureRowSchema);

const pairRowSchema = z.strictObject({
  cardA: z.string().min(1),
  cardB: z.string().min(1),
  reason: z.string(),
  rows: z.string().min(1),
  linkKind: z.enum(LINK_KINDS),
  source: z.string(),
  link: z.number(),
  nonObvious: z.number(),
  score: z.number(),
});
const pairsFileSchema = z.strictObject({ pairings: z.array(pairRowSchema) });

const countSchema = z.looseObject({ n: z.int().nonnegative(), of: z.int().nonnegative() });
const pairPrecisionSchema = z.looseObject({ perRow: z.record(z.string(), z.looseObject({ precision: countSchema })) });

const synergyReplaySchema = z.looseObject({ outputHash: z.looseObject({ "pairs.toon": z.string().length(64) }) });

const complementaritySchema = z.looseObject({
  rows: z.array(z.looseObject({ id: z.string(), strength: z.number() })),
});

const REMOVAL_EFFECTS = new Set(["damage", "defeat", "capture", "take_control", "bounce", "exhaust", "indirect_damage"]);
const UNIT_TARGET = /^(any|enemy|mixed)_unit/;

export function effectProfileOf(effects: Readonly<Record<string, { byTarget: Record<string, number> }>>): EffectProfile {
  let removal = false;
  let heal = false;
  for (const [key, v] of Object.entries(effects)) {
    const [, effect] = key.split(":");
    if (REMOVAL_EFFECTS.has(effect) && Object.keys(v.byTarget).some((t) => UNIT_TARGET.test(t))) removal = true;
    if (effect === "heal") heal = true;
  }
  return { removal, heal };
}

export interface TablePins {
  scoresSha256: string;
  coefficientsSha256: string;
  featuresSha256: string;
  leaderCardsSha256: string;
  pairsSha256: string | null;
  pairPrecisionSha256: string | null;
  complementaritySha256: string | null;
}

export interface CardTables {
  /** cardKey of an engine card by title and subtitle; null for tokens and unmapped cards. */
  keyOf(title: string, subtitle: string | null | undefined): string | null;
  /** playCalibrated with a null score at its type's median; 0 for an unknown key. */
  score(cardKey: string | null): number;
  effects(cardKey: string | null): EffectProfile;
  ability(cardKey: string | null, face: "text" | "deployBox"): AbilityProfile;
  upgradeStats(cardKey: string | null): { power: number; hp: number };
  /** Printed aspects from the parsed card. */
  aspects(cardKey: string): readonly string[];
  /** Placement-weighted share of the leader's tournament lists that play the card (D38); 0 when absent. */
  leaderInclusion(leaderKey: string | null, cardKey: string | null): number;
  /** w(a -> b) = (traitOnly ? 0 : score) * shrunk row precision; 0 when there is no edge or pairs were not loaded. */
  edgeWeight(a: string | null, b: string | null): number;
  pins: TablePins;
  /** The weighted edges, for handing to worker threads; null when pairs were not loaded. */
  pairTable: PairTable | null;
  /** Name collisions folded onto the code-point-first cardKey. */
  ambiguousNames: number;
}

/** Directed edge weights keyed "a>b", with the hashes of the files they came from. */
export interface PairTable {
  edges: [string, number][];
  pins: { pairsSha256: string; pairPrecisionSha256: string; complementaritySha256: string };
}

/**
 * Reads pairs.toon (refusing bytes that differ from synergy/replay.json), pair-precision.json and the complementarity
 * table into w(a -> b) = score * shrunk precision of the edge's strongest mechanical row; trait-only edges weigh 0 and are left out.
 */
export function loadPairTable(runDir: string, complementarity: string): PairTable {
  const pairsBytes = readFileSync(path.join(runDir, "synergy/pairs.toon"));
  const pairsSha256 = sha256(pairsBytes);
  const replay = synergyReplaySchema.parse(JSON.parse(readFileSync(path.join(runDir, "synergy/replay.json"), "utf8")));
  if (replay.outputHash["pairs.toon"] !== pairsSha256) throw new Error(`pairs.toon sha256 ${pairsSha256} differs from synergy/replay.json`);
  const precisionBytes = readFileSync(path.join(runDir, "verify/pair-precision.json"));
  const perRow = pairPrecisionSchema.parse(JSON.parse(precisionBytes.toString("utf8"))).perRow;
  const tableBytes = readFileSync(complementarity);
  const strength = new Map(complementaritySchema.parse(JSON.parse(tableBytes.toString("utf8"))).rows.map((r) => [r.id, r.strength]));
  // A row id may carry a qualifier ("stat-count:power-0"); strength and precision fall back to the base row.
  const baseOf = (row: string): string => row.split(":")[0];
  const precisionOf = (row: string): number => {
    const p = (perRow[row] ?? perRow[baseOf(row)])?.precision;
    return p === undefined ? MECHANICAL_PRIOR : shrunkRowPrecision(p.n, p.of);
  };
  const table = pairsFileSchema.parse(decode(pairsBytes.toString("utf8")));
  const edges: [string, number][] = [];
  for (const e of table.pairings) {
    if (e.linkKind === "trait-only") continue;
    const mech = e.rows
      .split("|")
      .filter((r) => r !== "trait-reference" && !r.startsWith("trait-reference:"))
      .sort((a, b) => (strength.get(baseOf(b)) ?? 0) - (strength.get(baseOf(a)) ?? 0) || compareCodePoints(a, b));
    if (mech.length === 0) continue;
    edges.push([`${e.cardA}>${e.cardB}`, e.score * precisionOf(mech[0])]);
  }
  return { edges, pins: { pairsSha256, pairPrecisionSha256: sha256(precisionBytes), complementaritySha256: sha256(tableBytes) } };
}

export interface TableFiles {
  runDir: string;
  complementarity: string;
  /** Load the pair graph (rung 2), or reuse one already loaded (worker threads); rung 1 does not read it. */
  pairs: boolean | PairTable;
}

/** Shrinks a row's fixture precision toward MECHANICAL_PRIOR; a row with no fixture items is the prior. */
export function shrunkRowPrecision(n: number, of: number): number {
  return (n + ROW_PSEUDO_ITEMS * MECHANICAL_PRIOR) / (of + ROW_PSEUDO_ITEMS);
}

export function loadTables({ runDir, complementarity, pairs }: TableFiles): CardTables {
  const scoresBytes = readFileSync(path.join(runDir, "scores/scores.json"));
  const scoresFile = scoresFileSchema.parse(JSON.parse(scoresBytes.toString("utf8")));
  const featuresBytes = readFileSync(path.join(runDir, "features/features.json"));
  const features = featuresSchema.parse(JSON.parse(featuresBytes.toString("utf8")));
  const leaderBytes = readFileSync(path.join(runDir, "meta/leader-cards.json"));
  const leaderIndex: LeaderCardsIndex = indexLeaderCards(JSON.parse(leaderBytes.toString("utf8")));

  const byName = new Map<string, string>();
  let ambiguousNames = 0;
  const rows = [...scoresFile.cards].sort((a, b) => compareCodePoints(a.cardKey, b.cardKey));
  for (const r of rows) {
    const name = normalizeCardName(r.title, r.subtitle);
    if (byName.has(name)) ambiguousNames++;
    else byName.set(name, r.cardKey);
  }
  const byType = new Map<string, number[]>();
  for (const r of rows) if (r.playCalibrated !== null) byType.set(r.type, [...(byType.get(r.type) ?? []), r.playCalibrated]);
  const medianOf = new Map<string, number>();
  for (const [type, values] of byType) {
    const s = [...values].sort((a, b) => a - b);
    medianOf.set(type, s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2);
  }
  const scoreOf = new Map(rows.map((r) => [r.cardKey, r.playCalibrated ?? medianOf.get(r.type) ?? 0]));
  const featureOf = new Map(features.map((f) => [f.cardKey, f]));
  const effectCache = new Map<string, EffectProfile>();
  const NO_EFFECTS: EffectProfile = { removal: false, heal: false };
  const abilityCache = new Map<string, AbilityProfile>();

  const pairTable = pairs === true ? loadPairTable(runDir, complementarity) : pairs === false ? null : pairs;
  const edge = new Map(pairTable?.edges ?? []);

  return {
    keyOf: (title, subtitle) => byName.get(normalizeCardName(title, subtitle)) ?? null,
    score: (key) => (key === null ? 0 : (scoreOf.get(key) ?? 0)),
    effects: (key) => {
      if (key === null) return NO_EFFECTS;
      const hit = effectCache.get(key);
      if (hit) return hit;
      const f = featureOf.get(key);
      const p = f ? effectProfileOf(f.vector.effects) : NO_EFFECTS;
      effectCache.set(key, p);
      return p;
    },
    ability: (key, face) => {
      if (key === null) return NO_ABILITY;
      const ck = `${face}|${key}`;
      const hit = abilityCache.get(ck);
      if (hit) return hit;
      const p = abilityProfileOf(featureOf.get(key)?.faces, face);
      abilityCache.set(ck, p);
      return p;
    },
    upgradeStats: (key) => {
      const f = key === null ? undefined : featureOf.get(key);
      return { power: f?.structured.upgradePower ?? 0, hp: f?.structured.upgradeHp ?? 0 };
    },
    aspects: (key) => featureOf.get(key)?.structured.aspects ?? [],
    leaderInclusion: (leaderKey, key) => (leaderKey === null || key === null ? 0 : (leaderIndex.get(leaderKey)?.byCard.get(key)?.inclusion ?? 0)),
    edgeWeight: (a, b) => (a === null || b === null ? 0 : (edge.get(`${a}>${b}`) ?? 0)),
    pins: {
      scoresSha256: sha256(scoresBytes),
      coefficientsSha256: scoresFile.coefficientsSha256,
      featuresSha256: sha256(featuresBytes),
      leaderCardsSha256: sha256(leaderBytes),
      pairsSha256: pairTable?.pins.pairsSha256 ?? null,
      pairPrecisionSha256: pairTable?.pins.pairPrecisionSha256 ?? null,
      complementaritySha256: pairTable?.pins.complementaritySha256 ?? null,
    },
    pairTable,
    ambiguousNames,
  };
}

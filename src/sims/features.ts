/**
 * @displayName Evaluator feature layout
 * @strategicPurpose One flatten step from EncodedState to sparse (index, value) pairs, shared by training (#126) and
 * inference (#127), so the two can never disagree about a column.
 * @tacticalObjective Lays out the scalars, ten positional fields per unit slot per side, and eight count blocks over
 * the vocabulary (board, hand, discard, library and the base-and-leader identity of each side); the layout hash
 * changes whenever a width, an order, the vocabulary or the state layout changes. Pure: no clock, no randomness.
 */
import { canonicalJson, sha256Hex } from "../swu/canonical.js";
import { IDENTITY_NAMES, SLOT_NAMES, STATE_LAYOUT_SHA256, STATE_VERSION, type EncodedState } from "./state.js";
import { RESERVED } from "./vocab.js";

export const FEATURE_LAYOUT_VERSION = 1;
/** keywordMask stays out: a bitmask read as one number has no linear meaning; the sentinel and shield counts are scalars. */
export const POSITIONAL_FIELDS = ["arena", "power", "hp", "damage", "exhausted", "upgradeCount", "shields", "capturedCount", "isLeaderUnit", "isToken"] as const;
const CARD_FIELDS = ["cardIndex", "upgrade1", "upgrade2", "upgrade3"] as const;
export const FEATURE_BLOCKS = ["meBoard", "oppBoard", "meHand", "meDiscard", "oppDiscard", "meLibrary", "meIdentity", "oppIdentity"] as const;

/** By name from #124's SLOT_NAMES, so a renamed column throws at import instead of shifting a feature. */
const column = (name: string): number => {
  const i = (SLOT_NAMES as readonly string[]).indexOf(name);
  if (i < 0) throw new Error(`slot column ${name} is not in #124's SLOT_NAMES`);
  return i;
};
const POSITIONAL_COLUMNS = POSITIONAL_FIELDS.map(column);
const CARD_COLUMNS = CARD_FIELDS.map(column);
const block = (name: (typeof FEATURE_BLOCKS)[number]): number => FEATURE_BLOCKS.indexOf(name);

export interface FeatureLayout {
  version: number;
  scalarCount: number;
  slotCap: number;
  vocabSize: number;
  vocabSha256: string;
  stateLayoutSha256: string;
  width: number;
  sha256: string;
}

export interface SparseRow {
  indices: number[];
  values: number[];
}

/** vocabSize counts every index the vocabulary can emit: its keys plus the reserved indices below FIRST_CARD_INDEX. */
export function featureLayout(scalarCount: number, slotCap: number, vocabSize: number, vocabSha256: string): FeatureLayout {
  const width = scalarCount + 2 * slotCap * POSITIONAL_FIELDS.length + FEATURE_BLOCKS.length * vocabSize;
  const body = {
    version: FEATURE_LAYOUT_VERSION,
    stateVersion: STATE_VERSION,
    stateLayoutSha256: STATE_LAYOUT_SHA256,
    scalarCount,
    slotCap,
    vocabSize,
    vocabSha256,
    width,
    positional: [...POSITIONAL_FIELDS],
    cardFields: [...CARD_FIELDS],
    identity: [...IDENTITY_NAMES],
    blocks: [...FEATURE_BLOCKS],
    padSkipped: RESERVED.pad,
  };
  return { version: FEATURE_LAYOUT_VERSION, scalarCount, slotCap, vocabSize, vocabSha256, stateLayoutSha256: STATE_LAYOUT_SHA256, width, sha256: sha256Hex(canonicalJson(body)) };
}

export function flattenState(s: EncodedState, layout: FeatureLayout): SparseRow {
  if (s.layoutSha256 !== layout.stateLayoutSha256) throw new RangeError(`state layoutSha256 ${s.layoutSha256} differs from the feature layout's ${layout.stateLayoutSha256}`);
  if (s.vocabSha256 !== layout.vocabSha256) throw new RangeError(`state vocabSha256 ${s.vocabSha256} differs from the feature layout's vocabulary ${layout.vocabSha256}`);
  if (s.scalars.length !== layout.scalarCount) throw new RangeError(`scalars: expected ${layout.scalarCount}, got ${s.scalars.length}`);
  const acc = new Map<number, number>();
  const add = (i: number, v: number): void => {
    if (v !== 0) acc.set(i, (acc.get(i) ?? 0) + v);
  };
  s.scalars.forEach((v, i) => add(i, v));
  const sides = [s.slots.me, s.slots.opp];
  const P = POSITIONAL_COLUMNS.length;
  let base = layout.scalarCount;
  for (const side of sides) {
    if (side.length !== layout.slotCap) throw new RangeError(`slots: expected ${layout.slotCap}, got ${side.length}`);
    side.forEach((row, u) => POSITIONAL_COLUMNS.forEach((c, f) => add(base + u * P + f, row[c])));
    base += layout.slotCap * P;
  }
  const count = (b: number, index: number, n: number): void => {
    if (index === RESERVED.pad) return;
    if (!Number.isInteger(index) || index < 0 || index >= layout.vocabSize) throw new RangeError(`card index ${index} outside vocabulary of ${layout.vocabSize}`);
    add(base + b * layout.vocabSize + index, n);
  };
  sides.forEach((side, b) => {
    for (const row of side) for (const c of CARD_COLUMNS) count(b, row[c], 1);
  });
  for (const index of s.hand) count(block("meHand"), index, 1);
  for (const [index, n] of s.discardHist.me) count(block("meDiscard"), index, n);
  for (const [index, n] of s.discardHist.opp) count(block("oppDiscard"), index, n);
  for (const [index, n] of s.libraryHist) count(block("meLibrary"), index, n);
  for (const [name, ids] of [["meIdentity", s.identity.me], ["oppIdentity", s.identity.opp]] as const) {
    if (ids.length !== IDENTITY_NAMES.length) throw new RangeError(`identity: expected ${IDENTITY_NAMES.length} indices, got ${ids.length}`);
    for (const index of ids) count(block(name), index, 1);
  }
  const indices = [...acc.keys()].sort((a, b) => a - b);
  return { indices, values: indices.map((i) => acc.get(i) as number) };
}

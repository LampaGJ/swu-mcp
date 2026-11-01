import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FEATURE_BLOCKS, FEATURE_LAYOUT_VERSION, featureLayout, flattenState, POSITIONAL_FIELDS } from "../../src/sims/features.js";
import { encodeState, IDENTITY_NAMES, SCALAR_COUNT, SLOT_NAMES, STATE_LAYOUT_SHA256, U, type EncodedState } from "../../src/sims/state.js";
import { buildVocab, compileVocab, FIRST_CARD_INDEX } from "../../src/sims/vocab.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VOCAB_SHA = "c".repeat(64);
const slot = (fields: Record<string, number> = {}): number[] => SLOT_NAMES.map((n) => fields[n] ?? 0);
const emptySide = (): number[][] => Array.from({ length: U }, () => slot());

function state(over: Partial<EncodedState> = {}): EncodedState {
  const me = emptySide();
  me[0] = slot({ cardIndex: 7, power: 2, hp: 3, upgrade1: 9, keywordMask: 5 });
  const scalars = new Array<number>(SCALAR_COUNT).fill(0);
  scalars[0] = 3;
  scalars[2] = 1;
  return {
    stateVersion: 1,
    layoutSha256: STATE_LAYOUT_SHA256,
    vocabSha256: VOCAB_SHA,
    scalars,
    slots: { me, opp: emptySide() },
    hand: [5, ...new Array<number>(11).fill(0)],
    discardHist: { me: [[4, 2]], opp: [[8, 1]] },
    libraryHist: [[6, 3]],
    identity: { me: [10, 11], opp: [12, 13] },
    unknown: 0,
    unknownKeywords: 0,
    overflow: { me: 0, opp: 0, hand: 0 },
    ...over,
  };
}

const V = 20;
const layout = featureLayout(SCALAR_COUNT, U, V, VOCAB_SHA);
const P = POSITIONAL_FIELDS.length;
const blockBase = SCALAR_COUNT + 2 * U * P;
const blockAt = (name: (typeof FEATURE_BLOCKS)[number], index: number): number => blockBase + FEATURE_BLOCKS.indexOf(name) * V + index;

describe("feature layout", () => {
  it("has scalars, ten positional fields per slot per side and eight vocabulary blocks including both identity blocks", () => {
    expect(FEATURE_LAYOUT_VERSION).toBe(1);
    expect(P).toBe(10);
    expect(POSITIONAL_FIELDS).not.toContain("keywordMask");
    expect(FEATURE_BLOCKS).toEqual(["meBoard", "oppBoard", "meHand", "meDiscard", "oppDiscard", "meLibrary", "meIdentity", "oppIdentity"]);
    expect(layout.width).toBe(SCALAR_COUNT + 2 * U * 10 + 8 * V);
    expect(layout.stateLayoutSha256).toBe(STATE_LAYOUT_SHA256);
  });

  it("hashes stably and moves with every size, the vocabulary and the state layout", () => {
    expect(featureLayout(SCALAR_COUNT, U, V, VOCAB_SHA).sha256).toBe(layout.sha256);
    expect(featureLayout(SCALAR_COUNT, U, V + 1, VOCAB_SHA).sha256).not.toBe(layout.sha256);
    expect(featureLayout(SCALAR_COUNT, U - 1, V, VOCAB_SHA).sha256).not.toBe(layout.sha256);
    expect(featureLayout(SCALAR_COUNT - 1, U, V, VOCAB_SHA).sha256).not.toBe(layout.sha256);
    expect(featureLayout(SCALAR_COUNT, U, V, "d".repeat(64)).sha256).not.toBe(layout.sha256);
  });

  it("flattens to sorted sparse pairs, skipping pad index 0 and zero values", () => {
    const f = flattenState(state(), layout);
    expect(f.indices).toEqual([...f.indices].sort((a, b) => a - b));
    expect(new Set(f.indices).size).toBe(f.indices.length);
    const at = (i: number): number | undefined => (f.indices.includes(i) ? f.values[f.indices.indexOf(i)] : undefined);
    expect(at(0)).toBe(3);
    expect(at(1)).toBeUndefined();
    expect(at(2)).toBe(1);
    expect(at(SCALAR_COUNT + POSITIONAL_FIELDS.indexOf("power"))).toBe(2);
    expect(at(SCALAR_COUNT + POSITIONAL_FIELDS.indexOf("hp"))).toBe(3);
    expect(at(blockAt("meBoard", 7))).toBe(1);
    expect(at(blockAt("meBoard", 9))).toBe(1);
    expect(at(blockAt("meBoard", 0))).toBeUndefined();
    expect(at(blockAt("meHand", 5))).toBe(1);
    expect(at(blockAt("meHand", 0))).toBeUndefined();
    expect(at(blockAt("meDiscard", 4))).toBe(2);
    expect(at(blockAt("oppDiscard", 8))).toBe(1);
    expect(at(blockAt("meLibrary", 6))).toBe(3);
    expect(at(blockAt("meIdentity", 10))).toBe(1);
    expect(at(blockAt("meIdentity", 11))).toBe(1);
    expect(at(blockAt("oppIdentity", 12))).toBe(1);
    expect(at(blockAt("oppIdentity", 13))).toBe(1);
    // two scalars, power and hp, two board cards, hand, two discards, library, four identity cards
    expect(f.indices.length).toBe(14);
    expect(f.indices.every((i) => i >= 0 && i < layout.width)).toBe(true);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(flattenState(state(), layout))).toBe(JSON.stringify(flattenState(state(), layout)));
  });

  it("refuses another vocabulary, another state layout, an index outside the vocabulary and wrong lengths", () => {
    expect(() => flattenState(state({ vocabSha256: "d".repeat(64) }), layout)).toThrow(/vocabSha256/);
    expect(() => flattenState(state({ layoutSha256: "e".repeat(64) }), layout)).toThrow(/layoutSha256/);
    expect(() => flattenState(state({ hand: [V, ...new Array<number>(11).fill(0)] }), layout)).toThrow(/outside vocabulary/);
    expect(() => flattenState(state({ identity: { me: [10, V + 3], opp: [12, 13] } }), layout)).toThrow(/outside vocabulary/);
    expect(() => flattenState(state({ identity: { me: [10], opp: [12, 13] } }), layout)).toThrow(/identity/);
    expect(() => flattenState(state({ slots: { me: [slot()], opp: emptySide() } }), layout)).toThrow(/slots/);
    expect(() => flattenState(state({ scalars: [1] }), layout)).toThrow(/scalars/);
  });

  it("flattens a real encoded state from #124's fixture, identity included", () => {
    const vocab = buildVocab({
      dataVersion: "test.r1",
      buildHash: "a".repeat(64),
      cardsToonSha256: "b".repeat(64),
      engineCommit: "0000000",
      cards: ["0101001", "0101002", "0101003", "0101004", "0101005", "0101006", "0101030", "0101031"].map((cardKey) => ({ cardKey, type: "Unit", title: cardKey })),
      engineKeywords: ["sentinel", "raid", "overwhelm", "shielded"],
      parent: null,
    });
    const compiled = compileVocab(vocab);
    const encoded = encodeState(JSON.parse(readFileSync(path.join(HERE, "../fixtures/sims/state-views/basic.json"), "utf8")), compiled);
    const real = featureLayout(SCALAR_COUNT, U, vocab.keys.length + FIRST_CARD_INDEX, vocab.contentSha256);
    const f = flattenState(encoded, real);
    const rb = SCALAR_COUNT + 2 * U * P;
    const vs = vocab.keys.length + FIRST_CARD_INDEX;
    for (const [b, side] of [[6, "me"], [7, "opp"]] as const)
      for (let k = 0; k < IDENTITY_NAMES.length; k++) {
        const index = encoded.identity[side][k];
        if (index !== 0) expect(f.indices).toContain(rb + b * vs + index);
      }
    expect(f.indices.length).toBeGreaterThan(10);
  });
});

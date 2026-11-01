import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { canonicalJson, sha256Hex } from "../../src/swu/canonical.js";
import {
  encodeState,
  H,
  layoutSha256,
  SCALAR_COUNT,
  SCALAR_NAMES,
  SLOT_NAMES,
  STATE_LAYOUT,
  STATE_LAYOUT_SHA256,
  stateSha256,
  U,
} from "../../src/sims/state.js";
import { buildVocab, compileVocab } from "../../src/sims/vocab.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (): Record<string, any> => JSON.parse(readFileSync(path.join(HERE, "../fixtures/sims/state-views/basic.json"), "utf8"));
const vocab = compileVocab(
  buildVocab({
    dataVersion: "test.r1",
    buildHash: "a".repeat(64),
    cardsToonSha256: "b".repeat(64),
    engineCommit: "0000000",
    cards: [
      ...["0101001", "0101002", "0101003", "0101004", "0101005", "0101006", "0101030", "0101031"].map((cardKey) => ({
        cardKey,
        type: "Unit",
        title: cardKey,
      })),
      { cardKey: "04010t04", type: "Token Upgrade", title: "Shield" },
      { cardKey: "05010t02", type: "Token Upgrade", title: "Shield" },
    ],
    engineKeywords: ["sentinel", "raid", "overwhelm", "shielded"],
    parent: null,
  }),
);
const GOLDEN = "6e6ae667da4ac15150efe41c370fe0f5ec8399300fcb8a35d93b5302539cc134";

describe("encodeState", () => {
  it("encodes the fixture to the pinned golden hash, identically on two runs", () => {
    const first = encodeState(fixture(), vocab);
    const second = encodeState(fixture(), vocab);
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(stateSha256(first)).toBe(GOLDEN);
    expect(first.unknown).toBe(0);
    expect(first.unknownKeywords).toBe(0);
    const text = canonicalJson(first);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
    expect(Object.keys(first).filter((k) => /time|date|uuid|id$/i.test(k))).toEqual([]);
  });

  it("encodes both sides' base and leader identities; leader deployment stays in the scalars", () => {
    const encoded = encodeState(fixture(), vocab);
    expect(STATE_LAYOUT.identityNames).toEqual(["baseIndex", "leaderIndex"]);
    expect(encoded.identity).toEqual({ me: [9, 3], opp: [10, 8] });
    expect(encoded.scalars[SCALAR_NAMES.indexOf("opp_leaderDeployed")]).toBe(1);
    const view = fixture();
    view.opp.leader.cardKey = "9999998";
    const unknownLeader = encodeState(view, vocab);
    expect(unknownLeader.identity.opp[1]).toBe(1);
    expect(unknownLeader.unknown).toBe(1);
  });

  it("keeps the layout constants consistent", () => {
    expect(SCALAR_NAMES.length).toBe(SCALAR_COUNT);
    expect(layoutSha256()).toBe(STATE_LAYOUT_SHA256);
    const renamed = { ...STATE_LAYOUT, scalarNames: SCALAR_NAMES.map((n, i) => (i === 0 ? "turn" : n)) };
    expect(sha256Hex(canonicalJson(renamed))).not.toBe(STATE_LAYOUT_SHA256);
  });

  it("orders units canonically, not by input order", () => {
    const view = fixture();
    view.me.units.reverse();
    expect(stateSha256(encodeState(view, vocab))).toBe(GOLDEN);
  });

  it("refuses an opponent hand or library and a viewer without a hand", () => {
    const withHand = fixture();
    withHand.opp.hand = ["0101002"];
    expect(() => encodeState(withHand, vocab)).toThrow(ZodError);
    const withLibrary = fixture();
    withLibrary.opp.library = [{ cardKey: "0101002", count: 40 }];
    expect(() => encodeState(withLibrary, vocab)).toThrow(ZodError);
    const noHand = fixture();
    delete noHand.me.hand;
    expect(() => encodeState(noHand, vocab)).toThrow(ZodError);
  });

  it("refuses impossible numbers and empty card keys", () => {
    const zeroHp = fixture();
    zeroHp.me.units[0].hp = 0;
    expect(() => encodeState(zeroHp, vocab)).toThrow(ZodError);
    const negativeDamage = fixture();
    negativeDamage.me.units[0].damage = -1;
    expect(() => encodeState(negativeDamage, vocab)).toThrow(ZodError);
    const overReady = fixture();
    overReady.me.resourcesReady = 4;
    expect(() => encodeState(overReady, vocab)).toThrow(ZodError);
    const emptyKey = fixture();
    emptyKey.me.discard = [""];
    expect(() => encodeState(emptyKey, vocab)).toThrow(ZodError);
    const numberKey = fixture();
    numberKey.me.discard = [101004];
    expect(() => encodeState(numberKey, vocab)).toThrow(ZodError);
  });

  it("counts an unknown card and an unlisted keyword instead of throwing", () => {
    const view = fixture();
    view.opp.units[0].cardKey = "9999999";
    view.opp.units[0].keywords = ["bounty"];
    const encoded = encodeState(view, vocab);
    expect(encoded.unknown).toBe(1);
    expect(encoded.slots.opp[0][0]).toBe(1);
    expect(encoded.unknownKeywords).toBe(1);
    expect(encoded.slots.opp[0][SLOT_NAMES.indexOf("keywordMask")]).toBe(1);
  });

  it("caps a 40-unit side at U and counts the overflow", () => {
    const view = fixture();
    view.opp.units = Array.from({ length: 40 }, (_, i) => ({ ...view.opp.units[0], isLeaderUnit: false, power: i % 7 }));
    const encoded = encodeState(view, vocab);
    expect(encoded.overflow.opp).toBe(40 - U);
    expect(encoded.slots.opp).toHaveLength(U);
  });

  it("encodes a decision between phases (engine phase null) as an all-zero phase one-hot", () => {
    const view = fixture();
    view.phase = null;
    const encoded = encodeState(view, vocab);
    expect(encoded.scalars.slice(1, 4)).toEqual([0, 0, 0]);
    view.phase = "draw";
    expect(() => encodeState(view, vocab)).toThrow(ZodError);
  });

  it("caps the hand at H and counts the overflow", () => {
    const view = fixture();
    view.me.hand = Array.from({ length: H + 2 }, () => "0101002");
    view.me.handCount = H + 2;
    expect(encodeState(view, vocab).overflow.hand).toBe(2);
  });
});

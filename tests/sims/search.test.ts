import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { candidateMean, candidateOrder, LEAF_TERMINAL, pickScored, replyValue, terminalValue, untiedTop1 } from "../../scripts/sims/policy/search-core.js";
import { REPO_ROOT } from "../../src/paths.js";
import { parsePolicySpec, policyHeader, specName } from "../../src/sims/policies/index.js";
import { driverName } from "../../src/sims/policies/typed-adapter.js";
import { searchBlockSchema } from "../../src/sims/schemas.js";

const pinned = (file: string, side: "candidate" | "baseline" = "candidate"): string =>
  (JSON.parse(readFileSync(path.join(REPO_ROOT, "data/pinned/sim-ladder-v1", file), "utf8")) as Record<string, { paramsSha256: string }>)[side].paramsSha256;

describe("learned rung names (#128)", () => {
  it("rung3v and rung4 have canonical names that always state k, ev (and d, m at rung 4)", () => {
    expect(driverName("rung3v")).toBe("rung3v:k=8,ev=v1");
    expect(driverName("rung3v:k=8,ev=v1")).toBe("rung3v:k=8,ev=v1");
    expect(driverName("rung3v:k=5")).toBe("rung3v:k=5,ev=v1");
    expect(driverName("rung4")).toBe("rung4:d=3,k=5,m=2,ev=v1");
    expect(driverName("rung4:k=3,m=1,d=3,ev=v1")).toBe("rung4:d=3,k=3,m=1,ev=v1");
    expect(specName(parsePolicySpec("rung3v:stub=1"))).toBe("rung3v:k=8,ev=v1,stub=1");
    expect(driverName("rung3v:horizon=round")).toBe("rung3v:k=8,ev=v1,horizon=round");
    expect(driverName("rung3v:noPass=1,horizon=round")).toBe("rung3v:k=8,ev=v1,horizon=round,noPass=1");
    expect(policyHeader(parsePolicySpec("rung3v:horizon=reply")).paramsSha256).toBe(policyHeader(parsePolicySpec("rung3v")).paramsSha256);
    expect(policyHeader(parsePolicySpec("rung3v:horizon=round")).paramsSha256).not.toBe(policyHeader(parsePolicySpec("rung3v")).paramsSha256);
    const h3 = policyHeader(parsePolicySpec("rung3v"));
    expect(h3).toMatchObject({ id: "rung3-value", rung: 3, version: "1" });
    expect(h3.params).toMatchObject({ sacGuard: 1, handCap: 1, d: 1, m: 0 });
    expect(policyHeader(parsePolicySpec("rung4")).rung).toBe(4);
  });

  it("refuses rung 4 below two determinizations or without a reply, and rung 3 with determinizations", () => {
    expect(() => parsePolicySpec("rung4:d=1")).toThrow(/at least 2 determinizations/);
    expect(() => parsePolicySpec("rung4:m=0")).toThrow(/at least 1 reply/);
    expect(() => parsePolicySpec("rung3v:d=2")).toThrow(/true state/);
    expect(() => parsePolicySpec("rung3v:ev=1")).toThrow(/bad policy parameter/);
  });

  it("leaves every existing name, params hash and pinned record identity unchanged", () => {
    expect(policyHeader(parsePolicySpec("rung3:k=8")).paramsSha256).toBe(pinned("rung3-vs-rung1.json"));
    expect(policyHeader(parsePolicySpec("rung1")).paramsSha256).toBe(pinned("rung3-vs-rung1.json", "baseline"));
    expect(policyHeader(parsePolicySpec("rung1:sacGuard=1,handCap=1")).paramsSha256).toBe(pinned("rung1-pilot-vs-rung0.json"));
    expect(policyHeader(parsePolicySpec("rung3:k=8,sacGuard=1,handCap=1")).paramsSha256).toBe(pinned("rung3-pilot-vs-rung1.json"));
    expect(policyHeader(parsePolicySpec("rung0")).paramsSha256).toBe(pinned("rung3-vs-rung0.json", "baseline"));
    expect(driverName("rung3:k=8")).toBe("rung3:k=8");
  });
});

describe("search block schema (#128)", () => {
  const block = (over: Record<string, unknown>) => ({ rung: 3, mode: "none", determinizations: 1, replies: 0, candidates: [{ descriptor: "pass", rank: 0, values: [0.5], mean: 0.5, fallback: null }], chosen: "pass", ...over });
  it("accepts a rung 3 block and a rung 4 block with two determinizations", () => {
    expect(searchBlockSchema.safeParse(block({})).success).toBe(true);
    expect(searchBlockSchema.safeParse(block({ rung: 4, mode: "multiset", determinizations: 2, replies: 2, candidates: [{ descriptor: "pass", rank: 0, values: [0.5, null], mean: 0.5, fallback: null }] })).success).toBe(true);
  });
  it("refuses rung 4 with fewer than 2 determinizations and rung 3 with a determinization mode", () => {
    expect(searchBlockSchema.safeParse(block({ rung: 4, mode: "multiset" })).success).toBe(false);
    expect(searchBlockSchema.safeParse(block({ mode: "multiset" })).success).toBe(false);
    expect(searchBlockSchema.safeParse(block({ chosen: "attack" })).success).toBe(false);
    expect(searchBlockSchema.safeParse(block({ candidates: [{ descriptor: "pass", rank: 0, values: [0.5, 1], mean: 0.75, fallback: null }] })).success).toBe(false);
  });
});

describe("search core (#128)", () => {
  it("terminal leaves score plus or minus 20 for the actor, a draw 0", () => {
    expect(LEAF_TERMINAL).toBe(20);
    expect(terminalValue("won")).toBe(20);
    expect(terminalValue("lost")).toBe(-20);
    expect(terminalValue("draw")).toBe(0);
  });

  it("a reply value is the minimum of the rounded leaves; a mean is taken over rounded values and rounded again", () => {
    expect(replyValue([0.123449, -0.5, null])).toBe(-0.5);
    expect(replyValue([null, null])).toBeNull();
    expect(replyValue([0.333333333])).toBe(0.3333);
    expect(candidateMean([0.33334, 0.33334, 0.33334])).toBe(0.3333);
    expect(candidateMean([1, null, 2])).toBe(1.5);
    expect(candidateMean([null])).toBeNull();
  });

  it("picks the highest mean, ties by rank then descriptor, never a failed candidate while another scored", () => {
    const c = (descriptor: string, rank: number, mean: number | null) => ({ index: rank, descriptor, rank, values: [mean], mean, fallback: null });
    expect(pickScored([c("a", 0, 0.1), c("b", 1, 0.2)]).descriptor).toBe("b");
    expect(pickScored([c("b", 1, 0.2), c("a", 0, 0.2)]).descriptor).toBe("a");
    expect(pickScored([c("a", 0, null), c("b", 1, -5)]).descriptor).toBe("b");
    expect(pickScored([c("b", 1, null), c("a", 0, null)]).descriptor).toBe("a");
  });

  it("candidates are the ranking's top k plus Pass and Claim Initiative when legal, never a cancelled answer", () => {
    const kinds = ["play", "play", "pass", "takeInitiative", "attack"];
    expect(candidateOrder([1, 0], kinds, new Set())).toEqual([1, 0, 2, 3]);
    expect(candidateOrder([2, 1], kinds, new Set([3]))).toEqual([2, 1]);
    expect(candidateOrder([0, 4], kinds, new Set([4]))).toEqual([0, 2, 3]);
    expect(candidateOrder([1, 2, 0], kinds, new Set(), true)).toEqual([1, 0, 3]);
    expect(candidateOrder([2, 1], kinds, new Set(), true)).toEqual([2, 1, 3]);
  });

  it("untied top-1 counts only decisions with one best label, and compares the model's argmax with the constant's first action", () => {
    const r = untiedTop1([
      { pred: [0.1, 0.9, 0.3], label: [0.2, 0.8, 0.5] },
      { pred: [0.9, 0.1], label: [0.5, 0.5] },
      { pred: [0.2, 0.1], label: [0.9, 0.1] },
      { pred: [0.1, 0.2], label: [0.9, 0.1] },
    ]);
    expect(r).toMatchObject({ decisions: 4, untied: 3, model: 2, constant: 2, modelOnly: 1, constantOnly: 1 });
  });
});

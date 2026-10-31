import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { createSynergyContext } from "../../src/synergy/context.js";
import { engineHitOf, leaderEngineOf } from "../../src/synergy/leader-engine.js";
import type { ToolResult } from "../../src/tools.js";
import { findPairings } from "../../src/tools/synergy.js";
import { COMMITTED_TABLE, mk } from "./fixtures.js";

const body = (result: ToolResult): Record<string, any> => {
  expect(result.isError, result.content[0].text).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
};

const GRANT = "Play a unit with 3 or less power from your hand and give it Ambush for this phase.";
const leader = mk("LD", "Ambush Leader", {
  type: "Leader",
  icons: ["Command", "Heroism"],
  offers: ["offers:grant-ambush"],
  why: { "offers:grant-ambush": `text: ${GRANT}` },
  abilities: [
    {
      repeat: "action",
      text: GRANT,
      effect: { cat: "play", rule: "play_from", what: "a unit with 3 or less power from your hand" } as never,
    },
    { repeat: "action", text: GRANT, effect: { cat: "grant_keyword", rule: "give_keyword", keywords: [{ keyword: "Ambush" }] } as never },
  ],
});
const copier = mk("CP", "Keyword Copier", {
  aspects: ["Command"],
  cost: 3,
  power: 4,
  wants: ["wants:keyword-ambush"],
  why: { "wants:keyword-ambush": "text: This unit gains Ambush while another friendly unit has it." },
  abilities: [{ repeat: "constant", text: "This unit gains Ambush while another friendly unit has it." }],
});

describe("a keyword the leader grants feeds a partner that wants holders of it (D67)", () => {
  const engine = leaderEngineOf(leader);

  it("reads the leader's grant and plays limit", () => {
    expect(engine?.grantsKeywords).toEqual(["Ambush"]);
  });

  it("is the grants-held-keyword hit when the partner holds wants:keyword-<k> and its text does not name the friendly unit with the keyword", () => {
    const hit = engineHitOf(engine, copier);
    expect(hit).toMatchObject({ kind: "grants-held-keyword", keyword: "Ambush", partnerText: "This unit gains Ambush while another friendly unit has it." });
    expect(hit?.how).toContain("Ambush holder");
  });

  it("does not fire for another keyword's want or a card with no keyword want", () => {
    const other = mk("OT", "Grit Copier", { aspects: ["Command"], cost: 3, power: 4, wants: ["wants:keyword-grit"] });
    expect(engineHitOf(engine, other)?.kind).not.toBe("grants-held-keyword");
    expect(engineHitOf(engine, mk("PL", "Plain", { aspects: ["Command"], cost: 3, power: 9 }))).toBeNull();
  });

  const ctx = createSynergyContext([leader, copier], COMMITTED_TABLE);

  it("needs the graph to hold the leader's own grant as an edge to the copier (the post-#155 shape)", () => {
    const edge = ctx.graph.edgeByKey.get("LD>CP");
    expect(edge?.rows.map((r) => `${r.offer} -> ${r.want}`)).toContain("offers:grant-ambush -> wants:keyword-ambush");
  });

  it("lists the copier once, as a leader-engine row quoting both clauses, when the leader's grant is the only edge", () => {
    const rows = body(findPairings(ctx, { cardKey: "LD", leader: "LD", limit: 20, perLink: 20 })).pairings.filter((r: any) => r.cardKey === "CP");
    expect(rows).toHaveLength(1);
    expect(rows[0].linkKind).toBe("leader-engine");
    expect(rows[0].link).toBe("leader:grant-ambush -> wants:keyword-ambush");
    expect(rows[0].reason).toContain(GRANT);
    expect(rows[0].reason).toContain("This unit gains Ambush while another friendly unit has it.");
    const none = body(findPairings(ctx, { cardKey: "LD", leader: "LD", weighting: "none", limit: 20, perLink: 20 })).pairings.filter((r: any) => r.cardKey === "CP");
    expect(none.map((r: any) => r.linkKind)).toEqual(["leader-engine"]);
  });

  it("keeps the edge a graph row when the subject is the copier, so only the leader as subject takes the engine reading", () => {
    const rows = body(findPairings(ctx, { cardKey: "CP", includeLeaders: true, aspects: ["Command", "Heroism"], limit: 20, perLink: 20 })).pairings.filter((r: any) => r.cardKey === "LD");
    expect(rows.map((r: any) => r.linkKind)).toEqual(["mechanical"]);
  });
});

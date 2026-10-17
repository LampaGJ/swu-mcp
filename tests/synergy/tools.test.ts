import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { decode } from "@toon-format/toon";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createServer } from "../../src/create-server.js";
import { loadStore } from "../../src/data.js";
import { createSynergyContext } from "../../src/synergy/context.js";
import { aspectCover, explainSynergy, findPairings, findTrios, fungibleSubstitutes, SYNERGY_TOOLS } from "../../src/tools/synergy.js";
import type { ToolResult } from "../../src/tools.js";
import { COMMITTED_TABLE, mk, table } from "./fixtures.js";

const unit = (key: string, title: string, aspects: string[], cost: number, extra: Record<string, unknown> = {}) =>
  mk(key, title, { aspects, cost, abilities: [{ repeat: "once_on_play", text: `${title} text`, n: 1 }], ...extra });

const cards = [
  mk("L1", "Aggro Leader", { type: "Leader", icons: ["Aggression", "Villainy"] }),
  mk("L2", "Green Leader", { type: "Leader", icons: ["Command", "Heroism"] }),
  mk("BC", "Command Base", { type: "Base", icons: ["Command"] }),
  mk("BV", "Vigilance Base", { type: "Base", icons: ["Vigilance"] }),
  unit("1", "Death Trooper", ["Vigilance", "Villainy"], 3, {
    offers: ["offers:damage-friendly-unit"],
    why: { "offers:damage-friendly-unit": "text: Death Trooper text" },
  }),
  unit("2", "Pinger Red", ["Aggression"], 3, {
    offers: ["offers:damage-friendly-unit"],
    why: { "offers:damage-friendly-unit": "text: Pinger Red text" },
  }),
  unit("3", "Pinger Green", ["Command"], 3, {
    offers: ["offers:damage-friendly-unit"],
    why: { "offers:damage-friendly-unit": "text: Pinger Green text" },
  }),
  unit("4", "The Elite Squad", ["Aggression", "Villainy"], 8, { wants: ["wants:damage-friendly"] }),
  unit("5", "Grit Brute", ["Aggression"], 3, { wants: ["wants:self-damaged"], offers: ["offers:draw"] }),
  unit("6", "Draw Payoff", ["Command"], 2, { wants: ["wants:draw"] }),
];

const ctx = createSynergyContext(cards, COMMITTED_TABLE);

function body(result: ToolResult): Record<string, any> {
  expect(result.isError).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

describe("fungible_substitutes", () => {
  it("lists substitutes for the slot's role, grouped by aspect", () => {
    const out = body(fungibleSubstitutes(ctx, { cardKey: "1", tag: "offers:damage-friendly-unit" }));
    expect(out.roles).toHaveLength(1);
    const role = out.roles[0];
    expect(role.classSize).toBe(3);
    expect(role.substitutes.map((g: any) => g.aspects)).toEqual(["Aggression", "Command"]);
    expect(role.substitutes.every((g: any) => g.differsFromSlot)).toBe(true);
  });

  it("puts aspects the deck covers first", () => {
    const out = body(fungibleSubstitutes(ctx, { cardKey: "1", tag: "offers:damage-friendly-unit", preferAspects: ["Command"] }));
    expect(out.roles[0].substitutes[0]).toMatchObject({ aspects: "Command", covered: true });
  });

  it("reports every role when no tag is given, and errors on an unknown card or tag", () => {
    expect(body(fungibleSubstitutes(ctx, { cardKey: "5" })).roles.map((r: any) => r.tag)).toEqual(["offers:draw", "wants:self-damaged"]);
    expect(fungibleSubstitutes(ctx, { cardKey: "nope" }).isError).toBe(true);
    expect(fungibleSubstitutes(ctx, { cardKey: "1", tag: "offers:heal" }).isError).toBe(true);
  });
});

describe("find_pairings", () => {
  it("finds payoffs and enablers with reason, score and penalty", () => {
    const out = body(findPairings(ctx, { cardKey: "1" }));
    const partners = out.pairings.map((p: any) => p.cardKey);
    expect(partners).toEqual(expect.arrayContaining(["4", "5"]));
    const squad = out.pairings.find((p: any) => p.cardKey === "4");
    expect(squad).toMatchObject({ partnerIs: "payoff", link: "offers:damage-friendly-unit -> wants:damage-friendly" });
    expect(squad.reason).toContain("Damaging your own unit");
    expect(squad.score).toBeGreaterThan(0);
    expect(typeof squad.penalty).toBe("number");
  });

  it("filters by direction, maxCost and trait-only links", () => {
    expect(body(findPairings(ctx, { cardKey: "4", direction: "payoffs" })).pairings).toEqual([]);
    const enablers = body(findPairings(ctx, { cardKey: "4", direction: "enablers" }));
    expect(enablers.pairings.every((p: any) => p.partnerIs === "enabler")).toBe(true);
    expect(body(findPairings(ctx, { cardKey: "1", maxCost: 2 })).pairings).toEqual([]);
  });

  it("measures the penalty against the aspects given and ranks covered partners higher", () => {
    const out = body(findPairings(ctx, { cardKey: "1", aspects: ["Aggression", "Villainy"] }));
    const grit = out.pairings.find((p: any) => p.cardKey === "5");
    expect(grit.penalty).toBe(2);
    expect(grit.rank).toBeLessThan(grit.score);
    const squad = out.pairings.find((p: any) => p.cardKey === "4");
    expect(squad.penalty).toBe(2);
  });

  it("lists the partner slot's alternatives by aspect", () => {
    const out = body(findPairings(ctx, { cardKey: "4", direction: "enablers" }));
    const trooper = out.pairings.find((p: any) => p.cardKey === "1");
    expect(trooper.alternatives.join(" ")).toContain("Pinger Red");
    expect(trooper.alternatives.join(" ")).toContain("Pinger Green");
    expect(
      body(findPairings(ctx, { cardKey: "4", direction: "enablers", withAlternatives: false })).pairings[0].alternatives,
    ).toBeUndefined();
  });

  it("rejects an unknown card", () => {
    expect(findPairings(ctx, { cardKey: "nope" }).isError).toBe(true);
  });
});

describe("find_trios", () => {
  const chainCtx = createSynergyContext(
    [
      mk("L", "Leader", { type: "Leader", icons: ["Command", "Heroism"] }),
      mk("Z", "Base", { type: "Base", icons: ["Command"] }),
      mk("1", "Alpha", { offers: ["offers:x"], aspects: ["Command"], cost: 2 }),
      mk("1b", "Alpha Twin", { offers: ["offers:x"], aspects: ["Cunning"], cost: 2 }),
      mk("2", "Bravo", { wants: ["wants:x"], offers: ["offers:y"], aspects: ["Command"], cost: 3 }),
      mk("3", "Charlie", { wants: ["wants:y"], aspects: ["Command"], cost: 9 }),
      mk("4", "Delta", { wants: ["wants:y"], aspects: ["Command"], cost: 1 }),
    ],
    table([
      { id: "r1", offers: { "offers:x": 1 }, wants: { "wants:x": 1 } },
      { id: "r2", offers: { "offers:y": 1 }, wants: { "wants:y": 1 } },
    ]),
  );

  it("returns ranked trios with cost, aspect pair, penalty and per-slot alternatives", () => {
    const out = body(findTrios(chainCtx, {}));
    expect(out.trios[0]).toMatchObject({ shape: "chain", cardKeys: "1|2|4", totalCost: 6, penalty: 0 });
    expect(out.trios[0].aspectPair).toBe("leader Command+Heroism / base Command");
    const slotA = out.trios[0].alternatives[0];
    expect(slotA).toMatchObject({ slot: "A", roles: "offers:x" });
    expect(slotA.substitutes.join(" ")).toContain("Alpha Twin");
  });

  it("caps total cost (default 9) and filters by card and shape", () => {
    const out = body(findTrios(chainCtx, {}));
    expect(out.trios.every((t: any) => t.totalCost <= 9)).toBe(true);
    expect(out.trios.map((t: any) => t.cardKeys)).not.toContain("1|2|3");
    const wide = body(findTrios(chainCtx, { maxTotalCost: 20 }));
    expect(wide.trios.map((t: any) => t.cardKeys)).toContain("1|2|3");
    expect(body(findTrios(chainCtx, { cardKey: "4" })).trios.every((t: any) => t.cardKeys.split("|").includes("4"))).toBe(true);
    expect(findTrios(chainCtx, { shape: "loop" }).content[0].text).toContain("shown: 0");
  });

  it("measures the penalty against a fixed leader and base", () => {
    const out = body(findTrios(chainCtx, { leaderAspects: ["Aggression", "Villainy"], baseAspects: ["Vigilance"] }));
    expect(out.trios[0].penalty).toBe(6);
    expect(out.trios[0].aspectPair).toBe("leader Aggression+Villainy / base Vigilance");
  });

  it("rejects an unknown card", () => {
    expect(findTrios(chainCtx, { cardKey: "nope" }).isError).toBe(true);
  });
});

describe("explain_synergy", () => {
  it("explains a link with rows, tags, the text behind each tag and the non-obviousness terms", () => {
    const out = body(explainSynergy(ctx, { cardKeys: ["1", "4"] }));
    expect(out.links).toHaveLength(1);
    expect(out.links[0]).toMatchObject({ from: "Death Trooper", to: "The Elite Squad", differentAspects: true });
    expect(out.links[0].rows[0]).toMatchObject({
      row: "ping-own-damage-payoff",
      offer: "offers:damage-friendly-unit",
      want: "wants:damage-friendly",
    });
    expect(out.evidence.map((e: any) => e.tag)).toEqual(["offers:damage-friendly-unit", "wants:damage-friendly"]);
    expect(out.totalCost).toBe(11);
  });

  it("names pairs with no link, and checks the keys", () => {
    const out = body(explainSynergy(ctx, { cardKeys: ["1", "4", "6"] }));
    expect(out.noLink).toEqual(expect.arrayContaining(["Death Trooper / Draw Payoff"]));
    expect(explainSynergy(ctx, { cardKeys: ["1", "1"] }).isError).toBe(true);
    expect(explainSynergy(ctx, { cardKeys: ["1", "nope"] }).isError).toBe(true);
    expect(() => explainSynergy(ctx, { cardKeys: ["1"] })).toThrow();
  });
});

describe("aspect_cover", () => {
  it("ranks leader and base combinations cheapest first with the arithmetic", () => {
    const out = body(aspectCover(ctx, { cardKeys: ["2", "3"] }));
    expect(out.combinations).toBe(4);
    expect(out.combos[0].penalty).toBe(0);
    const penalties = out.combos.map((c: any) => c.penalty);
    expect(penalties).toEqual([...penalties].sort((a, b) => a - b));
    expect(out.best.combo).toBe("leader Aggression+Villainy / base Command");
    const worst = body(aspectCover(ctx, { cardKeys: ["2", "3"], limit: 100 })).combos.at(-1);
    expect(worst.penalty).toBe(2);
  });

  it("tests one fixed combination and lists the uncovered icons per card", () => {
    const out = body(aspectCover(ctx, { cardKeys: ["2", "3", "5"], leaderAspects: ["Command", "Heroism"], baseAspects: ["Command"] }));
    expect(out.combinations).toBe(1);
    expect(out.best.penalty).toBe(4);
    expect(out.best.uncovered.map((u: any) => [u.card, u.icons])).toEqual([
      ["Pinger Red", "Aggression"],
      ["Grit Brute", "Aggression"],
    ]);
  });

  it("counts penalty-free combinations and rejects unknown cards", () => {
    expect(body(aspectCover(ctx, { cardKeys: ["6"] })).penaltyFree).toBe(3);
    expect(aspectCover(ctx, { cardKeys: ["nope"] }).isError).toBe(true);
  });
});

describe("registration", () => {
  const store = loadStore(path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures"));

  it("exposes the five tools through the server", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([createServer(store).connect(serverSide), client.connect(clientSide)]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of Object.keys(SYNERGY_TOOLS)) expect(names).toContain(name);
    await client.close();
  });

  it("reports a missing feature file as a tool error that names the fix", () => {
    const bare = { ...store, dataDir: path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures-missing/llm") };
    const result = SYNERGY_TOOLS.aspect_cover.handler(bare, { cardKeys: ["0101033"] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("pnpm card-features");
  });
});

describe("candidate evidence", () => {
  const long = "x".repeat(300);
  const evCtx = createSynergyContext(
    [
      mk("L", "Leader", { type: "Leader", icons: ["Command", "Heroism"] }),
      mk("Z", "Base", { type: "Base", icons: ["Command"] }),
      mk("1", "Alpha", { offers: ["offers:x"], aspects: ["Command"], cost: 2, why: { "offers:x": `text: Alpha pings ${long}` } }),
      mk("1b", "Alpha Twin", { offers: ["offers:x"], aspects: ["Cunning"], cost: 2, why: { "offers:x": "text: Twin pings" } }),
      mk("2", "Bravo", {
        wants: ["wants:x"],
        offers: ["offers:y"],
        aspects: ["Command"],
        cost: 3,
        why: { "wants:x": "text: Bravo wants pings", "offers:y": "text: Bravo gives y" },
      }),
      mk("4", "Delta", { wants: ["wants:y"], aspects: ["Command"], cost: 1, why: { "wants:y": "text: Delta wants y" } }),
    ],
    table([
      { id: "r1", offers: { "offers:x": 1 }, wants: { "wants:x": 1 } },
      { id: "r2", offers: { "offers:y": 1 }, wants: { "wants:y": 1 } },
    ]),
  );

  it("find_pairings returns status candidate and the clause text of both cards, clipped to 160 characters", () => {
    const row = body(findPairings(evCtx, { cardKey: "2", direction: "enablers" })).pairings.find((p: any) => p.cardKey === "1");
    expect(row.status).toBe("candidate");
    expect(row.evidence).toHaveLength(1);
    expect(row.evidence[0].want).toBe("text: Bravo wants pings");
    expect(row.evidence[0].offer.length).toBe(160);
    expect(row.evidence[0].offer.endsWith("…")).toBe(true);
    expect(row.evidence[0].offer.startsWith("text: Alpha pings")).toBe(true);
  });

  it("find_pairings leaves evidence out on request but keeps the status", () => {
    const row = body(findPairings(evCtx, { cardKey: "2", direction: "enablers", evidence: false })).pairings[0];
    expect(row.evidence).toBeUndefined();
    expect(row.status).toBe("candidate");
  });

  it("find_trios carries each link's clause texts", () => {
    const trio = body(findTrios(evCtx, {})).trios[0];
    expect(trio.status).toBe("candidate");
    expect(trio.evidence.map((e: any) => [e.link, e.want])).toEqual([
      ["Alpha > Bravo", "text: Bravo wants pings"],
      ["Bravo > Delta", "text: Delta wants y"],
    ]);
    expect(trio.evidence[1].offer).toBe("text: Bravo gives y");
    expect(body(findTrios(evCtx, { evidence: false })).trios[0].evidence).toBeUndefined();
  });

  it("explain_synergy clips the tag text, adds the status and honours evidence:false", () => {
    const out = body(explainSynergy(evCtx, { cardKeys: ["1", "2"] }));
    expect(out.status).toBe("candidate");
    expect(out.evidence.find((e: any) => e.tag === "offers:x").why.length).toBe(160);
    const bare = body(explainSynergy(evCtx, { cardKeys: ["1", "2"], evidence: false }));
    expect(bare.evidence).toBeUndefined();
    expect(bare.status).toBe("candidate");
  });

  it("fungible_substitutes shows the role clause of the slot card and of each substitute", () => {
    const out = body(fungibleSubstitutes(evCtx, { cardKey: "1", tag: "offers:x" }));
    expect(out.status).toBe("candidate");
    const role = out.roles[0];
    expect(role.slotText.length).toBe(160);
    expect(role.substitutes[0].cards[0]).toMatchObject({ cardKey: "1b", text: "text: Twin pings" });
    const bare = body(fungibleSubstitutes(evCtx, { cardKey: "1", tag: "offers:x", evidence: false }));
    expect(bare.roles[0].slotText).toBeUndefined();
    expect(bare.roles[0].substitutes[0].cards[0].text).toBeUndefined();
  });

  it("describes the candidate status in the four tool descriptions", () => {
    for (const name of ["find_pairings", "find_trios", "explain_synergy", "fungible_substitutes"] as const)
      expect(SYNERGY_TOOLS[name].description).toContain("candidate");
  });
});

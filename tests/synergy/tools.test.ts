import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { decode } from "@toon-format/toon";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createServer } from "../../src/create-server.js";
import { loadStore } from "../../src/data.js";
import { createSynergyContext, DEFAULT_CURATED_PATH, loadCuratedClauses } from "../../src/synergy/context.js";
import { aspectCover, deferRepeatedLinks, explainSynergy, findPairings, findTrios, fungibleSubstitutes, SYNERGY_TOOLS } from "../../src/tools/synergy.js";
import { offerTargetSide } from "../../src/synergy/qualifiers.js";
import type { SynergyCard } from "../../src/synergy/schema.js";
import { indexLeaderCards } from "../../src/meta/schema.js";
import { LEADER_INCLUSION_FLOOR } from "../../src/tools/deck.js";
import { synergyCardsSchema } from "../../src/synergy/schema.js";
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

describe("find_pairings perLink", () => {
  const linkCtx = createSynergyContext(
    [
      mk("L", "Leader", { type: "Leader", icons: ["Command", "Heroism"] }),
      mk("Z", "Base", { type: "Base", icons: ["Command"] }),
      mk("F", "Focus", { offers: ["offers:x", "offers:y"], aspects: ["Command"], cost: 2 }),
      ...["A1", "A2", "A3", "A4"].map((k) => mk(k, `Payoff ${k}`, { wants: ["wants:x"], aspects: ["Command"], cost: 2 })),
      ...["B1", "B2", "B3"].map((k) => mk(k, `Payoff ${k}`, { wants: ["wants:y"], aspects: ["Command"], cost: 2 })),
    ],
    table([
      { id: "rx", offers: { "offers:x": 1 }, wants: { "wants:x": 1 }, strength: 3 },
      { id: "ry", offers: { "offers:y": 1 }, wants: { "wants:y": 1 }, strength: 1 },
    ]),
  );
  const keys = (out: Record<string, any>) => out.pairings.map((p: any) => p.cardKey);
  const args = { cardKey: "F", withAlternatives: false, evidence: false, limit: 100 };

  it("ranks the stronger link first with no cap (perLink 100)", () => {
    const out = body(findPairings(linkCtx, { ...args, perLink: 100 }));
    expect(keys(out)).toEqual(["A1", "A2", "A3", "A4", "B1", "B2", "B3"]);
    expect(out).toMatchObject({ total: 7, shown: 7, capped: 0 });
    expect(out.note).toBeUndefined();
  });

  it("lists at most perLink rows per link first, then the deferred tail in rank order", () => {
    const out = body(findPairings(linkCtx, { ...args, perLink: 2 }));
    expect(keys(out)).toEqual(["A1", "A2", "B1", "B2", "A3", "A4", "B3"]);
    expect(out).toMatchObject({ total: 7, shown: 7, capped: 3 });
    expect(out.note).toContain("perLink 2");
    expect(out.note).toContain("3 further rows");
  });

  it("defaults to 3 rows per link and keeps deferred rows reachable by limit", () => {
    const out = body(findPairings(linkCtx, { ...args, limit: 5 }));
    expect(keys(out)).toEqual(["A1", "A2", "A3", "B1", "B2"]);
    expect(out).toMatchObject({ total: 7, shown: 5, capped: 1 });
  });

  it("matches the uncapped output when no link repeats more than perLink times", () => {
    const capped = body(findPairings(linkCtx, { ...args, perLink: 4 }));
    const open = body(findPairings(linkCtx, { ...args, perLink: 100 }));
    expect(capped.pairings).toEqual(open.pairings);
    expect(capped.capped).toBe(0);
  });

  it("rejects perLink outside 1-100", () => {
    expect(() => findPairings(linkCtx, { ...args, perLink: 0 })).toThrow();
    expect(() => findPairings(linkCtx, { ...args, perLink: 101 })).toThrow();
  });
});

describe("deferRepeatedLinks", () => {
  const rows = [
    { id: 1, link: "a" },
    { id: 2, link: "a" },
    { id: 3, link: "a" },
    { id: 4, link: "b" },
    { id: 5, link: "a" },
    { id: 6, link: "b" },
  ];

  it("keeps the first perLink rows of each link, then the deferred rows, each in input order", () => {
    const out = deferRepeatedLinks(rows, (r) => r.link, 2);
    expect(out.ordered.map((r) => r.id)).toEqual([1, 2, 4, 6, 3, 5]);
    expect(out.deferred).toBe(2);
  });

  it("returns the input order when the cap is never reached", () => {
    const out = deferRepeatedLinks(rows, (r) => r.link, 100);
    expect(out.ordered).toEqual(rows);
    expect(out.deferred).toBe(0);
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
    const wide = body(findTrios(chainCtx, { maxTotalCost: 20, cardKey: "3" }));
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

describe("leader and base partners", () => {
  const lbCtx = createSynergyContext(
    [
      mk("L", "Cover Leader", { type: "Leader", icons: ["Command", "Heroism"] }),
      mk("Z", "Cover Base", { type: "Base", icons: ["Command"] }),
      mk("LX", "Feeding Leader", { type: "Leader", aspects: ["Command"], cost: 1, offers: ["offers:x"] }),
      mk("BX", "Wanting Base", { type: "Base", aspects: ["Command"], cost: 0, wants: ["wants:y"] }),
      mk("1", "Alpha", { offers: ["offers:x"], aspects: ["Command"], cost: 2 }),
      mk("2", "Bravo", { wants: ["wants:x"], offers: ["offers:y"], aspects: ["Command"], cost: 3 }),
      mk("4", "Delta", { wants: ["wants:y"], aspects: ["Command"], cost: 1 }),
    ],
    table([
      { id: "r1", offers: { "offers:x": 1 }, wants: { "wants:x": 1 } },
      { id: "r2", offers: { "offers:y": 1 }, wants: { "wants:y": 1 } },
    ]),
  );
  const pairKeys = (out: Record<string, any>) => out.pairings.map((p: any) => p.cardKey).sort();

  it("find_pairings leaves Leader and Base partners out by default and says so", () => {
    const enablers = body(findPairings(lbCtx, { cardKey: "2", direction: "enablers", withAlternatives: false }));
    expect(pairKeys(enablers)).toEqual(["1"]);
    expect(enablers.partnerFilter).toContain("Leader and Base");
    expect(enablers.partnerFilter).toContain("includeLeaders");
    const payoffs = body(findPairings(lbCtx, { cardKey: "2", direction: "payoffs", withAlternatives: false }));
    expect(pairKeys(payoffs)).toEqual(["4"]);
    expect(body(findPairings(lbCtx, { cardKey: "2", withAlternatives: false })).total).toBe(2);
  });

  it("find_pairings lists them when includeLeaders is true", () => {
    const out = body(findPairings(lbCtx, { cardKey: "2", includeLeaders: true, withAlternatives: false }));
    expect(pairKeys(out)).toEqual(["1", "4", "BX", "LX"]);
    expect(out.partnerFilter).toContain("included");
    expect(out.pairings.find((p: any) => p.cardKey === "LX")).toMatchObject({ type: "Leader", partnerIs: "enabler" });
  });

  it("find_pairings from a Leader still lists its Unit partners", () => {
    const out = body(findPairings(lbCtx, { cardKey: "LX", withAlternatives: false }));
    expect(pairKeys(out)).toEqual(["2"]);
  });

  it("find_pairings keeps Leader and Base cards out of the partner alternatives", () => {
    const out = body(findPairings(lbCtx, { cardKey: "2", direction: "enablers" }));
    expect(out.pairings[0].alternatives.join(" ")).not.toContain("Feeding Leader");
  });

  it("find_trios never builds a trio around a Leader or Base unless includeLeaders is true", () => {
    const hasLeader = (out: Record<string, any>) => out.trios.some((t: any) => /LX|BX/.test(t.cardKeys));
    const out = body(findTrios(lbCtx, {}));
    expect(out.trios.length).toBeGreaterThan(0);
    expect(hasLeader(out)).toBe(false);
    expect(out.partnerFilter).toContain("Leader and Base");
    const open = body(findTrios(lbCtx, { includeLeaders: true }));
    expect(hasLeader(open)).toBe(true);
    expect(open.partnerFilter).toContain("included");
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

describe("fungible_substitutes widening", () => {
  const lone = (key: string, title: string, cost: number, n: number, extra: Record<string, unknown> = {}) =>
    mk(key, title, {
      cost,
      aspects: ["Command"],
      arenas: ["Ground"],
      wants: ["wants:self-damaged"],
      why: { "wants:self-damaged": `text: ${title} wants` },
      abilities: [{ repeat: "static", text: `${title} wants`, n }],
      ...extra,
    });
  const wideCtx = createSynergyContext(
    [
      lone("slot", "Lone Slot", 3, 1),
      lone("near", "Next Band", 5, 1, { aspects: ["Aggression"] }),
      lone("big", "Bigger", 5, 3, { aspects: ["Cunning"] }),
      lone("space", "Other Arena", 4, 1, { arenas: ["Space"] }),
    ],
    COMMITTED_TABLE,
  );

  it("reports widened: 'cost band' and tags the substitutes found that way", () => {
    const out = body(fungibleSubstitutes(wideCtx, { cardKey: "slot", tag: "wants:self-damaged", evidence: false }));
    const role = out.roles[0];
    expect(role.classSize).toBe(1);
    expect(role.widened).toBe("cost band");
    const cards = role.substitutes.flatMap((g: any) => g.cards);
    expect(cards.map((c: any) => c.cardKey)).toEqual(["near"]);
    expect(cards.every((c: any) => c.match === "widened")).toBe(true);
  });

  it("widens past magnitude only when the cost-band step finds nothing, and keeps the arena", () => {
    const only = createSynergyContext([lone("slot", "Lone Slot", 3, 1), lone("big", "Bigger", 5, 3), lone("space", "Other Arena", 4, 3, { arenas: ["Space"] })], COMMITTED_TABLE);
    const role = body(fungibleSubstitutes(only, { cardKey: "slot", tag: "wants:self-damaged", evidence: false })).roles[0];
    expect(role.widened).toBe("cost band + magnitude");
    expect(role.substitutes.flatMap((g: any) => g.cards.map((c: any) => [c.cardKey, c.match]))).toEqual([["big", "widened"]]);
  });

  it("reports widened: null, and no match field, when the exact class has other members", () => {
    const role = body(fungibleSubstitutes(ctx, { cardKey: "1", tag: "offers:damage-friendly-unit" })).roles[0];
    expect(role.widened).toBeNull();
    expect(role.substitutes.flatMap((g: any) => g.cards).some((c: any) => "match" in c)).toBe(false);
  });

  it("reports widened: null with no substitutes when widening finds nothing", () => {
    const alone = createSynergyContext([lone("slot", "Lone Slot", 3, 1), lone("far", "Far", 9, 1)], COMMITTED_TABLE);
    const role = body(fungibleSubstitutes(alone, { cardKey: "slot", tag: "wants:self-damaged", evidence: false })).roles[0];
    expect(role.widened).toBeNull();
    expect(role.substitutes).toEqual([]);
  });
});

/** A small leader-cards.json (meta/leader-cards.json shape, src/meta/schema.ts leaderCardsFileSchema). */
const leaderCardsFile = (
  leaderKey: string,
  title: string,
  aspects: string[],
  rows: [string, number][],
  topBase: { cardKey: string; title: string; decks: number } | null = null,
) =>
  indexLeaderCards({
    schemaVersion: 1,
    window: { from: "2026-07-20", to: "2026-10-17", days: 90 },
    weighting: "test weighting",
    baseline: "test baseline",
    maxCards: 150,
    leaders: [
      {
        leader: { cardKey: leaderKey, title, aspects },
        population: "tournament",
        fallback: false,
        decks: 12,
        weight: 10.5,
        window: { from: "2026-07-20", to: "2026-10-17" },
        topBase,
        cards: rows.map(([cardKey, inclusion]) => ({ cardKey, title: cardKey, inclusion, meanCopies: 2, baselineInclusion: 0.1, lift: inclusion - 0.1 })),
      },
    ],
  });

describe("find_pairings with a leader", () => {
  const leaderCtx = createSynergyContext(cards, COMMITTED_TABLE, leaderCardsFile("L1", "Aggro Leader", ["Aggression", "Villainy"], [["5", 0.8]]));

  it("leaves the no-leader answer byte-identical when leader data is loaded", () => {
    for (const args of [{ cardKey: "1" }, { cardKey: "1", aspects: ["Command"] }, { cardKey: "4", direction: "enablers" }]) {
      expect(findPairings(leaderCtx, args).content[0].text).toBe(findPairings(ctx, args).content[0].text);
    }
  });

  it("carries each partner's leaderInclusion (null when unplayed) and weights the rank by it", () => {
    const out = body(findPairings(leaderCtx, { cardKey: "1", leader: "L1" }));
    const plain = body(findPairings(ctx, { cardKey: "1", aspects: ["Aggression", "Villainy"] }));
    const rankOf = (o: Record<string, any>, k: string) => o.pairings.find((p: any) => p.cardKey === k).rank as number;
    const grit = out.pairings.find((p: any) => p.cardKey === "5");
    const squad = out.pairings.find((p: any) => p.cardKey === "4");
    expect(grit.leaderInclusion).toBe(0.8);
    expect(squad.leaderInclusion).toBeNull();
    // D73: the weighted rank divides the score by 1 + penalty where the plain rank divides it by 1 + penalty / 2.
    const penaltyFix = (o: Record<string, any>, k: string) => (1 + o.pairings.find((p: any) => p.cardKey === k).penalty / 2) / (1 + o.pairings.find((p: any) => p.cardKey === k).penalty);
    expect(grit.rank).toBeCloseTo(rankOf(plain, "5") * penaltyFix(plain, "5") * 1.3, 2);
    expect(squad.rank).toBeCloseTo(rankOf(plain, "4") * penaltyFix(plain, "4") * 0.5, 2);
    expect(out.pairings[0].cardKey).toBe("5");
  });

  it("defaults aspects to the leader's icons and names the population and window", () => {
    const out = body(findPairings(leaderCtx, { cardKey: "1", leader: "Aggro Leader" }));
    expect(out.pairings.every((p: any) => p.aspectPair === "icons Aggression+Villainy")).toBe(true);
    expect(out.leader).toMatchObject({ cardKey: "L1", population: "tournament", decks: 12, window: "2026-07-20..2026-10-17" });
    expect(out.leader.note).toContain("tournament, 12 decks, 2026-07-20..2026-10-17");
    const given = body(findPairings(leaderCtx, { cardKey: "1", leader: "L1", aspects: ["Command"] }));
    expect(given.pairings.every((p: any) => p.aspectPair === "icons Command")).toBe(true);
  });

  it("rejects a leader that is not a Leader card", () => {
    expect(findPairings(leaderCtx, { cardKey: "1", leader: "nope" }).isError).toBe(true);
    expect(findPairings(leaderCtx, { cardKey: "1", leader: "5" }).isError).toBe(true);
  });

  it("says so when the package has no decklists for the leader, and does not weight the rank", () => {
    const out = body(findPairings(leaderCtx, { cardKey: "1", leader: "L2" }));
    expect(out.leader.note).toContain("no decklist data");
    expect(out.pairings.every((p: any) => !("leaderInclusion" in p))).toBe(true);
  });
});

describe("find_pairings and find_trios with a base (D45)", () => {
  // Grit Brute (5, Aggression) pairs with Pinger Green (3, Command) and Draw Payoff (6, Command): the leader's icons
  // alone leave their Command icon uncovered, the Command Base covers it.
  const baseCtx = createSynergyContext(cards, COMMITTED_TABLE, leaderCardsFile("L1", "Aggro Leader", ["Aggression", "Villainy"], [["5", 0.8]]));
  const penalty = (o: Record<string, any>, k: string) => o.pairings.find((p: any) => p.cardKey === k).penalty as number;

  it("defaults aspects to the leader's and the base's icons, and the leader block names the base", () => {
    const out = body(findPairings(baseCtx, { cardKey: "5", leader: "L1", base: "BC" }));
    expect(out.pairings.every((p: any) => p.aspectPair === "icons Aggression+Villainy+Command")).toBe(true);
    expect(penalty(out, "3")).toBe(0);
    expect(penalty(out, "6")).toBe(0);
    expect(out.leader.base).toEqual({ cardKey: "BC", title: "Command Base", aspects: "Command" });
    expect(out.leader).not.toHaveProperty("baseNote");
    expect(body(findPairings(baseCtx, { cardKey: "5", leader: "L1", base: "Command Base" })).leader.base.cardKey).toBe("BC");
  });

  it("measures against the leader's icons only without a base, and says so", () => {
    const out = body(findPairings(baseCtx, { cardKey: "5", leader: "L1" }));
    expect(out.pairings.every((p: any) => p.aspectPair === "icons Aggression+Villainy")).toBe(true);
    expect(penalty(out, "3")).toBe(2);
    expect(penalty(out, "6")).toBe(2);
    expect(out.leader.baseNote).toBe("base not given: penalties measured against the leader's icons only");
    expect(out.leader).not.toHaveProperty("base");
    const noData = body(findPairings(baseCtx, { cardKey: "5", leader: "L2" }));
    expect(noData.leader.baseNote).toContain("base not given");
  });

  it("lets an explicit aspects list win, and says nothing about a missing base then", () => {
    const out = body(findPairings(baseCtx, { cardKey: "5", leader: "L1", base: "BC", aspects: ["Vigilance"] }));
    expect(out.pairings.every((p: any) => p.aspectPair === "icons Vigilance")).toBe(true);
    expect(body(findPairings(baseCtx, { cardKey: "5", leader: "L1", aspects: ["Vigilance"] })).leader).not.toHaveProperty("baseNote");
  });

  it("rejects a base that is not a Base card, an unknown base, and a base without a leader", () => {
    expect(findPairings(baseCtx, { cardKey: "5", leader: "L1", base: "nope" }).isError).toBe(true);
    expect(findPairings(baseCtx, { cardKey: "5", leader: "L1", base: "L2" }).isError).toBe(true);
    expect(findPairings(baseCtx, { cardKey: "5", leader: "L1", base: "5" }).isError).toBe(true);
    expect(findPairings(baseCtx, { cardKey: "5", base: "BC" }).isError).toBe(true);
    expect(findTrios(baseCtx, { base: "BC" }).isError).toBe(true);
  });

  it("leaves the no-leader answers byte-identical", () => {
    expect(findPairings(baseCtx, { cardKey: "5" }).content[0].text).toBe(findPairings(ctx, { cardKey: "5" }).content[0].text);
  });

  const vigilance = [
    mk("L", "Leader", { type: "Leader", icons: ["Command", "Heroism"] }),
    mk("Z", "Vigilance Base", { type: "Base", icons: ["Vigilance"] }),
    mk("1", "Alpha", { offers: ["offers:x"], aspects: ["Vigilance"], cost: 2 }),
    mk("2", "Bravo", { wants: ["wants:x"], offers: ["offers:y"], aspects: ["Vigilance"], cost: 3 }),
    mk("3", "Charlie", { wants: ["wants:y"], aspects: ["Vigilance"], cost: 3 }),
  ];
  const trioTable = table([
    { id: "r1", offers: { "offers:x": 1 }, wants: { "wants:x": 1 } },
    { id: "r2", offers: { "offers:y": 1 }, wants: { "wants:y": 1 } },
  ]);
  const trioCtx = createSynergyContext(vigilance, trioTable, leaderCardsFile("L", "Leader", ["Command", "Heroism"], [["1", 0.5]]));

  it("fixes the trio search to the leader's and the base's icons, and names the base", () => {
    const withBase = body(findTrios(trioCtx, { leader: "L", base: "Z", minPlayed: 0 }));
    expect(withBase.trios[0].aspectPair).toBe("leader Command+Heroism / base Vigilance");
    expect(withBase.trios[0].penalty).toBe(0);
    expect(withBase.leader.base).toEqual({ cardKey: "Z", title: "Vigilance Base", aspects: "Vigilance" });
    const without = body(findTrios(trioCtx, { leader: "L", minPlayed: 0 }));
    expect(without.trios[0].aspectPair).toBe("leader Command+Heroism / base neutral");
    expect(without.trios[0].penalty).toBe(6);
    expect(without.leader.baseNote).toBe("base not given: penalties measured against the leader's icons only");
    expect(body(findTrios(trioCtx, { leader: "L", base: "Z", baseAspects: [], minPlayed: 0 })).trios[0].aspectPair).toBe("leader Command+Heroism / base neutral");
  });
});

describe("find_trios with a leader", () => {
  const trioCards = [
    mk("L", "Leader", { type: "Leader", icons: ["Command", "Heroism"] }),
    mk("Z", "Base", { type: "Base", icons: ["Command"] }),
    mk("1", "Alpha", { offers: ["offers:x"], aspects: ["Command"], cost: 2 }),
    mk("2", "Bravo", { wants: ["wants:x"], offers: ["offers:y"], aspects: ["Command"], cost: 3 }),
    mk("3", "Charlie", { wants: ["wants:y"], aspects: ["Command"], cost: 3 }),
    mk("4", "Delta", { wants: ["wants:y"], aspects: ["Command"], cost: 1 }),
  ];
  const trioTable = table([
    { id: "r1", offers: { "offers:x": 1 }, wants: { "wants:x": 1 } },
    { id: "r2", offers: { "offers:y": 1 }, wants: { "wants:y": 1 } },
  ]);
  const plainCtx = createSynergyContext(trioCards, trioTable);
  const leaderCtx = createSynergyContext(trioCards, trioTable, leaderCardsFile("L", "Leader", ["Command", "Heroism"], [["1", 0.5], ["2", 0.5], ["3", 0.9]]));

  it("leaves the no-leader answer byte-identical when leader data is loaded", () => {
    expect(findTrios(leaderCtx, {}).content[0].text).toBe(findTrios(plainCtx, {}).content[0].text);
  });

  it("carries each member's leaderInclusion and ranks played members first", () => {
    const plain = body(findTrios(plainCtx, { leaderAspects: ["Command", "Heroism"] }));
    expect(plain.trios[0].cardKeys).toBe("1|2|4");
    const out = body(findTrios(leaderCtx, { leader: "L" }));
    expect(out.trios[0].cardKeys).toBe("1|2|3");
    expect(out.trios[0].leaderInclusion).toEqual([0.5, 0.5, 0.9]);
    const delta = body(findTrios(leaderCtx, { leader: "L", cardKey: "4" })).trios.find((t: any) => t.cardKeys === "1|2|4");
    expect(delta.leaderInclusion).toEqual([0.5, 0.5, null]);
    expect(delta.rank).toBeCloseTo(delta.score * Math.cbrt(1 * 1 * 0.5), 3);
  });

  it("defaults the leader aspects to the leader's icons and names the population and window", () => {
    const out = body(findTrios(leaderCtx, { leader: "L" }));
    expect(out.trios[0].aspectPair).toBe(body(findTrios(plainCtx, { leaderAspects: ["Command", "Heroism"] })).trios[0].aspectPair);
    expect(out.leader).toMatchObject({ cardKey: "L", population: "tournament", window: "2026-07-20..2026-10-17" });
    expect(findTrios(leaderCtx, { leader: "nope" }).isError).toBe(true);
  });
});

describe("fungible_substitutes ordering and keyword roles", () => {
  const sentinel = (key: string, title: string, extra: Record<string, unknown> = {}) =>
    mk(key, title, { cost: 3, aspects: ["Command"], arenas: ["Ground"], power: 3, hp: 4, keywords: ["Sentinel"], ...extra });
  const orderCtx = (rows: [string, number][]) =>
    createSynergyContext(
      [
        mk("LD", "Order Leader", { type: "Leader", icons: ["Command", "Heroism"] }),
        sentinel("slot", "Slot Sentinel", {
          aspects: ["Vigilance"],
          wants: ["wants:upgrades-attached"],
          why: { "wants:upgrades-attached": "text: While this unit is upgraded, he gains Saboteur." },
          abilities: [{ repeat: "constant", text: "While this unit is upgraded, he gains Saboteur." }],
        }),
        sentinel("a", "Alpha"),
        sentinel("b", "Bravo"),
        sentinel("c", "Charlie"),
        sentinel("d", "Delta", { cost: 2 }),
        sentinel("sp", "Space Sentinel", { arenas: ["Space"] }),
      ],
      COMMITTED_TABLE,
      leaderCardsFile("LD", "Order Leader", ["Command", "Heroism"], rows),
    );
  const scores = new Map([
    ["a", { playCalibrated: 1 }],
    ["b", { playCalibrated: 3 }],
    ["c", { playCalibrated: 2 }],
    ["d", { playCalibrated: null }],
  ]);
  const keysOf = (out: Record<string, any>, tag = "keyword:Sentinel") =>
    out.roles.find((r: any) => r.tag === tag).substitutes.flatMap((g: any) => g.cards.map((c: any) => c.cardKey));

  it("lists the keyword role before the while-upgraded role and leaves out the Space Sentinel", () => {
    const out = body(fungibleSubstitutes(orderCtx([]), { cardKey: "slot", evidence: false }));
    expect(out.roles.map((r: any) => r.tag)).toEqual(["keyword:Sentinel", "wants:upgrades-attached"]);
    expect(keysOf(out)).not.toContain("sp");
    expect(keysOf(out).sort()).toEqual(["a", "b", "c", "d"]);
    const withText = body(fungibleSubstitutes(orderCtx([]), { cardKey: "slot", tag: "keyword:Sentinel" })).roles[0];
    expect(withText.slotText).toBe("printed keyword Sentinel");
    expect(withText.substitutes[0].cards[0].text).toBe("printed keyword Sentinel");
  });

  it("without a leader sorts by play-calibrated score (unscored last, then cost, then cardKey) and adds no leaderInclusion", () => {
    const out = body(fungibleSubstitutes(orderCtx([["a", 0.9]]), { cardKey: "slot", evidence: false }, scores));
    expect(keysOf(out)).toEqual(["b", "c", "a", "d"]);
    expect(JSON.stringify(out)).not.toContain("leaderInclusion");
    expect(out.leader).toBeUndefined();
    expect(keysOf(body(fungibleSubstitutes(orderCtx([]), { cardKey: "slot", evidence: false })))).toEqual(["d", "a", "b", "c"]);
    const tied = new Map([["a", { playCalibrated: 2 }], ["b", { playCalibrated: 2 }], ["c", { playCalibrated: 2 }]]);
    expect(keysOf(body(fungibleSubstitutes(orderCtx([]), { cardKey: "slot", evidence: false }, tied)))).toEqual(["a", "b", "c", "d"]);
  });

  it("with a leader sorts by leaderInclusion desc (null last), then play-calibrated score, and carries leaderInclusion", () => {
    const ctxL = orderCtx([["a", 0.5], ["b", 0.5], ["c", 0.8]]);
    const out = body(fungibleSubstitutes(ctxL, { cardKey: "slot", leader: "LD", evidence: false }, scores));
    expect(keysOf(out)).toEqual(["c", "b", "a", "d"]);
    const cards2 = out.roles[0].substitutes.flatMap((g: any) => g.cards);
    expect(cards2.map((c: any) => c.leaderInclusion)).toEqual([0.8, 0.5, 0.5, null]);
    expect(out.leader).toMatchObject({ cardKey: "LD", population: "tournament", decks: 12, window: "2026-07-20..2026-10-17" });
    expect(keysOf(body(fungibleSubstitutes(ctxL, { cardKey: "slot", leader: "Order Leader", evidence: false })))).toEqual(["c", "a", "b", "d"]);
  });

  it("names a leader without decklist data and rejects an unknown leader", () => {
    const bare = createSynergyContext([mk("LD", "Order Leader", { type: "Leader" }), sentinel("slot", "Slot"), sentinel("a", "Alpha")], COMMITTED_TABLE);
    const out = body(fungibleSubstitutes(bare, { cardKey: "slot", leader: "LD", evidence: false }));
    expect(out.leader.note).toMatch(/no decklist data/);
    expect(out.roles[0].substitutes[0].cards[0].leaderInclusion).toBeNull();
    expect(fungibleSubstitutes(bare, { cardKey: "slot", leader: "nope" }).isError).toBe(true);
  });
});

describe("side-aware pair reasons (#121)", () => {
  const pinger = (key: string, title: string, tag: string, side: string) =>
    unit(key, title, ["Aggression"], 2, {
      offers: [tag],
      why: { [tag]: `text: ${title} pings` },
      abilities: [{ repeat: "once_on_play", text: `${title} pings`, n: 1, effect: { cat: "damage", target: { side } } }],
    });
  const sideCards = [
    pinger("E", "Enemy Pinger", "offers:damage-any-unit", "enemy"),
    pinger("A", "Any Pinger", "offers:damage-any-unit", "any"),
    pinger("F", "Own Pinger", "offers:damage-any-unit", "friendly"),
    unit("G", "Grit Unit", ["Aggression"], 3, { wants: ["wants:self-damaged"] }),
    unit("K", "Finisher", ["Aggression"], 3, { wants: ["wants:damaged-units"] }),
    mk("SL", "Side Leader", { type: "Leader", icons: ["Aggression", "Villainy"] }),
    mk("SB", "Side Base", { type: "Base", icons: ["Aggression"] }),
  ];
  const sideCtx = createSynergyContext(sideCards, COMMITTED_TABLE);
  const reasonOf = (from: string, to: string): string =>
    body(findPairings(sideCtx, { cardKey: from, direction: "payoffs", withAlternatives: false })).pairings.find((p: any) => p.cardKey === to).reason;

  it("words an enemy-target damage offer as a finisher setup, not as Grit", () => {
    expect(reasonOf("E", "K")).toBe("Damage on an enemy unit sets up a finisher that wants a damaged target.");
    expect(reasonOf("E", "G")).not.toContain("your own unit");
  });

  it("keeps the own-unit wording when the offer lands on a friendly unit", () => {
    expect(reasonOf("F", "G")).toBe("Damaging your own unit switches on Grit, 'while damaged' and damage-taken triggers.");
  });

  it("uses the any wording when the clause says a unit, naming both sides", () => {
    const text = reasonOf("A", "K");
    expect(text).toContain("an enemy's or your own");
    expect(text).toContain("a finisher that wants any damaged target");
  });

  it("lets a tag that names a side win over the first effect of its clause", () => {
    const mixed = createSynergyContext(
      [
        unit("M", "Mixed Pinger", ["Aggression"], 2, {
          offers: ["offers:damage-enemy-unit"],
          why: { "offers:damage-enemy-unit": "text: Mixed Pinger pings" },
          abilities: [{ repeat: "once_on_play", text: "Mixed Pinger pings", n: 1, effect: { cat: "damage", target: { side: "friendly" } } }],
        }),
        sideCards[4],
        sideCards[5],
        sideCards[6],
      ],
      table([{ id: "r", offers: { "offers:damage-enemy-unit": 1 }, wants: { "wants:damaged-units": 1 } }]),
    );
    expect(mixed.graph.edges).toHaveLength(1);
    expect(offerTargetSide(mixed.graph.byKey.get("M") as SynergyCard, "offers:damage-enemy-unit")).toBe("enemy");
  });

  it("reads the tag name when the clause states no side, and falls back to reason for a row without variants", () => {
    const named = createSynergyContext(
      [unit("P", "Named Pinger", ["Aggression"], 2, { offers: ["offers:damage-friendly-unit"] }), sideCards[3], sideCards[5], sideCards[6]],
      COMMITTED_TABLE,
    );
    expect(body(findPairings(named, { cardKey: "P", withAlternatives: false })).pairings[0].reason).toContain("Damaging your own unit");
    const plain = createSynergyContext(
      [unit("X", "Healer", ["Aggression"], 2, { offers: ["offers:heal"] }), unit("Y", "Heal Payoff", ["Aggression"], 2, { wants: ["wants:heal"] }), sideCards[5], sideCards[6]],
      COMMITTED_TABLE,
    );
    expect(body(findPairings(plain, { cardKey: "X", withAlternatives: false })).pairings[0].reason).toBe("Healing triggers 'when damage is healed' payoffs.");
  });

  it("changes no edge: the link, score and rank match the same table without variants", () => {
    const stripped = { ...COMMITTED_TABLE, rows: COMMITTED_TABLE.rows.map((row) => ({ ...row, reasonBySide: undefined })) };
    const plainCtx = createSynergyContext(sideCards, stripped);
    const drop = (o: Record<string, any>) => o.pairings.map((p: Record<string, any>) => ({ ...p, reason: undefined }));
    for (const key of ["E", "A", "F", "K"]) {
      expect(drop(body(findPairings(sideCtx, { cardKey: key })))).toEqual(drop(body(findPairings(plainCtx, { cardKey: key }))));
    }
  });

  it("explain_synergy words each row by its side too", () => {
    const rows = body(explainSynergy(sideCtx, { cardKeys: ["E", "K"] })).links[0].rows;
    expect(rows[0].reason).toBe("Damage on an enemy unit sets up a finisher that wants a damaged target.");
  });
});

describe("a Leader cardKey defaults the leader weighting (#121)", () => {
  const withBase = [
    ...cards,
    mk("BN", "Nevarro Base", { type: "Base", icons: ["Command"] }),
    mk("LP", "Pinger Leader", {
      type: "Leader",
      icons: ["Aggression", "Villainy"],
      cost: 4,
      offers: ["offers:damage-friendly-unit"],
      why: { "offers:damage-friendly-unit": "text: Pinger Leader text" },
    }),
  ];
  const plainLeaderCtx = createSynergyContext(withBase, COMMITTED_TABLE);
  const leaderCtx = createSynergyContext(
    withBase,
    COMMITTED_TABLE,
    leaderCardsFile("LP", "Pinger Leader", ["Aggression", "Villainy"], [["5", 0.8]], { cardKey: "BN", title: "Nevarro Base", decks: 40 }),
  );

  it("find_pairings defaults leader to the Leader cardKey and base to its top base, and says so", () => {
    const out = body(findPairings(leaderCtx, { cardKey: "LP" }));
    expect(out.leader).toMatchObject({ cardKey: "LP", defaulted: true, population: "tournament" });
    expect(out.leader.base).toMatchObject({ cardKey: "BN", title: "Nevarro Base", defaulted: true });
    expect(out.pairings.every((p: any) => p.aspectPair === "icons Aggression+Villainy+Command")).toBe(true);
    expect(out.pairings.every((p: any) => "leaderInclusion" in p)).toBe(true);
  });

  it("weights the rank by the leader's decklists and puts the played partner first", () => {
    const withLeader = body(findPairings(leaderCtx, { cardKey: "LP" }));
    expect(withLeader.pairings.find((p: any) => p.cardKey === "5").leaderInclusion).toBe(0.8);
    expect(withLeader.pairings[0].cardKey).toBe("5");
  });

  it("weighting: none restores the unweighted answer with no leader block", () => {
    const none = findPairings(leaderCtx, { cardKey: "LP", weighting: "none" });
    expect(none.content[0].text).toBe(findPairings(plainLeaderCtx, { cardKey: "LP" , weighting: "none" }).content[0].text);
    expect(body(none)).not.toHaveProperty("leader");
  });

  it("an explicit leader is not marked defaulted, and an explicit base wins over the top base", () => {
    const explicit = body(findPairings(leaderCtx, { cardKey: "LP", leader: "LP" }));
    expect(explicit.leader).not.toHaveProperty("defaulted");
    expect(explicit.leader).not.toHaveProperty("base");
    const chosen = body(findPairings(leaderCtx, { cardKey: "LP", base: "BV" }));
    expect(chosen.leader).toMatchObject({ defaulted: true, base: { cardKey: "BV" } });
    expect(chosen.leader.base).not.toHaveProperty("defaulted");
  });

  it("weighting: none with an explicit leader keeps the aspects but drops the inclusion weighting", () => {
    const out = body(findPairings(leaderCtx, { cardKey: "1", leader: "LP", weighting: "none" }));
    expect(out.pairings.every((p: any) => !("leaderInclusion" in p))).toBe(true);
    expect(out.pairings.every((p: any) => p.aspectPair === "icons Aggression+Villainy")).toBe(true);
    expect(out.leader.note).toContain("weighting: none");
  });

  it("a Leader without decklist data still defaults the leader and its aspects", () => {
    const out = body(findPairings(leaderCtx, { cardKey: "L2" }));
    expect(out.leader).toMatchObject({ cardKey: "L2", defaulted: true });
    expect(out.leader.note).toContain("no decklist data");
  });

  it("a non-Leader cardKey is unchanged", () => {
    expect(findPairings(leaderCtx, { cardKey: "5" }).content[0].text).toBe(findPairings(plainLeaderCtx, { cardKey: "5" }).content[0].text);
  });

  const trioCards = [
    mk("L", "Leader", { type: "Leader", icons: ["Command", "Heroism"] }),
    mk("Z", "Command Base", { type: "Base", icons: ["Command"] }),
    mk("1", "Alpha", { offers: ["offers:x"], aspects: ["Command"], cost: 2 }),
    mk("2", "Bravo", { wants: ["wants:x"], offers: ["offers:y"], aspects: ["Command"], cost: 3 }),
    mk("3", "Charlie", { wants: ["wants:y"], aspects: ["Command"], cost: 3 }),
  ];
  const trioTable = table([
    { id: "r1", offers: { "offers:x": 1 }, wants: { "wants:x": 1 } },
    { id: "r2", offers: { "offers:y": 1 }, wants: { "wants:y": 1 } },
  ]);
  const trioCtx = createSynergyContext(trioCards, trioTable, leaderCardsFile("L", "Leader", ["Command", "Heroism"], [["1", 0.5]], { cardKey: "Z", title: "Command Base", decks: 9 }));

  it("find_trios defaults the leader and base from a Leader cardKey, and weighting: none restores the plain answer", () => {
    const out = body(findTrios(trioCtx, { cardKey: "L", includeLeaders: true }));
    expect(out.leader).toMatchObject({ cardKey: "L", defaulted: true, base: { cardKey: "Z", defaulted: true } });
    const none = findTrios(trioCtx, { cardKey: "L", includeLeaders: true, weighting: "none" });
    expect(none.content[0].text).toBe(findTrios(createSynergyContext(trioCards, trioTable), { cardKey: "L", includeLeaders: true, weighting: "none" }).content[0].text);
  });

  it("find_trios from a non-Leader cardKey adds no leader", () => {
    expect(body(findTrios(trioCtx, { cardKey: "1" }))).not.toHaveProperty("leader");
  });
});

/** Feature-record excerpts shaped like data/runs/2026-10-30/features/features.json, so the matcher reads the clause targets. */
const featureRec = (cardKey: string, title: string, type: string, traits: string[], aspects: string[], faces: Record<string, unknown[]>, offers: [string, string][], wants: [string, string][]) =>
  synergyCardsSchema.parse([
    {
      cardKey,
      title,
      subtitle: null,
      type,
      structured: { cost: 3, aspects, aspectIcons: aspects, traits },
      faces,
      tags: { offers: offers.map(([tag, why]) => ({ tag, why })), wants: wants.map(([tag, why]) => ({ tag, why })) },
    },
  ])[0];
const eventText = (text: string, effects: unknown[]) => ({
  text: [{ kind: "ability", triggers: [{ trigger: "event_resolve" }], clauses: [{ text, effects, conditions: [], modifiers: [] }], options: [], grantedAbilities: [] }],
});
const upgradedText = (text: string) => ({
  text: [{ kind: "ability", triggers: [{ trigger: "constant" }], clauses: [{ text, effects: [], conditions: [{ cat: "self_state", state: "upgraded" }], modifiers: [] }], options: [], grantedAbilities: [] }],
});
const defeatFriendly = (cardKey: string, title: string, aspects: string[], restrict: string[], text: string) =>
  featureRec(cardKey, title, "Event", ["Innate"], aspects, eventText(text, [{ cat: "defeat", n: 1, target: { side: "friendly", kind: "unit", arena: "any", restrict, text: text.slice(7, -1) } }]), [["offers:defeat-friendly-unit", `text: ${text}`]], []);
const LAST_WORDS_TEXT = "If a friendly unit was defeated this phase, give 2 Experience tokens to a unit.";
const lastWords = featureRec("LW", "Last Words", "Event", ["Learned"], ["Command"], eventText(LAST_WORDS_TEXT, [{ cat: "give_token", n: 2, target: { side: "any", kind: "unit", arena: "any", restrict: [], text: "a unit" } }]), [["offers:give-experience", `text: ${LAST_WORDS_TEXT}`]], [["wants:friendly-unit-defeated", `text: ${LAST_WORDS_TEXT}`]]);
const UPGRADED = "While this unit is upgraded, it gets +1/+0.";
const host = (cardKey: string, title: string, traits: string[]) =>
  featureRec(cardKey, title, "Unit", traits, ["Command"], upgradedText(UPGRADED), [], [["wants:upgrades-attached", `text: ${UPGRADED}`]]);

describe("slot alternatives keep the slot's link and the Premier pool (#119)", () => {
  const outlet = defeatFriendly("OUT", "Plain Outlet", ["Command"], [], "Defeat a friendly unit.");
  const fish = defeatFriendly("FISH", "Always a Bigger Fish", ["Cunning"], ["trait:Creature"], "Defeat a friendly Creature unit.");
  const twin = defeatFriendly("TWIN", "Outlet Twin", ["Aggression"], [], "Defeat a friendly unit.");
  const pieces = [mk("LC", "Command Leader", { type: "Leader", icons: ["Command", "Heroism"] }), mk("BK", "Cunning Base", { type: "Base", icons: ["Cunning"] })];
  const trooperCtx = createSynergyContext([...pieces, outlet, fish, twin, lastWords, host("TRP", "Trooper Host", ["Trooper"])], COMMITTED_TABLE);
  const creatureCtx = createSynergyContext([...pieces, outlet, fish, twin, lastWords, host("BST", "Creature Host", ["Creature"])], COMMITTED_TABLE);
  const slotA = (c: typeof trooperCtx, last: string, inPool?: (k: string) => boolean) => {
    const out = body(findTrios(c, { cardKey: "OUT", shape: "chain", evidence: false, maxTotalCost: 20 }, inPool));
    const trio = out.trios.find((t: any) => t.cardKeys === `OUT|LW|${last}`);
    expect(trio).toBeDefined();
    return (trio.alternatives[0].substitutes as string[]).join(" ");
  };

  it("find_trios: Always a Bigger Fish is no slot-A alternative in a trio with no Creature", () => {
    expect(slotA(trooperCtx, "TRP")).toContain("Outlet Twin");
    expect(slotA(trooperCtx, "TRP")).not.toContain("Always a Bigger Fish");
  });

  it("find_trios: Always a Bigger Fish stays a slot-A alternative when the trio holds a Creature (positive control)", () => {
    expect(slotA(creatureCtx, "BST")).toContain("Always a Bigger Fish");
  });

  it("find_trios: a card outside the Premier pool is no alternative", () => {
    expect(slotA(trooperCtx, "TRP", (k) => k !== "TWIN")).not.toContain("Outlet Twin");
  });

  it("find_pairings: a partner alternative must still link with the card; Always a Bigger Fish does not feed Last Words", () => {
    const out = body(findPairings(trooperCtx, { cardKey: "LW", direction: "enablers", evidence: false }));
    const alt = (out.pairings.find((p: any) => p.cardKey === "OUT").alternatives as string[]).join(" ");
    expect(alt).toContain("Outlet Twin");
    expect(alt).not.toContain("Always a Bigger Fish");
    const pooled = body(findPairings(trooperCtx, { cardKey: "LW", direction: "enablers", evidence: false }, (k) => k !== "TWIN"));
    expect((pooled.pairings.find((p: any) => p.cardKey === "OUT").alternatives as string[]).join(" ")).not.toContain("Outlet Twin");
  });

  it("fungible_substitutes: a card outside the Premier pool is no substitute", () => {
    const keys = (inPool?: (k: string) => boolean) =>
      body(fungibleSubstitutes(trooperCtx, { cardKey: "OUT", tag: "offers:defeat-friendly-unit", evidence: false }, new Map(), inPool)).roles[0].substitutes.flatMap((g: any) => g.cards.map((c: any) => c.cardKey));
    expect(keys()).toContain("TWIN");
    expect(keys((k) => k !== "TWIN")).not.toContain("TWIN");
  });
});

describe("find_trios with a leader ranks by the geometric mean of the member factors (#119)", () => {
  // Unweighted, 1|2|4 (score 2.888) leads 1|2|3 (2.613). Charlie alone is played (10%): the product of factors
  // (0.5 x 0.5 x 0.6 = 0.15 against 0.125) lets that one card lift two unplayed ones above the better trio; the
  // geometric mean (0.531 against 0.5) does not.
  const trioCards = [
    mk("L", "Leader", { type: "Leader", icons: ["Command", "Heroism"] }),
    mk("1", "Alpha", { offers: ["offers:x"], aspects: ["Command"], cost: 2 }),
    mk("2", "Bravo", { wants: ["wants:x"], offers: ["offers:y"], aspects: ["Command"], cost: 3 }),
    mk("3", "Charlie", { wants: ["wants:y"], aspects: ["Command"], cost: 3 }),
    mk("4", "Delta", { wants: ["wants:y"], aspects: ["Command"], cost: 1 }),
  ];
  const trioTable = table([
    { id: "r1", offers: { "offers:x": 1 }, wants: { "wants:x": 1 } },
    { id: "r2", offers: { "offers:y": 1 }, wants: { "wants:y": 1 } },
  ]);
  const ctxG = createSynergyContext(trioCards, trioTable, leaderCardsFile("L", "Leader", ["Command", "Heroism"], [["3", 0.1]]));

  it("one played card does not carry two unplayed ones past a better-scored trio", () => {
    const out = body(findTrios(ctxG, { leader: "L", minPlayed: 0, withAlternatives: false, evidence: false }));
    // 1|2|3 shares Alpha and Bravo with 1|2|4, so it is listed as that row's variant (#134).
    expect(out.trios.map((t: any) => t.cardKeys)).toEqual(["1|2|4"]);
    expect(out.trios[0].variants.map((v: any) => v.title)).toEqual(["Charlie"]);
    const charlie = body(findTrios(ctxG, { leader: "L", minPlayed: 0, cardKey: "3", withAlternatives: false, evidence: false })).trios[0];
    expect(charlie.cardKeys).toBe("1|2|3");
    expect(out.trios[0].rank).toBeGreaterThan(charlie.rank);
    expect(charlie.leaderInclusion).toEqual([null, null, 0.1]);
    expect(charlie.rank).toBeCloseTo(charlie.score * Math.cbrt(0.5 * 0.5 * 0.6), 3);
    expect(out.trios[0].rank).toBeCloseTo(out.trios[0].score * 0.5, 3);
    expect(out.leader.note).toContain("cube root");
  });
});

describe("find_trios played members and de-duplication (#134)", () => {
  const cards = [
    mk("L", "Leader", { type: "Leader", icons: ["Command", "Heroism"] }),
    mk("Z", "Base", { type: "Base", icons: ["Command"] }),
    mk("1", "Alpha", { offers: ["offers:x"], aspects: ["Command"], cost: 2 }),
    mk("5", "Echo", { offers: ["offers:x"], aspects: ["Command"], cost: 2 }),
    mk("2", "Bravo", { wants: ["wants:x"], offers: ["offers:y"], aspects: ["Command"], cost: 3 }),
    mk("3", "Charlie", { wants: ["wants:y"], aspects: ["Command"], cost: 3 }),
    mk("4", "Delta", { wants: ["wants:y"], aspects: ["Command"], cost: 1 }),
  ];
  const rows = table([
    { id: "r1", offers: { "offers:x": 1 }, wants: { "wants:x": 1 } },
    { id: "r2", offers: { "offers:y": 1 }, wants: { "wants:y": 1 } },
  ]);
  const plainCtx = createSynergyContext(cards, rows);
  const leaderCtx = createSynergyContext(cards, rows, leaderCardsFile("L", "Leader", ["Command", "Heroism"], [["1", 0.5], ["2", 0.6], ["3", 0.9]]));
  const keysOf = (out: Record<string, any>): string[] => out.trios.map((t: any) => t.cardKeys);
  const played = (t: any): number => t.leaderInclusion.filter((x: number | null) => x !== null && x > 0).length;

  it("with a leader keeps only trios with at least two played members by default, and the note says so", () => {
    const out = body(findTrios(leaderCtx, { leader: "L", withAlternatives: false }));
    expect(out.trios.length).toBeGreaterThan(0);
    expect(out.trios.every((t: any) => played(t) >= 2)).toBe(true);
    expect(out.leader.minPlayed).toBe(2);
    expect(out.leader.note).toContain("at least 2 members with leaderInclusion of 0.02 or more");
  });

  it("takes minPlayed 0 to 3 and rejects it without leader weighting", () => {
    const three = body(findTrios(leaderCtx, { leader: "L", minPlayed: 3, withAlternatives: false }));
    expect(keysOf(three)).toEqual(["1|2|3"]);
    expect(three.trios[0].variants).toBeUndefined();
    const zero = body(findTrios(leaderCtx, { leader: "L", minPlayed: 0, withAlternatives: false }));
    const all = [...keysOf(zero), ...zero.trios.flatMap((t: any) => (t.variants ?? []).map((v: any) => v.title))];
    expect(all).toContain("Delta");
    expect(() => findTrios(leaderCtx, { leader: "L", minPlayed: 4 })).toThrow();
    expect(findTrios(plainCtx, { minPlayed: 1 }).isError).toBe(true);
    expect(body(findTrios(plainCtx, { minPlayed: 0 })).trios.length).toBeGreaterThan(0);
  });

  it("collapses rows that share two members into the best-ranked one and lists the other third members as variants", () => {
    const out = body(findTrios(leaderCtx, { leader: "L", minPlayed: 0, withAlternatives: false }));
    // 1|2|4, 5|2|3 and the convergent 1|5|2 each share two members with 1|2|3; 5|2|4 shares only Bravo.
    expect(keysOf(out)).toEqual(["1|2|3", "5|2|4"]);
    expect(out.trios[0].variants.map((v: any) => v.title)).toEqual(["Echo", "Delta"]);
    // D83 (#165) flipped this expectation: a variant names its slot and, with fixed aspects, its penalty.
    expect(out.trios[0].variants[1]).toEqual({ title: "Delta", slot: "C", cost: 1, penalty: 0, leaderInclusion: null });
    expect(out.trios[1].variants).toBeUndefined();
    expect(out.shown).toBe(2);
  });

  it("de-duplicates without a leader too, and its variants carry no leaderInclusion", () => {
    const out = body(findTrios(plainCtx, { withAlternatives: false }));
    const pairs = out.trios.map((t: any) => t.cardKeys.split("|"));
    for (let i = 0; i < pairs.length; i++)
      for (let j = i + 1; j < pairs.length; j++) expect(pairs[i].filter((k: string) => pairs[j].includes(k)).length).toBeLessThan(2);
    expect(out.trios[0].variants.length).toBeGreaterThan(0);
    expect(out.trios[0].variants[0].leaderInclusion).toBeUndefined();
  });
});

describe("find_trios curated evidence (#134)", () => {
  const rows = table([
    { id: "r1", offers: { "offers:x": 1 }, wants: { "wants:x": 1 } },
    { id: "fill-discard", offers: { "offers:discard-own": 1 }, wants: { "wants:cards-in-discard": 1 } },
  ]);
  // The cards behind row 5 of the fifth judged session (Cad Bane / Nevarro City): both tags of their link came from the curated table.
  const trooper = mk("08010045", "Reanimated Night Trooper", {
    wants: ["wants:x"],
    offers: ["offers:discard-own"],
    why: { "wants:x": "text: When Defeated", "offers:discard-own": "curated cur-0141" },
  });
  const torture = mk("07010174", "0-0-0", { wants: ["wants:cards-in-discard"], why: { "wants:cards-in-discard": "curated cur-0124" } });
  const feeder = mk("1", "Feeder", { offers: ["offers:x"], why: { "offers:x": "text: Defeat a friendly unit." } });
  const realCtx = createSynergyContext([feeder, trooper, torture], rows, null, loadCuratedClauses(DEFAULT_CURATED_PATH));
  const link = (ctx: ReturnType<typeof createSynergyContext>, name: string) =>
    body(findTrios(ctx, { withAlternatives: false })).trios[0].evidence.find((e: any) => e.link === name);

  it("shows the committed curated clause text with source curated, never a bare curated id", () => {
    const row = link(realCtx, "Reanimated Night Trooper > 0-0-0");
    expect(row).toEqual({
      link: "Reanimated Night Trooper > 0-0-0",
      offer: "text: You may discard it.",
      want: "text: You may put a Aggression card from your discard pile on the bottom of your deck.",
      source: "curated",
    });
    expect(link(realCtx, "Feeder > Reanimated Night Trooper").source).toBe("grammar");
    expect(findTrios(realCtx, {}).content[0].text).not.toMatch(/curated cur-\d/);
  });

  it("names the curated side on a synthetic entry, and never prints the id when the table lacks it", () => {
    const synth = mk("9", "Synth", { offers: ["offers:x"], why: { "offers:x": "curated cur-9001" } });
    const curated = new Map([["cur-9001", "text: A synthetic curated clause."]]);
    const ctx = createSynergyContext([synth, trooper, torture], rows, null, curated);
    expect(link(ctx, "Synth > Reanimated Night Trooper")).toMatchObject({ offer: "text: A synthetic curated clause.", want: "text: When Defeated", source: "curated offer" });
    expect(link(ctx, "Reanimated Night Trooper > 0-0-0")).toMatchObject({ offer: "(no clause text recorded)", want: "(no clause text recorded)", source: "curated" });
    const bare = createSynergyContext([synth, trooper, torture], rows);
    expect(findTrios(bare, {}).content[0].text).not.toMatch(/curated cur-\d/);
  });
});

describe("played means leaderInclusion of at least 2% in every synergy tool (#136)", () => {
  const trioCards = [
    mk("L", "Leader", { type: "Leader", icons: ["Command", "Heroism"] }),
    mk("1", "Alpha", { offers: ["offers:x"], aspects: ["Command"], cost: 2 }),
    mk("2", "Bravo", { wants: ["wants:x"], offers: ["offers:y"], aspects: ["Command"], cost: 3 }),
    mk("3", "Charlie", { wants: ["wants:y"], aspects: ["Command"], cost: 3 }),
  ];
  const trioTable = table([
    { id: "r1", offers: { "offers:x": 1 }, wants: { "wants:x": 1 } },
    { id: "r2", offers: { "offers:y": 1 }, wants: { "wants:y": 1 } },
  ]);
  const withRows = (rows: [string, number][]) => createSynergyContext(trioCards, trioTable, leaderCardsFile("L", "Leader", ["Command", "Heroism"], rows));

  it("uses one floor constant, 2%", () => {
    expect(LEADER_INCLUSION_FLOOR).toBe(0.02);
  });

  it("find_trios: a card at 0.0039 is unplayed, so it does not satisfy minPlayed", () => {
    const thin = withRows([["1", 0.5], ["2", 0.0039], ["3", 0.0039]]);
    expect(body(findTrios(thin, { leader: "L", withAlternatives: false })).trios ?? []).toEqual([]);
    const one = body(findTrios(thin, { leader: "L", minPlayed: 1, withAlternatives: false }));
    expect(one.trios[0].leaderInclusion).toEqual([0.5, 0.0039, 0.0039]);
    expect(one.leader.note).toContain("with leaderInclusion of 0.02 or more");
    const two = body(findTrios(withRows([["1", 0.5], ["2", 0.0039], ["3", 0.02]]), { leader: "L", withAlternatives: false }));
    expect(two.trios.map((t: any) => t.cardKeys)).toEqual(["1|2|3"]);
  });

  it("find_trios: the member factor is 0.5 for a card under the floor, 0.5 + inclusion at the floor", () => {
    const out = body(findTrios(withRows([["1", 0.5], ["2", 0.0039], ["3", 0.02]]), { leader: "L", minPlayed: 0, withAlternatives: false }));
    expect(out.trios[0].rank).toBeCloseTo(out.trios[0].score * Math.cbrt(1 * 0.5 * 0.52), 3);
  });

  it("find_pairings: the partner factor is 0.5 under the floor, and leaderInclusion still shows the raw share", () => {
    const leaderCtx = createSynergyContext(cards, COMMITTED_TABLE, leaderCardsFile("L1", "Aggro Leader", ["Aggression", "Villainy"], [["5", 0.0039], ["4", 0.02]]));
    const out = body(findPairings(leaderCtx, { cardKey: "1", leader: "L1", withAlternatives: false }));
    const plain = body(findPairings(ctx, { cardKey: "1", aspects: ["Aggression", "Villainy"], withAlternatives: false }));
    const rankOf = (o: Record<string, any>, k: string) => o.pairings.find((p: any) => p.cardKey === k).rank as number;
    expect(out.pairings.find((p: any) => p.cardKey === "5").leaderInclusion).toBe(0.0039);
    // D73: the weighted rank divides the score by 1 + penalty where the plain rank divides it by 1 + penalty / 2.
    const penaltyFix = (k: string) => (1 + plain.pairings.find((p: any) => p.cardKey === k).penalty / 2) / (1 + plain.pairings.find((p: any) => p.cardKey === k).penalty);
    expect(rankOf(out, "5")).toBeCloseTo(rankOf(plain, "5") * penaltyFix("5") * 0.5, 2);
    expect(rankOf(out, "4")).toBeCloseTo(rankOf(plain, "4") * penaltyFix("4") * 0.52, 2);
  });

  it("fungible_substitutes: a card under the floor sorts with the unplayed ones, by score", () => {
    const sentinel = (key: string, title: string) => mk(key, title, { cost: 3, aspects: ["Command"], arenas: ["Ground"], power: 3, hp: 4, keywords: ["Sentinel"] });
    const subCtx = createSynergyContext(
      [mk("LD", "Order Leader", { type: "Leader", icons: ["Command", "Heroism"] }), sentinel("slot", "Slot"), sentinel("a", "Alpha"), sentinel("b", "Bravo"), sentinel("c", "Charlie")],
      COMMITTED_TABLE,
      leaderCardsFile("LD", "Order Leader", ["Command", "Heroism"], [["a", 0.0039], ["c", 0.03]]),
    );
    const scores = new Map([["a", { playCalibrated: 3 }], ["b", { playCalibrated: 1 }], ["c", { playCalibrated: 0 }]]);
    const out = body(fungibleSubstitutes(subCtx, { cardKey: "slot", tag: "keyword:Sentinel", leader: "LD", evidence: false }, scores));
    const cards2 = out.roles[0].substitutes.flatMap((g: any) => g.cards);
    expect(cards2.map((c: any) => c.cardKey)).toEqual(["c", "a", "b"]);
    expect(cards2.map((c: any) => c.leaderInclusion)).toEqual([0.03, 0.0039, null]);
  });
});

describe("a Leader cardKey keeps its own icons in every weighting mode (#136)", () => {
  const pieces = [
    mk("LP", "Pinger Leader", { type: "Leader", icons: ["Aggression", "Villainy"], offers: ["offers:x"] }),
    mk("LV", "Other Leader", { type: "Leader", icons: ["Command", "Heroism"] }),
    mk("BN", "Cunning Base", { type: "Base", icons: ["Cunning"] }),
    mk("2", "Bravo", { wants: ["wants:x"], offers: ["offers:y"], aspects: ["Cunning"], cost: 3 }),
    mk("3", "Charlie", { wants: ["wants:y"], aspects: ["Cunning"], cost: 3 }),
  ];
  const t = table([
    { id: "r1", offers: { "offers:x": 1 }, wants: { "wants:x": 1 } },
    { id: "r2", offers: { "offers:y": 1 }, wants: { "wants:y": 1 } },
  ]);
  const lcx = createSynergyContext(pieces, t, leaderCardsFile("LP", "Pinger Leader", ["Aggression", "Villainy"], [["2", 0.5]], { cardKey: "BN", title: "Cunning Base", decks: 9 }));

  it("find_pairings weighting none measures every partner against the leader's own icons, not the best other leader and base", () => {
    const out = body(findPairings(lcx, { cardKey: "LP", weighting: "none", withAlternatives: false, evidence: false }));
    expect(out.pairings.length).toBeGreaterThan(0);
    expect(out.pairings.every((p: any) => p.aspectPair === "icons Aggression+Villainy")).toBe(true);
    expect(out.pairings[0].penalty).toBe(2);
    expect(out.pairings.every((p: any) => !("leaderInclusion" in p))).toBe(true);
    expect(out).not.toHaveProperty("leader");
    const weighted = body(findPairings(lcx, { cardKey: "LP", withAlternatives: false, evidence: false }));
    expect(weighted.pairings.every((p: any) => p.aspectPair === "icons Aggression+Villainy+Cunning")).toBe(true);
  });

  it("find_pairings: an explicit aspects argument still wins, and a non-Leader card is measured as before", () => {
    const given = body(findPairings(lcx, { cardKey: "LP", weighting: "none", aspects: ["Cunning"], withAlternatives: false, evidence: false }));
    expect(given.pairings.every((p: any) => p.aspectPair === "icons Cunning")).toBe(true);
    const plain = body(findPairings(lcx, { cardKey: "2", withAlternatives: false, evidence: false }));
    expect(plain.pairings.every((p: any) => p.aspectPair.startsWith("leader "))).toBe(true);
  });

  it("find_trios weighting none fixes the cover search to the leader's icons", () => {
    const out = body(findTrios(lcx, { cardKey: "LP", includeLeaders: true, weighting: "none", withAlternatives: false, evidence: false }));
    expect(out.trios.length).toBeGreaterThan(0);
    expect(out.trios.every((x: any) => x.aspectPair === "leader Aggression+Villainy / base neutral")).toBe(true);
    expect(out.trios[0].penalty).toBe(4);
  });
});

describe("a partner whose clause names a specific base is marked baseLocked and ranked after unlocked partners (#136)", () => {
  const LOCK = "While you control a Tatooine base, friendly units enter play ready.";
  const locked = mk("X1", "Ritual Like", { offers: ["offers:x"], aspects: ["Command"], cost: 3, abilities: [{ repeat: "constant", text: LOCK }] });
  const free = mk("X2", "Free Offer", { offers: ["offers:x"], aspects: ["Command"], cost: 3, abilities: [{ repeat: "constant", text: "Friendly units get +1/+0." }] });
  const aspectOnly = mk("X3", "Aspect Offer", { offers: ["offers:x"], aspects: ["Command"], cost: 3, abilities: [{ repeat: "constant", text: "While you control an Aggression leader or base, draw a card." }] });
  const want = mk("W", "Wanter", { wants: ["wants:x"], offers: ["offers:y"], aspects: ["Command"], cost: 3 });
  const tail = mk("T", "Tail", { wants: ["wants:y"], aspects: ["Command"], cost: 3 });
  const leader = mk("LK", "Lock Leader", { type: "Leader", icons: ["Command", "Heroism"] });
  const tatooine = mk("BT", "Mos Eisley", { type: "Base", icons: ["Command"], traits: ["Tatooine"] });
  const plainBase = mk("BP", "Command Base", { type: "Base", icons: ["Command"] });
  const t = table([
    { id: "r1", offers: { "offers:x": 1 }, wants: { "wants:x": 1 } },
    { id: "r2", offers: { "offers:y": 1 }, wants: { "wants:y": 1 } },
  ]);
  const file = leaderCardsFile("LK", "Lock Leader", ["Command", "Heroism"], [["X1", 0.8], ["X2", 0.1], ["X3", 0.1], ["W", 0.5], ["T", 0.5]]);
  const pairCtx = createSynergyContext([leader, tatooine, plainBase, locked, free, aspectOnly, want, tail], t, file);
  const order = (o: Record<string, any>): string[] => o.pairings.map((p: any) => p.cardKey);

  it("find_pairings: the locked partner carries baseLocked and follows the unlocked ones although its rank is higher", () => {
    const out = body(findPairings(pairCtx, { cardKey: "W", direction: "enablers", leader: "LK", withAlternatives: false, evidence: false }));
    // D82 (#164) flipped this expectation: X2 and X3 tie on rank, and a tie now goes to the title ("Aspect Offer" before "Free Offer").
    expect(order(out)).toEqual(["X3", "X2", "X1"]);
    expect(out.pairings[2]).toMatchObject({ cardKey: "X1", baseLocked: "Tatooine" });
    expect(out.pairings[2].rank).toBeGreaterThan(out.pairings[0].rank);
    expect(out.pairings[0]).not.toHaveProperty("baseLocked");
    expect(out.pairings[1]).not.toHaveProperty("baseLocked");
  });

  it("find_pairings: a base of the named kind satisfies the lock, so the partner keeps its rank", () => {
    const out = body(findPairings(pairCtx, { cardKey: "W", direction: "enablers", leader: "LK", base: "BT", withAlternatives: false, evidence: false }));
    expect(order(out)[0]).toBe("X1");
    // D59: a lock the base meets is cleared, so the row no longer names it (it used to keep the name, #150).
    expect(out.pairings[0]).not.toHaveProperty("baseLocked");
    const other = body(findPairings(pairCtx, { cardKey: "W", direction: "enablers", leader: "LK", base: "BP", withAlternatives: false, evidence: false }));
    expect(order(other)[2]).toBe("X1");
  });

  it("find_trios: a trio with a locked member carries baseLocked and a locked variant says so", () => {
    const only = createSynergyContext([leader, locked, want, tail], t, file);
    const row = body(findTrios(only, { leader: "LK", minPlayed: 0, withAlternatives: false, evidence: false })).trios[0];
    expect(row.baseLocked).toBe("Tatooine");
    const both = body(findTrios(pairCtx, { leader: "LK", minPlayed: 0, withAlternatives: false, evidence: false }));
    expect(both.trios[0].cardKeys).toBe("X2|W|T");
    expect(both.trios[0]).not.toHaveProperty("baseLocked");
    // D83 (#165) flipped this expectation: a variant names its slot and, with fixed aspects, its penalty.
    expect(both.trios[0].variants).toContainEqual({ title: "Ritual Like", slot: "A", cost: 3, penalty: 0, leaderInclusion: 0.8, baseLocked: "Tatooine" });
  });

  it("find_trios: a base of the named kind clears the lock on the trio and on its variant, a base of another kind keeps it (#150)", () => {
    const run = (base: string) => body(findTrios(pairCtx, { leader: "LK", base, minPlayed: 0, withAlternatives: false, evidence: false })).trios[0];
    const met = run("BT");
    expect(met.cardKeys).toBe("X1|W|T");
    expect(met).not.toHaveProperty("baseLocked");
    const kept = run("BP");
    expect(kept.cardKeys).toBe("X2|W|T");
    // D83 (#165) flipped this expectation: a variant names its slot and, with fixed aspects, its penalty.
    expect(kept.variants).toContainEqual({ title: "Ritual Like", slot: "A", cost: 3, penalty: 0, leaderInclusion: 0.8, baseLocked: "Tatooine" });
  });

  it("find_pairings: a pinned location clears the Tatooine clause under Jundland Wastes and keeps it under Origin Tree, and Kashyyyk clears under Origin Tree (#150)", () => {
    const dragon = mk("RD", "Ritual Dragon", { offers: ["offers:x"], aspects: ["Cunning"], cost: 8, abilities: [{ repeat: "constant", text: LOCK }] });
    const cell = mk("SC", "Soaring Can-Cell", { offers: ["offers:x"], aspects: ["Cunning"], cost: 2, abilities: [{ repeat: "constant", text: "While you control a Kashyyyk base, this unit gains Ambush." }] });
    const origin = mk("OT", "Origin Tree", { type: "Base", icons: ["Command"], traits: ["Kashyyyk"] });
    const jundland = mk("JW", "Jundland Wastes", { type: "Base", icons: ["Command"], traits: ["Tatooine"] });
    const fx = createSynergyContext([leader, origin, jundland, dragon, cell, want, tail], t, file);
    const at = (base: string, key: string) => body(findPairings(fx, { cardKey: "W", direction: "enablers", leader: "LK", base, withAlternatives: false, evidence: false })).pairings.find((p: any) => p.cardKey === key);
    expect(at("OT", "RD")).toMatchObject({ baseLocked: "Tatooine" });
    expect(at("JW", "RD")).not.toHaveProperty("baseLocked");
    expect(at("OT", "SC")).not.toHaveProperty("baseLocked");
    expect(at("JW", "SC")).toMatchObject({ baseLocked: "Kashyyyk" });
  });
});

describe("a base-locked partner stays last past the perLink cap, and curated evidence quotes its clause (#154, D63)", () => {
  const LOCK = "While you control a Tatooine base, friendly units enter play ready.";
  const free = [1, 2, 3].map((i) => mk(`F${i}`, `Free Feeder ${i}`, { offers: ["offers:x"], aspects: ["Command"], cost: 3, why: { "offers:x": "text: Friendly units get +1/+0." } }));
  // The locked card's link is the only row of its kind, so the perLink cap lists it among the first rows; its tag comes from the curated table.
  const locked = mk("L", "Ritual Dragon", {
    offers: ["offers:z"],
    aspects: ["Command"],
    cost: 8,
    abilities: [{ repeat: "constant", text: LOCK }],
    why: { "offers:z": "curated cur-9001" },
  });
  const want = mk("W", "Wanter", { wants: ["wants:x", "wants:z"], aspects: ["Command"], cost: 3, why: { "wants:x": "text: Wants x.", "wants:z": "text: Wants z." } });
  const leader = mk("LK", "Lock Leader", { type: "Leader", icons: ["Command", "Heroism"] });
  const origin = mk("OT", "Origin Tree", { type: "Base", icons: ["Command"], traits: ["Kashyyyk"] });
  const jundland = mk("JW", "Jundland Wastes", { type: "Base", icons: ["Command"], traits: ["Tatooine"] });
  const t = table([
    { id: "r1", offers: { "offers:x": 1 }, wants: { "wants:x": 1 } },
    { id: "r2", offers: { "offers:z": 1 }, wants: { "wants:z": 1 } },
  ]);
  const file = leaderCardsFile("LK", "Lock Leader", ["Command", "Heroism"], [["L", 0.9], ["F1", 0.1], ["F2", 0.1], ["F3", 0.1], ["W", 0.5]]);
  const curated = new Map([["cur-9001", "text: Play a unit from your hand (paying its cost)."]]);
  const ctx = createSynergyContext([leader, origin, jundland, ...free, locked, want], t, file, curated);
  const call = (extra: object) => body(findPairings(ctx, { cardKey: "W", direction: "enablers", leader: "LK", base: "OT", withAlternatives: false, ...extra }));
  const order = (o: Record<string, any>): string[] => o.pairings.map((p: any) => p.cardKey);

  it.each([
    ["leader-weighted", {}],
    ["weighting none", { weighting: "none" }],
  ])("%s: the locked partner follows every unlocked one although perLink 1 would list its unique link second", (_, extra) => {
    const out = call({ perLink: 1, ...extra });
    expect(order(out)[3]).toBe("L");
    expect(order(out).slice(0, 3).sort()).toEqual(["F1", "F2", "F3"]);
    expect(out.pairings[3]).toMatchObject({ baseLocked: "Tatooine" });
    expect(out.capped).toBe(2);
  });

  it("keeps the unlocked rows' own cap order: the first row of each link ahead of the repeats", () => {
    const rowsOf = (o: Record<string, any>) => o.pairings.map((p: any) => p.link);
    const out = call({ perLink: 1 });
    expect(rowsOf(out).slice(0, 3)).toEqual(Array(3).fill("offers:x -> wants:x"));
  });

  it("a base of the named location returns the partner to its rank", () => {
    const out = body(findPairings(ctx, { cardKey: "W", direction: "enablers", leader: "LK", base: "JW", perLink: 1, withAlternatives: false }));
    expect(order(out)).toContain("L");
    expect(order(out)[3]).not.toBe("L");
    expect(out.pairings.find((p: any) => p.cardKey === "L")).not.toHaveProperty("baseLocked");
  });

  it("evidence quotes the curated clause with source naming the curated side, and a grammar row carries no source", () => {
    const out = call({ perLink: 100 });
    const dragon = out.pairings.find((p: any) => p.cardKey === "L");
    expect(dragon.evidence).toEqual([{ offer: "text: Play a unit from your hand (paying its cost).", want: "text: Wants z.", source: "curated offer" }]);
    const feeder = out.pairings.find((p: any) => p.cardKey === "F1");
    expect(feeder.evidence).toEqual([{ offer: "text: Friendly units get +1/+0.", want: "text: Wants x." }]);
    expect(findPairings(ctx, { cardKey: "W", leader: "LK", perLink: 100 }).content[0].text).not.toMatch(/curated cur-\d/);
  });

  it("a curated id the table lacks reads no clause text recorded and never prints the id", () => {
    const bare = createSynergyContext([leader, origin, ...free, locked, want], t, file);
    const text = findPairings(bare, { cardKey: "W", leader: "LK", perLink: 100 }).content[0].text;
    expect(text).toContain("(no clause text recorded)");
    expect(text).not.toMatch(/curated cur-\d/);
  });
});

describe("find_trios ranks a trio with a base-locked member after every unlocked trio (#154, D63)", () => {
  const LOCK = "While you control a Tatooine base, friendly units enter play ready.";
  const link = (key: string, wants: string | null, offers: string | null, locked = false) =>
    mk(key, `Card ${key}`, {
      aspects: ["Command"],
      cost: 2,
      ...(wants === null ? {} : { wants: [wants] }),
      ...(offers === null ? {} : { offers: [offers] }),
      abilities: locked ? [{ repeat: "constant", text: LOCK }] : [],
      why: { ...(wants === null ? {} : { [wants]: `text: ${key} wants` }), ...(offers === null ? {} : { [offers]: `text: ${key} offers` }) },
    });
  const leader = mk("LK", "Lock Leader", { type: "Leader", icons: ["Command", "Heroism"] });
  const origin = mk("OT", "Origin Tree", { type: "Base", icons: ["Command"], traits: ["Kashyyyk"] });
  const t = table([
    { id: "r1", offers: { "offers:x": 1 }, wants: { "wants:x": 1 } },
    { id: "r2", offers: { "offers:y": 1 }, wants: { "wants:y": 1 } },
    { id: "r3", offers: { "offers:p": 1 }, wants: { "wants:p": 1 } },
    { id: "r4", offers: { "offers:q": 1 }, wants: { "wants:q": 1 } },
  ]);
  // Two chains with no shared card: U1 > U2 > U3 is open; V1 > V2 > V3 holds V1, which needs a Tatooine base, and the leader's lists play all of V.
  const pool = [
    leader,
    origin,
    link("U1", null, "offers:x"),
    link("U2", "wants:x", "offers:y"),
    link("U3", "wants:y", null),
    link("V1", null, "offers:p", true),
    link("V2", "wants:p", "offers:q"),
    link("V3", "wants:q", null),
  ];
  const file = leaderCardsFile("LK", "Lock Leader", ["Command", "Heroism"], [["V1", 0.95], ["V2", 0.95], ["V3", 0.95], ["U1", 0.05], ["U2", 0.05], ["U3", 0.05]]);
  const ctx = createSynergyContext(pool, t, file);
  const run = (extra: object) => body(findTrios(ctx, { leader: "LK", minPlayed: 0, withAlternatives: false, evidence: false, limit: 10, ...extra })).trios;

  it("lists the unlocked trio first although the locked one has the higher rank", () => {
    const trios = run({ base: "OT" });
    expect(trios.map((x: any) => x.cardKeys)).toEqual(["U1|U2|U3", "V1|V2|V3"]);
    expect(trios[1]).toMatchObject({ baseLocked: "Tatooine" });
    expect(trios[0]).not.toHaveProperty("baseLocked");
    expect(trios[1].rank).toBeGreaterThan(trios[0].rank);
  });

  it("keeps the rank order when the base meets the lock", () => {
    const jundland = mk("JW", "Jundland Wastes", { type: "Base", icons: ["Command"], traits: ["Tatooine"] });
    const met = body(findTrios(createSynergyContext([...pool, jundland], t, file), { leader: "LK", base: "JW", minPlayed: 0, withAlternatives: false, evidence: false, limit: 10 })).trios;
    expect(met.map((x: any) => x.cardKeys)).toEqual(["V1|V2|V3", "U1|U2|U3"]);
    expect(met[0]).not.toHaveProperty("baseLocked");
  });
});

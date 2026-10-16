import { describe, expect, it } from "vitest";
import {
  SWU_CONDITION_CATS,
  SWU_EFFECT_CATS,
  type SwuTarget,
} from "../../src/schemas/card-features.js";
import {
  SWU_PRODUCTIONS,
  normalizeText,
  parseClause,
  parseHeader,
  parseKeywordList,
  parseTarget,
  splitHeader,
  splitSentences,
  stripReminders,
  extractGranted,
} from "../../src/ability-grammar/index.js";

const tgt = (t: SwuTarget | undefined): string | undefined =>
  t && [t.side, t.kind, t.arena, t.quant, t.restrict.join(",")].join("/");

const effectsOf = (clause: string) => parseClause(clause).accepted.effect.map((e) => [e.cat, e.n, tgt(e.target)] as const);

// One real clause per effect category, taken from the 2026-10-16 card set.
const GOLDEN: readonly (readonly [string, string, number | string | undefined, string | undefined])[] = [
  ["A friendly unit loses all abilities for this round.", "blank", 1, undefined],
  ["You may return a non-leader unit that costs 3 or less to its owner's hand.", "bounce", 1, "any/unit/any/one/cost_le_3,non_leader"],
  ["The chosen unit captures it.", "capture", 1, "ref/ref/any/one/"],
  ["If you do, use that ability again.", "copy_ability", 1, undefined],
  ["Each unit that opponent plays this phase costs 1 resource more.", "cost_increase", 1, undefined],
  ["The first upgrade you play on this unit each round costs [1 resource] less.", "cost_reduction", 1, undefined],
  ["If you attacked with a non-token Vehicle unit this phase, create a TIE Fighter token.", "create_token", 1, undefined],
  ["If you do, deal 1 damage to a unit.", "damage", 1, "any/unit/any/one/"],
  ["You may defeat a space unit that costs 3 or less.", "defeat", 1, "any/unit/space/one/cost_le_3"],
  ["They discard a card from their hand.", "discard_opponent", 1, undefined],
  ["Discard a card that costs 3 or more from your hand.", "discard_self", 1, undefined],
  ["If you do, draw a card.", "draw", 1, undefined],
  ["Exhaust a non-leader unit.", "exhaust", 1, "any/unit/any/one/non_leader"],
  ["Attack with a space unit.", "extra_attack", 1, "any/unit/space/one/"],
  ["The Force is with you.", "gain_force", 1, undefined],
  ["If it's not a unit, give an Experience token to another unit.", "give_token", undefined, "any/unit/any/one/other"],
  ["Attached unit gains Restore 2.", "grant_keyword", undefined, "self/unit/any/one/"],
  ["Heal 3 damage from a unit or base.", "heal", 3, "any/unit_or_base/any/one/"],
  ["Ignore the aspect penalties on non-Villainy Official units you play.", "ignore_aspect_penalty", undefined, undefined],
  ["If you do, deal 1 indirect damage to a player.", "indirect_damage", 1, "any/player/any/one/"],
  ["Look at an opponent's hand.", "look", 1, undefined],
  ["Discard a card from the defending player's deck.", "mill", 1, undefined],
  ["If you do, its controller creates an X-Wing token.", "opponent_token", 1, undefined],
  ["Play a unit from your hand.", "play_extra", 1, undefined],
  ["The next time damage would be dealt to it this phase, prevent that damage.", "prevent_damage", "all", undefined],
  ["You may put the top card of your deck into play as a resource.", "ramp", 1, undefined],
  ["If you do, ready a Resistance unit.", "ready", 1, "any/unit/any/one/trait:Resistance"],
  ["For each friendly unit or upgrade that has an odd cost, ready a resource.", "ready_resource", 1, undefined],
  ["You may return an Underworld card from your discard pile to your hand.", "recursion", 1, "any/card/any/one/trait:Underworld"],
  ["Each enemy unit loses Hidden for this phase.", "remove_keyword", 1, undefined],
  ["This upgrade can't be defeated by enemy card abilities.", "restriction", undefined, "self/upgrade/any/one/"],
  ["Search the top 7 cards of your deck for a unit, reveal it, and play it.", "search", 7, undefined],
  ["Defeat this unit.", "self_defeat", 1, undefined],
  ["You may exhaust this leader.", "self_exhaust", 1, undefined],
  ["While you control a Force unit or a Force upgrade, this unit gets +1/+1.", "stat_mod", undefined, "self/unit/any/one/"],
  ["Take control of that unit.", "take_control", 1, "ref/unit/any/one/"],
  ["The next time you take the initiative this phase, exhaust all units.", "take_initiative", 1, undefined],
];

describe("rung 3 golden clauses", () => {
  it.each(GOLDEN)("%s", (clause, cat, n, target) => {
    expect(effectsOf(clause)).toContainEqual([cat, n, target]);
  });

  it("leaves only the two categories no card in the set uses without a golden clause", () => {
    const covered = new Set(GOLDEN.map((g) => g[1]));
    expect(SWU_EFFECT_CATS.filter((c) => !covered.has(c)).sort()).toEqual(["exhaust_resource", "move_token"]);
  });

  it("keeps the shared category lists in step with the productions", () => {
    const effectCats = new Set<string>(SWU_EFFECT_CATS);
    const conditionCats = new Set<string>(SWU_CONDITION_CATS);
    for (const p of SWU_PRODUCTIONS) {
      if (p.layer === "effect") expect(effectCats.has(p.cat), `${p.id} -> ${p.cat}`).toBe(true);
      if (p.layer === "condition") expect(conditionCats.has(p.cat), `${p.id} -> ${p.cat}`).toBe(true);
    }
  });

  it("classifies on an effect or structure, never on a condition alone", () => {
    expect(parseClause("If you control 3 or more resources.").classified).toBe(false);
    expect(parseClause("Draw a card.").classified).toBe(true);
  });

  it("returns content words nothing consumed as residue", () => {
    const r = parseClause("Draw a card and frobnicate the widget.");
    expect(r.classified).toBe(true);
    expect(r.residueWords).toContain("frobnicate");
  });
});

describe("trigger headers", () => {
  it.each([
    ["When Played", "when_played", "once_on_play"],
    ["On Attack", "on_attack", "per_attack"],
    ["When Defeated", "when_defeated", "once_on_defeat"],
    ["When Deployed", "when_deployed", "once_on_play"],
    ["When this unit completes an attack", "attack_end", "per_attack"],
    ["When Attack Ends", "attack_end", "per_attack"],
    ["When this unit attacks and defeats a unit", "on_attack_kill", "per_attack"],
    ["When attached unit is attacked", "on_defense", "per_defense"],
    ["When deployed as an upgrade", "when_played_as_upgrade", "once_on_play"],
    ["When you take the initiative", "take_initiative", "per_round"],
    ["When the first action phase starts", "phase_start", "per_round"],
    ["When a friendly unit is defeated", "reactive_friendly", "per_event"],
    ["When an opponent draws 1 or more cards during the action phase", "reactive_opponent", "per_event"],
    ["When this upgrade attaches to a unit", "reactive_self", "per_event"],
    ["When you use a When Defeated ability", "reactive_you", "per_event"],
    ["When 1 or more damage is healed from this unit", "reactive_other", "per_event"],
  ])("%s", (header, trigger, repeat) => {
    expect(parseHeader(header)).toEqual([{ trigger, repeat, text: header }]);
  });

  it("parses an Epic Action as once per game", () => {
    expect(parseHeader("Epic Action")[0]).toMatchObject({ trigger: "epic_action", repeat: "once_per_game" });
  });

  it("splits compound headers on a slash", () => {
    expect(parseHeader("When Played/On Attack").map((t) => t.trigger)).toEqual(["when_played", "on_attack"]);
  });

  it("parses action costs, and an exhaust cost makes it once per round", () => {
    const [t] = parseHeader("Action [Exhaust, 2 resources, Use the Force]");
    expect(t.trigger).toBe("action");
    expect(t.repeat).toBe("per_round");
    expect(t.cost).toEqual({ exhaust: true, resources: 2, force: true, other: [] });
    expect(parseHeader("Action [3 resources]")[0].repeat).toBe("repeatable_paid");
  });

  it("flags a header no rule recognises", () => {
    expect(parseHeader("Some Odd Header")).toEqual([{ trigger: "unknown_header", repeat: "unknown", text: "Some Odd Header" }]);
  });
});

describe("target parser", () => {
  it.each([
    ["a friendly unit", { side: "friendly", kind: "unit", arena: "any", quant: "one" }],
    ["an enemy unit", { side: "enemy", kind: "unit", arena: "any", quant: "one" }],
    ["a friendly unit you control", { side: "friendly", kind: "unit" }],
    ["a friendly and enemy unit", { side: "mixed", kind: "unit" }],
    ["this unit", { side: "self", kind: "unit" }],
    ["attached unit", { side: "self", kind: "unit" }],
    ["that unit", { side: "ref", kind: "unit" }],
    ["it", { side: "ref", kind: "ref" }],
    ["a ground unit", { arena: "ground", kind: "unit" }],
    ["a space unit", { arena: "space", kind: "unit" }],
    ["a ground or space unit", { arena: "both" }],
    ["a unit in the same arena", { arena: "same" }],
    ["a unit in a different arena", { arena: "other" }],
    ["a base", { kind: "base" }],
    ["a unit or base", { kind: "unit_or_base" }],
    ["an upgrade", { kind: "upgrade" }],
    ["an Experience token", { kind: "token" }],
    ["a card", { kind: "card" }],
    ["a player", { kind: "player" }],
    ["each enemy unit", { quant: "all", side: "enemy" }],
    ["up to 3 friendly units", { quant: "up_to_3" }],
    ["2 units", { quant: "exactly_2" }],
    ["any number of units", { quant: "any_number" }],
  ])("%s", (text, expected) => {
    expect(parseTarget(text)).toMatchObject(expected);
  });

  it.each([
    ["a non-leader unit", ["non_leader"]],
    ["a non-unique unit", ["non_unique"]],
    ["a unique unit", ["unique"]],
    ["a damaged unit", ["damaged"]],
    ["an undamaged unit", ["undamaged"]],
    ["an exhausted unit", ["exhausted"]],
    ["another friendly unit", ["other"]],
    ["a unit with 3 or less remaining HP", ["hp_le_3"]],
    ["a unit with 4 or less power", ["power_le_4"]],
    ["a unit that costs 3 or less", ["cost_le_3"]],
    ["a unit that costs 5 or more", ["cost_ge_5"]],
    ["a Rebel unit", ["trait:Rebel"]],
    ["a non-Imperial unit", ["non_trait:Imperial"]],
    ["a Heroism unit", ["aspect:Heroism"]],
    ["a Bounty Hunter unit", ["trait:Bounty Hunter"]],
  ])("restriction: %s", (text, restrict) => {
    expect(parseTarget(text).restrict).toEqual(restrict);
  });

  it("sorts restrictions by code point and removes duplicates", () => {
    expect(parseTarget("another damaged non-leader Rebel unit").restrict).toEqual(["damaged", "non_leader", "other", "trait:Rebel"]);
  });

  it("is a pure function of its input", () => {
    expect(parseTarget("a friendly ground unit")).toEqual(parseTarget("a friendly ground unit"));
  });
});

describe("segmentation", () => {
  it("normalises quotes, minus signs, the unique marker and bullets", () => {
    expect(normalizeText("Give it –1/–1. Don’t.")).toBe("Give it -1/-1. Don't.");
    expect(normalizeText("a <uq> (unique) unit")).toBe("a unique unit");
    expect(normalizeText("a non-<uq> (non-unique) unit")).toBe("a non-unique unit");
    expect(normalizeText("A<bullet>B")).toBe("A\nB");
    expect(normalizeText("AggressionAggressionVillainy")).toBe("Aggression Aggression Villainy");
    expect(normalizeText(null)).toBe("");
  });

  it("strips reminder text and records that it was there", () => {
    expect(stripReminders("Raid 2 (This unit gets +2/+0 while attacking.)")).toEqual({ text: "Raid 2", removed: 1 });
    expect(stripReminders("(Only reminder text.)").text).toBe("");
  });

  it("lifts a long quoted ability out as a granted slot", () => {
    const { body, granted } = extractGranted("Attached unit gains “On Attack: Draw a card.”");
    expect(body).toBe("Attached unit gains ⟦G0⟧");
    expect(granted).toEqual(["On Attack: Draw a card."]);
  });

  it("keeps a short quote with no colon inline as a reference, not a grant", () => {
    const { body, granted } = extractGranted("This unit gains “When Defeated”");
    expect(granted).toEqual([]);
    expect(body).toBe("This unit gains When Defeated");
  });

  it("splits a header from its body and refuses a colon that opens a quote", () => {
    expect(splitHeader("On Attack: Draw a card.")).toEqual({ header: "On Attack", body: "Draw a card." });
    expect(splitHeader("Attached unit gains: ⟦G0⟧").header).toBeNull();
  });

  it("splits sentences and a modal opener", () => {
    expect(splitSentences("Draw a card. Discard a card.")).toEqual(["Draw a card.", "Discard a card."]);
    expect(splitSentences("Choose one: Draw a card.")).toEqual(["Choose one:", "Draw a card."]);
  });

  it("parses keyword lists with a number or a cost", () => {
    expect(parseKeywordList("Raid 2, Sentinel")).toEqual([{ keyword: "Raid", n: 2 }, { keyword: "Sentinel" }]);
    expect(parseKeywordList("Piloting [2 resources Command]")).toEqual([{ keyword: "Piloting", cost: "2 resources Command", n: 2 }]);
  });
});

describe("known precision bugs from the prototype", () => {
  it("treats \"doesn't ready\" as a restriction, not a ready", () => {
    const cats = effectsOf("This unit doesn't ready during the regroup phase.").map((e) => e[0]);
    expect(cats).toContain("restriction");
    expect(cats).not.toContain("ready");
  });

  it("parses \"give a unit +2/+2\" without \"gains\" as a stat buff", () => {
    expect(parseClause("Give a unit +2/+2 for this phase.").accepted.effect[0]).toMatchObject({ cat: "stat_mod", power: 2, hp: 2, sign: "buff" });
  });

  it("separates a fight (\"X deals damage equal to its power to Y\") from \"deal damage to X equal to Y\"", () => {
    const fight = parseClause("A friendly unit deals damage equal to its power to an enemy unit.").accepted.effect[0];
    expect(fight).toMatchObject({ rule: "damage_equal", fight: true });
    const plain = parseClause("Deal damage to a unit equal to the number of cards in your hand.").accepted.effect[0];
    expect(plain).toMatchObject({ rule: "damage_to_equal" });
  });

  it("reads an en-dash debuff as a debuff", () => {
    const text = normalizeText("Give an enemy unit –2/–2 for this phase.");
    expect(parseClause(text).accepted.effect[0]).toMatchObject({ cat: "stat_mod", sign: "debuff" });
  });
});

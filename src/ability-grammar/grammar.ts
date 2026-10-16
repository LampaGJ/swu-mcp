import type { SwuFeature, SwuFeatureFields, SwuTarget } from "./deps.js";
import { compareCodePoints } from "./deps.js";
import { KW_ITEM, parseKeywordList } from "./segment.js";
import { ASPECTS, KW_ALT, TOKEN_ALT, TRAIT_WORDS, alternation } from "./vocab.js";

const TRAIT_RE = new RegExp(`\\b(non-)?(${alternation(TRAIT_WORDS)})\\b`, "g");
const ASPECT_RE = new RegExp(`\\b(non-)?(${alternation(ASPECTS)})\\b`, "g");

/**
 * @displayName SWU target parser
 * @strategicPurpose Every effect needs to know who it hits; one parser keeps
 * "friendly", "enemy" and "this unit" meaning the same thing in every production.
 * @tacticalObjective Turns a target phrase into side, kind, arena, quantifier
 * and sorted restrictions (non_leader, damaged, hp_le_N, trait:X, aspect:X).
 */
export function parseTarget(raw: string | undefined): SwuTarget {
  const s = (raw ?? "").trim();
  const l = s.toLowerCase();
  const t: SwuTarget = { side: "any", kind: "ref", arena: "any", quant: "one", restrict: [], text: "" };
  if (/\bfriendly\b|\byour (?:units?|bases?|leader|hand|deck|discard|resources)\b|\byou control\b/.test(l)) t.side = "friendly";
  if (/\benemy\b|\bopponent'?s?'?\b|\bthe defender\b|\bthe attacker\b|\bdefending unit\b|\bthey control\b/.test(l)) {
    t.side = t.side === "friendly" ? "mixed" : "enemy";
  }
  if (/^(?:this|attached) (?:unit|leader|upgrade)\b|^(?:it|him|her|itself|this leader)$|^(?:that|the chosen|each chosen|the attacking) unit\b|^them$/.test(l)) {
    t.side = /^(?:this|attached)/.test(l) || /^(?:him|her|itself|this leader)$/.test(l) ? "self" : "ref";
  }
  if (/\bunits? or (?:a |an )?(?:[a-z']+ )?bases?\b|\bbases? or (?:a |an )?units?\b/.test(l)) t.kind = "unit_or_base";
  else if (/\bbases?\b/.test(l)) t.kind = "base";
  else if (/\bupgrades?\b/.test(l)) t.kind = "upgrade";
  else if (/\btokens?\b/.test(l)) t.kind = "token";
  else if (/\bcards?\b/.test(l)) t.kind = "card";
  else if (/\bunits?\b/.test(l)) t.kind = "unit";
  else if (/\bleader\b/.test(l)) t.kind = "leader";
  else if (/\b(?:player|opponent)\b/.test(l)) t.kind = "player";
  if (/\bground\b/.test(l)) t.arena = "ground";
  if (/\bspace\b/.test(l)) t.arena = t.arena === "ground" ? "both" : "space";
  if (/\bin the same arena\b/.test(l)) t.arena = "same";
  if (/\bin a different arena\b/.test(l)) t.arena = "other";
  let m: RegExpMatchArray | null;
  if (/^(?:each|all)\b/.test(l)) t.quant = "all";
  if ((m = l.match(/\bup to (\d+)\b/))) t.quant = `up_to_${m[1]}`;
  else if ((m = l.match(/^(\d+) /))) t.quant = `exactly_${m[1]}`;
  if (/^any number of\b/.test(l)) t.quant = "any_number";
  if (/\bnon-leader\b/.test(l)) t.restrict.push("non_leader");
  if (/\bnon-unique\b/.test(l)) t.restrict.push("non_unique");
  else if (/\bunique\b/.test(l)) t.restrict.push("unique");
  if (/\bnon-token\b/.test(l)) t.restrict.push("non_token");
  if (/\bundamaged\b/.test(l)) t.restrict.push("undamaged");
  else if (/\bdamaged\b/.test(l)) t.restrict.push("damaged");
  if (/\bexhausted\b/.test(l)) t.restrict.push("exhausted");
  if (/\b(?:another|other)\b/.test(l)) t.restrict.push("other");
  if ((m = l.match(/\bwith (\d+) or (?:less|fewer) remaining hp\b/))) t.restrict.push(`hp_le_${m[1]}`);
  if ((m = l.match(/\bwith (\d+) or less power\b/))) t.restrict.push(`power_le_${m[1]}`);
  if ((m = l.match(/\bthat costs? (\d+) or less\b|\bcosting (\d+) or less\b/))) t.restrict.push(`cost_le_${m[1] ?? m[2]}`);
  if ((m = l.match(/\bthat costs? (\d+) or more\b/))) t.restrict.push(`cost_ge_${m[1]}`);
  if (/\bwith less remaining hp than\b/.test(l)) t.restrict.push("hp_lt_ref");
  for (const tm of s.matchAll(TRAIT_RE)) t.restrict.push(`${tm[1] ? "non_" : ""}trait:${tm[2]}`);
  for (const am of s.matchAll(ASPECT_RE)) t.restrict.push(`${am[1] ? "non_" : ""}aspect:${am[2]}`);
  t.restrict = [...new Set(t.restrict)].sort(compareCodePoints);
  t.text = s;
  return t;
}

type Groups = Record<string, string | undefined>;
type Layer = "effect" | "condition" | "structure" | "modifier";
type Build = (g: Groups, whole: string) => SwuFeatureFields;

interface Production {
  id: string;
  cat: string;
  layer: Layer;
  re: RegExp;
  build: Build;
}

const NUMBER_WORDS = new Map<string, number>([["a", 1], ["an", 1], ["one", 1], ["two", 2], ["three", 3]]);
function numOf(x: string | undefined): number | "var" {
  if (x == null) throw new Error("numOf: missing capture group");
  const word = NUMBER_WORDS.get(x.toLowerCase());
  if (word !== undefined) return word;
  return /^\d+$/.test(x) ? Number(x) : "var";
}

/** Target phrase: lazy up to a clause boundary or a coordinated next effect. */
const TGT =
  "(?<tgt>[^.;:⟦]+?)(?=$|[.;:⟦]|, (?:then |and |or |if |you |deal |give |draw |heal |exhaust |ready |defeat |create |return |play |attack |reveal |search |discard |put |shuffle )| and (?:\\d+ |deal |give |draw |heal |exhaust |ready |defeat |create |return |play |attack |reveal |search |discard |put |shuffle |it |they |that |gains? |gets? |can't )| for this (?:phase|attack|round)| instead| if | unless | to their | to its | to your hand| from (?:your|their|its|a) | for each |, even)";

const PRODUCTIONS: Production[] = [];
const def = (id: string, cat: string, layer: Layer, src: string, build: Build): void => {
  PRODUCTIONS.push({ id, cat, layer, re: new RegExp(src, "gi"), build });
};
const str = (x: string | undefined): string => x ?? "";

// --- damage
def("damage_equal", "damage", "effect",
  `(?<src>\\b(?:a|an|another|each|that|this|the) (?:friendly |enemy )?[^.;,]*?units? )?\\bdeals? (?:indirect )?damage equal to (?<eq>[^.;]+?) to ${TGT}`,
  (g, w) => ({ n: "var", indirect: /indirect/i.test(w), basis: g.eq, fight: !!g.src, source: g.src ? parseTarget(g.src) : null, target: parseTarget(g.tgt) }));
def("damage_to_equal", "damage", "effect", "\\bdeal damage to (?<tgt>[^.;]+?) equal to (?<eq>[^.;]+)",
  (g) => ({ n: "var", basis: g.eq, target: parseTarget(g.tgt) }));
def("damage_divided", "damage", "effect",
  `\\bdeal (?:up to )?(?<n>\\d+|X) damage divided as you choose among ${TGT}`,
  (g) => ({ n: numOf(g.n), divided: true, target: parseTarget(g.tgt) }));
def("damage_indirect", "indirect_damage", "effect",
  `\\bdeal (?<n>\\d+|X) indirect damage to ${TGT}`,
  (g) => ({ n: numOf(g.n), target: parseTarget(g.tgt) }));
def("damage_each_of", "damage", "effect",
  `\\bdeal (?<n>\\d+|X) damage to each of ${TGT}`,
  (g) => ({ n: numOf(g.n), target: parseTarget(`each of ${str(g.tgt)}`) }));
def("damage", "damage", "effect",
  `\\bdeals? (?:up to )?(?<n>\\d+|X) (?:unpreventable )?damage to ${TGT}`,
  (g) => ({ n: numOf(g.n), target: parseTarget(g.tgt) }));
def("damage_continuation", "damage", "effect",
  `\\band (?<n>\\d+) damage to ${TGT}`,
  (g) => ({ n: numOf(g.n), target: parseTarget(g.tgt) }));
def("damage_unspecified", "damage", "effect",
  `\\bdeal (?:that much|its|their|that) (?:combat )?damage to ${TGT}`,
  (g) => ({ n: "var", target: parseTarget(g.tgt) }));

// --- removal
def("defeat_self", "self_defeat", "effect", "\\bdefeat (?:this unit|this upgrade|attached unit|it|him|her)\\b", () => ({ n: 1 }));
def("defeat_all", "defeat", "effect", "\\bdefeat (?<tgt>(?:all|each) [^.;:⟦]+?)(?=$|[.;:]| if |, then)",
  (g) => ({ n: "all", target: parseTarget(g.tgt) }));
def("defeat", "defeat", "effect", `\\bdefeat ${TGT}`, (g) => ({ n: 1, target: parseTarget(g.tgt) }));
def("capture", "capture", "effect", `\\bcaptures? ${TGT}`, (g) => ({ n: 1, target: parseTarget(g.tgt) }));
def("bounce", "bounce", "effect",
  `\\breturn ${TGT} to (?:its|their) owner'?s?'? hands?`,
  (g) => ({ n: 1, target: parseTarget(g.tgt) }));
def("take_control", "take_control", "effect", `\\b(?<who>an opponent |its owner |that unit's owner )?takes? control of ${TGT}`,
  (g) => ({ n: 1, toOpponent: !!g.who, target: parseTarget(g.tgt) }));

// --- heal
def("heal", "heal", "effect",
  `\\bheal (?<n>\\d+|X|all|up to \\d+) damage from ${TGT}`,
  (g) => {
    const n = str(g.n);
    return { n: n.startsWith("up to") ? Number(n.slice(6)) : n === "all" ? "all" : numOf(n), target: parseTarget(g.tgt) };
  });
def("heal_equal", "heal", "effect", `\\bheal damage from ${TGT} equal to`, (g) => ({ n: "var", target: parseTarget(g.tgt) }));

// --- card flow
def("draw", "draw", "effect", "\\bdraws? (?<n>\\d+|a|an|X|that many) cards?\\b", (g) => ({ n: g.n === "that many" ? "var" : numOf(g.n) }));
def("draw_ref", "draw", "effect", "\\b(?:and|,) draw (?:it|them|that card)\\b", () => ({ n: "ref" }));
def("search", "search", "effect",
  "\\bsearch the top (?<n>\\d+|X) cards of your deck for (?<for>[^.;]+?)(?=$|[.;]|, reveal)",
  (g) => ({ n: numOf(g.n), for: g.for, upTo: (str(g.for).match(/up to (\d+)/) || [])[1] ?? null }));
def("look", "look", "effect",
  "\\blook at (?:the top (?<n>\\d+) cards? of (?:your|an opponent's|their) deck|an opponent's hand|the top card of (?:your|an opponent's|each player's) deck)",
  (g) => ({ n: g.n ? Number(g.n) : 1 }));
def("reveal_ref", "reveal", "structure", "\\breveal (?:it|them|that card|the top card of your deck)\\b", () => ({}));
def("discard_opponent", "discard_opponent", "effect",
  "\\b(?:an opponent|each opponent|that player|each player|the defending player|they) discards? (?<n>\\d+|a|an) cards?(?: from (?:their|his or her) hand)?",
  (g) => ({ n: numOf(g.n) }));
def("discard_self", "discard_self", "effect",
  "\\bdiscard (?<n>\\d+|a|an|any number of)(?: [A-Za-z'-]+){0,4}? cards?(?: that costs? \\d+ or (?:more|less))? from your hand",
  (g) => ({ n: g.n === "any number of" ? "var" : numOf(g.n) }));
def("mill_plain", "mill", "effect",
  "\\bdiscards? (?<n>\\d+|a|an|X) cards? from (?<who>your|the defending player's|an opponent's|their|each player's|its controller's) deck",
  (g) => ({ n: numOf(g.n), whose: g.who }));
def("mill", "mill", "effect", "\\bdiscard the top (?<n>\\d+|X) cards? of (?<who>your|an opponent's|their|each player's) deck",
  (g) => ({ n: numOf(g.n), whose: g.who }));
def("discard_chosen", "discard_opponent", "effect", "\\bdiscard (?:a|that) card from (?:their|an opponent's) hand", () => ({ n: 1 }));
def("recursion", "recursion", "effect",
  `\\breturn ${TGT} from your discard pile to your hand`,
  (g) => ({ n: 1, target: parseTarget(g.tgt) }));

// --- tokens
def("give_tokens", "give_token", "effect",
  `\\bgive (?<n1>\\d+|a|an|X) (?<tok1>${TOKEN_ALT}) tokens?(?: and (?<n2>\\d+|a|an) (?<tok2>${TOKEN_ALT}) tokens?)? to ${TGT}`,
  (g) => ({
    tokens: [[str(g.tok1), numOf(g.n1)], ...(g.tok2 ? [[g.tok2, numOf(g.n2)] as [string, number | "var"]] : [])],
    target: parseTarget(g.tgt),
  }));
def("create_tokens", "create_token", "effect",
  `\\bcreate (?<n>\\d+|a|an|X|two|three|that many) (?<tok>${TOKEN_ALT}) tokens?`,
  (g) => ({ token: g.tok, n: g.n === "that many" ? "var" : numOf(g.n) }));
def("force_gain", "gain_force", "effect", "\\bthe force is with you\\b", () => ({ n: 1 }));
def("move_token", "move_token", "effect", `\\bmove (?:a|an|any number of|all) (?:${TOKEN_ALT}) tokens? `, () => ({ n: 1 }));

// --- stats (structured upgradePower/upgradeHp covers printed upgrade stats; these are text buffs)
const statBuild: Build = (g) => {
  const p = str(g.p);
  const h = str(g.h);
  const pv = p.includes("X") ? "var" : Number(p);
  const hv = h.includes("X") ? "var" : Number(h);
  const tgt = (g.tgt ?? "").trim() || "this unit";
  const sum = (typeof pv === "number" ? pv : 1) + (typeof hv === "number" ? hv : 0);
  return { power: pv, hp: hv, sign: sum < 0 ? "debuff" : "buff", target: parseTarget(tgt) };
};
def("stat_give", "stat_mod", "effect", "\\bgive (?<tgt>[^.;:+⟦]+?) (?<p>[+-]\\d+|[+-]X)\\/(?<h>[+-]\\d+|[+-]X)", statBuild);
def("stat_gets", "stat_mod", "effect",
  "(?<tgt>\\b(?:the|each|a|an|this|attached|other|another|that|it|they|friendly|enemy)\\b[^.;:,+⟦]*?)?\\bgets? (?<p>[+-]\\d+|[+-]X)\\/(?<h>[+-]\\d+|[+-]X)",
  statBuild);
const SUBJ = "(?<tgt>\\b(?:attached|this|each|other|another|friendly|enemy|that|the|it|they|a|an|your)\\b[^.;:,+⟦]*?)?";
def("grant_keyword", "grant_keyword", "effect",
  `${SUBJ}\\b(?:gains?|gain|have|has) (?<kw>(?:${KW_ITEM})(?:(?:,|,? and) (?:${KW_ITEM}))*)`,
  (g) => ({ keywords: parseKeywordList(str(g.kw)), target: parseTarget((g.tgt ?? "").trim() || "this unit") }));
def("give_keyword", "grant_keyword", "effect",
  `\\bgive (?<tgt>[^.;:+⟦]+?) (?<kw>(?:${KW_ITEM})(?:(?:,|,? and) (?:${KW_ITEM}))*)(?= for| until|\\.|$|,)`,
  (g) => ({ keywords: parseKeywordList(str(g.kw)), target: parseTarget(g.tgt) }));
def("lose_abilities", "blank", "effect", "\\bloses? all (?:abilities|keywords)\\b", () => ({ n: 1 }));

// --- tempo
def("exhaust_self", "self_exhaust", "effect", "\\bexhaust (?:this unit|this leader|it|attached unit|him|her|this upgrade)\\b", () => ({ n: 1 }));
def("exhaust", "exhaust", "effect", `\\bexhaust ${TGT}`, (g) => ({ n: 1, target: parseTarget(g.tgt) }));
def("ready_resources", "ready_resource", "effect", "\\bready (?<n>\\d+|a|an) resources?\\b", (g) => ({ n: numOf(g.n) }));
def("exhaust_resources", "exhaust_resource", "effect", "\\bexhaust (?<n>\\d+|a|an) (?:of their |of your |enemy )?resources?\\b", (g) => ({ n: numOf(g.n) }));
def("no_ready", "restriction", "effect", "\\b(?<who>[^.;:,]*?)\\b(?:doesn't|don't|does not|do not) ready\\b", (g) => ({ what: "ready", target: parseTarget(g.who) }));
def("ready", "ready", "effect", `\\bready ${TGT}`, (g) => ({ n: 1, target: parseTarget(g.tgt) }));
def("enters_ready", "ready", "effect", "(?<subj>\\b(?:the next|this|each|a|an|that|the first)\\b[^.;:,]*?)?\\benters play ready\\b",
  (g) => ({ n: 1, target: parseTarget((g.subj ?? "").trim() || "this unit") }));
def("extra_attack", "extra_attack", "effect", `\\battack with ${TGT}`, (g) => ({ n: 1, target: parseTarget(g.tgt) }));
def("initiative", "take_initiative", "effect", "\\btake the initiative\\b", () => ({ n: 1 }));
def("cant", "restriction", "effect",
  "\\b(?<who>[^.;:,]*?)\\bcan't (?<what>attack|ready|be attacked|be defeated|be captured|be damaged|be healed|be played|attack bases|play events|deal damage|be targeted)",
  (g) => ({ what: g.what, target: parseTarget(g.who) }));
def("prevent", "prevent_damage", "effect", "\\bprevent (?<n>all|that|\\d+)(?: of that)? damage\\b",
  (g) => ({ n: g.n === "all" || g.n === "that" ? "all" : Number(g.n) }));

// --- resources and cost
def("ramp", "ramp", "effect",
  `\\b(?:put|resource) (?:the top card of your deck|a card from your hand|a card|${TGT}) (?:into play )?as a resource|\\bresource the top card of your deck\\b`,
  () => ({ n: 1 }));
def("cost_less_subject", "cost_reduction", "effect",
  "\\b(?<subj>(?:the (?:first|next)|each|this|that|it)\\b[^.;,]*?)\\bcosts? (?:\\[)?(?<n>\\d+|X)(?: resources?)?(?:\\])? (?:resources? )?less(?: to play)?\\b",
  (g) => ({ n: numOf(g.n), applies: parseTarget(g.subj), oneShot: /\b(?:first|next)\b/i.test(str(g.subj)) }));
def("cost_less", "cost_reduction", "effect",
  "\\bcosts? (?:\\[)?(?<n>\\d+|X)(?: resources?)?(?:\\])? (?:resources? )?less\\b", (g) => ({ n: numOf(g.n) }));
def("cost_more", "cost_increase", "effect", "\\bcosts? (?:\\[)?(?<n>\\d+)(?: resources?)?(?:\\])? (?:resources? )?more\\b", (g) => ({ n: numOf(g.n) }));
def("free", "cost_reduction", "effect", "\\bfor free\\b", () => ({ n: "all" }));
def("play_from", "play_extra", "effect",
  "\\bplay (?<what>[^.;]+?) from (?<zone>your hand|your discard pile|your resources|the top of your deck|among them|an opponent's discard pile)",
  (g) => ({ n: 1, zone: g.zone, what: g.what }));
def("play_generic", "play_extra", "effect", "\\bplay (?:a|an|that|it|the) (?:[a-z'-]+ ){0,3}(?:card|unit|event|upgrade)\\b", () => ({ n: 1, zone: "unspecified" }));
def("deploy", "deploy", "structure", "\\bdeploy (?:this leader|him|her|it)(?: as an upgrade on (?<host>[^.;]+))?", (g) => ({ asUpgrade: !!g.host }));
def("credit_pay", "cost_reduction", "effect", "\\bdefeat (?:a|any number of) friendly credit tokens?\\b", () => ({ n: "var" }));

// --- structure
def("attach_to", "attach_restriction", "structure", `^attach to ${TGT}`, (g) => ({ target: parseTarget(g.tgt) }));
def("attached_is_leader", "leader_pilot", "structure", "\\battached unit is a leader unit\\b", () => ({}));
def("gains_trait", "grant_trait", "structure", "\\bgains? the (?<t>[A-Z][A-Za-z' -]+?) trait\\b", (g) => ({ trait: g.t }));
def("granted_ref", "granted_ability", "structure", `${SUBJ}\\b(?:gains?|gets [^.;⟦]+ and gains?):? ?⟦G\\d+⟧`,
  (g) => ({ target: parseTarget((g.tgt ?? "").trim() || "this unit") }));
def("granted_bare", "granted_ability", "structure", "⟦G\\d+⟧", () => ({}));
def("disclose", "disclose", "structure", "\\bdisclose (?<icons>(?:(?:Aggression|Command|Cunning|Heroism|Vigilance|Villainy) ?)+)",
  (g) => ({ icons: str(g.icons).trim().split(" ") }));
def("name_card", "name_card", "structure", "\\bname a card\\b", () => ({}));
def("opponent_creates", "opponent_token", "effect",
  `\\b(?:an opponent|each opponent|its controller|that player) creates? (?<n>\\d+|a|an) (?<tok>${TOKEN_ALT}) tokens?`,
  (g) => ({ token: g.tok, n: numOf(g.n) }));
def("discard_from_ref", "discard_opponent", "effect", "\\bdiscard a card from (?:it|that hand|their hand)\\b", () => ({ n: 1 }));
def("opponent_chooses", "opponent_select", "structure", "\\b(?:an opponent|each player|a player|each opponent)(?: may)? chooses? (?:a|an|\\d+) [^.;]*?they control\\b", () => ({}));
def("lose_keyword", "remove_keyword", "effect", `\\b(?:loses?|lose) (?:${KW_ALT})\\b`, () => ({ n: 1 }));
def("repeat_ability", "copy_ability", "effect", "\\buse (?:that|this|the) ability again\\b", () => ({ n: 1 }));
def("return_control", "return_control", "structure", "\\bits owner (?:takes control of it|rescues it)\\b", () => ({}));
def("choose_one", "modal", "structure", "\\bchoose one\\b", () => ({}));
def("choose_unit", "select", "structure", "^choose (?<tgt>(?:a|an|another|\\d+|two|up to \\d+|any number of) [^.;]+?)\\.", (g) => ({ target: parseTarget(g.tgt) }));
def("use_force_cost", "force_cost", "structure", "\\buse the force\\b", () => ({}));
def("pay_cost", "pay_cost", "structure", "\\bpay (?<n>\\d+) resources?\\b", (g) => ({ n: Number(g.n) }));
def("once_each_round", "limit_per_round", "modifier", "\\buse this ability only once each (?:round|phase)\\b", () => ({}));
def("instead", "replacement", "modifier", "\\binstead\\b", () => ({}));

// --- conditions (never classify a clause on their own)
def("if_you_do", "if_you_do", "condition", "\\bif (?:you do|they do|it does)\\b", () => ({}));
def("control_resources", "control_resources", "condition", "\\b(?:if|while) you control (?<n>\\d+) or more resources\\b", (g) => ({ n: Number(g.n) }));
def("control_n", "control", "condition",
  "\\b(?:if|while) (?:you|an opponent) controls? (?:(?<n>\\d+) or more |(?:a|an|another) )?(?<what>[^,.;]+?)(?=,|\\.|$| and | this )",
  (g) => ({ n: g.n ? Number(g.n) : 1, what: parseTarget(g.what) }));
def("initiative_cond", "initiative", "condition", "\\b(?:if|while) (?:you have|an opponent has) the initiative\\b", () => ({}));
def("force_cond", "force", "condition", "\\b(?:if|while) the force is with you\\b", () => ({}));
def("self_state", "self_state", "condition",
  "\\b(?:if|while) (?:this|attached) unit (?:is|has) (?<st>ready|exhausted|damaged|undamaged|attacking|defending|upgraded|in the (?:ground|space) arena|a leader unit|no damage on it)",
  (g) => ({ state: g.st }));
def("this_phase", "event_this_phase", "condition",
  "\\bif (?:an? |another )?(?:enemy |friendly )?(?:[a-z]+ )?(?:unit|card|leader|event)s? (?:was|were|has been|have been) (?:defeated|played|dealt damage|healed)[^,.;]* this (?:phase|round)",
  () => ({}));
def("you_did_this_phase", "event_this_phase", "condition",
  "\\bif you (?:have )?(?:played|attacked with|dealt|defeated|drew|healed|used|attacked|discarded|resourced|disclosed)\\b[^,.;]*? this (?:phase|round)", () => ({}));
def("damage_would", "replacement_window", "condition",
  "\\b(?:the next time |if |all )?(?:combat |non-combat )?damage (?:that )?would be dealt to (?<tgt>[^,.;]+?)(?= this phase| during this attack|,|\\.|$)(?: this phase| during this attack)?",
  (g) => ({ target: parseTarget(g.tgt) }));
def("would_be_defeated", "replacement_window", "condition", "\\bif (?<tgt>[^,.;]+?) would be (?:defeated|captured|returned)", (g) => ({ target: parseTarget(g.tgt) }));
def("ignore_penalty", "ignore_aspect_penalty", "effect", "\\b(?:ignoring|ignore) (?:its|the|their) aspect penalt(?:y|ies)(?: on [^.;,]+)?", () => ({}));
def("ref_check", "target_check", "condition", "\\bif (?:it|it's|that unit|the defender|the attacker|that card|the chosen unit|the revealed card) (?:is|was|has|had|costs|'s)\\b[^,.;]*", () => ({}));
def("for_each", "scaling", "condition", "\\bfor each (?<per>[^,.;]+?)(?=$|[,.;])", (g) => ({ per: g.per }));
def("you_may", "optional", "modifier", "\\byou may\\b", () => ({}));
def("for_phase", "duration_phase", "modifier", "\\bfor this (?:phase|round)\\b", () => ({}));
def("for_attack", "duration_attack", "modifier", "\\bfor this attack\\b", () => ({}));
def("while_generic", "while_other", "condition", "^while (?<w>[^,]+),", (g) => ({ w: g.w }));
def("otherwise", "otherwise", "modifier", "\\botherwise\\b", () => ({}));

export const SWU_PRODUCTIONS: readonly Production[] = PRODUCTIONS;

/** Words that never count as unparsed residue. */
const GLUE = new Set(
  ("a an the to of and or you your it its it's that this may if do then from for with on in is are be by as " +
    "each up any one instead they their them he she him her his those these there which who also but at into onto " +
    "than so not was were has have had can can't only still other another another's chosen").split(" "),
);

function wordsOf(s: string): string[] {
  return s.toLowerCase().replace(/⟦g\d+⟧/g, " ").match(/[a-z0-9'+\-/]+/g) ?? [];
}

export type AcceptedFeature = SwuFeature & { span: [number, number] };

export interface ClauseParse {
  accepted: Record<Layer, AcceptedFeature[]>;
  classified: boolean;
  contentWords: number;
  residueWords: string[];
}

/**
 * @displayName SWU clause parser (rung 3)
 * @strategicPurpose Turns one sentence of ability text into typed effect,
 * structure, condition and modifier features without a model.
 * @tacticalObjective Runs the ordered productions layer by layer; within a
 * layer the earliest, then longest, match wins so no two matches overlap. A
 * clause is classified when an effect, a structure or a once-per-round
 * modifier fires; conditions alone never classify it. Unmatched content words
 * are returned as residue.
 */
export function parseClause(clause: string): ClauseParse {
  const accepted: Record<Layer, AcceptedFeature[]> = { effect: [], condition: [], structure: [], modifier: [] };
  for (const layer of ["effect", "structure", "modifier", "condition"] as const) {
    const cands: { pi: number; m: RegExpMatchArray; start: number; end: number }[] = [];
    for (let pi = 0; pi < PRODUCTIONS.length; pi++) {
      const pr = PRODUCTIONS[pi];
      if (pr.layer !== layer) continue;
      for (const m of clause.matchAll(pr.re)) {
        const start = m.index ?? 0;
        cands.push({ pi, m, start, end: start + m[0].length });
      }
    }
    cands.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.pi - b.pi);
    let lastEnd = -1;
    for (const c of cands) {
      if (c.start < lastEnd) continue;
      lastEnd = c.end;
      const pr = PRODUCTIONS[c.pi];
      accepted[layer].push({ rule: pr.id, cat: pr.cat, span: [c.start, c.end], ...pr.build(c.m.groups ?? {}, c.m[0]) });
    }
  }
  const covered = new Array<boolean>(clause.length).fill(false);
  for (const layer of Object.keys(accepted) as Layer[]) {
    for (const a of accepted[layer]) for (let i = a.span[0]; i < a.span[1]; i++) covered[i] = true;
  }
  let residue = "";
  for (let i = 0; i < clause.length; i++) residue += covered[i] ? " " : clause[i];
  const allWords = wordsOf(clause).filter((w) => !GLUE.has(w));
  const resWords = wordsOf(residue).filter((w) => !GLUE.has(w));
  const classified =
    accepted.effect.length + accepted.structure.length + accepted.modifier.filter((x) => x.cat === "limit_per_round").length > 0;
  return { accepted, classified, contentWords: allWords.length, residueWords: resWords };
}

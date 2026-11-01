import { SELF_GAINS } from "../ability-grammar/tags.js";
import { ASPECT_NAMES } from "./locks.js";
import { cmp } from "./order.js";
import type { SynergyCard } from "./schema.js";

/**
 * @displayName SWU tag qualifiers
 * @strategicPurpose An offers/wants tag is a bare name, but the clause that produced it carries
 * qualifiers the pairing must respect: the arena, trait, ownership and kind of what the effect
 * touches, and the trigger scope ("while attacking", "for this attack"). Without them a ground-only
 * defeat outlet pairs with a Space payoff and a returned upgrade counts as a returned unit
 * (LampaGJ/swu-mcp#12, root causes RC06 and RC02 of docs/verification/2026-10-16.md).
 * @tacticalObjective Recovers the qualifiers from the structured clause found through the tag's
 * `why`, and reports a conflict only when both sides state a qualifier explicitly and the two
 * contradict. A missing qualifier never blocks a pair (fail closed on explicit conflict only).
 * Pure function of the card records.
 */

type Side = "friendly" | "enemy";
type Kind = "unit" | "upgrade" | "base" | "token" | "resource" | "card" | "leader";
type Arena = "ground" | "space";

/** What an effect or watcher touches, as far as the features state it. */
export interface Subject {
  side?: Side;
  kind?: Kind;
  arena?: Arena;
  traits: string[];
  notTraits: string[];
  /** Cost bounds stated by the target ("a unit that costs 3 or less"). */
  maxCost?: number;
  minCost?: number;
  /** Power bound stated by the target ("the next unit you play with 1 or less power"), checked against the fed card's printed power (D58). */
  maxPower?: number;
  /** D84 (#166): "a non-leader unit with 6 or more power" (Exploit Confidence). */
  minPower?: number;
  nonLeader?: boolean;
  /** The aspect a target must have ("a Heroism unit"). */
  aspect?: string;
  /** The card itself, used when the want acts on the card that carries it. */
  cost?: number | null;
  power?: number | null;
  isLeader?: boolean;
  aspects?: string[];
  /** The token units the offer creates and hands over, with their printed traits; set only when every token's card is known. */
  supplies?: { token: string; traits: string[]; aspects?: string[] }[];
  /** `supplies` lists every printed token unit because the offer multiplies whatever tokens are created, not tokens of its own (D58). */
  anyToken?: boolean;
  /** The effect acts only on the tokens the same clause creates ("create 2 Beast tokens and ready 1 of them"). */
  tokensOnly?: boolean;
  /** Keywords the target must have ("friendly units with Hidden"). */
  keywords?: string[];
  /** The effect may act on several subjects at once ("Defeat any number of friendly units"). */
  many?: boolean;
  /** The want counts the aspect icons or units of this aspect ("for each Heroism aspect icon among friendly units", D66). */
  countsAspect?: string;
  /** D85 (#167): the effect reaches only a unit that is already damaged ("deal 2 damage to a damaged unit", TIE Dagger Vanguard). */
  damagedOnly?: boolean;
  /** D86 (#168): the effect reaches only a unit that has not attacked this phase ("ready a unit that didn't attack", It's Not Over Yet). */
  unattackedOnly?: boolean;
}

/** What an upgrade or Pilot may attach to: the printed "Attach to ..." line, or a Vehicle for Piloting (CR: "attach to a friendly Vehicle unit"). */
export interface AttachBound {
  /** The target phrase, used in the conflict text. */
  label: string;
  traits: string[];
  /** The traits are alternatives ("a Capital Ship or Transport unit"). */
  anyTrait: boolean;
  notTraits: string[];
  arena?: Arena;
  /** Fortify: the upgrade attaches to your base, never to a unit (CR reminder: "Attach this to your base, not a unit."). */
  base?: boolean;
}

export interface TagQualifier {
  /** Subject of the effect that produced the tag (offers), or of the clause the card needs (wants). */
  subject: Subject;
  /** Trigger names of the ability that produced the tag. */
  triggers: string[];
  /** Combat scope stated by the watcher's trigger or condition text. */
  scope?: "attacking" | "defending";
  /** The ability exists only because an effect granted it "for this attack". */
  forAttackOnly: boolean;
  /** The effect category when it differs from what the tag names (a curated tuck tagged as a return). */
  viaCat?: string;
  /** The tag acts on the card that carries it (defeat self, defeated self) rather than on a chosen subject. */
  onSelf: boolean;
  /** The clause text, used for the attack-timing guard. */
  text: string;
  /** The want is an ability of the unit that only works while that unit is upgraded. */
  hostAbility?: boolean;
  /** Where an upgrade-to-attach offer may attach. */
  attach?: AttachBound;
  /** The wanting card is the one that receives the upgrade or token ("while this unit is upgraded"), so the offer's target restriction binds it. */
  receives?: boolean;
  /** The want comes from a condition on what an opponent controls ("if an opponent controls an upgrade"), so only an offer that can act on the opponent's side feeds it (D62). */
  opponentControls?: boolean;
  /** The offer acts on the unit its own watcher trigger saw ("When you play a unit ...: ready that unit"); holds that trigger text, so a trio can tell which want it relays (D64). */
  relays?: string;
  /** The unit a play offer puts into play ("Play a Vehicle unit from your discard pile"), read off the play effect's object (D64). */
  delivers?: Subject;
  /** The ability that carries the want defeats or returns its own card ("You may defeat this upgrade. If you do, ..."), so it pays off once (D66). */
  spendsSelf?: boolean;
  /** D83: the offer happens in the regroup phase ("When the regroup phase starts", "At the start of the next regroup phase"). */
  regroup?: boolean;
  /** D85 (#167): the offer is a mode an opponent picks ("An opponent chooses one:", Watto), so the card's controller cannot count on it. */
  opponentChooses?: boolean;
}

interface TargetLite {
  side?: string;
  kind?: string;
  quant?: string;
  arena?: string;
  restrict?: string[];
  text?: string;
}
interface EffectLite {
  cat?: string;
  sign?: string;
  token?: string;
  target?: TargetLite;
  what?: unknown;
}
interface ClauseLite {
  text: string;
  curatedId?: string;
  effects: EffectLite[];
  conditions?: { cat?: string; state?: string }[];
  modifiers?: { cat?: string }[];
  structure?: { cat?: string; target?: TargetLite }[];
}
interface AbilityNode {
  kind: string;
  triggers?: { trigger?: string; text?: string }[];
  clauses?: ClauseLite[];
  options?: { clauses: ClauseLite[] }[];
  grantedAbilities?: { index: number; abilities: unknown[] }[];
}
interface Origin {
  ability: AbilityNode;
  clause?: ClauseLite;
  forAttackOnly: boolean;
}

const EMPTY: Subject = { traits: [], notTraits: [] };
const ATTACK_TRIGGERS = new Set(["on_attack", "on_defense", "attack_end", "on_attack_kill", "on_base_hit"]);
const FACE_PREFIX = /^([A-Za-z]+): ([\s\S]*)$/;

/** The clause gives the card itself a keyword ("this unit gains Raid 1"), so an extra-attacks want it carries is bound to that card (D62). */
const grantsItself = (clause: ClauseLite | undefined): boolean =>
  clause !== undefined && SELF_GAINS.test(clause.text) && clause.effects.some((e) => e.cat === "grant_keyword" && e.target?.side === "self");
const clausesOf = (a: AbilityNode): ClauseLite[] => [...(a.clauses ?? []), ...(a.options ?? []).flatMap((o) => o.clauses)];

function* abilitiesOf(nodes: readonly unknown[], forAttackOnly = false): Generator<{ ability: AbilityNode; forAttackOnly: boolean }> {
  for (const raw of nodes) {
    const a = raw as AbilityNode;
    if (a.kind !== "ability") continue;
    yield { ability: a, forAttackOnly };
    for (const g of a.grantedAbilities ?? []) {
      const marker = `⟦G${g.index}⟧`;
      const oneAttack = clausesOf(a).some((c) => c.text.includes(marker) && (c.modifiers ?? []).some((m) => m.cat === "duration_attack"));
      yield* abilitiesOf(g.abilities, forAttackOnly || oneAttack);
    }
  }
}

/** Finds the ability and clause that produced a tag, from the `why` the tag builder recorded. */
function findOrigin(card: SynergyCard, why: string): Origin | undefined {
  const faceMatch = FACE_PREFIX.exec(why);
  const curatedId = why.startsWith("curated ") ? why.slice("curated ".length) : undefined;
  const payload = faceMatch === null ? why : faceMatch[2];
  const faces = Object.keys(card.faces)
    .filter((f) => curatedId !== undefined || faceMatch === null || faceMatch[1] === f)
    .sort(cmp);
  let triggerHit: Origin | undefined;
  for (const face of faces) {
    for (const { ability, forAttackOnly } of abilitiesOf(card.faces[face])) {
      for (const clause of clausesOf(ability)) {
        const hit = curatedId !== undefined ? clause.curatedId === curatedId : clause.text === payload;
        if (hit) return { ability, clause, forAttackOnly };
      }
      if (triggerHit === undefined && (ability.triggers ?? []).some((t) => t.text === payload || t.trigger === payload)) {
        triggerHit = { ability, forAttackOnly };
      }
    }
  }
  return triggerHit;
}

const ONCE_EACH_ROUND = /\bonly once each round\b/i;

/**
 * D86 (#168): one feed fills the want for the whole round, so a second source adds nothing: a gate on the card being damaged
 * ("can't attack unless it's damaged", Oggdo Bogdo) or an ability usable only once each round (Rancor Keeper). Grit and other
 * counting wants, and an extra-attacks want, grow with every feed and never saturate.
 */
export function wantSaturates(card: SynergyCard, tag: string): boolean {
  const entries = card.tags.wants.filter((t) => t.tag === tag);
  return (
    entries.length > 0 &&
    entries.every((t) => {
      const origin = findOrigin(card, t.why);
      if (origin === undefined) return false;
      const texts = [...(origin.ability.triggers ?? []).map((x) => x.text ?? ""), ...clausesOf(origin.ability).map((c) => c.text)];
      return DAMAGED_GATE.test(origin.clause?.text ?? "") || texts.some((x) => ONCE_EACH_ROUND.test(x));
    })
  );
}

const SCALES = /\b(?:doubled?|for each)\b/i;

/**
 * D87 (#169): a want whose clause counts or doubles what feeds it ("Each friendly unit's Raid is doubled", Marchion Ro; "for each")
 * grows with every supplier, so another supplier is never redundant.
 */
export function wantScales(card: SynergyCard, tag: string): boolean {
  const entries = card.tags.wants.filter((t) => t.tag === tag);
  return entries.length > 0 && entries.some((t) => SCALES.test(findOrigin(card, t.why)?.clause?.text ?? t.why));
}

/** Effect categories that make a tag; a tag with no entry carries no effect subject. */
const OFFER_CATS: [RegExp, string[]][] = [
  [/^offers:defeat-(?:friendly|enemy|any)-unit$/, ["defeat"]],
  [/^offers:damage-/, ["damage", "indirect_damage"]],
  [/^offers:heal$/, ["heal"]],
  [/^offers:ready-unit$/, ["ready"]],
  [/^offers:(?:return-(?:own|any)-to-hand|return-upgrade|bounce-enemy)$/, ["bounce"]],
  [/^offers:exhaust-(?:enemy|any)$/, ["exhaust"]],
  [/^offers:extra-attack$/, ["extra_attack"]],
  [/^offers:give-/, ["give_token"]],
];
const WANT_CATS: [RegExp, string[]][] = [[/^wants:credit-tokens$/, ["defeat"]]];
const CREATE_OFFERS = new Set(["offers:credit-tokens", "offers:create-token-units", "offers:the-force"]);
const SELF_OFFERS = new Set(["offers:defeat-self"]);
/** A keyword holder offers itself (D64). */
const isSelfOffer = (tag: string): boolean => SELF_OFFERS.has(tag) || tag.startsWith("offers:has-keyword-");
const SELF_WANTS = new Set(["wants:self-defeated", "wants:self-damaged", "wants:replay-when-played", "wants:ready-unit"]);

const catsFor = (table: [RegExp, string[]][], tag: string): string[] => table.find(([re]) => re.test(tag))?.[1] ?? [];

const NON_TRAIT = /\bnon[-‐‑ ]([A-Z][\w']*)/g;

const MODIFIERS = new Set([
  "a", "an", "the", "this", "that", "each", "every", "all", "any", "up", "to", "number", "of", "another", "other", "your", "friendly", "enemy", "own",
  "damaged", "undamaged", "exhausted", "ready", "ground", "space", "unique", "non", "leader", "non-leader", "non-unique", "or", "more", "less", "and", "one", "two", "three",
]);
const HEADS: Record<string, Kind> = { unit: "unit", units: "unit", upgrade: "upgrade", upgrades: "upgrade", base: "base", bases: "base", resource: "resource", resources: "resource", card: "card", cards: "card", token: "token", tokens: "token" };
const NON_UNIT_LEADER = /\bnon[-\u2011]unit leaders?\b/i;
const MIN_POWER = /\bwith (\d+) or more power\b/i;
/** "choose a non-leader unit that opponent controls" (Beguile): the side sits in a relative clause the grammar leaves as residue. */
const UNIT_OPPONENT_CONTROLS = /\bunits? (?:that )?(?:an |that )?opponent controls\b/i;
/** "While you control a Force unit or a Force upgrade" (Padawan Starfighter): the trait the wanted upgrade must carry. */
const TRAIT_UPGRADE = /\b(?:an?|another) ([A-Z][\p{L}'\u2019-]*) upgrade\b/u;
const UPGRADE_TOKEN = /\b(?:experience|shield|credit|advantage|weakness|force)\b/i;
const DAMAGED_TARGET = /(?<!un)\bdamaged units?\b/i;
const UNATTACKED_TARGET = /\b(?:didn['’]t|did not|hasn['’]t|has not) attack(?:ed)?\b/i;
/** D85 (#167): a want gated on the card being damaged at all ("can't attack unless it's damaged", "While this unit is damaged"), not one that counts damage (Grit). */
const DAMAGED_GATE = /\b(?:unless|while|if) (?:it['’]?s|it is|this unit is|he['’]?s|she['’]?s|he is|she is) damaged\b/i;

/** The head noun of a target phrase ("a unit that costs 3 resources" is a unit), because the parsed kind follows the first noun it sees. */
function headKind(text: string, parsed: string | undefined): Kind | undefined {
  // D84 (#166): "ready a non-unit leader" (Darth Traya) acts on the leader card, which is no unit.
  if (NON_UNIT_LEADER.test(text)) return "leader";
  for (const raw of text.split(/\s+/)) {
    const word = raw.replace(/[^\p{L}\p{N}'\u2011-]/gu, "");
    const low = word.toLowerCase();
    if (low === "" || /^\d+$/.test(low) || MODIFIERS.has(low) || /^non[-\u2011]/.test(low)) continue;
    if (!(low in HEADS)) {
      if (/^[A-Z]/.test(word)) continue;
      break;
    }
    const head = HEADS[low];
    if (head === undefined) break;
    if (head === "token") return UPGRADE_TOKEN.test(text) ? "token" : undefined;
    if (head === "unit" && /\bor (?:a |an |any )?bases?\b/i.test(text)) return undefined;
    return head;
  }
  return parsed === "unit" || parsed === "leader" ? "unit" : parsed === "base" ? "base" : undefined;
}

function subjectOf(t: TargetLite | undefined): Subject {
  if (t === undefined) return EMPTY;
  const text = t.text ?? "";
  const restrict = t.restrict ?? [];
  const notTraits = [...new Set([...restrict.filter((r) => r.startsWith("non_trait:")).map((r) => r.slice(10)), ...[...text.matchAll(NON_TRAIT)].map((m) => m[1])])];
  const traits = restrict
    .filter((r) => r.startsWith("trait:"))
    .map((r) => r.slice(6))
    .filter((x) => !notTraits.includes(x));
  const side: Side | undefined = t.side === "friendly" || t.side === "self" ? "friendly" : t.side === "enemy" ? "enemy" : undefined;
  const lower = text.toLowerCase();
  const kind = headKind(text, t.kind);
  const arena: Arena | undefined = t.arena === "ground" || t.arena === "space" ? t.arena : /\bground units?\b/.test(lower) ? "ground" : /\bspace units?\b/.test(lower) ? "space" : undefined;
  const bound = (prefix: string): number | undefined => {
    const hit = restrict.map((r) => new RegExp(`^${prefix}_(\\d+)$`).exec(r)).find((m) => m !== null);
    return hit == null ? undefined : Number(hit[1]);
  };
  const aspect = restrict.find((r) => r.startsWith("aspect:"))?.slice(7);
  const keywords = restrict.filter((r) => r.startsWith("keyword:")).map((r) => r.slice(8));
  return {
    side,
    kind,
    arena,
    traits: [...new Set(traits)].sort(cmp),
    notTraits: notTraits.sort(cmp),
    maxCost: bound("cost_le"),
    minCost: bound("cost_ge"),
    maxPower: bound("power_le"),
    ...(MIN_POWER.test(text) ? { minPower: Number(MIN_POWER.exec(text)?.[1]) } : {}),
    nonLeader: restrict.includes("non_leader") || restrict.includes("non-leader") || undefined,
    aspect,
    ...(keywords.length === 0 ? {} : { keywords: [...new Set(keywords)].sort(cmp) }),
    ...(t.quant === "any_number" || t.quant === "all" ? { many: true } : {}),
    ...(DAMAGED_TARGET.test(text) ? { damagedOnly: true } : {}),
    ...(UNATTACKED_TARGET.test(text) ? { unattackedOnly: true } : {}),
  };
}

const PILOTING_BOUND: AttachBound = { label: "a Vehicle unit", traits: ["Vehicle"], anyTrait: false, notTraits: [] };
const FORTIFY_BOUND: AttachBound = { label: "your base", traits: [], anyTrait: false, notTraits: [], base: true };

/** Where the card attaches as an upgrade: an Upgrade's "Attach to ..." restriction, or a Vehicle for a non-Upgrade with Piloting. */
function attachBound(card: SynergyCard): AttachBound | undefined {
  if (card.type === "Upgrade" && printedKeywords(card).includes("Fortify")) return FORTIFY_BOUND;
  if (card.type !== "Upgrade") {
    const listed = (card.keywords as { keyword?: unknown; granted?: unknown }[] | undefined) ?? [];
    return listed.some((k) => k.keyword === "Piloting" && k.granted !== true) ? PILOTING_BOUND : undefined;
  }
  for (const face of Object.keys(card.faces).sort(cmp)) {
    for (const { ability } of abilitiesOf(card.faces[face])) {
      for (const clause of clausesOf(ability)) {
        const target = (clause.structure ?? []).find((x) => x.cat === "attach_restriction")?.target;
        if (target === undefined) continue;
        const { traits, notTraits, arena } = subjectOf(target);
        const label = target.text ?? "";
        if (traits.length + notTraits.length === 0 && arena === undefined) return undefined;
        return { label, traits, anyTrait: traits.length > 1 && /\bor\b/.test(label), notTraits, arena };
      }
    }
  }
  return undefined;
}

/** Printed keywords of a card: `structured.keywordsField` and the non-granted entries of `keywords`. */
function printedKeywords(card: SynergyCard): string[] {
  const field = ((card.structured.keywordsField as unknown[] | undefined) ?? []).filter((k): k is string => typeof k === "string");
  const listed = ((card.keywords as { keyword?: unknown; granted?: unknown }[] | undefined) ?? []).flatMap((k) => (typeof k.keyword === "string" && k.granted !== true ? [k.keyword] : []));
  return [...new Set([...field, ...listed])];
}

const RECEIVING_WANTS = new Set(["wants:upgrades-attached", "wants:pilot-attached"]);
/** A want that counts upgrades wherever they sit ("you control 2 or more upgrades") or on a base, which a Fortify upgrade can feed. */
const BASE_OR_ANY_UPGRADE = /\bupgrades? (?:you control|on (?:your|a friendly) base)\b|\bcontrol (?:\d+ or more |an? |any )?upgrades?\b/i;
/** Wants the tag builder reads off a control or "for each" condition, which can name what an opponent controls. */
const CONDITION_WANTS = new Set(["wants:upgrades-attached", "wants:tokens", "wants:damaged-units", "wants:exhausted-own", "wants:exhausted-resources", "wants:wide-board"]);
const OPPONENT_CONTROLS = /\b(?:an|each|that) opponent controls?\b|\bthe defending player controls\b/i;
const YOU_CONTROL = /\byou control\b/i;
const OWN_SIDE_TAG = /-(?:friendly|own|self)(?:-|$)/;

/**
 * The offer acts only on its own player's side: the tag or the target says so, it acts on the card itself, or the clause
 * names only friendly things. An upgrade you play stays yours on any unit (CR: "If a player plays an upgrade onto an enemy
 * unit, that player still controls that upgrade"), so attaching one never gives an opponent an upgrade.
 */
function actsOnOwnSide(offerTag: string, offer: TagQualifier): boolean {
  if (OWN_SIDE_TAG.test(offerTag) || offer.onSelf || offer.subject.side === "friendly" || offerTag === "offers:upgrade-to-attach") return true;
  return offer.subject.side === undefined && /\bfriendly\b/i.test(offer.text) && !/\b(?:enemy|opponent)/i.test(offer.text);
}
const ON_THIS_UNIT = /\b(?:this unit is upgraded|upgrades? (?:on|attach(?:es)? to) (?:this unit|him|her)\b|upgrade on this unit)/i;

const isRef = (t: TargetLite | undefined): boolean => t?.kind === "ref" || t?.side === "ref";
const RELAYED = /^(?:(?:that|the|those) units?|it|them)$/i;
const ATTACHED_UNIT = /^attached unit$/i;

/** The target of a take-control earlier in the ability, which a later "ready it" acts on (Commandeer, D64). */
function seizedTarget(ability: AbilityNode, clause: ClauseLite): TargetLite | undefined {
  const clauses = clausesOf(ability);
  for (let i = clauses.indexOf(clause); i >= 0; i--) {
    const hit = clauses[i].effects.find((e) => e.cat === "take_control" && e.target !== undefined);
    if (hit !== undefined) return hit.target;
  }
  return undefined;
}

/** An "attached unit" effect acts on the host, so the upgrade's attach line or Piloting's Vehicle bounds it (Han Solo, D64). */
function boundToHost(subject: Subject, bound: AttachBound | undefined): Subject {
  if (bound === undefined || bound.base === true) return subject;
  return {
    ...subject,
    traits: bound.anyTrait ? subject.traits : [...new Set([...subject.traits, ...bound.traits])].sort(cmp),
    notTraits: [...new Set([...subject.notTraits, ...bound.notTraits])].sort(cmp),
    arena: subject.arena ?? bound.arena,
  };
}

const PLAY_OFFERS = new Set(["offers:play-from-discard", "offers:play-from-resources", "offers:paid-play", "offers:cheat-play", "offers:units-entering"]);
const PLAYED_TRAIT = /\b((?:[A-Z][\w'-]*\s)*[A-Z][\w'-]*) units?\b/;

/** The unit a play effect names ("a Vehicle unit", "a unit that costs 3 or less"), as a target subject. */
function playedSubject(what: string): Subject {
  const restrict: string[] = [];
  const trait = PLAYED_TRAIT.exec(what);
  if (trait !== null) restrict.push(`trait:${trait[1]}`);
  const cost = /\bcosts? (\d+) or less\b/i.exec(what);
  if (cost !== null) restrict.push(`cost_le_${cost[1]}`);
  const power = /\b(\d+) or less power\b/i.exec(what);
  if (power !== null) restrict.push(`power_le_${power[1]}`);
  return subjectOf({ text: what, restrict });
}

/** Token name to printed traits, from the Token Unit cards in the set. */
export type TokenTraits = ReadonlyMap<string, readonly string[]>;
/** Token name to printed aspects, from the Token Unit cards in the set (D66). */
export type TokenAspects = ReadonlyMap<string, readonly string[]>;

const tokenSupply = (token: string, tokenTraits: TokenTraits, tokenAspects: TokenAspects | undefined): NonNullable<Subject["supplies"]>[number] => ({
  token,
  traits: [...(tokenTraits.get(token) ?? [])],
  ...(tokenAspects?.has(token) === true ? { aspects: [...(tokenAspects.get(token) ?? [])] } : {}),
});

/** The token units a clause creates, or undefined when none is created or one has no known card. */
function suppliedTokens(clause: ClauseLite | undefined, tokenTraits: TokenTraits | undefined, tokenAspects?: TokenAspects): Subject["supplies"] {
  const names = (clause?.effects ?? []).filter((e) => e.cat === "create_token" && e.token !== undefined).map((e) => e.token as string);
  if (names.length === 0 || tokenTraits === undefined || !names.every((n) => tokenTraits.has(n))) return undefined;
  return [...new Set(names)].sort(cmp).map((token) => tokenSupply(token, tokenTraits, tokenAspects));
}

const GENERIC_TOKEN = /^tokens?$/i;

/** Every printed token unit, when the clause only names "tokens" (a doubler: "create twice that number of tokens"). */
function multipliedTokens(clause: ClauseLite | undefined, tokenTraits: TokenTraits | undefined, tokenAspects?: TokenAspects): Subject["supplies"] {
  const names = (clause?.effects ?? []).filter((e) => e.cat === "create_token" && e.token !== undefined).map((e) => e.token as string);
  if (names.length === 0 || !names.every((n) => GENERIC_TOKEN.test(n)) || tokenTraits === undefined || tokenTraits.size === 0) return undefined;
  return [...tokenTraits.keys()].sort(cmp).map((token) => tokenSupply(token, tokenTraits, tokenAspects));
}

/**
 * The trait bounds of the card's own defeat outlet. The sac-fodder want is derived from that offer, so its
 * `why` names no clause and the restriction ("Defeat a friendly Creature unit") is read from the outlet.
 */
function outletSubject(card: SynergyCard): Subject {
  const why = card.tags.offers.find((t) => t.tag === "offers:defeat-friendly-unit")?.why;
  const clause = why === undefined ? undefined : findOrigin(card, why)?.clause;
  const { traits, notTraits } = subjectOf(clause?.effects.find((e) => e.cat === "defeat")?.target);
  return traits.length + notTraits.length === 0 ? EMPTY : { traits, notTraits };
}

const WATCHED = /\bfriendly (?:([A-Z][\w']*(?: [A-Z][\w']*)*) )?(?:(space|ground) )?units?\b/;

/** The traits and arena a watcher names in its trigger or condition text ("a friendly Rebel unit"). */
function watcherSubject(text: string): Subject {
  const m = WATCHED.exec(text);
  if (m === null) return EMPTY;
  return { side: "friendly", arena: m[2] === "ground" || m[2] === "space" ? m[2] : undefined, traits: m[1] === undefined ? [] : [m[1]], notTraits: [] };
}

const ASPECT_ALT = [...ASPECT_NAMES].join("|");
/** "for each Heroism aspect icon among friendly units", "3 or more Command aspect icons", "for each friendly Vigilance unit" (D66). */
const COUNTS_ASPECT = new RegExp(`\\b(${ASPECT_ALT}) aspect icons?\\b|\\bfor each (?:other )?friendly (${ASPECT_ALT}) units?\\b|\\b(?:\\d+|X) or more (${ASPECT_ALT}) units\\b`);

/** "defeat this upgrade", "return this unit to its owner's hand"; a replacement ("... instead") spends nothing the effect needs. */
const SPENDS_SELF = /\b(?:defeat|discard) this (?:upgrade|unit|card)\b|\breturn this (?:upgrade|unit|card) to (?:its owner's|your) hand\b/i;
const spendsSelf = (ability: AbilityNode): boolean => clausesOf(ability).some((c) => SPENDS_SELF.test(c.text) && !/\binstead\b/i.test(c.text));

const REGROUP = /\bregroup phase\b/i;
/**
 * D85 (#167): the clause sits in a mode list the opponent picks from (curated structure "opponent_modal", chooser "opponent").
 * D86 (#168): any chooser naming an opponent counts ("each opponent", Giant Gorax).
 */
const opponentPicks = (ability: AbilityNode, clause: ClauseLite | undefined): boolean =>
  clause !== undefined &&
  (ability.options ?? []).some((o) => o.clauses.includes(clause)) &&
  (ability.clauses ?? []).some((c) => (c.structure ?? []).some((s) => /\bopponent\b/i.test(String((s as { chooser?: unknown }).chooser ?? ""))));

const scopeOf = (text: string): TagQualifier["scope"] =>
  /\bwhile attacking\b/i.test(text) ? "attacking" : /\bwhile defending\b/i.test(text) ? "defending" : undefined;

/** The qualifiers of one tag on one card; a tag whose origin is not in the feature record carries none. */
export function qualifierOf(card: SynergyCard, side: "offers" | "wants", tag: string, why: string, tokenTraits?: TokenTraits, tokenAspects?: TokenAspects): TagQualifier {
  const origin = findOrigin(card, why);
  if (origin === undefined) {
    const onSelf = side === "offers" ? isSelfOffer(tag) : SELF_WANTS.has(tag) || (tag === "wants:extra-attacks" && ATTACK_TRIGGERS.has(FACE_PREFIX.exec(why)?.[2] ?? why));
    const subject = side === "wants" && tag === "wants:sac-fodder" ? outletSubject(card) : EMPTY;
    const attach = side === "offers" && tag === "offers:upgrade-to-attach" ? attachBound(card) : undefined;
    return { subject, triggers: [], forAttackOnly: false, onSelf, text: "", ...(attach === undefined ? {} : { attach }) };
  }
  const { ability, clause, forAttackOnly } = origin;
  const triggers = (ability.triggers ?? []).flatMap((t) => (t.trigger === undefined ? [] : [t.trigger]));
  const payload = FACE_PREFIX.exec(why)?.[2] ?? why;
  const triggerText = (ability.triggers ?? []).map((t) => t.text ?? "").join(" ");
  const text = clause?.text ?? payload;

  let subject: Subject = EMPTY;
  let viaCat: string | undefined;
  let relays: string | undefined;
  const cats = catsFor(side === "offers" ? OFFER_CATS : WANT_CATS, tag);
  if (clause !== undefined && cats.length > 0) {
    const hit = clause.effects.find((e) => cats.includes(e.cat ?? ""));
    if (hit !== undefined) {
      const seized = isRef(hit.target) ? seizedTarget(ability, clause) : undefined;
      subject = subjectOf(seized ?? hit.target);
      if ((hit.cat === "ready" || hit.cat === "extra_attack") && ATTACHED_UNIT.test(hit.target?.text ?? "")) subject = boundToHost(subject, attachBound(card));
      if (isRef(hit.target) && RELAYED.test(hit.target?.text ?? "") && (ability.triggers ?? []).some((t) => t.trigger?.startsWith("reactive") === true)) relays = triggerText;
      // A ready aimed back at "them" readies only the tokens the clause just made; give-* offers stay open because an upgrade on a token still counts as an upgrade.
      if (tag === "offers:ready-unit" && hit.target?.kind === "ref" && clause.effects.some((e) => e.cat === "create_token")) {
        const supplies = suppliedTokens(clause, tokenTraits, tokenAspects);
        subject = { ...subject, tokensOnly: true, ...(supplies === undefined ? {} : { supplies }) };
      }
    } else if (clause.effects.some((e) => e.cat === "tuck")) viaCat = "tuck";
  } else if (side === "offers" && CREATE_OFFERS.has(tag)) {
    const supplies = suppliedTokens(clause, tokenTraits, tokenAspects);
    const multiplied = supplies === undefined ? multipliedTokens(clause, tokenTraits, tokenAspects) : undefined;
    subject = { side: "friendly", traits: [], notTraits: [], ...(supplies !== undefined ? { supplies } : multiplied !== undefined ? { supplies: multiplied, anyToken: true } : {}) };
  }
  if (side === "offers" && subject.side === undefined && UNIT_OPPONENT_CONTROLS.test(text)) subject = { ...subject, side: "enemy" };
  if (side === "wants" && subject === EMPTY) {
    const watcher = watcherSubject(`${text} ${triggerText}`);
    if (watcher !== EMPTY && watcher.traits.length + Number(watcher.arena !== undefined) > 0) subject = watcher;
  }
  const counted = side === "wants" ? COUNTS_ASPECT.exec(text) : null;
  if (counted !== null) subject = { ...subject, countsAspect: counted[1] ?? counted[2] ?? counted[3] };
  const hostAbility = side === "wants" && (clause?.conditions ?? []).some((k) => k.cat === "self_state" && k.state === "upgraded");
  const attach = side === "offers" && tag === "offers:upgrade-to-attach" ? attachBound(card) : undefined;
  const receives = side === "wants" && RECEIVING_WANTS.has(tag) && (hostAbility || ON_THIS_UNIT.test(`${text} ${triggerText}`));
  const opponentControls = side === "wants" && CONDITION_WANTS.has(tag) && OPPONENT_CONTROLS.test(text) && !YOU_CONTROL.test(text);
  const played = side === "offers" && PLAY_OFFERS.has(tag) ? clause?.effects.find((e) => e.cat === "play_extra" && typeof e.what === "string") : undefined;
  const delivers = played === undefined ? undefined : playedSubject(played.what as string);
  return {
    subject,
    triggers,
    scope: side === "wants" ? scopeOf(`${triggerText} ${text}`) : undefined,
    forAttackOnly: side === "wants" && forAttackOnly,
    viaCat,
    onSelf:
      side === "offers"
        ? isSelfOffer(tag)
        : SELF_WANTS.has(tag) ||
          (tag === "wants:heal" && /\bthis unit\b/i.test(triggerText)) ||
          (tag === "wants:extra-attacks" && (ATTACK_TRIGGERS.has(payload) || grantsItself(clause))),
    text,
    hostAbility,
    ...(attach === undefined ? {} : { attach }),
    ...(receives ? { receives } : {}),
    ...(opponentControls ? { opponentControls } : {}),
    ...(relays === undefined ? {} : { relays }),
    ...(delivers === undefined ? {} : { delivers }),
    ...(side === "wants" && spendsSelf(ability) ? { spendsSelf: true } : {}),
    ...(side === "offers" && REGROUP.test(`${triggerText} ${text}`) ? { regroup: true } : {}),
    ...(side === "offers" && opponentPicks(ability, clause) ? { opponentChooses: true } : {}),
  };
}

/**
 * Where an offer's effect lands: the side the tag names (`damage-friendly-unit`; one clause can make a friendly and an
 * enemy tag, so the tag wins), else the side the clause states, else "any" ("deal 1 damage to a unit").
 */
export function offerTargetSide(card: SynergyCard, tag: string): "enemy" | "own" | "any" {
  if (/-(?:friendly|own|self)(?:-|$)/.test(tag)) return "own";
  if (/-enemy(?:-|$)/.test(tag)) return "enemy";
  const why = card.tags.offers.find((t) => t.tag === tag)?.why ?? "";
  const stated = qualifierOf(card, "offers", tag, why).subject.side;
  return stated === undefined ? "any" : stated === "friendly" ? "own" : "enemy";
}

/** D74 (#161): "While attached unit is attacking, it gains: ... and loses all other abilities" (Condemn) parses with the loss as residue, not as a blank effect. */
const LOSES_ALL = /\battached unit\b[^.]*\bloses all (?:other )?abilities\b/i;

/** True when the card is an upgrade that strips the abilities of the unit it attaches to. */
export function blanksHost(c: SynergyCard): boolean {
  return Object.keys(c.faces).some((f) =>
    [...abilitiesOf(c.faces[f])].some(({ ability }) =>
      clausesOf(ability).some((cl) => cl.effects.some((e) => e.cat === "blank" && /\battached\b/i.test(e.target?.text ?? "")) || LOSES_ALL.test(cl.text)),
    ),
  );
}

/**
 * D83 (#165): an upgrade whose own effect harms the unit it sits on (Condemn: "loses all other abilities" while attacking;
 * "Attached unit can't ready"; "Attached unit gets -3/-0"; "Exhaust attached unit") is played on an enemy unit.
 */
export function harmsHost(c: SynergyCard): boolean {
  if (c.type !== "Upgrade") return false;
  if (blanksHost(c)) return true;
  const onHost = (e: EffectLite): boolean => ATTACHED_UNIT.test(e.target?.text ?? "");
  return Object.keys(c.faces).some((f) =>
    [...abilitiesOf(c.faces[f])].some(({ ability }) =>
      clausesOf(ability).some((cl) => cl.effects.some((e) => onHost(e) && ((e.cat === "stat_mod" && e.sign === "debuff") || e.cat === "restriction" || e.cat === "exhaust"))),
    ),
  );
}

/** "If attached unit is Darth Maul, you may attack with him": the name the clause gates on, or null ("If attached unit is a Fighter" names a trait). */
const ATTACHED_NAME = /\b[Ii]f attached unit is ((?!an? )[A-Z][\p{L}'\u2019-]*(?: [A-Z][\p{L}'\u2019-]*)*)/u;
const folded = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** D74 (#161): a token that is not a unit (CR: Credit, Force, Experience, Shield and Advantage tokens are no units), named by a defeat offer. */
const NON_UNIT_TOKEN = /\b(Credit|Force|Experience|Shield|Advantage) tokens?\b/i;
const DEFEATS_UNIT = /^offers:defeat-(?:any|friendly|enemy)-unit$/;

const cardArena = (c: SynergyCard): Arena | undefined => {
  const arenas = c.structured.arenas as string[] | undefined;
  return arenas?.length === 1 ? (arenas[0].toLowerCase() as Arena) : undefined;
};
const cardSubject = (c: SynergyCard): Subject => ({
  kind: c.type === "Unit" || c.type === "Leader" ? "unit" : undefined,
  arena: cardArena(c),
  traits: c.structured.traits,
  notTraits: [],
  cost: c.structured.cost,
  power: c.structured.power,
  isLeader: c.type === "Leader",
  aspects: c.structured.aspects,
});

/** Whether a unit with these traits and arena meets an attach bound's traits and arena (a Fortify bound is checked apart, by the caller). */
function boundAdmitsSubject(bound: AttachBound, host: Subject): boolean {
  const traitsOk = bound.traits.length === 0 || (bound.anyTrait ? bound.traits.some((t) => host.traits.includes(t)) : bound.traits.every((t) => host.traits.includes(t)));
  const arenaOk = bound.arena === undefined || host.arena === undefined || bound.arena === host.arena;
  return traitsOk && arenaOk && !bound.notTraits.some((t) => host.traits.includes(t));
}

/** D74 (#161): whether the unit is a legal host for an upgrade with this bound; a Fortify upgrade sits on a base, never a unit. */
export function hostAdmits(bound: AttachBound | undefined, unit: SynergyCard): boolean {
  if (unit.type !== "Unit") return false;
  if (bound === undefined) return true;
  return bound.base !== true && boundAdmitsSubject(bound, cardSubject(unit));
}

const NON_UNIT: ReadonlySet<Kind> = new Set(["upgrade", "base", "token", "resource", "card", "leader"]);

/** The card can be the subject: kind, traits, cost, power and arena all fit (D64). */
export function admits(subject: Subject, c: SynergyCard): boolean {
  const s = cardSubject(c);
  const kindOk =
    subject.kind === undefined || subject.kind === "card" || (subject.kind === "unit" ? s.kind === "unit" || c.type === "Token Unit" : c.type.toLowerCase().includes(subject.kind));
  if (!kindOk) return false;
  if (subject.traits.some((t) => !s.traits.includes(t)) || subject.notTraits.some((t) => s.traits.includes(t))) return false;
  if (subject.maxCost !== undefined && typeof s.cost === "number" && s.cost > subject.maxCost) return false;
  if (subject.minCost !== undefined && typeof s.cost === "number" && s.cost < subject.minCost) return false;
  if (subject.maxPower !== undefined && typeof s.power === "number" && s.power > subject.maxPower) return false;
  return subject.arena === undefined || s.arena === undefined || subject.arena === s.arena;
}

/** Wants on a lasting state; a combat scope limits when the payoff applies, not when the state may be created. */
const STATE_WANTS = new Set(["wants:exhausted-enemy", "wants:exhausted-own", "wants:damaged-units"]);

const PLAYS_NON_UNIT = /\b(?:play|for) (?:an? |up to \d+ |any number of )?(?:[\w-]+ )?(?:upgrades?|events?|non-unit)\b/i;
const NAMES_UNIT = /(?<!non-)\bunits?\b/i;

/**
 * Why an offer on card A cannot feed a want on card B, or null when nothing contradicts. Every
 * check needs both sides to state the qualifier; a missing one is not a conflict.
 */
export function conflictBetween(
  a: SynergyCard,
  offerTag: string,
  offer: TagQualifier,
  b: SynergyCard,
  wantTag: string,
  want: TagQualifier,
): string | null {
  const offerConcrete = offer.onSelf ? cardSubject(a) : undefined;
  const wantConcrete = want.onSelf ? cardSubject(b) : undefined;
  const touched = offerConcrete ?? offer.subject;
  const needed = wantConcrete ?? want.subject;

  if (offer.viaCat !== undefined && wantTag === "wants:replay-when-played") return `the offer is a ${offer.viaCat}, not a return to hand`;
  const token = DEFEATS_UNIT.test(offerTag) && offer.subject.kind === "token" ? NON_UNIT_TOKEN.exec(offer.text)?.[1] : undefined;
  if (token !== undefined) return `the offer defeats a ${token} token, which is not a unit`;
  if (touched.kind === "leader" && b.type !== "Leader") return "the offer acts on a non-unit leader, the wanting card is not a leader";
  // D84 (#166): a want on the card itself is a want of your own unit, which an offer aimed at what an opponent controls never reaches.
  if (wantConcrete !== undefined && offer.subject.side === "enemy") return "the offer acts on what an opponent controls, the want is on the wanting card itself";
  if (touched.kind !== undefined && NON_UNIT.has(touched.kind) && needed.kind === "unit" && wantConcrete !== undefined) {
    return `the offer touches a ${touched.kind}, the want needs a unit`;
  }
  if ((offerConcrete === undefined || wantConcrete === undefined) && touched.arena !== undefined && needed.arena !== undefined && touched.arena !== needed.arena) {
    return `the offer reaches ${touched.arena} only, the want is ${needed.arena}`;
  }
  if (want.opponentControls === true && actsOnOwnSide(offerTag, offer)) {
    return "the want counts what an opponent controls, the offer acts on your own side";
  }
  if (touched.side !== undefined && needed.side !== undefined && touched.side !== needed.side) {
    return `the offer acts on ${touched.side} things, the want is ${needed.side}`;
  }
  if (wantTag === "wants:base-upgrade" && offer.attach?.base !== true) return "the offer attaches to a unit, the want needs an upgraded base";
  if (offer.attach?.base === true && RECEIVING_WANTS.has(wantTag) && !BASE_OR_ANY_UPGRADE.test(want.text)) {
    return "the offer is a Fortify upgrade, which attaches to your base, not a unit";
  }
  if (want.receives === true) {
    const host = cardSubject(b);
    const bound = offer.attach;
    if (bound !== undefined && !boundAdmitsSubject(bound, host)) return `the offer attaches to ${bound.label} only, the wanting card is not one`;
    if (offerTag.startsWith("offers:give-")) {
      const missing = offer.subject.traits.find((t) => !host.traits.includes(t));
      if (missing !== undefined) return `the offer gives to ${missing} units only, the wanting card is not one`;
      const excluded = offer.subject.notTraits.find((t) => host.traits.includes(t));
      if (excluded !== undefined) return `the offer excludes ${excluded}`;
      const keyword = (offer.subject.keywords ?? []).find((k) => !printedKeywords(b).includes(k));
      if (keyword !== undefined) return `the offer gives to units with ${keyword} only, the wanting card has no ${keyword}`;
    }
  }
  if (offerConcrete !== undefined) {
    const missing = want.subject.traits.find((t) => !offerConcrete.traits.includes(t));
    if (missing !== undefined) return `the defeating unit is not a ${missing}`;
  }
  if (wantConcrete !== undefined) {
    const missing = offer.subject.traits.find((t) => !wantConcrete.traits.includes(t));
    if (missing !== undefined) return `the offer needs a ${missing}, the wanting card is not`;
    const excluded = offer.subject.notTraits.find((t) => wantConcrete.traits.includes(t));
    if (excluded !== undefined) return `the offer excludes ${excluded}`;
  }
  const supplies = offer.subject.supplies;
  if (supplies !== undefined && want.subject.traits.length + want.subject.notTraits.length > 0) {
    const fits = supplies.some((s) => want.subject.traits.every((t) => s.traits.includes(t)) && !want.subject.notTraits.some((t) => s.traits.includes(t)));
    if (!fits) {
      if (offer.subject.anyToken === true) return `the offer multiplies tokens, and no printed token fits the want's ${want.subject.traits.length > 0 ? want.subject.traits.join(" ") : "trait"} restriction`;
      const first = supplies[0];
      const missing = want.subject.traits.find((t) => !first.traits.includes(t));
      return missing !== undefined ? `the offer supplies a ${first.token} token, the want needs a ${missing}` : `the offer supplies a ${first.token} token, the want excludes it`;
    }
  }
  // D66: a token adds only its printed aspect icons, so a token of another aspect does not raise an aspect count.
  const counts = want.subject.countsAspect;
  if (counts !== undefined && supplies !== undefined && supplies.every((s) => s.aspects !== undefined && !s.aspects.includes(counts))) {
    return `the offer supplies ${supplies.map((s) => `a ${s.token} token (${s.aspects?.join(", ") || "no aspect"})`).join(" or ")}, which adds no ${counts} icon`;
  }
  if (offer.subject.tokensOnly === true && wantConcrete !== undefined && !/\btoken\b/i.test(b.type)) {
    return "the offer acts only on the tokens it creates, the wanting card is not one";
  }
  if (wantConcrete !== undefined) {
    const { maxCost, minCost, maxPower, minPower, nonLeader, aspect } = offer.subject;
    const { cost, power } = wantConcrete;
    if (maxPower !== undefined && typeof power === "number" && power > maxPower) return `the offer reaches units with ${maxPower} or less power, the wanting card has ${power}`;
    if (minPower !== undefined && typeof power === "number" && power < minPower) return `the offer reaches units with ${minPower} or more power, the wanting card has ${power}`;
    if (maxCost !== undefined && typeof cost === "number" && cost > maxCost) return `the offer reaches units costing ${maxCost} or less, the wanting card costs ${cost}`;
    if (minCost !== undefined && typeof cost === "number" && cost < minCost) return `the offer reaches units costing ${minCost} or more, the wanting card costs ${cost}`;
    if (nonLeader === true && wantConcrete.isLeader === true) return "the offer reaches non-leader units, the wanting card is a leader";
    if (aspect !== undefined && !(wantConcrete.aspects ?? []).includes(aspect)) return `the offer reaches ${aspect} units, the wanting card is not`;
  }
  if (offerTag === "offers:return-upgrade" && wantTag === "wants:pilot-attached" && offer.subject.side === "enemy") {
    return "the returned upgrades belong to the opponent, who takes them back";
  }
  const barred = offer.subject.notTraits.find((t) => want.subject.traits.includes(t));
  if (barred !== undefined) return `the offer excludes ${barred}`;
  if (wantTag === "wants:units-played" && (PLAYS_NON_UNIT.test(offer.text) || (a.type === "Upgrade" && !NAMES_UNIT.test(offer.text)))) {
    return "the offer plays an upgrade or event, the want needs a unit played";
  }
  if (wantTag === "wants:pilot-attached" && offerTag !== "offers:return-upgrade" && !(offerTag === "offers:upgrade-to-attach" ? a.structured.traits.includes("Pilot") : /\bpilot/i.test(offer.text))) {
    return "the offer is not a Pilot and does not play one";
  }
  if (offerTag === "offers:upgrade-to-attach" && want.hostAbility === true && a.type === "Upgrade" && blanksHost(a)) {
    return "the upgrade removes the abilities of the unit it attaches to, including the one that needs the unit upgraded";
  }
  // D83 (#165): an upgrade that harms its carrier goes on an enemy unit, so it upgrades none of yours and no card of yours moves it.
  if (offerTag === "offers:upgrade-to-attach" && RECEIVING_WANTS.has(wantTag) && !BASE_OR_ANY_UPGRADE.test(want.text) && harmsHost(a)) {
    return "the upgrade harms the unit it attaches to, so it is played on an enemy unit and upgrades none of yours";
  }
  // D83 (#165): an effect gated on the attached unit's name reaches only that card.
  const named = ATTACHED_NAME.exec(offer.text)?.[1];
  if (named !== undefined && (want.onSelf || want.receives === true) && folded(named) !== folded(b.title) && !b.structured.traits.includes(named)) {
    return `the offer works only if the attached unit is ${named}, the wanting card is not`;
  }
  // D83 (#165): a defeat in the regroup phase is not one a "this phase" check of the action phase sees.
  if (offer.regroup === true && /\bthis phase\b/i.test(want.text)) {
    return "the offer happens in the regroup phase, the want counts what happened this phase";
  }
  if (want.scope !== undefined && !STATE_WANTS.has(wantTag) && offer.triggers.length > 0 && !offer.triggers.some((t) => ATTACK_TRIGGERS.has(t)) && !/\battack/i.test(offer.text)) {
    return `the want triggers only ${want.scope}, the offer does not happen in combat`;
  }
  // D84 (#166): "a Force upgrade" is met by an upgrade of that trait; an Experience or Shield token carries no trait.
  const upgradeTrait = wantTag === "wants:upgrades-attached" ? TRAIT_UPGRADE.exec(want.text)?.[1] : undefined;
  if (upgradeTrait !== undefined && (offerTag.startsWith("offers:give-") || (offerTag === "offers:upgrade-to-attach" && !a.structured.traits.includes(upgradeTrait)))) {
    return `the want needs a ${upgradeTrait} upgrade, the offer does not supply one`;
  }
  // D85 (#167): damage that only a damaged unit can take never makes an undamaged card damaged (TIE Dagger Vanguard cannot switch on Oggdo Bogdo).
  if (offer.subject.damagedOnly === true && wantTag === "wants:self-damaged" && DAMAGED_GATE.test(want.text)) {
    return "the offer reaches only a unit that is already damaged, the want needs the card to become damaged";
  }
  // D86 (#168): a ready that reaches only a unit that has not attacked this phase restores that unit's one attack, never a second one.
  if (offer.subject.unattackedOnly === true && offerTag === "offers:ready-unit" && wantTag === "wants:extra-attacks") {
    return "the offer readies only a unit that has not attacked this phase, so it gives no extra attack";
  }
  if (want.forAttackOnly && (offerTag === "offers:ready-unit" || offerTag === "offers:extra-attack")) {
    return "the wanted ability lasts for one attack only and does not carry through a ready";
  }
  return null;
}

/** Wants that count what an effect leaves behind (a card in the discard), not the subject the effect acted on. */
const SIDE_PRODUCT_WANTS = new Set(["wants:cards-in-discard"]);

/** The traits a card puts on the board: its own when it is a unit, and the printed traits of every token it creates (D42). */
export function boardTraits(card: SynergyCard, tokenTraits: TokenTraits | undefined): string[] {
  const own = card.type === "Unit" || card.type === "Leader" || card.type === "Token Unit" ? card.structured.traits : [];
  const made = card.tags.offers
    .filter((t) => CREATE_OFFERS.has(t.tag))
    .map((t) => qualifierOf(card, "offers", t.tag, t.why, tokenTraits).subject)
    .flatMap((s) => (s.anyToken === true ? [] : (s.supplies ?? []).flatMap((x) => x.traits)));
  return [...new Set([...own, ...made])].sort(cmp);
}

/**
 * The traits a friendly offer's target restricts to ("Defeat a friendly Creature unit") that card B neither
 * carries nor creates, when B's want watches the offered subject (#108). Empty when nothing is missing. A non-empty
 * answer is not a conflict: the pair alone cannot fire, but a trio whose third card supplies the traits can.
 * A want on the card itself is already bound by conflictBetween.
 */
export function offerTraitNeeds(offer: TagQualifier, b: SynergyCard, wantTag: string, want: TagQualifier, tokenTraits?: TokenTraits): string[] {
  const { side, kind, traits } = offer.subject;
  if (offer.onSelf || want.onSelf || side !== "friendly" || traits.length === 0 || (kind !== undefined && kind !== "unit") || SIDE_PRODUCT_WANTS.has(wantTag)) return [];
  const carried = boardTraits(b, tokenTraits);
  return traits.filter((t) => !carried.includes(t));
}

/**
 * What a tag acts on, when that differs from a plain unit: an arena, or a non-unit kind such as a
 * base, an upgrade or a resource. Empty when the features state nothing beyond "a unit".
 */
export function targetLabel(q: TagQualifier): string {
  if (q.viaCat !== undefined) return q.viaCat;
  const { kind, arena } = q.subject;
  return [arena, kind !== undefined && NON_UNIT.has(kind) ? kind : undefined].filter((x) => x !== undefined).join("-");
}

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
type Kind = "unit" | "upgrade" | "base" | "token" | "resource" | "card";
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
  nonLeader?: boolean;
  /** The aspect a target must have ("a Heroism unit"). */
  aspect?: string;
  /** The card itself, used when the want acts on the card that carries it. */
  cost?: number | null;
  isLeader?: boolean;
  aspects?: string[];
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
}

interface TargetLite {
  side?: string;
  kind?: string;
  arena?: string;
  restrict?: string[];
  text?: string;
}
interface EffectLite {
  cat?: string;
  target?: TargetLite;
}
interface ClauseLite {
  text: string;
  curatedId?: string;
  effects: EffectLite[];
  modifiers?: { cat?: string }[];
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
const SELF_WANTS = new Set(["wants:self-defeated", "wants:self-damaged", "wants:replay-when-played", "wants:ready-unit"]);

const catsFor = (table: [RegExp, string[]][], tag: string): string[] => table.find(([re]) => re.test(tag))?.[1] ?? [];

const NON_TRAIT = /\bnon[-‐‑ ]([A-Z][\w']*)/g;

const MODIFIERS = new Set([
  "a", "an", "the", "this", "that", "each", "every", "all", "any", "up", "to", "number", "of", "another", "other", "your", "friendly", "enemy", "own",
  "damaged", "undamaged", "exhausted", "ready", "ground", "space", "unique", "non", "leader", "non-leader", "non-unique", "or", "more", "less", "and", "one", "two", "three",
]);
const HEADS: Record<string, Kind> = { unit: "unit", units: "unit", upgrade: "upgrade", upgrades: "upgrade", base: "base", bases: "base", resource: "resource", resources: "resource", card: "card", cards: "card", token: "token", tokens: "token" };
const UPGRADE_TOKEN = /\b(?:experience|shield|credit|advantage|weakness|force)\b/i;

/** The head noun of a target phrase ("a unit that costs 3 resources" is a unit), because the parsed kind follows the first noun it sees. */
function headKind(text: string, parsed: string | undefined): Kind | undefined {
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
  return {
    side,
    kind,
    arena,
    traits: [...new Set(traits)].sort(cmp),
    notTraits: notTraits.sort(cmp),
    maxCost: bound("cost_le"),
    minCost: bound("cost_ge"),
    nonLeader: restrict.includes("non_leader") || restrict.includes("non-leader") || undefined,
    aspect,
  };
}

const WATCHED = /\bfriendly (?:([A-Z][\w']*(?: [A-Z][\w']*)*) )?(?:(space|ground) )?units?\b/;

/** The traits and arena a watcher names in its trigger or condition text ("a friendly Rebel unit"). */
function watcherSubject(text: string): Subject {
  const m = WATCHED.exec(text);
  if (m === null) return EMPTY;
  return { side: "friendly", arena: m[2] === "ground" || m[2] === "space" ? m[2] : undefined, traits: m[1] === undefined ? [] : [m[1]], notTraits: [] };
}

const scopeOf = (text: string): TagQualifier["scope"] =>
  /\bwhile attacking\b/i.test(text) ? "attacking" : /\bwhile defending\b/i.test(text) ? "defending" : undefined;

/** The qualifiers of one tag on one card; a tag whose origin is not in the feature record carries none. */
export function qualifierOf(card: SynergyCard, side: "offers" | "wants", tag: string, why: string): TagQualifier {
  const origin = findOrigin(card, why);
  if (origin === undefined) {
    const onSelf = side === "offers" ? SELF_OFFERS.has(tag) : SELF_WANTS.has(tag) || (tag === "wants:extra-attacks" && ATTACK_TRIGGERS.has(FACE_PREFIX.exec(why)?.[2] ?? why));
    return { subject: EMPTY, triggers: [], forAttackOnly: false, onSelf, text: "" };
  }
  const { ability, clause, forAttackOnly } = origin;
  const triggers = (ability.triggers ?? []).flatMap((t) => (t.trigger === undefined ? [] : [t.trigger]));
  const payload = FACE_PREFIX.exec(why)?.[2] ?? why;
  const triggerText = (ability.triggers ?? []).map((t) => t.text ?? "").join(" ");
  const text = clause?.text ?? payload;

  let subject: Subject = EMPTY;
  let viaCat: string | undefined;
  const cats = catsFor(side === "offers" ? OFFER_CATS : WANT_CATS, tag);
  if (clause !== undefined && cats.length > 0) {
    const hit = clause.effects.find((e) => cats.includes(e.cat ?? ""));
    if (hit !== undefined) subject = subjectOf(hit.target);
    else if (clause.effects.some((e) => e.cat === "tuck")) viaCat = "tuck";
  } else if (side === "offers" && CREATE_OFFERS.has(tag)) {
    subject = { side: "friendly", traits: [], notTraits: [] };
  }
  if (side === "wants" && subject === EMPTY) {
    const watcher = watcherSubject(`${text} ${triggerText}`);
    if (watcher !== EMPTY && watcher.traits.length + Number(watcher.arena !== undefined) > 0) subject = watcher;
  }
  return {
    subject,
    triggers,
    scope: side === "wants" ? scopeOf(`${triggerText} ${text}`) : undefined,
    forAttackOnly: side === "wants" && forAttackOnly,
    viaCat,
    onSelf: side === "offers" ? SELF_OFFERS.has(tag) : SELF_WANTS.has(tag) || (tag === "wants:heal" && /\bthis unit\b/i.test(triggerText)) || (tag === "wants:extra-attacks" && ATTACK_TRIGGERS.has(payload)),
    text,
  };
}

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
  isLeader: c.type === "Leader",
  aspects: c.structured.aspects,
});

const NON_UNIT: ReadonlySet<Kind> = new Set(["upgrade", "base", "token", "resource", "card"]);

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
  if (touched.kind !== undefined && NON_UNIT.has(touched.kind) && needed.kind === "unit" && wantConcrete !== undefined) {
    return `the offer touches a ${touched.kind}, the want needs a unit`;
  }
  if ((offerConcrete === undefined || wantConcrete === undefined) && touched.arena !== undefined && needed.arena !== undefined && touched.arena !== needed.arena) {
    return `the offer reaches ${touched.arena} only, the want is ${needed.arena}`;
  }
  if (touched.side !== undefined && needed.side !== undefined && touched.side !== needed.side) {
    return `the offer acts on ${touched.side} things, the want is ${needed.side}`;
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
  if (wantConcrete !== undefined) {
    const { maxCost, minCost, nonLeader, aspect } = offer.subject;
    const cost = wantConcrete.cost;
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
  if (want.scope !== undefined && offer.triggers.length > 0 && !offer.triggers.some((t) => ATTACK_TRIGGERS.has(t)) && !/\battack/i.test(offer.text)) {
    return `the want triggers only ${want.scope}, the offer does not happen in combat`;
  }
  if (want.forAttackOnly && (offerTag === "offers:ready-unit" || offerTag === "offers:extra-attack")) {
    return "the wanted ability lasts for one attack only and does not carry through a ready";
  }
  return null;
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

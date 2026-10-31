import { compareCodePoints } from "../swu/canonical.js";
import { ASPECT_NAMES, baseMeets, clauseTextsOf, namedBaseOfClause } from "./locks.js";
import type { SynergyCard } from "./schema.js";

/**
 * @displayName Clause locks
 * @strategicPurpose One lock rule for every deck tool (D59, #147): a clause that works only under a named base
 * (D51) or only while the deck controls a unit of an aspect is dead weight in a deck that cannot meet it, and
 * no tool should rank it as live. Before this, only find_pairings and find_trios honoured a base lock.
 * @tacticalObjective Reads the lock off a card's own clause text, checks it against the leader, base and deck
 * the caller holds, and names what is unmet as `baseLocked`, `needsUnitAspect`, (D66) `nameLocked` and (D68) `needsForce` and
 * `needsTrait`. Pure; no clock, no model.
 */

export interface ClauseLock {
  /** Base names the card's clauses require that the deck's base does not meet, sorted by code point. */
  baseLocked: string[];
  /** Aspect requirements ("Vigilance", "Command or Cunning") the leader, base and deck units do not meet, sorted by code point. */
  needsUnitAspect: string[];
  /** D66: card names a clause needs controlled ("While you control Padmé Amidala") that the leader, base and deck do not supply; present only when non-empty. */
  nameLocked?: string[];
  /** D68: the Force needs ("use the Force", "while the Force is with you") of a card no leader, base or deck card makes the Force for; present only when non-empty. */
  needsForce?: string[];
  /** D68: unit traits a clause needs controlled ("another Official unit") that the deck, or the leader's played lists, does not hold; present only when non-empty. */
  needsTrait?: string[];
}

export const NO_LOCK: ClauseLock = { baseLocked: [], needsUnitAspect: [] };

const OPTIONAL_LOCKS = ["nameLocked", "needsForce", "needsTrait"] as const;
type OptionalLock = (typeof OPTIONAL_LOCKS)[number];

export const isLocked = (lock: ClauseLock): boolean =>
  lock.baseLocked.length > 0 || lock.needsUnitAspect.length > 0 || OPTIONAL_LOCKS.some((k) => (lock[k] ?? []).length > 0);

/** The output fields of a lock, empty when it holds nothing. */
export function lockFields(lock: ClauseLock): { baseLocked?: string; needsUnitAspect?: string } & Partial<Record<OptionalLock, string>> {
  return {
    ...(lock.baseLocked.length === 0 ? {} : { baseLocked: lock.baseLocked.join(", ") }),
    ...(lock.needsUnitAspect.length === 0 ? {} : { needsUnitAspect: lock.needsUnitAspect.join(", ") }),
    ...Object.fromEntries(OPTIONAL_LOCKS.flatMap((k) => ((lock[k] ?? []).length === 0 ? [] : [[k, (lock[k] ?? []).join(", ")]]))),
  };
}

/** The optional lock fields that hold something, so an unlocked lock keeps the two-field shape callers compare against. */
const optionalFields = (values: Partial<Record<OptionalLock, string[]>>): Partial<Record<OptionalLock, string[]>> =>
  Object.fromEntries(OPTIONAL_LOCKS.flatMap((k) => ((values[k] ?? []).length === 0 ? [] : [[k, values[k]]])));

export function mergeLocks(locks: readonly ClauseLock[]): ClauseLock {
  const union = (pick: (l: ClauseLock) => string[]): string[] => [...new Set(locks.flatMap(pick))].sort(compareCodePoints);
  return {
    baseLocked: union((l) => l.baseLocked),
    needsUnitAspect: union((l) => l.needsUnitAspect),
    ...optionalFields(Object.fromEntries(OPTIONAL_LOCKS.map((k) => [k, union((l) => l[k] ?? [])]))),
  };
}

/** "While you control Padmé Amidala", "If you control Jabba the Hutt": a capitalised card name right after "you control" (D66). */
const NAMED_CARD = /\byou control ([A-Z][\p{L}'\u2019-]+(?: (?:(?:the|of) )?[A-Z][\p{L}'\u2019-]*)*)/u;
/** Accents and case dropped, so "Padme Amidala" in one text meets "Padmé Amidala" in a title. */
const nameKey = (name: string): string => name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** The card name one clause needs controlled, or null when it names none. */
export function namedCardOfClause(text: string): string | null {
  const hit = NAMED_CARD.exec(text)?.[1];
  return hit === undefined || ASPECT_NAMES.has(hit) ? null : hit;
}

/** The names the cards' clauses need controlled that no listed card (the cards themselves, a leader, a base) carries as its title, sorted by code point. */
export function nameLockOfCards(cards: readonly SynergyCard[], suppliers: readonly (SynergyCard | undefined)[]): string[] {
  const titles = new Set([...cards, ...suppliers].flatMap((c) => (c === undefined ? [] : [nameKey(c.title)])));
  const needed = cards.flatMap((c) => clauseTextsOf(c).flatMap((t) => namedCardOfClause(t) ?? []));
  return [...new Set(needed.filter((n) => !titles.has(nameKey(n))))].sort(compareCodePoints);
}

const ASPECT = [...ASPECT_NAMES].join("|");
const ASPECT_LIST = `(?:${ASPECT})(?:(?:, or | or |, )(?:${ASPECT}))*`;
/** A modal bullet that starts with its condition: "Vigilance unit, heal 2 damage from a base." */
const BULLET_UNIT = new RegExp(`^(${ASPECT_LIST}) unit,`);
/** "While you control another Aggression unit" and "If you control a Command or Cunning unit". */
const CONTROL_UNIT = new RegExp(`\\byou control (another |an? )(${ASPECT_LIST}) unit\\b`);

interface AspectGate {
  aspects: string[];
  /** The clause says "another", so the card itself cannot meet it. */
  another: boolean;
}

/**
 * The aspect-unit condition a clause is gated on, or null. A clause that says "instead" is an upgrade of an effect
 * that happens anyway, so its condition gates nothing the card lacks without it.
 */
export function aspectGateOfClause(text: string): AspectGate | null {
  if (/\binstead\b/i.test(text)) return null;
  const bullet = BULLET_UNIT.exec(text);
  if (bullet !== null) return { aspects: bullet[1].split(/, or | or |, /), another: false };
  const control = CONTROL_UNIT.exec(text);
  return control === null ? null : { aspects: control[2].split(/, or | or |, /), another: control[1] === "another " };
}

/** "use the Force" (a cost) and "While the Force is with you" (a state the deck must create) need the Force (D68). */
const NEEDS_FORCE = /\b(?:use the Force|(?:while|if) the Force is with you)\b/i;
const FORCE_STATE = /\b(?:while|if) the Force is with you\b/gi;
/** "The Force is with you (create your Force token)" makes the Force; "While the Force is with you" only reads it. */
const MAKES_FORCE = /\bthe Force is with you\b|\bcreate (?:a|your|the) Force token\b/i;

/**
 * The Force need one clause or trigger text states ("use the Force"), or null. A clause that says "instead" upgrades an
 * effect that happens anyway, and "or use the Force" offers another way to pay, so neither needs the Force.
 */
export function forceNeedOfText(text: string): string | null {
  if (/\binstead\b/i.test(text) || /\bor use the Force\b/i.test(text)) return null;
  const hit = NEEDS_FORCE.exec(text)?.[0];
  return hit === undefined ? null : `${hit.charAt(0).toLowerCase()}${hit.slice(1)}`;
}

/** The trigger texts of a card's abilities, every face: a cost such as "Action [Exhaust, use the Force]" sits there, not in a clause. */
function triggerTextsOf(card: SynergyCard): string[] {
  return Object.values(card.faces)
    .flat()
    .flatMap((a) => (a.triggers ?? []).flatMap((t) => (t.text === undefined ? [] : [t.text])));
}

/** Whether a card makes the Force: one of its clauses says "The Force is with you" as an effect, not as a condition. */
export const makesForce = (card: SynergyCard): boolean => clauseTextsOf(card).some((t) => MAKES_FORCE.test(t.replace(FORCE_STATE, "")));

const CAP = "[A-Z][\\p{L}'\u2019-]*(?: [A-Z][\\p{L}'\u2019-]*)*";
/** "While you control another Official unit", "If you control a Force unit", "another Wookiee unit or a Kashyyyk base". */
const TRAIT_UNIT = new RegExp(`\\byou control (another |an? )(${CAP}(?: or ${CAP})*) unit(?: or an? (${CAP}) base)?`, "u");

export interface TraitGate {
  traits: string[];
  /** The clause says "another", so the card itself cannot meet it. */
  another: boolean;
  /** "or a Kashyyyk base": a base of that location meets the gate as well. */
  orBase?: string;
}

/** The unit-trait condition a clause is gated on, or null; an aspect list is the aspect gate's, and an "instead" clause gates nothing. */
export function traitGateOfClause(text: string): TraitGate | null {
  if (/\binstead\b/i.test(text)) return null;
  const hit = TRAIT_UNIT.exec(text);
  if (hit === null) return null;
  const traits = hit[2].split(" or ");
  if (traits.some((t) => ASPECT_NAMES.has(t))) return null;
  return { traits, another: hit[1] === "another ", ...(hit[3] === undefined ? {} : { orBase: hit[3] }) };
}

/** "You may attack with a friendly Droid unit", "Give a friendly Jedi unit ...": the effect's own target names a unit trait. */
const TARGET_TRAIT = new RegExp(`\\b(?:(another|other) )?friendly (${CAP}(?: or ${CAP})*) units?\\b|\\battack with (another |an? )(${CAP}(?: or ${CAP})*) unit\\b`, "u");

/**
 * D82 (#164): the unit trait an effect's target is restricted to ("attack with a friendly Droid unit"), or null. With no
 * friendly unit of the trait the clause has no legal target, so it gates the clause the way "While you control a Droid unit"
 * does; an aspect list is no trait, and an "instead" clause gates nothing.
 */
export function targetTraitOfClause(text: string): TraitGate | null {
  if (/\binstead\b/i.test(text)) return null;
  const hit = TARGET_TRAIT.exec(text);
  if (hit === null) return null;
  const traits = (hit[2] ?? hit[4]).split(" or ");
  if (traits.some((t) => ASPECT_NAMES.has(t))) return null;
  return { traits, another: hit[1] !== undefined || hit[3] === "another " };
}

/** What the deck supplies: its base, and for each aspect the cards (leader, base, deck units) that supply a unit of it. */
export interface LockSupply {
  base: SynergyCard | undefined;
  suppliers: ReadonlyMap<string, ReadonlySet<string>>;
  /** D66: the titles (accent- and case-folded) of the leader, base and deck cards; without it no name lock is read. */
  names?: ReadonlySet<string>;
  /** D68: the cards (leader, base, deck or played lists) that make the Force; without it no Force lock is read. */
  forceMakers?: ReadonlySet<string>;
  /** D68: for each trait the cards (leader, deck or played-list units) that supply a unit of it; without it no trait lock is read. */
  traitUnits?: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * D68: the Force and trait supply of the leader, the base and a pool of cards (the decklist, or the leader's played
 * lists when no decklist is given). A deployed leader is a unit, so its traits count; a base is never a unit.
 */
export function resourceSupply(leader: SynergyCard | undefined, base: SynergyCard | undefined, pool: readonly SynergyCard[]): Required<Pick<LockSupply, "forceMakers" | "traitUnits">> {
  const forceMakers = new Set([leader, base, ...pool].flatMap((c) => (c !== undefined && makesForce(c) ? [c.cardKey] : [])));
  const traitUnits = new Map<string, Set<string>>();
  for (const c of [leader, ...pool]) {
    if (c === undefined || (c !== leader && c.type !== "Unit")) continue;
    for (const trait of c.structured.traits) traitUnits.set(trait, (traitUnits.get(trait) ?? new Set<string>()).add(c.cardKey));
  }
  return { forceMakers, traitUnits };
}

/**
 * The supply of a deck: the leader's aspects (a deployed leader is a unit) and the aspects of the deck's unit cards.
 * A base is never a unit, so its aspect does not meet an "<Aspect> unit" clause (D59).
 */
export function lockSupply(leader: SynergyCard | undefined, base: SynergyCard | undefined, deck: readonly SynergyCard[], played?: readonly SynergyCard[]): LockSupply {
  const suppliers = new Map<string, Set<string>>();
  const add = (card: SynergyCard): void => {
    for (const aspect of card.structured.aspects) suppliers.set(aspect, (suppliers.get(aspect) ?? new Set<string>()).add(card.cardKey));
  };
  if (leader !== undefined) add(leader);
  for (const card of deck) if (card.type === "Unit") add(card);
  const names = new Set([leader, base, ...deck].flatMap((c) => (c === undefined ? [] : [nameKey(c.title)])));
  // D68: the decklist when given, else the leader's played lists; with neither, the Force and trait locks stay silent.
  const pool = deck.length > 0 ? deck : played;
  return { base, suppliers, names, ...(pool === undefined ? {} : resourceSupply(leader, base, pool)) };
}

const metGate = (gate: AspectGate, cardKey: string, supply: LockSupply): boolean =>
  gate.aspects.some((a) => [...(supply.suppliers.get(a) ?? [])].some((k) => !gate.another || k !== cardKey));

const metTrait = (gate: TraitGate, cardKey: string, supply: LockSupply, self: SynergyCard | undefined): boolean =>
  (gate.orBase !== undefined && baseMeets(supply.base, gate.orBase)) ||
  gate.traits.some(
    (t) =>
      [...(supply.traitUnits?.get(t) ?? [])].some((k) => !gate.another || k !== cardKey) ||
      (!gate.another && self?.type === "Unit" && self.structured.traits.includes(t)),
  );

const traitLabel = (gate: TraitGate): string => [gate.traits.join(" or "), ...(gate.orBase === undefined ? [] : [`a ${gate.orBase} base`])].join(" or ");

/** D68: the Force need and the trait gate of one text that the supply does not meet; `self` (the card) meets a non-"another" trait gate and makes its own Force. */
function resourceTextLock(text: string, cardKey: string, supply: LockSupply, self?: SynergyCard): Partial<Record<"needsForce" | "needsTrait", string[]>> {
  const force = supply.forceMakers === undefined ? null : forceNeedOfText(text);
  const forceMet = supply.forceMakers === undefined || supply.forceMakers.size > 0 || (self !== undefined && makesForce(self));
  const trait = supply.traitUnits === undefined ? null : (traitGateOfClause(text) ?? targetTraitOfClause(text));
  return {
    ...(force === null || forceMet ? {} : { needsForce: [force] }),
    ...(trait === null || metTrait(trait, cardKey, supply, self) ? {} : { needsTrait: [traitLabel(trait)] }),
  };
}

/** The lock of one clause text on the card `cardKey`; `self`, when given, is that card. */
export function clauseTextLock(text: string, cardKey: string, supply: LockSupply, self?: SynergyCard): ClauseLock {
  const name = namedBaseOfClause(text);
  const gate = aspectGateOfClause(text);
  const card = namedCardOfClause(text);
  return {
    baseLocked: name === null || baseMeets(supply.base, name) ? [] : [name],
    needsUnitAspect: gate === null || metGate(gate, cardKey, supply) ? [] : [gate.aspects.join(" or ")],
    ...(card === null || supply.names === undefined || supply.names.has(nameKey(card)) ? {} : { nameLocked: [card] }),
    ...resourceTextLock(text, cardKey, supply, self),
  };
}

/** The lock of a clause as an offer or tag cites it ("text: If you control a Tatooine base, ..."): the face prefix is dropped. */
export const offerLock = (why: string, cardKey: string, supply: LockSupply): ClauseLock =>
  clauseTextLock(why.replace(/^(?:text|deployBox|epicAction): /, ""), cardKey, supply);

/** Every unmet lock across a card's own clauses, and the Force cost of its triggers (D68). */
export function clauseLock(card: SynergyCard, supply: LockSupply): ClauseLock {
  const triggers = triggerTextsOf(card).map((text) => ({ baseLocked: [], needsUnitAspect: [], ...resourceTextLock(text, card.cardKey, supply, card) }));
  return mergeLocks([...clauseTextsOf(card).map((text) => clauseTextLock(text, card.cardKey, supply, card)), ...triggers]);
}

/**
 * D68: the Force and trait locks of cards that supply each other (a pairing's subject and partner, a trio's members)
 * beside the leader, the base and a pool (the decklist, else the leader's played lists). Only these two locks: the
 * pairing and trio tools read the base and name locks their own way.
 */
export function resourceLockOfCards(
  cards: readonly SynergyCard[],
  leader: SynergyCard | undefined,
  base: SynergyCard | undefined,
  pool: readonly SynergyCard[],
): { needsForce: string[]; needsTrait: string[] } {
  const supply: LockSupply = { base, suppliers: new Map(), ...resourceSupply(leader, base, [...pool, ...cards]) };
  const lock = mergeLocks(
    cards.flatMap((c) =>
      [...clauseTextsOf(c), ...triggerTextsOf(c)].map((text) => ({ baseLocked: [], needsUnitAspect: [], ...resourceTextLock(text, c.cardKey, supply, c) })),
    ),
  );
  return { needsForce: lock.needsForce ?? [], needsTrait: lock.needsTrait ?? [] };
}

/**
 * D71: a Pilot unit (printed Piloting, offering `offers:upgrade-to-attach`) attaches to a Vehicle, so a trio that
 * leans on that offer needs a Vehicle unit on the board. The suppliers are the leader, the deck and the other members.
 */
export function hostNeedOfCards(cards: readonly SynergyCard[], leader: SynergyCard | undefined, deck: readonly SynergyCard[]): string[] {
  const pilots = cards.filter(
    (c) =>
      c.type === "Unit" &&
      (((c.structured as { keywordsField?: unknown }).keywordsField as unknown[] | undefined) ?? []).includes("Piloting") &&
      c.tags.offers.some((o) => o.tag === "offers:upgrade-to-attach"),
  );
  if (pilots.length === 0) return [];
  const hosted = [leader, ...deck, ...cards].some((c) => c !== undefined && (c === leader || c.type === "Unit") && !pilots.includes(c) && c.structured.traits.includes("Vehicle"));
  return hosted ? [] : ["Vehicle"];
}

/** "For this attack, it deals damage ...", "If you do, ...": a clause whose every effect lands on what an earlier clause chose. */
const REFERS_BACK = /^(?:if you do(?:n't)?|for this attack|then)\b/i;
function refersBack(clause: { text: string; effects: readonly unknown[] }): boolean {
  if (REFERS_BACK.test(clause.text.trim())) return true;
  const targets = clause.effects.map((e) => (e as { target?: { side?: unknown } }).target?.side);
  return targets.length > 0 && targets.every((side) => side === "ref");
}

/**
 * D82 (#164): the tags of a card that rest only on clauses the trait lock shuts. A clause whose own target or condition
 * needs a unit of a trait the supply lacks is shut; when every clause of the ability is shut or only refers back to a
 * shut one (Babu Frik: "You may attack with a friendly Droid unit. For this attack, it deals damage ..."), the whole
 * ability is, its trigger and cost included ("Action [Exhaust]"). A tag is locked when every entry of it cites a shut text.
 */
export function lockedTagsOf(card: SynergyCard, supply: LockSupply): Set<string> {
  if (supply.traitUnits === undefined) return new Set();
  const shut = new Set<string>();
  const shutTriggers: string[] = [];
  const liveTriggers = new Set<string>();
  for (const [face, abilities] of Object.entries(card.faces)) {
    for (const ability of abilities) {
      const clauses = [...(ability.clauses ?? []), ...(ability.options ?? []).flatMap((o) => o.clauses)];
      const locked = clauses.map((c) => (resourceTextLock(c.text, card.cardKey, supply, card).needsTrait ?? []).length > 0);
      const whole = locked.includes(true) && clauses.every((c, i) => locked[i] || refersBack(c));
      // Two abilities can share a trigger text ("Action [Exhaust]"); the trigger is shut only when no live ability carries it.
      if (!whole) for (const t of ability.triggers ?? []) if (t.text !== undefined) liveTriggers.add(`${face}: ${t.text}`);
      if (!locked.includes(true)) continue;
      clauses.forEach((c, i) => {
        if (!locked[i] && !whole) return;
        shut.add(`${face}: ${c.text}`);
        if (c.curatedId !== undefined) shut.add(`curated ${c.curatedId}`);
      });
      if (whole) for (const t of ability.triggers ?? []) if (t.text !== undefined) shutTriggers.push(`${face}: ${t.text}`);
    }
  }
  const isShut = (why: string): boolean => shut.has(why) || shutTriggers.some((t) => !liveTriggers.has(t) && (why === t || why.startsWith(`${t} (`)));
  const tags = [...card.tags.offers, ...card.tags.wants];
  return new Set(tags.filter((t) => tags.filter((u) => u.tag === t.tag).every((u) => isShut(u.why))).map((t) => t.tag));
}

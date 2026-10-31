import { compareCodePoints } from "../swu/canonical.js";
import { ASPECT_NAMES, baseMeets, clauseTextsOf, namedBaseOfClause } from "./locks.js";
import type { SynergyCard } from "./schema.js";

/**
 * @displayName Clause locks
 * @strategicPurpose One lock rule for every deck tool (D59, #147): a clause that works only under a named base
 * (D51) or only while the deck controls a unit of an aspect is dead weight in a deck that cannot meet it, and
 * no tool should rank it as live. Before this, only find_pairings and find_trios honoured a base lock.
 * @tacticalObjective Reads the lock off a card's own clause text, checks it against the leader, base and deck
 * the caller holds, and names what is unmet as `baseLocked`, `needsUnitAspect` and (D66) `nameLocked`. Pure; no clock, no model.
 */

export interface ClauseLock {
  /** Base names the card's clauses require that the deck's base does not meet, sorted by code point. */
  baseLocked: string[];
  /** Aspect requirements ("Vigilance", "Command or Cunning") the leader, base and deck units do not meet, sorted by code point. */
  needsUnitAspect: string[];
  /** D66: card names a clause needs controlled ("While you control Padmé Amidala") that the leader, base and deck do not supply; present only when non-empty. */
  nameLocked?: string[];
}

export const NO_LOCK: ClauseLock = { baseLocked: [], needsUnitAspect: [] };

export const isLocked = (lock: ClauseLock): boolean => lock.baseLocked.length > 0 || lock.needsUnitAspect.length > 0 || (lock.nameLocked ?? []).length > 0;

/** The output fields of a lock, empty when it holds nothing. */
export function lockFields(lock: ClauseLock): { baseLocked?: string; needsUnitAspect?: string; nameLocked?: string } {
  return {
    ...(lock.baseLocked.length === 0 ? {} : { baseLocked: lock.baseLocked.join(", ") }),
    ...(lock.needsUnitAspect.length === 0 ? {} : { needsUnitAspect: lock.needsUnitAspect.join(", ") }),
    ...((lock.nameLocked ?? []).length === 0 ? {} : { nameLocked: (lock.nameLocked ?? []).join(", ") }),
  };
}

export function mergeLocks(locks: readonly ClauseLock[]): ClauseLock {
  const union = (pick: (l: ClauseLock) => string[]): string[] => [...new Set(locks.flatMap(pick))].sort(compareCodePoints);
  const names = union((l) => l.nameLocked ?? []);
  return { baseLocked: union((l) => l.baseLocked), needsUnitAspect: union((l) => l.needsUnitAspect), ...(names.length === 0 ? {} : { nameLocked: names }) };
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

/** What the deck supplies: its base, and for each aspect the cards (leader, base, deck units) that supply a unit of it. */
export interface LockSupply {
  base: SynergyCard | undefined;
  suppliers: ReadonlyMap<string, ReadonlySet<string>>;
  /** D66: the titles (accent- and case-folded) of the leader, base and deck cards; without it no name lock is read. */
  names?: ReadonlySet<string>;
}

/**
 * The supply of a deck: the leader's aspects (a deployed leader is a unit) and the aspects of the deck's unit cards.
 * A base is never a unit, so its aspect does not meet an "<Aspect> unit" clause (D59).
 */
export function lockSupply(leader: SynergyCard | undefined, base: SynergyCard | undefined, deck: readonly SynergyCard[]): LockSupply {
  const suppliers = new Map<string, Set<string>>();
  const add = (card: SynergyCard): void => {
    for (const aspect of card.structured.aspects) suppliers.set(aspect, (suppliers.get(aspect) ?? new Set<string>()).add(card.cardKey));
  };
  if (leader !== undefined) add(leader);
  for (const card of deck) if (card.type === "Unit") add(card);
  const names = new Set([leader, base, ...deck].flatMap((c) => (c === undefined ? [] : [nameKey(c.title)])));
  return { base, suppliers, names };
}

const metGate = (gate: AspectGate, cardKey: string, supply: LockSupply): boolean =>
  gate.aspects.some((a) => [...(supply.suppliers.get(a) ?? [])].some((k) => !gate.another || k !== cardKey));

/** The lock of one clause text on the card `cardKey`. */
export function clauseTextLock(text: string, cardKey: string, supply: LockSupply): ClauseLock {
  const name = namedBaseOfClause(text);
  const gate = aspectGateOfClause(text);
  const card = namedCardOfClause(text);
  return {
    baseLocked: name === null || baseMeets(supply.base, name) ? [] : [name],
    needsUnitAspect: gate === null || metGate(gate, cardKey, supply) ? [] : [gate.aspects.join(" or ")],
    ...(card === null || supply.names === undefined || supply.names.has(nameKey(card)) ? {} : { nameLocked: [card] }),
  };
}

/** The lock of a clause as an offer or tag cites it ("text: If you control a Tatooine base, ..."): the face prefix is dropped. */
export const offerLock = (why: string, cardKey: string, supply: LockSupply): ClauseLock =>
  clauseTextLock(why.replace(/^(?:text|deployBox|epicAction): /, ""), cardKey, supply);

/** Every unmet lock across a card's own clauses. */
export function clauseLock(card: SynergyCard, supply: LockSupply): ClauseLock {
  return mergeLocks(clauseTextsOf(card).map((text) => clauseTextLock(text, card.cardKey, supply)));
}

import { compareCodePoints } from "../swu/canonical.js";
import type { SynergyCard } from "./schema.js";

/**
 * @displayName Base-name locks
 * @strategicPurpose A clause such as "While you control a Tatooine base" works only under a base of that
 * location (D51). Locations are pinned from the engine's card data (#150, D59), so the lock can now be cleared
 * by the deck's actual base instead of only being named.
 * @tacticalObjective Finds the base names a card's own clauses require, and says which of them a given base
 * does not meet. A base meets a name when its traits carry it (the features step merges the location in).
 */

export const ASPECT_NAMES: ReadonlySet<string> = new Set(["Aggression", "Command", "Cunning", "Heroism", "Vigilance", "Villainy"]);
/** "While you control a Tatooine base": the clause names one kind of base, not an aspect ("an Aggression leader or base" never matches). */
const NAMED_BASE = /\byou control an? ([A-Z][\w'-]*(?: [A-Z][\w'-]*)*) base\b/;
const baseLocks = new WeakMap<SynergyCard, string | null>();

/** The clause texts of a card: abilities and the options of its modal abilities, every face. */
export function clauseTextsOf(card: SynergyCard): string[] {
  const out: string[] = [];
  for (const ability of Object.values(card.faces).flat()) {
    for (const c of [...(ability.clauses ?? []), ...(ability.options ?? []).flatMap((o) => o.clauses)]) out.push(c.text);
  }
  return out;
}

/** The base name one clause requires ("Tatooine"), or null when it names none. */
export function namedBaseOfClause(text: string): string | null {
  const hit = NAMED_BASE.exec(text)?.[1];
  return hit !== undefined && !ASPECT_NAMES.has(hit) ? hit : null;
}

/** Decision D51: the base a card's own clause names, or null when no clause does. */
export function baseLockOf(card: SynergyCard): string | null {
  const known = baseLocks.get(card);
  if (known !== undefined) return known;
  let name: string | null = null;
  for (const text of clauseTextsOf(card)) name ??= namedBaseOfClause(text);
  baseLocks.set(card, name);
  return name;
}

/** Whether the base meets the name: its traits carry the location (a missing base meets nothing). */
export const baseMeets = (base: SynergyCard | undefined, name: string): boolean => base !== undefined && base.structured.traits.includes(name);

/**
 * The names the members require that the deck's base does not meet, sorted by code point, and whether any is unmet.
 * A name the base meets is cleared (D59): it no longer appears, so a caller prints a lock only while it holds.
 */
export function baseLockOfAll(cards: readonly SynergyCard[], base: SynergyCard | undefined): { names: string[]; unmet: boolean } {
  const names = [...new Set(cards.flatMap((c) => baseLockOf(c) ?? []))].filter((n) => !baseMeets(base, n)).sort(compareCodePoints);
  return { names, unmet: names.length > 0 };
}

/** "you control another Wookiee unit or a Kashyyyk base": the named base may be one alternative of the condition. */
const ENABLING_BASE = /\byou control (?:[^.,;]*? or )?an? ([A-Z][\w'-]*(?: [A-Z][\w'-]*)*) base\b/;

/**
 * Decision D73: the positive side of D59. The location and the clause when the given base meets a base name the
 * card's own clause names, else null. An opponent's base ("If an opponent controls a Kashyyyk base") never counts.
 */
export function baseEnabledOf(card: SynergyCard, base: SynergyCard | undefined): { location: string; clause: string } | null {
  if (base === undefined) return null;
  for (const clause of clauseTextsOf(card)) {
    const name = ENABLING_BASE.exec(clause)?.[1];
    if (name !== undefined && !ASPECT_NAMES.has(name) && baseMeets(base, name)) return { location: name, clause };
  }
  return null;
}

/** The D73 output fields: the location the given base supplies and the clause that names it, present only while a base meets one. */
export const enabledFields = (e: { location: string; clause: string } | null): Record<string, string> =>
  e === null ? {} : { baseEnabled: e.location, baseEnabledClause: e.clause };

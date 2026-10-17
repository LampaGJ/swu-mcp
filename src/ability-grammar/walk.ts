import type { SwuAbility, SwuAbilityNode, SwuClause, SwuKeyword } from "./deps.js";

export interface AbilityVisit {
  a: SwuAbility;
  repeat: SwuAbility["repeat"];
  clauses: SwuClause[];
  option?: true;
  /** The clause that grants this ability ("For this attack, it gains: ..."), when it is granted. */
  grantedBy: SwuClause | null;
}

const grantingClause = (clauses: readonly SwuClause[], index: number): SwuClause | null =>
  clauses.find((c) => c.text.includes(`⟦G${index}⟧`)) ?? null;

/**
 * Visits every ability, modal option and granted ability of a face. A granted
 * ability does not inherit the parent's repeat class; it keeps its own.
 */
export function* walkAbilities(
  abilities: readonly SwuAbilityNode[],
  inheritedRepeat: SwuAbility["repeat"] | null,
  grantedBy: SwuClause | null = null,
): Generator<AbilityVisit> {
  for (const a of abilities) {
    if (a.kind !== "ability") continue;
    const repeat = inheritedRepeat ?? a.repeat;
    yield { a, repeat, clauses: a.clauses, grantedBy };
    for (const o of a.options) yield { a, repeat, clauses: o.clauses, option: true, grantedBy };
    for (const g of a.grantedAbilities) yield* walkAbilities(g.abilities, null, grantingClause(a.clauses, g.index));
    for (const o of a.options) for (const g of o.granted) yield* walkAbilities(g.abilities, null, grantingClause(o.clauses, g.index));
  }
}

export function* walkKeywords(abilities: readonly SwuAbilityNode[]): Generator<SwuKeyword & { granted: boolean }> {
  for (const a of abilities) {
    if (a.kind === "keyword") yield* a.keywords.map((k) => ({ ...k, granted: a.granted }));
    else for (const g of [...a.grantedAbilities, ...a.options.flatMap((o) => o.granted)]) yield* walkKeywords(g.abilities);
  }
}

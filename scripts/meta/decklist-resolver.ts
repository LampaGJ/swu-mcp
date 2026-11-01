import { nameVariants } from "../../src/meta/decklist-capture.js";
import { compareCodePoints } from "../../src/swu/canonical.js";
import { normalizeName, type CardMap } from "../bench/card-map.js";

/**
 * @displayName Swumetastats decklist name resolver
 * @strategicPurpose Both steps that read the pinned swumetastats decklist capture (sleepers, LampaGJ/swu-mcp#184, and the
 * deck index, #193) must map the capture's card, leader and base names to the run's cardKeys the same way, or one step would
 * count a deck the other drops.
 * @tacticalObjective Resolves a leader name to one cardKey, a base name to its aspect icons (and, when one card bears the
 * name, its cardKey) and a card line to one cardKey, using the printed numbers to tell two cards that share a name. A name it
 * cannot place resolves to null, never a guess.
 */

export interface Resolver {
  leader(name: string, set: string | null | undefined): string | null;
  /** The base's aspect icons (all the analysis needs); a name two printings share resolves when their aspects agree. */
  baseAspects(name: string, aspectText: string | null | undefined): string[] | null;
  /** The base's cardKey when exactly one base card bears the name; null when none or several do (their aspects may still resolve). */
  base(name: string): string | null;
  card(name: string, stats: { cost: number | null; power: number | null; hp: number | null }): string | null;
}

const ASPECT_WORDS = new Set(["Aggression", "Command", "Cunning", "Heroism", "Vigilance", "Villainy"]);

export function resolverOf(
  map: CardMap,
  aspectsOf: (cardKey: string) => readonly string[] | undefined,
  statsOf: (cardKey: string) => { cost: number | null; power: number | null; hp: number | null; aspects: string } | undefined,
): Resolver {
  const types = new Map<string, Set<string>>();
  const sets = new Map<string, Set<string>>();
  for (const p of map.printings) {
    types.set(p.cardKey, (types.get(p.cardKey) ?? new Set()).add(p.type));
    sets.set(p.cardKey, (sets.get(p.cardKey) ?? new Set()).add(p.expansion.toLowerCase()));
  }
  const memo = new Map<string, string | null>();
  const cached = (key: string, compute: () => string | null): string | null => {
    if (!memo.has(key)) memo.set(key, compute());
    return memo.get(key) as string | null;
  };
  const named = (name: string): string[] => map.names.get(normalizeName(name)) ?? [];
  return {
    leader: (name, set) =>
      cached(`L\u0000${name}\u0000${set ?? ""}`, () => {
        for (const variant of nameVariants(name)) {
          let hits = named(variant).filter((k) => types.get(k)?.has("Leader") === true);
          if (hits.length > 1 && set) {
            const inSet = hits.filter((k) => sets.get(k)?.has(set.toLowerCase()) === true);
            if (inSet.length > 0) hits = inSet;
          }
          if (hits.length === 1) return hits[0];
        }
        return null;
      }),
    baseAspects: (name, aspectText) => {
      const hits = named(name).filter((k) => types.get(k)?.has("Base") === true);
      const options = [...new Set(hits.map((k) => [...(aspectsOf(k) ?? [])].sort(compareCodePoints).join("+")))];
      if (hits.length > 0 && options.length === 1) return options[0] === "" ? [] : options[0].split("+");
      const words = (aspectText ?? "")
        .split(",")
        .map((w) => w.trim())
        .filter((w) => w !== "");
      if (hits.length > 0 && words.every((w) => ASPECT_WORDS.has(w))) return words.sort(compareCodePoints);
      return null;
    },
    base: (name) => {
      const hits = named(name).filter((k) => types.get(k)?.has("Base") === true);
      return hits.length === 1 ? hits[0] : null;
    },
    card: (name, stats) =>
      cached(`C\u0000${name}\u0000${stats.cost}\u0000${stats.power}\u0000${stats.hp}`, () => {
        for (const variant of nameVariants(name)) {
          const hits = named(variant).filter((k) => types.get(k)?.has("Leader") !== true && types.get(k)?.has("Base") !== true);
          if (hits.length === 1) return hits[0];
          if (hits.length < 2) continue;
          // Two cards share the name (Grassroots Resistance in SEC and ASH): the line's own printed numbers pick one;
          // when every candidate prints the same numbers it is one card in two products, and the first key stands for it.
          const fits = hits.filter((k) => {
            const f = statsOf(k);
            return f !== undefined && f.cost === stats.cost && f.power === stats.power && f.hp === stats.hp;
          });
          if (fits.length === 1) return fits[0];
          const shapes = new Set(hits.map((k) => JSON.stringify(statsOf(k) ?? null)));
          if (fits.length > 1 && shapes.size === 1) return [...fits].sort(compareCodePoints)[0];
          return null;
        }
        return null;
      }),
  };
}

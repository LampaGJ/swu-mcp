import { compareCodePoints } from "../swu/canonical.js";
import type { AbilityLite, SynergyCard } from "./schema.js";

/**
 * @displayName SWU card-name references
 * @strategicPurpose A card whose text names another card by its title ("If attached unit is Chewbacca") is built
 * for that card, which no offers/wants tag can say because the tag vocabulary has no card names (LampaGJ/swu-mcp#153, D62).
 * @tacticalObjective Pure function of the card list: resolves each clause's title mentions against the card table,
 * case-sensitive, whole words, longest name first, every sort a code-unit order.
 */

/** Types whose title is a card name; token titles ("Battle Droid") are read by create_token, not as names. */
const NAMED_TYPES: ReadonlySet<string> = new Set(["Unit", "Upgrade", "Event", "Leader", "Base"]);

export interface NameReference {
  /** The card whose text names the other. */
  a: string;
  /** The named card. */
  b: string;
  /** The title as printed on both. */
  title: string;
  /** "face: clause" of the first clause on `a` that names the title. */
  why: string;
}

function* clauseTexts(nodes: readonly unknown[]): Generator<string> {
  for (const raw of nodes) {
    const a = raw as AbilityLite;
    if (a.kind !== "ability") continue;
    for (const c of [...(a.clauses ?? []), ...(a.options ?? []).flatMap((o) => o.clauses)]) yield c.text;
    for (const g of a.grantedAbilities ?? []) yield* clauseTexts(g.abilities);
  }
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The titles that count as names. A title of two or more words is a name; a one-word title is a name only when a card
 * carrying it is unique (a character or a named ship: "Chewbacca", "Neel"), because one-word titles of non-unique cards
 * are ordinary words ("Repair", "Restock"). A title spelled like a trait or a printed keyword is never a name.
 */
function nameTitles(cards: readonly SynergyCard[], traits: ReadonlySet<string>): Map<string, SynergyCard[]> {
  const keywords = new Set(cards.flatMap((c) => ((c.structured.keywordsField as unknown[] | undefined) ?? []).filter((k): k is string => typeof k === "string")));
  const byTitle = new Map<string, SynergyCard[]>();
  for (const c of cards) {
    if (!NAMED_TYPES.has(c.type) || c.title.trim() === "") continue;
    byTitle.set(c.title, [...(byTitle.get(c.title) ?? []), c]);
  }
  for (const [title, list] of [...byTitle]) {
    const oneWord = !/\s/.test(title.trim());
    if (traits.has(title) || keywords.has(title) || (oneWord && !list.some((c) => c.structured.unique === true))) byTitle.delete(title);
  }
  return byTitle;
}

/**
 * Every (namer, named) card pair. A clause is scanned once with every name and every trait name, longest first, so a
 * trait that contains a title ("Bounty Hunter" around "Hunter") takes the words and links nothing. The namer's own
 * title links nothing, and a card never links to a card of its own title.
 */
export function nameReferences(cards: readonly SynergyCard[]): NameReference[] {
  const traits = new Set(cards.flatMap((c) => c.structured.traits));
  const byTitle = nameTitles(cards, traits);
  const words = [...new Set([...byTitle.keys(), ...traits])].sort((x, y) => y.length - x.length || compareCodePoints(x, y));
  if (words.length === 0) return [];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_'’-])(?:${words.map(escape).join("|")})(?![\\p{L}\\p{N}_-])`, "gu");
  const out: NameReference[] = [];
  for (const a of cards) {
    if (!NAMED_TYPES.has(a.type)) continue;
    const named = new Map<string, string>();
    for (const face of Object.keys(a.faces)) {
      for (const text of clauseTexts(a.faces[face])) {
        for (const m of text.matchAll(pattern)) {
          const title = m[0];
          if (title === a.title || !byTitle.has(title) || named.has(title)) continue;
          named.set(title, `${face}: ${text}`);
        }
      }
    }
    for (const [title, why] of [...named].sort(([x], [y]) => compareCodePoints(x, y))) {
      for (const b of byTitle.get(title) ?? []) out.push({ a: a.cardKey, b: b.cardKey, title, why });
    }
  }
  return out.sort((x, y) => compareCodePoints(x.a, y.a) || compareCodePoints(x.b, y.b));
}

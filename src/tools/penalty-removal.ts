import { compareCodePoints } from "../swu/canonical.js";
import { UNCOVERED_ICON_PENALTY } from "../synergy/cover.js";
import { cardLabel } from "../synergy/order.js";
import type { SynergyCard } from "../synergy/schema.js";

/**
 * @displayName Aspect penalty removal
 * @strategicPurpose A deck card can make another card's aspect penalty vanish (The Darksaber lends its carrier's
 * icons to every cost payment; a leader or base says "ignore the aspect penalties on ... units you play"). An audit
 * that reads only the printed icons overstates the tax and hides the card that pays it off (D75).
 * @tacticalObjective Reads the card text of the leader, base and deck and, per penalised card, names the remover and
 * the penalty that is left once it is in place.
 */

/** The card text and print facts the removal reading needs; a deck line, a leader or a base fits. */
export interface RemovalCard {
  syn: SynergyCard;
  text: string | null;
  unique: boolean;
  count: number;
}

export interface RemovalNote {
  /** Who removes it, with the carriers or the clause quoted. */
  by: string;
  /** Penalty per copy that is left once the remover is in place. */
  effectivePenaltyEach: number;
}

const PROVIDES_ICONS = /\bwhile you are paying costs, this unit provides its aspect icons\b/i;
const IGNORE_CLAUSE = /[^.\n]*\bignore the aspect penalt(?:y|ies) on ([^.\n]*?) you play\b[^.\n]*\./i;
const ASPECTS = new Set(["Vigilance", "Command", "Aggression", "Cunning", "Heroism", "Villainy"]);
const NOUNS = new Set(["unit", "units", "card", "cards", "non-unit", "non-units"]);

const countOf = (icons: readonly string[]): Map<string, number> => {
  const out = new Map<string, number>();
  for (const i of icons) out.set(i, (out.get(i) ?? 0) + 1);
  return out;
};

/** The icons of a card that the leader and base do not supply, one entry per missing icon (coverPenalty's own count). */
export function missingIcons(syn: SynergyCard, supplied: readonly string[]): string[] {
  const have = countOf(supplied);
  const missing: string[] = [];
  for (const [icon, need] of countOf(syn.structured.aspectIcons)) for (let i = have.get(icon) ?? 0; i < need; i++) missing.push(icon);
  return missing.sort(compareCodePoints);
}

/** Icons a carrier lends toward `missing`: the overlap of the two multisets. */
function covered(missing: readonly string[], carrier: SynergyCard): number {
  const lent = countOf(carrier.structured.aspectIcons);
  let n = 0;
  for (const [icon, need] of countOf(missing)) n += Math.min(need, lent.get(icon) ?? 0);
  return n;
}

function carrierOk(provider: RemovalCard, carrier: RemovalCard): boolean {
  if (carrier.syn.type !== "Unit" || carrier.count < 1) return false;
  const text = provider.text ?? "";
  if (/<uq>|\bunique\b/i.test(text) && !carrier.unique) return false;
  if (/\bnon-Vehicle\b/i.test(text) && carrier.syn.structured.traits.includes("Vehicle")) return false;
  return true;
}

interface IgnoreClause {
  source: RemovalCard;
  /** The whole sentence, quoted, condition included. */
  clause: string;
  /** Does the clause name this card? */
  covers: (syn: SynergyCard) => boolean;
}

/** "non-Villainy Official units", "Heroism units": aspects and traits that must hold, aspects after "non-" that must not. */
function filterOf(filter: string): (syn: SynergyCard) => boolean {
  const need: string[] = [];
  const forbid: string[] = [];
  const traits: string[] = [];
  let unitOnly = false;
  for (const raw of filter.split(/\s+/).filter((w) => w !== "")) {
    const word = raw.replace(/[‑–]/g, "-");
    if (NOUNS.has(word.toLowerCase())) {
      if (word.toLowerCase().startsWith("unit")) unitOnly = true;
      continue;
    }
    if (word.toLowerCase().startsWith("non-") && ASPECTS.has(word.slice(4))) forbid.push(word.slice(4));
    else if (ASPECTS.has(word)) need.push(word);
    else if (/^[A-Z]/.test(word)) traits.push(word);
  }
  return (syn) =>
    (!unitOnly || syn.type === "Unit") &&
    need.every((a) => syn.structured.aspects.includes(a)) &&
    forbid.every((a) => !syn.structured.aspects.includes(a)) &&
    traits.every((t) => syn.structured.traits.includes(t));
}

function ignoreClauseOf(source: RemovalCard): IgnoreClause | null {
  const match = IGNORE_CLAUSE.exec((source.text ?? "").replace(/[‑–]/g, "-"));
  if (match === null) return null;
  return { source, clause: match[0].trim(), covers: filterOf(match[1]) };
}

export interface PenaltyRemovalReader {
  /** What removes the penalty of this card, or null when nothing in the leader, base and deck does. */
  noteFor(card: SynergyCard, supplied: readonly string[]): RemovalNote | null;
  /** Every remover found, for the section note. */
  removers: { card: string; kind: "icon-lender" | "ignore-clause"; detail: string }[];
}

const CARRIER_LIMIT = 3;

/**
 * Reads the leader, base and deck text once. An icon lender (The Darksaber) removes the icons its carrier prints, from
 * the carrier's own turn in play on; the carrier is a deck unit other than the card itself. An ignore clause removes
 * the whole penalty of the cards it names. Both are conditional on the remover being in play, which the note says.
 */
export function readPenaltyRemovers(leader: RemovalCard, base: RemovalCard, deck: readonly RemovalCard[]): PenaltyRemovalReader {
  const everyone = [leader, base, ...deck];
  const lenders = deck.filter((d) => PROVIDES_ICONS.test(d.text ?? "") && d.count > 0);
  const ignorers = everyone.flatMap((d) => {
    const c = ignoreClauseOf(d);
    return c === null ? [] : [c];
  });
  const removers: PenaltyRemovalReader["removers"] = [
    ...lenders.map((l) => ({ card: cardLabel(l.syn), kind: "icon-lender" as const, detail: "the attached unit provides its aspect icons while you pay costs" })),
    ...ignorers.map((i) => ({ card: cardLabel(i.source.syn), kind: "ignore-clause" as const, detail: i.clause })),
  ];
  return {
    removers,
    noteFor(card, supplied) {
      const missing = missingIcons(card, supplied);
      if (missing.length === 0) return null;
      const ignoring = ignorers.find((i) => i.covers(card));
      if (ignoring !== undefined) {
        return { by: `${cardLabel(ignoring.source.syn)}: "${ignoring.clause}"`, effectivePenaltyEach: 0 };
      }
      // D82 (#164): a carrier that pays an aspect penalty of its own frees nothing before it is in play, and the carriers can
      // free only each other (Qimir, Darth Traya, Marchion Ro), so such a carrier is named but takes no penalty off.
      const taxed = (d: RemovalCard): boolean => missingIcons(d.syn, supplied).length > 0 && !ignorers.some((i) => i.covers(d.syn));
      const bestOf = (free: boolean): { lender: RemovalCard; carriers: RemovalCard[]; n: number } | null => {
        let best: { lender: RemovalCard; carriers: RemovalCard[]; n: number } | null = null;
        for (const lender of lenders) {
          const options = deck
            .filter((d) => d.syn.cardKey !== card.cardKey && carrierOk(lender, d) && taxed(d) !== free)
            .map((d) => ({ d, n: covered(missing, d.syn) }))
            .filter((o) => o.n > 0);
          const n = Math.max(0, ...options.map((o) => o.n));
          if (n === 0 || (best !== null && n <= best.n)) continue;
          const carriers = options.filter((o) => o.n === n).map((o) => o.d).sort((a, b) => compareCodePoints(cardLabel(a.syn), cardLabel(b.syn)));
          best = { lender, carriers, n };
        }
        return best;
      };
      const free = bestOf(true);
      const best = free ?? bestOf(false);
      if (best === null) return null;
      const names = best.carriers.slice(0, CARRIER_LIMIT).map((c) => cardLabel(c.syn));
      const more = best.carriers.length > CARRIER_LIMIT ? `, +${best.carriers.length - CARRIER_LIMIT} more` : "";
      const by = `${cardLabel(best.lender.syn)} attached to ${names.join(" or ")}${more}`;
      if (free === null)
        return { by: `${by} (each a taxed carrier: it pays its own aspect penalty, so it removes none here)`, effectivePenaltyEach: UNCOVERED_ICON_PENALTY * missing.length };
      return { by, effectivePenaltyEach: UNCOVERED_ICON_PENALTY * (missing.length - best.n) };
    },
  };
}

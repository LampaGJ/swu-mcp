import { existsSync } from "node:fs";
import path from "node:path";
import { packageDirOf, readJson, type CardStore } from "../data.js";
import { compareCodePoints } from "../swu/canonical.js";
import { archetypeEvidenceKey, aspectsEvidenceKey } from "./outcomes.js";
import { SWUMETASTATS_SOURCE, winRatesFileSchema, type DeckEvidence, type WinRatesFile } from "./schema.js";
import { wilson } from "./stats.js";

/**
 * @displayName Tournament deck evidence
 * @strategicPurpose One reading of swumetastats' with-card / without-card deck records, shared by meta_answers and
 * playable_cards, so a card measured negative in one tool is flagged negative in the other (LampaGJ/swu-mcp#168, D86).
 * @tacticalObjective Reads <package>/meta/winrates.json, indexes its deckEvidence groups by key, and classes a card's
 * record (ok, negative, unmeasured, thin-control) by decision D36. No model and no clock in the path.
 */

type EvidenceGroup = DeckEvidence["groups"][number];
export type EvidenceIndex = Map<string, { group: EvidenceGroup; cards: Map<string, EvidenceGroup["cards"][number]> }>;

export interface Record3 {
  wins: number;
  losses: number;
  draws: number;
}

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4 || 0;
const rate = (wins: number, n: number): number | null => (n === 0 ? null : r4(wins / n));

/** A W-L-D record as shipped: n decisive matches, win rate wins / n (draws left out, as swumetastats does), Wilson 95% interval. */
export function rated(r: Record3): { record: string; n: number; winRate: number | null; ci95: string | null } {
  const n = r.wins + r.losses;
  const ci = wilson(r.wins, n);
  return { record: `${r.wins}-${r.losses}-${r.draws}`, n, winRate: rate(r.wins, n), ci95: ci === null ? null : `${ci.low}..${ci.high}` };
}

export type EvidenceClass = "ok" | "negative" | "unmeasured" | "thin-control";

/** What a deck-evidence cell needs to be classed: the object cardDeckEvidence returns, or the reason it has none. */
export type DeckEvidenceView =
  | string
  | { withCard: { n: number; decks: number; ci95?: string | null }; withoutCard: { n: number; decks: number; ci95?: string | null }; difference: number | null };

const NEGATIVE_GAP = -0.05;
/** Decision D36: a side with fewer decks than this is one deck's luck, however many matches it played. */
export const MIN_EVIDENCE_DECKS = 10;

/**
 * Decision D36 (#139): the decks without the card are a control group only when they hold at least this share of the
 * comparable decks, or CONTROL_DECKS_CAP decks, whichever is smaller. The decks with the card are not held to it: a
 * rarely played card is still measured against the field (an owner question is open on that side).
 */
export const CONTROL_SHARE = 0.1;
export const CONTROL_DECKS_CAP = 50;

/** The without-card count and the comparable total when the without side is too small to be a control group; undefined otherwise. */
export function thinControl(evidence: Exclude<DeckEvidenceView, string>): { decks: number; of: number } | undefined {
  const of = evidence.withCard.decks + evidence.withoutCard.decks;
  return evidence.withoutCard.decks < Math.min(of * CONTROL_SHARE, CONTROL_DECKS_CAP) ? { decks: evidence.withoutCard.decks, of } : undefined;
}

/** What keeps a side from being measured: fewer than minN decisive matches or fewer than MIN_EVIDENCE_DECKS decks. */
export function thinSides(evidence: Exclude<DeckEvidenceView, string>, minN: number): string[] {
  const out: string[] = [];
  for (const side of ["withCard", "withoutCard"] as const) {
    const e = evidence[side];
    if (e.decks < MIN_EVIDENCE_DECKS) out.push(`${side} has ${e.decks} decks (needs ${MIN_EVIDENCE_DECKS})`);
    if (e.n < minN) out.push(`${side} has ${e.n} decisive matches (needs ${minN})`);
  }
  return out;
}

/**
 * Decision D36: unmeasured unless both sides have at least minN decisive matches. Then negative on a point gap below
 * -0.05 whatever the deck count (a thin negative still warns), else ok only when both sides also have MIN_EVIDENCE_DECKS
 * decks, else unmeasured. #139: an otherwise ok figure whose without-card side holds under the smaller of 10% of the
 * comparable decks and 50 decks is thin-control, because a handful of decks that skip a staple are not a control group.
 */
export function evidenceClassOf(evidence: DeckEvidenceView, minN: number): EvidenceClass {
  if (typeof evidence === "string" || evidence.difference === null) return "unmeasured";
  if (evidence.withCard.n < minN || evidence.withoutCard.n < minN) return "unmeasured";
  if (evidence.difference < NEGATIVE_GAP) return "negative";
  if (thinSides(evidence, minN).length > 0) return "unmeasured";
  return thinControl(evidence) === undefined ? "ok" : "thin-control";
}

export const evidenceIndexOf = (winrates: WinRatesFile): EvidenceIndex =>
  new Map((winrates.deckEvidence?.groups ?? []).map((group) => [group.key, { group, cards: new Map(group.cards.map((c) => [c.cardKey, c])) }]));

/** The comparable populations of our deck: our leader and base aspects first, then our aspect set under any leader. */
export interface EvidenceKeys {
  archetype: string;
  aspects: string;
  label: string;
  aspectText: string;
}

export function evidenceKeysOf(leaderKey: string, leaderLabel: string, leaderIcons: readonly string[], baseIcons: readonly string[]): EvidenceKeys {
  const ourAspects = [...leaderIcons, ...baseIcons];
  return {
    archetype: archetypeEvidenceKey(leaderKey, baseIcons),
    aspects: aspectsEvidenceKey(ourAspects),
    label: `${leaderLabel} / ${baseIcons.join("+") || "neutral"} base`,
    aspectText: [...ourAspects].sort(compareCodePoints).join("+") || "no-aspect",
  };
}

/** The match record of comparable tournament decks with the card against those without it, or the reason there is none. */
export function cardDeckEvidence(winrates: WinRatesFile, index: EvidenceIndex, cardKey: string, ours: EvidenceKeys) {
  const ev = winrates.deckEvidence;
  if (ev === null) return "no tournament decklists captured";
  for (const [key, comparable] of [
    [ours.archetype, `${ours.label} decks`],
    [ours.aspects, `${ours.aspectText} decks (any leader)`],
  ] as const) {
    const hit = index.get(key);
    const row = hit?.cards.get(cardKey);
    if (hit === undefined || row === undefined) continue;
    const g = hit.group;
    const withCard = rated(row);
    const without = rated({ wins: g.wins - row.wins, losses: g.losses - row.losses, draws: g.draws - row.draws });
    return {
      comparable,
      withCard: { decks: row.decks, ...withCard },
      withoutCard: { decks: g.decks - row.decks, ...without },
      difference: withCard.winRate === null || without.winRate === null ? null : r4(withCard.winRate - without.winRate),
      opponents: "unknown",
      source: SWUMETASTATS_SOURCE,
      window: `${ev.window.from}..${ev.window.to}`,
    };
  }
  return `fewer than ${winrates.minN} decisive matches with or without it among comparable tournament decks in ${ev.window.from}..${ev.window.to}`;
}

const loaded = new WeakMap<CardStore, { winrates: WinRatesFile; index: EvidenceIndex } | null>();

/** The package's deck evidence (meta/winrates.json), or null when the package has none. */
export function deckEvidenceOf(store: CardStore): { winrates: WinRatesFile; index: EvidenceIndex } | null {
  if (loaded.has(store)) return loaded.get(store) ?? null;
  const file = path.join(packageDirOf(store), "meta", "winrates.json");
  const winrates = existsSync(file) ? winRatesFileSchema.parse(readJson(file)) : null;
  const out = winrates === null ? null : { winrates, index: evidenceIndexOf(winrates) };
  loaded.set(store, out);
  return out;
}

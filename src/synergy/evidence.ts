import type { PairEdge, PairRowHit, SynergyCard } from "./schema.js";

/**
 * @displayName SWU synergy evidence
 * @strategicPurpose Pairings are candidates, not facts (LampaGJ/swu-mcp#15): the calling model must be
 * able to confirm each link against the card text that produced the tags, so the text travels with the answer.
 * @tacticalObjective Looks up the `why` the feature extractor recorded for a tag (face plus clause text)
 * and clips it, so a response carries the clause without carrying the whole card.
 */

export const EVIDENCE_CHARS = 160;
export const CANDIDATE_STATUS = "candidate";

const MISSING = "(no clause text recorded)";

export function clip(text: string, max = EVIDENCE_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

export function tagEvidence(card: SynergyCard, tag: string): string {
  const hit = [...card.tags.offers, ...card.tags.wants].find((t) => t.tag === tag);
  return hit === undefined || hit.why === "" ? MISSING : clip(hit.why);
}

export interface RowEvidence {
  offer: string;
  want: string;
}

/** One entry per distinct offer/want text pair of the edge's rows; `a` offers, `b` wants. */
export function edgeEvidence(a: SynergyCard, b: SynergyCard, rows: readonly PairRowHit[]): RowEvidence[] {
  const seen = new Set<string>();
  const out: RowEvidence[] = [];
  for (const r of rows) {
    const entry = { offer: tagEvidence(a, r.offer), want: tagEvidence(b, r.want) };
    const key = `${entry.offer}\u0000${entry.want}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

export const evidenceOf = (e: PairEdge, byKey: ReadonlyMap<string, SynergyCard>, rows: readonly PairRowHit[] = e.rows): RowEvidence[] =>
  edgeEvidence(byKey.get(e.a) as SynergyCard, byKey.get(e.b) as SynergyCard, rows);

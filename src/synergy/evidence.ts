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
    const entry = { offer: r.offerWhy === undefined ? tagEvidence(a, r.offer) : clip(r.offerWhy), want: r.wantWhy === undefined ? tagEvidence(b, r.want) : clip(r.wantWhy) };
    const key = `${entry.offer}\u0000${entry.want}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

export const evidenceOf = (e: PairEdge, byKey: ReadonlyMap<string, SynergyCard>, rows: readonly PairRowHit[] = e.rows): RowEvidence[] =>
  edgeEvidence(byKey.get(e.a) as SynergyCard, byKey.get(e.b) as SynergyCard, rows);

/** Curated entry id -> "face: sourceClause", the clause a curated tag stands for (data/curated-rules.json). */
export type CuratedClauses = ReadonlyMap<string, string>;
/** Which side's tag came from the curated table rather than the grammar; the text shown is the curated clause either way. */
export type EvidenceSource = "grammar" | "curated" | "curated offer" | "curated want";

export interface SourcedEvidence extends RowEvidence {
  source: EvidenceSource;
}

const CURATED_WHY = /^curated (\S+)$/;

/** A tag's clause text with a curated id resolved through the table, so no bare id reaches the caller (D49). */
function sourcedTag(card: SynergyCard, tag: string, curated: CuratedClauses): { text: string; curated: boolean } {
  const hit = [...card.tags.offers, ...card.tags.wants].find((t) => t.tag === tag);
  const id = hit === undefined ? undefined : CURATED_WHY.exec(hit.why)?.[1];
  if (id === undefined) return { text: tagEvidence(card, tag), curated: false };
  const clause = curated.get(id);
  return { text: clause === undefined ? MISSING : clip(clause), curated: true };
}

/** edgeEvidence with curated tags resolved and a `source` naming the curated side. */
export function sourcedEvidenceOf(e: PairEdge, byKey: ReadonlyMap<string, SynergyCard>, rows: readonly PairRowHit[], curated: CuratedClauses): SourcedEvidence[] {
  const a = byKey.get(e.a) as SynergyCard;
  const b = byKey.get(e.b) as SynergyCard;
  const seen = new Set<string>();
  const out: SourcedEvidence[] = [];
  for (const r of rows) {
    const offer = r.offerWhy === undefined ? sourcedTag(a, r.offer, curated) : { text: clip(r.offerWhy), curated: false };
    const want = r.wantWhy === undefined ? sourcedTag(b, r.want, curated) : { text: clip(r.wantWhy), curated: false };
    const source: EvidenceSource = offer.curated ? (want.curated ? "curated" : "curated offer") : want.curated ? "curated want" : "grammar";
    const key = `${offer.text}\u0000${want.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ offer: offer.text, want: want.text, source });
  }
  return out;
}

import type { AbilityLite, PairEdge, PairRowHit, SynergyCard } from "./schema.js";

/**
 * @displayName SWU synergy evidence
 * @strategicPurpose Pairings are candidates, not facts (LampaGJ/swu-mcp#15): the calling model must be
 * able to confirm each link against the card text that produced the tags, so the text travels with the answer.
 * @tacticalObjective Looks up the `why` the feature extractor recorded for a tag (face plus clause text),
 * widens it to the span that holds its cost and gate (D68) and clips it, so a response carries the clause
 * without carrying the whole card.
 */

export const EVIDENCE_CHARS = 160;
export const CANDIDATE_STATUS = "candidate";

const MISSING = "(no clause text recorded)";

export function clip(text: string, max = EVIDENCE_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** A clause that hangs on the one before it: "If you do, ready that unit." after "You may defeat this upgrade." */
const DEPENDENT = /^(?:if you do(?:n't)?|if you can't|if (?:it|that unit|they) (?:does|do|is|was|survives)|then|otherwise)\b/i;
/** A clause that qualifies the one before it: "If it shares a Trait ..., it gets +2/+0 for this attack.", "For this attack, he gains Overwhelm". */
const RIDER = /^(?:if (?:it|he|she|they|that unit)\b|for this attack\b)/i;
/** The why the tag builder writes for a trigger it reads by kind, not by text ("text: When Defeated"). */
const TRIGGER_WHY: Record<string, (t: { trigger?: string }) => boolean> = {
  "When Defeated": (t) => t.trigger === "when_defeated",
  "When Played": (t) => t.trigger === "when_played",
  "Action [Exhaust]": (t) => t.trigger === "action",
};
const flat = (text: string): string => text.replace(/\s+/g, " ").replace(/\s+\]/g, "]").trim();

/** The clause sequences of an ability: its own clauses and, apart, each modal option's. */
const sequencesOf = (a: AbilityLite): string[][] => [(a.clauses ?? []).map((c) => c.text), ...(a.options ?? []).map((o) => o.clauses.map((c) => c.text))];

/**
 * D68: the evidence span of a tag's `why`: the ability's trigger with its cost ("Action [Exhaust, use the Force]"),
 * the clauses the cited one hangs on ("You may use the Force. If you do, ..."), then the cited clause. A why that
 * cites the trigger alone ("When Defeated") takes the ability's clauses, so a drawback ("Each opponent may ready a
 * resource") shows. A why that names no clause of the card (a printed trait, a title, a curated id) is returned as it is.
 */
export function evidenceSpan(card: Pick<SynergyCard, "faces">, why: string): string {
  const prefix = /^(\w+): ([\s\S]*)$/.exec(why);
  const face = prefix !== null && prefix[1] in card.faces ? prefix[1] : undefined;
  const body = flat(face === undefined ? why : (prefix as RegExpExecArray)[2]);
  const head = face === undefined ? "" : `${face}: `;
  const abilities = face === undefined ? Object.values(card.faces).flat() : card.faces[face];
  const span = spanIn(abilities, body);
  return span === null ? why : `${head}${span}`;
}

const isAbility = (x: unknown): x is AbilityLite => typeof x === "object" && x !== null && typeof (x as { kind?: unknown }).kind === "string";

/**
 * The span of `body` in these abilities, or null. D74 (#161): a trigger inside a granted ability ("Attached unit gains:
 * \u201cOn Attack: ...\u201d") is cited by its kind ("on_attack") and was returned raw, so a granted ability is searched
 * too and quoted inside the clause that grants it, the placeholder \u27e6G<n>\u27e7 replaced by the granted text.
 */
function spanIn(abilities: readonly AbilityLite[], body: string): string | null {
  for (const a of abilities) {
    const trigger = (a.triggers ?? []).flatMap((t) => (t.text === undefined || t.text === "" ? [] : [flat(t.text)])).join("/");
    const lead = trigger === "" ? "" : `${trigger}: `;
    for (const [i, seq] of sequencesOf(a).entries()) {
      const at = seq.findIndex((c) => flat(c) === body);
      if (at < 0) continue;
      // D82 (#164): a mode of a choose-one is quoted whole, so its antecedent ("Look at an opponent's hand.") and its drawback
      // ("If you do, they draw a card.") travel with the cited clause. D83 (#165): the lead names the mode's place among the
      // modes ("Choose one (mode 2 of 2):") instead of an elision mark, so nothing reads as cut.
      if (i > 0) {
        const modes = (a.options ?? []).length;
        const choose = (a.clauses ?? []).map((c) => flat(c.text)).join(" ").replace(/:$/, "");
        return `${lead}${choose === "" ? "Choose one" : choose} (mode ${i} of ${modes}): ${seq.map(flat).join(" ")}`;
      }
      let from = at;
      while (from > 0 && DEPENDENT.test(flat(seq[from]))) from--;
      // D83 (#165): a conditional rider on the cited effect ("If it shares a Trait with another friendly unit, it gets +2/+0
      // for this attack.") is never trimmed from the quote.
      let to = at;
      while (to + 1 < seq.length && RIDER.test(flat(seq[to + 1]))) to++;
      return `${lead}${seq.slice(from, to + 1).map(flat).join(" ")}`;
    }
    // D83 (#165): the replay want's why carries the categories it read ("When Played (damage)"); it cites the trigger all the same.
    const byKind = TRIGGER_WHY[body] ?? TRIGGER_WHY[body.replace(/ \([^)]*\)$/, "")];
    const cited = (a.triggers ?? []).some((t) => (t.text !== undefined && flat(t.text) === body) || (byKind?.(t) ?? false) || t.trigger === body);
    const clauses = sequencesOf(a).flat();
    if (cited && clauses.length > 0) return `${trigger === "" ? body : trigger}: ${clauses.map(flat).join(" ")}`;
    for (const [i, granted] of (a.grantedAbilities ?? []).entries()) {
      const inner = spanIn(granted.abilities.filter(isAbility), body);
      if (inner === null) continue;
      const index = typeof granted.index === "number" ? granted.index : i;
      const placeholder = `\u27e6G${index}\u27e7`;
      const host = clauses.find((c) => c.includes(placeholder));
      return host === undefined ? inner : flat(host.replace(placeholder, `\u201c${inner}\u201d`));
    }
  }
  return null;
}

export function tagEvidence(card: SynergyCard, tag: string): string {
  const hit = [...card.tags.offers, ...card.tags.wants].find((t) => t.tag === tag);
  return hit === undefined || hit.why === "" ? MISSING : clip(evidenceSpan(card, hit.why));
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
    const entry = {
      offer: r.offerWhy === undefined ? tagEvidence(a, r.offer) : clip(evidenceSpan(a, r.offerWhy)),
      want: r.wantWhy === undefined ? tagEvidence(b, r.want) : clip(evidenceSpan(b, r.wantWhy)),
    };
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
  return { text: clause === undefined ? MISSING : clip(evidenceSpan(card, clause)), curated: true };
}

/** edgeEvidence with curated tags resolved and a `source` naming the curated side. */
export function sourcedEvidenceOf(e: PairEdge, byKey: ReadonlyMap<string, SynergyCard>, rows: readonly PairRowHit[], curated: CuratedClauses): SourcedEvidence[] {
  const a = byKey.get(e.a) as SynergyCard;
  const b = byKey.get(e.b) as SynergyCard;
  const seen = new Set<string>();
  const out: SourcedEvidence[] = [];
  for (const r of rows) {
    const offer = r.offerWhy === undefined ? sourcedTag(a, r.offer, curated) : { text: clip(evidenceSpan(a, r.offerWhy)), curated: false };
    const want = r.wantWhy === undefined ? sourcedTag(b, r.want, curated) : { text: clip(evidenceSpan(b, r.wantWhy)), curated: false };
    const source: EvidenceSource = offer.curated ? (want.curated ? "curated" : "curated offer") : want.curated ? "curated want" : "grammar";
    const key = `${offer.text}\u0000${want.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ offer: offer.text, want: want.text, source });
  }
  return out;
}

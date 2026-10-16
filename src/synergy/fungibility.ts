import { cmp } from "./order.js";
import type { AbilityLite, SynergyCard } from "./schema.js";

/**
 * @displayName SWU fungibility role classes
 * @strategicPurpose Cards that fill the same slot of a pair or trio are interchangeable for that
 * slot. When the substitutes sit in different aspects, a deck picks the one its leader and base
 * already cover and still completes the chain (LampaGJ/swu-mcp#3).
 * @tacticalObjective A role signature per card per offers/wants tag: tag (which carries the
 * friendly/enemy polarity), card type group, timing (repeat class of the ability that produced the
 * tag), magnitude band and cost band. Cards sharing a signature are one class. Deterministic: the
 * signature is a pure function of the feature record, with no model and no fitted parameter.
 * Trait tags are skipped: sharing a trait is membership, not a role.
 */

export type TagSide = "offers" | "wants";

export interface RoleSignature {
  tag: string;
  side: TagSide;
  typeGroup: string;
  timing: string;
  magnitude: string;
  costBand: string;
}

export interface RoleClass extends RoleSignature {
  id: string;
  members: string[];
}

export interface FungibilityIndex {
  classes: RoleClass[];
  classById: ReadonlyMap<string, RoleClass>;
  /** cardKey -> class ids, one per non-trait tag the card carries. */
  rolesByCard: ReadonlyMap<string, readonly string[]>;
  byKey: ReadonlyMap<string, SynergyCard>;
}

const TYPE_GROUPS = new Set(["Unit", "Event", "Upgrade"]);
const isTraitTag = (tag: string): boolean => tag.startsWith("offers:is-trait-") || tag.startsWith("wants:trait-");

export const aspectGroup = (c: SynergyCard): string => c.structured.aspectIcons.join("+") || "neutral";

export function costBand(cost: number | null): string {
  if (cost === null) return "-";
  if (cost <= 1) return "0-1";
  if (cost <= 3) return "2-3";
  if (cost <= 5) return "4-5";
  return "6+";
}

export function magnitudeBand(n: unknown): string {
  if (typeof n === "number") return n <= 1 ? "1" : n === 2 ? "2" : "3+";
  return typeof n === "string" ? "var" : "-";
}

function* abilitiesOf(nodes: readonly unknown[]): Generator<AbilityLite> {
  for (const raw of nodes) {
    const a = raw as AbilityLite;
    if (a.kind !== "ability") continue;
    yield a;
    for (const g of a.grantedAbilities ?? []) yield* abilitiesOf(g.abilities);
  }
}

interface Origin {
  timing: string;
  magnitude: string;
}

const TRIGGER_LABELS: Record<string, string> = {
  "When Defeated": "when_defeated",
  "When Played": "when_played",
  "When Played on a unit": "when_played",
};
const FACE_PREFIX = /^([A-Za-z]+): ([\s\S]*)$/;

/** Finds the ability and clause that produced a tag, from the `why` the tag builder recorded. */
function originOf(card: SynergyCard, why: string): Origin {
  const faceNames = Object.keys(card.faces).sort(cmp);
  const faceMatch = FACE_PREFIX.exec(why);
  const curatedId = why.startsWith("curated ") ? why.slice("curated ".length) : undefined;
  for (const face of faceNames) {
    if (faceMatch !== null && faceMatch[1] !== face && curatedId === undefined) continue;
    for (const a of abilitiesOf(card.faces[face])) {
      const clauses = [...(a.clauses ?? []), ...(a.options ?? []).flatMap((o) => o.clauses)];
      for (const c of clauses) {
        const hit = curatedId !== undefined ? c.curatedId === curatedId : faceMatch !== null && c.text === faceMatch[2];
        if (!hit) continue;
        const ns = [...c.effects, ...c.conditions].map((x) => x.n);
        const numeric = ns.filter((n): n is number => typeof n === "number");
        const magnitude = numeric.length > 0 ? magnitudeBand(Math.max(...numeric)) : ns.some((n) => typeof n === "string") ? "var" : "-";
        return { timing: a.repeat ?? "static", magnitude };
      }
      const triggerHit = (a.triggers ?? []).some(
        (t) =>
          t.text === why ||
          (faceMatch !== null &&
            faceMatch[1] === face &&
            (t.text === faceMatch[2] || t.trigger === faceMatch[2] || t.trigger === TRIGGER_LABELS[faceMatch[2]])),
      );
      if (triggerHit) return { timing: a.repeat ?? "static", magnitude: "-" };
    }
  }
  return { timing: "static", magnitude: "-" };
}

export function roleSignatures(card: SynergyCard): RoleSignature[] {
  const typeGroup = TYPE_GROUPS.has(card.type) ? card.type : "Other";
  const out: RoleSignature[] = [];
  for (const side of ["offers", "wants"] as const) {
    for (const { tag, why } of card.tags[side]) {
      if (isTraitTag(tag)) continue;
      const { timing, magnitude } = originOf(card, why);
      out.push({ tag, side, typeGroup, timing, magnitude, costBand: costBand(card.structured.cost) });
    }
  }
  return out;
}

export const roleId = (s: RoleSignature): string => `${s.tag}|${s.typeGroup}|${s.timing}|m${s.magnitude}|c${s.costBand}`;

export function buildFungibility(cards: readonly SynergyCard[]): FungibilityIndex {
  const classes = new Map<string, RoleClass>();
  const rolesByCard = new Map<string, string[]>();
  for (const card of cards) {
    const ids: string[] = [];
    for (const sig of roleSignatures(card)) {
      const id = roleId(sig);
      const cls = classes.get(id) ?? { ...sig, id, members: [] };
      cls.members.push(card.cardKey);
      classes.set(id, cls);
      ids.push(id);
    }
    rolesByCard.set(card.cardKey, ids);
  }
  const list = [...classes.values()].sort((a, b) => cmp(a.id, b.id));
  for (const c of list) c.members.sort(cmp);
  return { classes: list, classById: classes, rolesByCard, byKey: new Map(cards.map((c) => [c.cardKey, c])) };
}

export interface Substitute {
  cardKey: string;
  title: string;
  subtitle: string | null;
  cost: number | null;
}

export interface SubstituteGroup {
  aspects: string;
  /** True when this aspect set is not the slot card's own. */
  differsFromSlot: boolean;
  /** True when every icon is supplied by the preferred aspects. */
  covered: boolean | null;
  cards: Substitute[];
}

export interface SubstituteOptions {
  /** Aspects the deck's leader and base supply; groups they cover sort first. */
  preferAspects?: readonly string[];
  /** Cards listed per aspect group. */
  perGroup?: number;
  /** Drop groups with the slot card's own aspects. */
  crossAspectOnly?: boolean;
  maxCost?: number;
}

/** Class id the card holds for a tag, if any (a card has at most one signature per tag). */
export function roleOf(index: FungibilityIndex, cardKey: string, tag: string): RoleClass | undefined {
  const id = (index.rolesByCard.get(cardKey) ?? []).find((rid) => (index.classById.get(rid) as RoleClass).tag === tag);
  return id === undefined ? undefined : index.classById.get(id);
}

const iconsCovered = (icons: readonly string[], have: readonly string[]): boolean => {
  const pool = new Map<string, number>();
  for (const x of have) pool.set(x, (pool.get(x) ?? 0) + 1);
  return icons.every((i) => {
    const left = pool.get(i) ?? 0;
    pool.set(i, left - 1);
    return left > 0;
  });
};

/** Candidate members (one class, or the intersection of several) grouped by aspect set; covered groups first, then different aspects. */
export function substitutesFor(
  index: FungibilityIndex,
  members: readonly string[],
  slotCardKey: string,
  options: SubstituteOptions = {},
): SubstituteGroup[] {
  const slot = index.byKey.get(slotCardKey) as SynergyCard;
  const slotGroup = aspectGroup(slot);
  const prefer = options.preferAspects;
  const groups = new Map<string, Substitute[]>();
  const icons = new Map<string, readonly string[]>();
  for (const key of members) {
    const c = index.byKey.get(key) as SynergyCard;
    if (key === slotCardKey || c.title === slot.title) continue;
    if (options.maxCost !== undefined && (c.structured.cost === null || c.structured.cost > options.maxCost)) continue;
    const g = aspectGroup(c);
    if (options.crossAspectOnly && g === slotGroup) continue;
    icons.set(g, c.structured.aspectIcons);
    const list = groups.get(g) ?? [];
    list.push({ cardKey: key, title: c.title, subtitle: c.subtitle, cost: c.structured.cost });
    groups.set(g, list);
  }
  const perGroup = options.perGroup ?? 5;
  const out: SubstituteGroup[] = [...groups.entries()].map(([aspects, list]) => ({
    aspects,
    differsFromSlot: aspects !== slotGroup,
    covered: prefer === undefined ? null : iconsCovered(icons.get(aspects) ?? [], prefer),
    cards: list.sort((x, y) => (x.cost ?? 99) - (y.cost ?? 99) || cmp(x.cardKey, y.cardKey)).slice(0, perGroup),
  }));
  return out.sort(
    (x, y) =>
      Number(y.covered === true) - Number(x.covered === true) ||
      Number(y.differsFromSlot) - Number(x.differsFromSlot) ||
      cmp(x.aspects, y.aspects),
  );
}

export interface FungibilityStats {
  classes: number;
  cardsWithRole: number;
  singletonClasses: number;
  classesWithSubstitutes: number;
  classesSpanningAspects: number;
  sizeBuckets: Record<string, number>;
  largest: { id: string; size: number; aspectSets: number }[];
}

export function fungibilityStats(index: FungibilityIndex): FungibilityStats {
  const aspectSets = (c: RoleClass): number => new Set(c.members.map((k) => aspectGroup(index.byKey.get(k) as SynergyCard))).size;
  const buckets: Record<string, number> = { "1": 0, "2": 0, "3-5": 0, "6-10": 0, "11-25": 0, "26+": 0 };
  for (const c of index.classes) {
    const n = c.members.length;
    buckets[n === 1 ? "1" : n === 2 ? "2" : n <= 5 ? "3-5" : n <= 10 ? "6-10" : n <= 25 ? "11-25" : "26+"]++;
  }
  return {
    classes: index.classes.length,
    cardsWithRole: [...index.rolesByCard.values()].filter((v) => v.length > 0).length,
    singletonClasses: buckets["1"],
    classesWithSubstitutes: index.classes.length - buckets["1"],
    classesSpanningAspects: index.classes.filter((c) => aspectSets(c) > 1).length,
    sizeBuckets: buckets,
    largest: [...index.classes]
      .sort((a, b) => b.members.length - a.members.length || cmp(a.id, b.id))
      .slice(0, 10)
      .map((c) => ({ id: c.id, size: c.members.length, aspectSets: aspectSets(c) })),
  };
}

/** Cards that hold every listed tag's role class at the same signature as the slot card. */
export function commonMembers(
  index: FungibilityIndex,
  slotCardKey: string,
  tags: readonly string[],
): { classIds: string[]; members: string[] } {
  const classes = tags.map((t) => roleOf(index, slotCardKey, t));
  if (classes.length === 0 || classes.some((c) => c === undefined)) return { classIds: [], members: [] };
  const found = classes as RoleClass[];
  const members = found[0].members.filter((k) => found.every((c) => c.members.includes(k)));
  return { classIds: found.map((c) => c.id), members };
}

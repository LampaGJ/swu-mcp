import { compareCodePoints } from "../swu/canonical.js";

/**
 * @displayName Deck-idea pool reader
 * @strategicPurpose Manipulation node (preserves) between /swu-deck-ideas and the deck gauntlet (#198): every idea the
 * branches wrote is built and simulated, not only the shortlist, so the idea files must turn into build_deck inputs by
 * committed code, never by hand.
 * @tacticalObjective Parses the pool's `IDEA n | id | name | slot | leader | base ...` header and its `key:` line, fills a
 * bare card name from the same name keyed elsewhere in the pool, then from the card table when exactly one card bears it,
 * names every name it cannot place, and turns a resolved idea into a build_deck input (key cards and anchors at fixed
 * copies, excluded cards left out of mustInclude).
 */

export interface CardRef {
  name: string;
  key: string | null;
}

export interface Idea {
  id: string;
  name: string;
  leader: CardRef;
  base: CardRef;
  key: CardRef[];
}

export type RefKind = "leader" | "base" | "main";

function parseRef(text: string, prefix?: string): CardRef {
  let s = text.trim();
  if (prefix !== undefined && s.startsWith(`${prefix} `)) s = s.slice(prefix.length + 1).trim();
  const m = /^(.*?)\s+([0-9]{6,9})$/.exec(s);
  return m === null ? { name: s, key: null } : { name: m[1].trim(), key: m[2] };
}

export function parseIdeaPool(text: string): Idea[] {
  const ideas: Idea[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("IDEA ")) {
      const fields = line.split(" | ").map((f) => f.trim());
      const b = fields.findIndex((f) => f.startsWith("base "));
      if (b < 2 || fields.length < 4) throw new Error(`idea header without a leader and base field: ${line}`);
      ideas.push({ id: fields[1], name: fields[2].replace(/^name:\s*/, ""), leader: parseRef(fields[b - 1], "leader"), base: parseRef(fields[b], "base"), key: [] });
    } else if (/^key( cards)?:/.test(line)) {
      if (ideas.length === 0) throw new Error(`key line before any idea header: ${line}`);
      const last = ideas[ideas.length - 1];
      if (last.key.length > 0) throw new Error(`idea ${last.id} has two key lines`);
      last.key = line
        .slice(line.indexOf(":") + 1)
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s !== "")
        .map((s) => parseRef(s));
    }
  }
  // A pool file with no idea is a changed header format, not an empty branch: an empty list would hide it.
  if (ideas.length === 0) throw new Error("no idea header (IDEA n | id | ...) read in the pool file");
  // An idea without key cards would build from the anchors alone and look like a real list.
  const bare = ideas.filter((i) => i.key.length === 0).map((i) => i.id);
  if (bare.length > 0) throw new Error(`no key line read for idea ${bare.join(", ")}`);
  return ideas;
}

export interface Resolved {
  ideas: Idea[];
  unresolved: { idea: string; name: string }[];
}

/** `titles` returns the cardKeys of the card table bearing the name in that slot; a name it returns more or fewer than one for stays unresolved. */
export function resolveIdeas(ideas: readonly Idea[], titles: (name: string, kind: RefKind) => readonly string[]): Resolved {
  const seen: Record<RefKind, Map<string, Set<string>>> = { leader: new Map(), base: new Map(), main: new Map() };
  const note = (kind: RefKind, r: CardRef): void => {
    if (r.key === null) return;
    const m = seen[kind];
    m.set(r.name, (m.get(r.name) ?? new Set()).add(r.key));
  };
  for (const i of ideas) {
    note("leader", i.leader);
    note("base", i.base);
    for (const k of i.key) note("main", k);
  }
  const unresolved: { idea: string; name: string }[] = [];
  const fill = (idea: string, kind: RefKind, r: CardRef): CardRef => {
    if (r.key !== null) return r;
    const pooled = seen[kind].get(r.name);
    if (pooled !== undefined && pooled.size === 1) return { name: r.name, key: [...pooled][0] };
    const hits = [...new Set(titles(r.name, kind))];
    if (hits.length === 1) return { name: r.name, key: hits[0] };
    unresolved.push({ idea, name: r.name });
    return r;
  };
  return {
    ideas: ideas.map((i) => ({ ...i, leader: fill(i.id, "leader", i.leader), base: fill(i.id, "base", i.base), key: i.key.map((k) => fill(i.id, "main", k)) })),
    unresolved,
  };
}

export interface BuildOptions {
  /** Cards every idea runs (the anchors of the brief), at `copies` like the key cards. */
  anchors: readonly string[];
  copies: number;
  exclude: readonly string[];
}

export interface BuildInput {
  leader: string;
  base: string;
  name: string;
  mustInclude: { card: string; count: number }[];
  exclude?: string[];
}

export function buildInputOf(idea: Idea, o: BuildOptions): BuildInput {
  if (idea.leader.key === null || idea.base.key === null) throw new Error(`idea ${idea.id}: leader or base unresolved`);
  const excluded = new Set(o.exclude);
  const keys = new Set([...idea.key.map((k) => k.key).filter((k): k is string => k !== null), ...o.anchors]);
  const must = [...keys].filter((k) => !excluded.has(k) && k !== idea.leader.key && k !== idea.base.key).sort(compareCodePoints);
  const input: BuildInput = { leader: idea.leader.key, base: idea.base.key, name: `${idea.id} ${idea.name}`.slice(0, 80), mustInclude: must.map((card) => ({ card, count: o.copies })) };
  if (o.exclude.length > 0) input.exclude = [...o.exclude].sort(compareCodePoints);
  return input;
}

export interface JudgeScore {
  anonId: string;
  surprise: number;
  win: number;
  fits: number;
  covers: number;
  flags: string;
  risk: string;
  /** Dots the judges spent on the idea in the `DOTS|Ixx n|...` line. */
  dots: number;
}

/** The judges' `Ixx|surprise|win|fits|covers|flags|risk` lines and their `DOTS` vote line, joined to idea ids through anon-map.tsv (`Ixx<TAB>id<TAB>name`). */
export function parseJudgeScores(judgeText: string, anonMapText: string): Map<string, JudgeScore> {
  const ids = new Map<string, string>();
  for (const line of anonMapText.split(/\r?\n/).filter((l) => l.trim() !== "")) {
    const [anon, id] = line.split("\t");
    if (!/^I[0-9]+$/.test(anon ?? "") || (id ?? "") === "") throw new Error(`anon map line not read: ${line}`);
    ids.set(anon, id);
  }
  const out = new Map<string, JudgeScore>();
  const dots = new Map<string, number>();
  for (const line of judgeText.split(/\r?\n/).filter((l) => l.trim() !== "")) {
    const f = line.split("|");
    if (f[0] === "DOTS") {
      for (const vote of f.slice(1)) {
        const m = /^(I[0-9]+) ([0-9]+)$/.exec(vote.trim());
        if (m === null) throw new Error(`DOTS vote not read: ${vote}`);
        if (!ids.has(m[1])) throw new Error(`DOTS vote for ${m[1]} has no entry in the anon map`);
        dots.set(m[1], (dots.get(m[1]) ?? 0) + Number(m[2]));
      }
      continue;
    }
    const nums = f.slice(1, 5).map((x) => (/^[0-9]+$/.test(x.trim()) ? Number(x) : Number.NaN));
    if (f.length < 7 || nums.some((n) => Number.isNaN(n))) throw new Error(`judge line not read: ${line}`);
    const id = ids.get(f[0]);
    if (id === undefined) throw new Error(`judge line ${f[0]} has no entry in the anon map`);
    out.set(id, { anonId: f[0], surprise: nums[0], win: nums[1], fits: nums[2], covers: nums[3], flags: f[5].trim(), risk: f.slice(6).join("|").trim(), dots: 0 });
  }
  for (const s of out.values()) s.dots = dots.get(s.anonId) ?? 0;
  return out;
}

import { encode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { packageDirOf, type CardStore } from "../data.js";
import {
  answerOffers,
  counterCardSchema,
  detectThreats,
  loadCounterTable,
  relationHit,
  type AnswerOffer,
  type CounterCard,
  type RelationHit,
} from "../meta/counters.js";
import {
  metaFileSchema,
  POPULATIONS,
  winRatesFileSchema,
  type Archetype,
  type CounterTable,
  type MetaFile,
  type WinRatesFile,
} from "../meta/schema.js";
import { compareCodePoints } from "../swu/canonical.js";
import { CANDIDATE_STATUS } from "../synergy/evidence.js";
import { cardLabel } from "../synergy/order.js";
import type { ToolResult } from "../tools.js";
import {
  baseField,
  cardScope,
  decklistField,
  deckEnvOf,
  leaderField,
  MAIN_TYPES,
  resolveList,
  resolvePair,
  resolveRef,
  singlePenalty,
  suppliedBy,
  type DeckEnv,
} from "./deck.js";

/**
 * @displayName Meta defense tools
 * @strategicPurpose Answers "whatever my deck does, what must it include to beat the decks people are winning with
 * now" (LampaGJ/swu-mcp#25): meta_archetypes lists the current archetypes, meta_threats describes one, meta_answers
 * ranks the cards in our aspects that answer the most meta share. Tournament decks and tournament outcomes are the
 * primary sources; every answer names the population and outcome source it rests on.
 * @tacticalObjective Reads <package>/meta/archetypes.json and winrates.json (written by `pnpm meta`) and the committed
 * data/counters.json; answers are computed per call by src/meta/counters.ts, with clause evidence and
 * status: candidate. No model and no clock in the path.
 */

export interface MetaEnv {
  deck: DeckEnv;
  meta: MetaFile;
  winrates: WinRatesFile;
  table: CounterTable;
  cards: Map<string, { card: CounterCard; offers: AnswerOffer[] }>;
}

/** Builds the env from parsed parts, so tests can pass an in-code DeckEnv and synthetic meta files. */
export function createMetaEnv(deck: DeckEnv, meta: unknown, winrates: unknown, table: CounterTable, features: readonly unknown[]): MetaEnv {
  const cards = new Map<string, { card: CounterCard; offers: AnswerOffer[] }>();
  for (const raw of features) {
    const card = counterCardSchema.parse(raw);
    cards.set(card.cardKey, { card, offers: answerOffers(card) });
  }
  return { deck, meta: metaFileSchema.parse(meta), winrates: winRatesFileSchema.parse(winrates), table, cards };
}

const envs = new WeakMap<CardStore, MetaEnv>();

function metaEnvOf(store: CardStore): MetaEnv {
  const hit = envs.get(store);
  if (hit !== undefined) return hit;
  const dir = path.join(packageDirOf(store), "meta");
  const file = path.join(dir, "archetypes.json");
  if (!existsSync(file)) throw new Error(`no ${file}; this data package predates the meta step (run "pnpm meta" or "pnpm build:data")`);
  const read = (name: string): unknown => JSON.parse(readFileSync(name, "utf8"));
  const features = z.array(z.unknown()).parse(read(path.join(packageDirOf(store), "features/features.json")));
  const env = createMetaEnv(deckEnvOf(store), read(file), read(path.join(dir, "winrates.json")), loadCounterTable(), features);
  envs.set(store, env);
  return env;
}

const ok = (value: unknown): ToolResult => ({ content: [{ type: "text", text: encode(value) }] });
const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4 || 0;
const rate = (wins: number, n: number): number | null => (n === 0 ? null : r4(wins / n));

const populationField = z
  .enum(["primary", ...POPULATIONS])
  .default("primary")
  .describe(
    "primary (default): tournament decklists with placements, or community lists when the window has too few; tournament or community picks one",
  );

function populationOf(env: MetaEnv, wanted: "primary" | (typeof POPULATIONS)[number]): (typeof POPULATIONS)[number] {
  return wanted === "primary" ? env.meta.primary : wanted;
}

function sourcesNote(env: MetaEnv, population: string): Record<string, unknown> {
  const summary = env.meta.populations.find((p) => p.population === population);
  return {
    population,
    primary: env.meta.primary,
    fallback: env.meta.fallback,
    decks: summary?.decks ?? 0,
    events: summary?.events ?? 0,
    deckSources: Object.entries(summary?.sources ?? {})
      .map(([s, n]) => `${s} ${n}`)
      .join(", "),
    window: `${env.meta.window.from}..${env.meta.window.to}`,
    weighting: env.meta.method.weighting,
    tournamentMatchups:
      env.winrates.matchups === null
        ? "none captured"
        : `${env.winrates.matchups.label}, ${env.winrates.matchups.period.from}..${env.winrates.matchups.period.to}, ${env.winrates.matchups.matches} matches`,
    cardWinRates: env.winrates.cards.map((c) => `${c.label}: ${c.basis}`).join("; ") || "none",
  };
}

const archetypesIn = (env: MetaEnv, population: string): Archetype[] => env.meta.archetypes.filter((a) => a.population === population);

/** Tournament match record of a leader and base aspect against the field, or against one other archetype. */
function matchupRecord(
  env: MetaEnv,
  leader: string,
  baseAspects: readonly string[],
  opp?: Archetype,
): { wins: number; losses: number; draws: number } | null {
  const m = env.winrates.matchups;
  if (m === null) return null;
  const key = baseAspects.join("+");
  let wins = 0;
  let losses = 0;
  let draws = 0;
  for (const p of m.pairs) {
    if (p.leader !== leader || p.baseAspects.join("+") !== key) continue;
    if (opp !== undefined && (p.oppLeader !== opp.leader.cardKey || p.oppBaseAspects.join("+") !== opp.baseAspects.join("+"))) continue;
    wins += p.wins;
    losses += p.losses;
    draws += p.draws;
  }
  return wins + losses + draws === 0 ? null : { wins, losses, draws };
}

const recordText = (r: { wins: number; losses: number; draws: number } | null): string | null =>
  r === null
    ? null
    : `${r.wins}-${r.losses}-${r.draws} (${Math.round((r.wins / (r.wins + r.losses + r.draws)) * 1000) / 10}% of ${r.wins + r.losses + r.draws})`;

// ---------------------------------------------------------------------------------------------
// meta_archetypes

export const metaArchetypesShape = {
  population: populationField,
  leader: z.string().min(1).optional().describe("Only archetypes of this leader: a cardKey or exact title"),
  limit: z.number().int().min(1).max(100).default(10),
};

export function metaArchetypes(env: MetaEnv, input: unknown): ToolResult {
  const args = z.object(metaArchetypesShape).parse(input);
  const population = populationOf(env, args.population);
  let list = archetypesIn(env, population);
  if (args.leader !== undefined) {
    const leader = resolveRef(env.deck.store, args.leader, "leader");
    if (!leader.ok) return fail(`leader "${args.leader}": ${leader.reason}, ${leader.detail}`);
    list = list.filter((a) => a.leader.cardKey === leader.row.cardKey);
  }
  const shown = list.slice(0, args.limit);
  return ok({
    dataVersion: env.deck.dataVersion,
    sources: sourcesNote(env, population),
    archetypes: list.length,
    shown: shown.length,
    rows: shown.map((a) => ({
      id: a.id,
      name: a.name,
      leader: a.leader.cardKey,
      leaderAspects: a.leader.aspects.join("+"),
      baseAspects: a.baseAspects.join("+") || "neutral",
      share: a.share,
      top8Share: a.top8Share,
      decks: a.decks,
      tournamentRecord: recordText(matchupRecord(env, a.leader.cardKey, a.baseAspects)),
      threats: detectThreats(a.profile, env.table)
        .map((t) => t.threat.id)
        .join(", "),
      core: a.core
        .slice(0, 6)
        .map((c) => c.title)
        .join("; "),
    })),
    note: "share = placement-weighted share of the population's decks in the window; top8Share = share of all top-8 finishes; tournamentRecord = match wins-losses-draws of the leader and base aspect against the whole field (leader-level, all of its archetypes). Call meta_threats for one archetype and meta_answers for the cards that answer them.",
  });
}

// ---------------------------------------------------------------------------------------------
// meta_threats

export const metaThreatsShape = {
  archetype: z
    .string()
    .min(1)
    .describe(
      "An archetype id from meta_archetypes (for example t001-b32174, or just its rank part t001), or a leader cardKey or exact title (its largest archetype)",
    ),
  population: populationField,
  coreLimit: z.number().int().min(1).max(40).default(15),
};

function findArchetype(env: MetaEnv, ref: string, population: string): Archetype | string {
  const id = ref.trim();
  const byId = env.meta.archetypes.find((a) => a.id === id || a.id.startsWith(`${id}-`));
  if (byId !== undefined) return byId;
  const leader = resolveRef(env.deck.store, ref, "leader");
  if (!leader.ok) return `no archetype id "${ref}", and as a leader: ${leader.reason}, ${leader.detail}`;
  const hit = archetypesIn(env, population).find((a) => a.leader.cardKey === leader.row.cardKey);
  return hit ?? `no ${population} archetype with leader ${cardLabel(leader.row)} in ${env.meta.window.from}..${env.meta.window.to}`;
}

export function metaThreats(env: MetaEnv, input: unknown): ToolResult {
  const args = z.object(metaThreatsShape).parse(input);
  const a = findArchetype(env, args.archetype, populationOf(env, args.population));
  if (typeof a === "string") return fail(a);
  const others = archetypesIn(env, a.population)
    .filter((o) => o.id !== a.id && !(o.leader.cardKey === a.leader.cardKey && o.baseAspects.join("+") === a.baseAspects.join("+")))
    .slice(0, 10);
  const vs = others
    .map((o) => ({ archetype: o.name, share: o.share, record: matchupRecord(env, a.leader.cardKey, a.baseAspects, o) }))
    .filter((v) => v.record !== null)
    .map((v) => ({ archetype: v.archetype, share: v.share, record: recordText(v.record) }));
  return ok({
    dataVersion: env.deck.dataVersion,
    sources: sourcesNote(env, a.population),
    archetype: {
      id: a.id,
      name: a.name,
      population: a.population,
      share: a.share,
      top8Share: a.top8Share,
      decks: a.decks,
      window: `${a.window.from}..${a.window.to}`,
      cohesion: a.cohesion,
    },
    leader: { ...a.leader, aspects: a.leader.aspects.join("+"), power: a.profile.leader.power, hp: a.profile.leader.hp },
    bases: a.bases,
    threats: detectThreats(a.profile, env.table).map((t) => ({
      id: t.threat.id,
      title: t.threat.title,
      value: t.value,
      metrics: t.threat.metrics.join(" + "),
      reason: t.threat.reason,
    })),
    profile: {
      units: a.profile.units,
      events: a.profile.events,
      upgrades: a.profile.upgrades,
      groundUnits: a.profile.arena.ground,
      spaceUnits: a.profile.arena.space,
      meanCost: a.profile.meanCost,
      curve: Object.entries(a.profile.curve)
        .map(([k, v]) => `${k}:${v}`)
        .join(" "),
      keywords: Object.entries(a.profile.keywords)
        .filter(([, v]) => v >= 0.5)
        .map(([k, v]) => `${k} ${v}`)
        .join(", "),
      tokenUnitMakers: a.profile.offers["offers:create-token-units"] ?? 0,
      shieldGivers: (a.profile.offers["offers:give-shield"] ?? 0) + (a.profile.offers["offers:give-shield-self"] ?? 0),
      cheapUnits: a.profile.cheapUnits,
      cheapUnitMedianHp: a.profile.cheapUnitMedianHp,
    },
    keyUnits: a.profile.keyUnits.map((u) => ({
      ...u,
      arenas: u.arenas.join("+"),
      keywords: u.keywords.join(", "),
      traits: u.traits.join(", "),
    })),
    core: a.core.slice(0, args.coreLimit),
    tournamentRecordVs: vs,
    note: "Profile figures are placement-weighted mean copies per deck. Threats fire from data/counters.json thresholds. tournamentRecordVs is this leader and base aspect against each other large archetype's leader and base aspect (leader-level tournament matchups, all builds).",
  });
}

// ---------------------------------------------------------------------------------------------
// meta_answers

export const metaAnswersShape = {
  leader: leaderField.optional().describe("Our leader: a cardKey or exact title; may instead be listed in the decklist"),
  base: baseField.optional().describe("Our base: a cardKey or exact title; may instead be listed in the decklist"),
  decklist: decklistField
    .optional()
    .describe("Our deck as {card, count}; cards already in it are marked inDeck, and a leader and base in it are used when not given"),
  population: populationField,
  archetypes: z.number().int().min(1).max(30).default(10).describe("How many of the largest archetypes to defend against"),
  maxPenalty: z.number().int().min(0).default(0).describe("Highest aspect penalty to allow; 0 keeps cards our leader and base fully cover"),
  evidence: z.boolean().default(true).describe("Include the clause text behind each answer; false drops it"),
  limit: z.number().int().min(1).max(60).default(15),
};

interface Answer {
  cardKey: string;
  title: string;
  type: string;
  cost: number | null;
  penalty: number;
  inDeck: number;
  coverage: number;
  hits: { archetype: Archetype; hit: RelationHit }[];
}

function cardWinRates(env: MetaEnv, cardKey: string, leaders: readonly Archetype[]) {
  const out: { vs: string; source: string; rate: number | null; n: number; baseline: number | null; baselineN: number }[] = [];
  const seen = new Set<string>();
  for (const a of leaders) {
    if (seen.has(a.leader.cardKey)) continue;
    seen.add(a.leader.cardKey);
    for (const source of [...env.winrates.cards].sort((x, y) => x.rank - y.rank)) {
      const byLeader = source.byLeader.find((b) => b.leader === a.leader.cardKey);
      const row = byLeader?.cards.find((c) => c.cardKey === cardKey);
      if (byLeader === undefined || row === undefined) continue;
      out.push({
        vs: a.leader.title,
        source: source.source,
        rate: rate(row.wins, row.n),
        n: row.n,
        baseline: rate(byLeader.against.wins, byLeader.against.n),
        baselineN: byLeader.against.n,
      });
      break;
    }
  }
  return out.slice(0, 3);
}

export function metaAnswers(env: MetaEnv, input: unknown): ToolResult {
  const args = z.object(metaAnswersShape).parse(input);
  const listed = args.decklist ?? [];
  const pickFromList = (kind: "leader" | "base"): string | undefined =>
    listed
      .map((e) => e.card)
      .find((ref) => {
        const r = resolveRef(env.deck.store, ref, kind);
        return r.ok;
      });
  const leaderRef = args.leader ?? pickFromList("leader");
  const baseRef = args.base ?? pickFromList("base");
  if (leaderRef === undefined || baseRef === undefined) return fail("give a leader and a base, or a decklist that lists them");
  const pair = resolvePair(env.deck, leaderRef, baseRef);
  if (typeof pair === "string") return fail(pair);
  const mainEntries = listed.filter((e) => e.card !== leaderRef && e.card !== baseRef);
  const partial = mainEntries.length === 0 ? { lines: [], unresolved: [] } : resolveList(env.deck, mainEntries, "main");
  const inDeck = new Map(partial.lines.map((l) => [l.syn.cardKey, l.count]));
  const supplied = suppliedBy(pair);
  const population = populationOf(env, args.population);
  const targets = archetypesIn(env, population).slice(0, args.archetypes);
  const threatsOf = new Map(targets.map((a) => [a.id, new Set(detectThreats(a.profile, env.table).map((t) => t.threat.id))]));
  const consideredShare = targets.reduce((s, a) => s + a.share, 0);

  const answers: Answer[] = [];
  for (const syn of env.deck.ctx.cards) {
    const row = env.deck.store.byKey.get(syn.cardKey);
    const entry = env.cards.get(syn.cardKey);
    if (row === undefined || entry === undefined || !MAIN_TYPES.has(syn.type) || cardScope(env.deck.store, row) === "rotated") continue;
    const penalty = singlePenalty(syn, supplied);
    if (penalty > args.maxPenalty) continue;
    const hits: Answer["hits"] = [];
    let coverage = 0;
    for (const a of targets) {
      const live = threatsOf.get(a.id) as Set<string>;
      let best: RelationHit | null = null;
      for (const relation of env.table.relations) {
        if (!live.has(relation.threat)) continue;
        const hit = relationHit(entry.card, entry.offers, relation, a.profile);
        if (hit !== null && (best === null || hit.weight * hit.fraction > best.weight * best.fraction)) best = hit;
      }
      if (best === null) continue;
      hits.push({ archetype: a, hit: best });
      coverage += a.share * best.weight * best.fraction;
    }
    if (hits.length === 0) continue;
    answers.push({
      cardKey: syn.cardKey,
      title: cardLabel(syn),
      type: syn.type,
      cost: syn.structured.cost,
      penalty,
      inDeck: inDeck.get(syn.cardKey) ?? 0,
      coverage,
      hits,
    });
  }
  const threatCount = (a: Answer): number => new Set(a.hits.map((h) => h.hit.threat)).size;
  answers.sort(
    (x, y) =>
      x.penalty - y.penalty ||
      r4(y.coverage) - r4(x.coverage) ||
      threatCount(y) - threatCount(x) ||
      (x.cost ?? 99) - (y.cost ?? 99) ||
      compareCodePoints(x.cardKey, y.cardKey),
  );
  const shown = answers.slice(0, args.limit);

  const byThreat = (a: Answer) => {
    const groups = new Map<
      string,
      { threat: string; relation: string; offer: string; evidence: string; archetypes: string[]; units: Set<string> }
    >();
    for (const { archetype, hit } of a.hits) {
      const key = `${hit.relation}|${hit.offer}`;
      const g = groups.get(key) ?? {
        threat: hit.threat,
        relation: hit.relation,
        offer: hit.offer,
        evidence: hit.evidence,
        archetypes: [],
        units: new Set<string>(),
      };
      g.archetypes.push(`${archetype.id} (${archetype.share})`);
      for (const u of hit.answers) g.units.add(u);
      groups.set(key, g);
    }
    return [...groups.values()].map((g) => ({
      threat: g.threat,
      relation: g.relation,
      offer: g.offer,
      ...(args.evidence ? { evidence: g.evidence } : {}),
      archetypes: g.archetypes.join(", "),
      keyUnitsRemoved:
        g.units.size === 0
          ? null
          : `${g.units.size}: ${[...g.units].sort(compareCodePoints).slice(0, 6).join("; ")}${g.units.size > 6 ? "; ..." : ""}`,
    }));
  };

  return ok({
    dataVersion: env.deck.dataVersion,
    sources: sourcesNote(env, population),
    leader: { cardKey: pair.leader.row.cardKey, title: cardLabel(pair.leader.row) },
    base: { cardKey: pair.base.row.cardKey, title: cardLabel(pair.base.row) },
    suppliedIcons: supplied.join("+") || "none",
    unresolved: partial.unresolved,
    defendingAgainst: targets.map((a) => ({
      id: a.id,
      name: a.name,
      share: a.share,
      threats: [...(threatsOf.get(a.id) as Set<string>)].join(", "),
      ourTournamentRecord: recordText(matchupRecord(env, pair.leader.row.cardKey, pair.base.syn.structured.aspectIcons, a)),
    })),
    consideredShare: r4(consideredShare),
    matched: answers.length,
    shown: shown.length,
    answers: shown.map((a) => ({
      cardKey: a.cardKey,
      title: a.title,
      type: a.type,
      cost: a.cost,
      penalty: a.penalty,
      inDeck: a.inDeck,
      coverage: r4(a.coverage),
      archetypesAnswered: a.hits.length,
      threatsAnswered: threatCount(a),
      status: CANDIDATE_STATUS,
      answers: byThreat(a),
      winRates: cardWinRates(
        env,
        a.cardKey,
        a.hits.map((h) => h.archetype),
      ),
    })),
    note: "Penalty-free cards first, then by coverage = sum over the archetypes answered of share x relation weight x the share of key-unit copies removed (removal) or 1. Answers are candidates: confirm each clause (evidence) against the card text, then run deck_audit with the swaps. winRates: the card's win rate when seen against that archetype's leader, best source first (tournament match results when captured, else human Karabast games, a secondary casual signal), with n and the baseline rate of all sides against that leader; n >= 10 only, aggregates only. ourTournamentRecord: our leader and base aspect against that archetype's leader and base aspect in tournament matchups.",
  });
}

// ---------------------------------------------------------------------------------------------
// registration

function withEnv(store: CardStore, run: (env: MetaEnv) => ToolResult): ToolResult {
  try {
    return run(metaEnvOf(store));
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    return fail(error instanceof Error ? error.message : String(error));
  }
}

const tool = (title: string, description: string, shape: z.ZodRawShape, run: (env: MetaEnv, input: unknown) => ToolResult) => ({
  title,
  description,
  shape,
  handler: (store: CardStore, input: unknown): ToolResult => withEnv(store, (env) => run(env, input)),
});

export const META_TOOLS = {
  meta_archetypes: tool(
    "Meta archetypes",
    "The current Premier archetypes: recent tournament decklists (placement-weighted) clustered by leader, base aspect and shared core cards, with meta share, top-8 share, the date window, the leader's tournament match record, the threats each poses and its core cards. Community lists are a separate, labelled population.",
    metaArchetypesShape,
    metaArchetypes,
  ),
  meta_threats: tool(
    "Meta threats",
    "One archetype in depth: leader and bases, threat profile (arena split, curve, keywords, upgrade and token reliance), key units with cost, power and HP, core cards with inclusion rates, the threats it poses and its tournament record against the other large archetypes.",
    metaThreatsShape,
    metaThreats,
  ),
  meta_answers: tool(
    "Meta answers",
    "Cards in our aspects that answer the largest archetypes, penalty-free first: for each, the threats it answers with clause evidence and status: candidate, coverage weighted by meta share, cost, whether it is already in the deck, and its win rate against that archetype's leader when seen (aggregate, with n and source). Takes a leader and base, or a decklist.",
    metaAnswersShape,
    metaAnswers,
  ),
} as const;

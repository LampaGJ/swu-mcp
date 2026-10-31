import { canonicalJson, sha256Hex } from "../swu/canonical.js";
import { ENGINE_NODE_ENV, startGame, type Engine } from "./engine.js";
import { POLICIES, PolicyChain, policyHeader } from "./policy.js";
import { BOT_SCHEME } from "./rng.js";
import {
  deckSha256,
  matchHeaderSchema,
  matchId,
  matchRecordSchema,
  type CompactDecision,
  type EngineList,
  type FullDecision,
  type MatchFooter,
  type MatchHeader,
  type MatchRecord,
} from "./schemas.js";
import { Session, type RecordMode } from "./session.js";

/**
 * @displayName Match play, replay and batch summary
 * @strategicPurpose One seeded match becomes one record that replays to the same traceSha256 (#110, D2); a batch
 * summary counts every errored game and computes win shares over decided games only (#142), so a bug that kills
 * one deck's games cannot pass for a win share.
 * @tacticalObjective Builds the header from the pin and the decks, plays a match, replays a record asserting the
 * legal-action hash, the rngCursor and the chosen descriptor at every k (stopping at the first mismatch), and
 * summarises footers.
 */

export interface DeckInput {
  list: EngineList;
  leader: string;
  base: string;
  cards: { cardKey: string; count: number }[];
  source: string;
}

export interface MatchSpec {
  seed: string;
  decks: readonly [DeckInput, DeckInput];
  policies: readonly [string, string];
  /** none plays without decision records (bulk throughput); the record then carries header and footer only. */
  recordMode: "full" | "compact" | "none";
  undo: boolean;
  codeCommit: string;
}

export const cardKeyMapSha256 = (cardKeys: Readonly<Record<string, string>>): string => sha256Hex(canonicalJson(cardKeys));

export function buildHeader(engine: Engine, spec: MatchSpec, cardKeys: Readonly<Record<string, string>>): MatchHeader {
  const decks = spec.decks.map((d, i) => ({ seat: (i + 1) as 1 | 2, leader: d.leader, base: d.base, cards: d.cards, engineList: d.list, deckSha256: deckSha256(d.list), source: d.source })) as MatchHeader["decks"];
  const policies = spec.policies.map((name) => policyHeader(chainByName(name).top)) as MatchHeader["policies"];
  const engineHeader = {
    repo: engine.pin.repo,
    commit: engine.pin.commit,
    cardDataVersion: engine.pin.cardDataVersion,
    cardDataSha256: engine.pin.cardDataSha256,
    cardKeyMapSha256: cardKeyMapSha256(cardKeys),
    node: process.version,
    nodeEnv: ENGINE_NODE_ENV,
    undoMode: spec.undo ? ("free" as const) : ("disabled" as const),
  };
  const identity = { seed: spec.seed, decks, policies, engine: engineHeader };
  return matchHeaderSchema.parse({
    schemaVersion: 1,
    matchId: matchId(identity),
    ...identity,
    rng: { engineSeed: `engine:${spec.seed}`, botScheme: BOT_SCHEME },
    branch: null,
    codeCommit: spec.codeCommit,
    recordMode: spec.recordMode,
  });
}

function chainByName(name: string): PolicyChain {
  const make = POLICIES[name];
  if (make === undefined) throw new Error(`unknown policy ${name}; known: ${Object.keys(POLICIES).join(", ")}`);
  return make();
}

/** The chain whose top policy has the header's id, version and params hash; a record from other policy code cannot replay. */
export function chainForHeader(p: MatchHeader["policies"][number]): PolicyChain {
  for (const make of Object.values(POLICIES)) {
    const chain = make();
    const h = policyHeader(chain.top);
    if (h.policyId === p.policyId && h.policyVersion === p.policyVersion && h.paramsSha256 === p.paramsSha256 && canonicalJson(h.inputs) === canonicalJson(p.inputs)) return chain;
  }
  throw new Error(`no policy ${p.policyId} v${p.policyVersion} with params ${p.paramsSha256}`);
}

export interface PlayedMatch {
  record: MatchRecord;
  /** Null when the game could not be built; the record then carries a setup error. */
  session: Session | null;
}

/** Plays one match. An exception while building the game also ends as an error record; nothing is dropped. */
export async function playMatch(engine: Engine, spec: MatchSpec, cardKeys: Readonly<Record<string, string>>, opts: { maxDecisions?: number; verifyRollback?: boolean } = {}): Promise<PlayedMatch> {
  const header = buildHeader(engine, spec, cardKeys);
  return playHeader(engine, header, cardKeys, spec.recordMode, opts);
}

/** The footer of a match that failed before its first decision, for example a deck the engine refused. */
export function setupErrorFooter(message: string): MatchFooter {
  return {
    result: { winner: null, endCondition: "error", rounds: 0, decisions: 0 },
    error: `setup: ${message}`.slice(0, 300),
    coverage: { decisions: [0, 0], answered: [0, 0] },
    gaps: { cardRefs: 0, nullCardKey: 0 },
    cardsPlayed: [[], []],
    baseDamage: [0, 0],
    endBoard: [[], []],
    finalRngCursor: { engineDraws: 0, engineStateSha: "0000000000000000", botDraws: 0 },
    traceSha256: sha256Hex(""),
  };
}

async function playHeader(engine: Engine, header: MatchHeader, cardKeys: Readonly<Record<string, string>>, mode: RecordMode, opts: { maxDecisions?: number; verifyRollback?: boolean }): Promise<PlayedMatch> {
  let started;
  try {
    started = await startGame(engine, [header.decks[0].engineList, header.decks[1].engineList], { engineSeed: header.rng.engineSeed, undo: header.engine.undoMode === "free" });
  } catch (e) {
    return { record: { header, decisions: [], footer: setupErrorFooter(String((e as Error)?.message ?? e)) }, session: null };
  }
  const session = new Session(started, {
    seed: header.seed,
    cardKeys,
    chains: [chainForHeader(header.policies[0]), chainForHeader(header.policies[1])],
    recordMode: mode,
    playedMetric: engine.playedMetric,
    maxDecisions: opts.maxDecisions,
    manualSnapshotType: engine.SnapshotType.Manual,
    verifyRollback: opts.verifyRollback,
  });
  session.run();
  const record: MatchRecord = { header, decisions: mode === "none" ? [] : session.decisions, footer: session.footer() };
  return { record, session };
}

export interface ReplayMismatch {
  k: number | null;
  field: string;
  expected: unknown;
  actual: unknown;
}

export interface ReplayResult {
  ok: boolean;
  decisions: number;
  traceSha256: string;
  mismatch: ReplayMismatch | null;
}

const CURSOR_FIELDS = ["engineDraws", "engineStateSha", "botDraws"] as const;

/**
 * Replays a record: same engine pin, seed, decks and policies; at every k asserts actor, legalActionsSha256, the three
 * rngCursor fields and (after the policy chose) the chosen descriptor; a full record also asserts round, phase and
 * promptKind. Stops at the first mismatch. A clean replay must end on the logged result, footer and traceSha256.
 *
 * byDescriptor applies each logged descriptor without asking the policies: the replay oracle for a search policy
 * (rung 3), whose trials and rollbacks then never run, so any residue a rollback left shows as a mismatch. Bot draws
 * are not compared in that mode, because the policies that drew them are not consulted.
 */
export async function replayMatch(engine: Engine, input: unknown, cardKeys: Readonly<Record<string, string>>, opts: { maxDecisions?: number; byDescriptor?: boolean } = {}): Promise<ReplayResult> {
  const record = matchRecordSchema.parse(input);
  const h = record.header;
  if (h.recordMode === "none") return { ok: false, decisions: 0, traceSha256: "", mismatch: { k: null, field: "header.recordMode", expected: "full or compact", actual: "none" } };
  const fail = (m: ReplayMismatch, decisions = 0, trace = ""): ReplayResult => ({ ok: false, decisions, traceSha256: trace, mismatch: m });
  for (const [field, expected, actual] of [
    ["engine.commit", h.engine.commit, engine.pin.commit],
    ["engine.cardDataSha256", h.engine.cardDataSha256, engine.pin.cardDataSha256],
    ["engine.cardKeyMapSha256", h.engine.cardKeyMapSha256, cardKeyMapSha256(cardKeys)],
  ] as const)
    if (expected !== actual) return fail({ k: null, field, expected, actual });

  const started = await startGame(engine, [h.decks[0].engineList, h.decks[1].engineList], { engineSeed: h.rng.engineSeed, undo: h.engine.undoMode === "free" });
  const session = new Session(started, {
    seed: h.seed,
    cardKeys,
    chains: [chainForHeader(h.policies[0]), chainForHeader(h.policies[1])],
    recordMode: "none",
    playedMetric: engine.playedMetric,
    maxDecisions: opts.maxDecisions,
    manualSnapshotType: engine.SnapshotType.Manual,
  });
  let mismatch: ReplayMismatch | null = null;
  const full = (d: FullDecision | CompactDecision): d is FullDecision => typeof d.chosen === "object";
  const logged = (k: number): string | undefined => {
    const rec = record.decisions[k];
    return rec === undefined ? undefined : full(rec) ? rec.chosen.descriptor : rec.chosen;
  };
  const cursorFields = opts.byDescriptor === true ? CURSOR_FIELDS.filter((f) => f !== "botDraws") : CURSOR_FIELDS;
  session.run({
    force:
      opts.byDescriptor === true
        ? (p) => {
            const i = p.actions.findIndex((a) => a.action.descriptor === logged(p.k));
            return i < 0 ? null : i;
          }
        : undefined,
    until: (p) => {
      const rec = record.decisions[p.k];
      if (rec === undefined) {
        mismatch = { k: p.k, field: "decisions", expected: record.decisions.length, actual: "a further decision" };
        return true;
      }
      const checks: [string, unknown, unknown][] = [
        ["actor", rec.actor, p.seat],
        ["legalActionsSha256", rec.legalActionsSha256, p.legalActionsSha256],
        ...cursorFields.map((f): [string, unknown, unknown] => [`rngCursor.${f}`, rec.rngCursor[f], p.rngCursor[f]]),
      ];
      if (full(rec)) {
        checks.push(["round", rec.round, session.game.roundNumber], ["phase", rec.phase, session.game.currentPhase], ["promptKind", rec.promptKind, p.promptKind]);
        if (rec.legalActionsSha256 !== p.legalActionsSha256) {
          const now = p.actions.map((a) => a.action.descriptor);
          const was = rec.legalActions.map((a) => a.descriptor);
          checks.unshift(["legalActions", was.filter((d) => !now.includes(d)), now.filter((d) => !was.includes(d))]);
        }
      }
      for (const [field, expected, actual] of checks)
        if (expected !== actual && !(Array.isArray(expected) && Array.isArray(actual) && expected.length === 0 && actual.length === 0)) {
          mismatch = { k: p.k, field, expected, actual };
          return true;
        }
      return false;
    },
    check: (p, choice) => {
      const expected = logged(p.k);
      const actual = p.actions[choice.index].action.descriptor;
      if (expected === actual) return false;
      mismatch = { k: p.k, field: "chosen", expected, actual };
      return true;
    },
  });
  const trace = session.traceSha256();
  if (mismatch !== null) return fail(mismatch, session.k, trace);
  const footer = session.footer();
  const cursor = (c: MatchFooter["finalRngCursor"]): string => canonicalJson(opts.byDescriptor === true ? { engineDraws: c.engineDraws, engineStateSha: c.engineStateSha } : c);
  for (const [field, expected, actual] of [
    ["result", canonicalJson(record.footer.result), canonicalJson(footer.result)],
    ["error", record.footer.error, footer.error],
    ["finalRngCursor", cursor(record.footer.finalRngCursor), cursor(footer.finalRngCursor)],
    ["cardsPlayed", canonicalJson(record.footer.cardsPlayed), canonicalJson(footer.cardsPlayed)],
    ["baseDamage", canonicalJson(record.footer.baseDamage), canonicalJson(footer.baseDamage)],
    ["endBoard", canonicalJson(record.footer.endBoard), canonicalJson(footer.endBoard)],
    ["traceSha256", record.footer.traceSha256, trace],
  ] as const)
    if (expected !== actual) return fail({ k: footer.result.decisions, field, expected, actual }, session.k, trace);
  return { ok: true, decisions: session.k, traceSha256: trace, mismatch: null };
}

export interface BatchSummary {
  games: number;
  decided: number;
  wins: [number, number];
  draws: number;
  errors: number;
  timeouts: number;
  stuck: number;
  /** Over decided games (a destroyed base); errors, draws, timeouts and stuck games are excluded and counted beside. */
  winShare: [number, number] | null;
  errorRate: number;
  coverage: [number, number];
  cardKeyGapRate: number;
  meanDecisions: number;
  meanRounds: number;
  errorsBySeed: { seed: string; error: string; decisions: number }[];
}

const round4 = (x: number): number => Math.round(x * 10000) / 10000;

export function summarize(rows: readonly { seed: string; footer: MatchFooter }[]): BatchSummary {
  const s: BatchSummary = {
    games: rows.length,
    decided: 0,
    wins: [0, 0],
    draws: 0,
    errors: 0,
    timeouts: 0,
    stuck: 0,
    winShare: null,
    errorRate: 0,
    coverage: [1, 1],
    cardKeyGapRate: 0,
    meanDecisions: 0,
    meanRounds: 0,
    errorsBySeed: [],
  };
  const dec = [0, 0];
  const ans = [0, 0];
  let refs = 0;
  let nulls = 0;
  for (const { seed, footer: f } of rows) {
    const r = f.result;
    if (r.endCondition === "base_destroyed" && r.winner !== null) {
      s.decided += 1;
      s.wins[r.winner - 1] += 1;
    } else if (r.endCondition === "draw") s.draws += 1;
    else if (r.endCondition === "error") {
      s.errors += 1;
      s.errorsBySeed.push({ seed, error: f.error ?? "", decisions: r.decisions });
    } else if (r.endCondition === "timeout") s.timeouts += 1;
    else s.stuck += 1;
    for (const i of [0, 1]) {
      dec[i] += f.coverage.decisions[i];
      ans[i] += f.coverage.answered[i];
    }
    refs += f.gaps.cardRefs;
    nulls += f.gaps.nullCardKey;
    s.meanDecisions += r.decisions;
    s.meanRounds += r.rounds;
  }
  if (rows.length > 0) {
    s.meanDecisions = round4(s.meanDecisions / rows.length);
    s.meanRounds = round4(s.meanRounds / rows.length);
    s.errorRate = round4(s.errors / rows.length);
  }
  if (s.decided > 0) s.winShare = [round4(s.wins[0] / s.decided), round4(s.wins[1] / s.decided)];
  s.coverage = [dec[0] === 0 ? 1 : round4(ans[0] / dec[0]), dec[1] === 0 ? 1 : round4(ans[1] / dec[1])];
  s.cardKeyGapRate = refs === 0 ? 0 : round4(nulls / refs);
  return s;
}

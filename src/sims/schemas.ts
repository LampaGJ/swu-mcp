import { z } from "zod";
import { hex64 } from "../schemas/hash.js";
import { canonicalJson, compareCodePoints, sha256Hex } from "../swu/canonical.js";

/**
 * @displayName Simulated match record (header, decision, footer)
 * @strategicPurpose The record-and-replay contract every later simulation step builds on (#110, D2, D80): a seeded
 * match is replayed from its header alone and must reproduce every decision and the logged traceSha256. No field
 * carries a wall-clock time or a prompt uuid, because either would break byte-identical replay.
 * @tacticalObjective Zod v4 strict schemas for the match header, the full and compact decision records and the
 * footer, plus the three hashes they cross-check (deckSha256, legalActionsSha256, matchId).
 */

export const seatSchema = z.literal([1, 2]);

const entrySchema = z.strictObject({ id: z.string().min(1), count: z.int().positive() });

/** The SWUDB list exactly as handed to the engine; order matters, because the engine builds its draw pile in list order. */
export const engineListSchema = z.strictObject({
  leader: entrySchema,
  base: entrySchema,
  deck: z.array(entrySchema).min(1),
  sideboard: z.array(entrySchema),
});
export type EngineList = z.infer<typeof engineListSchema>;

export const deckSha256 = (list: EngineList): string => sha256Hex(canonicalJson(list));

export const deckSchema = z
  .strictObject({
    seat: seatSchema,
    leader: z.string().min(1),
    base: z.string().min(1),
    cards: z.array(z.strictObject({ cardKey: z.string().min(1), count: z.int().positive() })),
    engineList: engineListSchema,
    deckSha256: hex64,
    /** Where the list came from: a repo-relative file, or a tournament list, archetype id and sampling draw. */
    source: z.string().min(1),
  })
  .refine((d) => d.deckSha256 === deckSha256(d.engineList), { error: "deckSha256 is not the sha256 of the canonical engineList" });

export const policyHeaderSchema = z.strictObject({
  rung: z.int().min(0).max(4),
  policyId: z.string().min(1),
  policyVersion: z.string().min(1),
  paramsSha256: hex64,
  /** Table name to sha256 of every pinned table the rung reads. */
  inputs: z.record(z.string(), hex64),
});

export const engineHeaderSchema = z.strictObject({
  repo: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  cardDataVersion: z.string().min(1),
  cardDataSha256: hex64,
  /** sha256 of the engine internalName to cardKey map the descriptors were written with. */
  cardKeyMapSha256: hex64,
  node: z.string().regex(/^v\d+\.\d+\.\d+$/),
  /** forceteki words prompts differently by NODE_ENV and descriptors carry that text, so the adapter pins it. */
  nodeEnv: z.literal("test"),
  undoMode: z.enum(["disabled", "free"]),
});

export const descriptorSchema = z.string().min(1);

export const branchSchema = z.strictObject({ parentMatchId: hex64, atK: z.int().nonnegative(), alternative: descriptorSchema });

const headerShape = z.strictObject({
  schemaVersion: z.literal(1),
  matchId: hex64,
  seed: z.string().min(1),
  engine: engineHeaderSchema,
  rng: z.strictObject({ engineSeed: z.string().min(1), botScheme: z.literal("sha256-counter-v1") }),
  decks: z.tuple([deckSchema, deckSchema]),
  policies: z.tuple([policyHeaderSchema, policyHeaderSchema]),
  branch: branchSchema.nullable(),
  codeCommit: z.string().min(1),
  /** none: bulk throughput, header and footer only; such a record summarises but cannot replay. */
  recordMode: z.enum(["full", "compact", "none"]),
});

type HeaderIdentity = Pick<z.infer<typeof headerShape>, "seed" | "decks" | "policies" | "engine">;

export const matchId = (h: HeaderIdentity): string => sha256Hex(canonicalJson({ seed: h.seed, decks: h.decks, policies: h.policies, engine: h.engine }));

export const matchHeaderSchema = headerShape
  .refine((h) => h.decks[0].seat === 1 && h.decks[1].seat === 2, { error: "decks are seat 1 then seat 2" })
  .refine((h) => h.rng.engineSeed === `engine:${h.seed}`, { error: "rng.engineSeed must be engine:<seed>" })
  .refine((h) => h.matchId === matchId(h), { error: "matchId is not the sha256 of the canonical {seed, decks, policies, engine}" });
export type MatchHeader = z.infer<typeof matchHeaderSchema>;

export const ACTION_KINDS = ["play", "act", "resource", "card", "pass", "takeInitiative", "done", "mulligan", "choose", "list", "number", "display", "perCard", "distribute"] as const;
export const PROMPT_KINDS = ["mulligan", "resource", "mainAction", "target", "choice", "number", "distribute", "multiSelect"] as const;
export const END_CONDITIONS = ["base_destroyed", "draw", "timeout", "stuck", "error"] as const;

export const targetSchema = z.strictObject({
  cardKey: z.string().nullable(),
  engineCardId: z.string().min(1),
  owner: seatSchema,
  zone: z.string().min(1),
  ordinal: z.int().nonnegative(),
  amount: z.int().nonnegative().nullable(),
});

export const legalActionSchema = z.strictObject({
  i: z.int().nonnegative(),
  kind: z.enum(ACTION_KINDS),
  cardKey: z.string().nullable(),
  /** The engine's internalName; logged so an unmapped card (cardKey null) is still identifiable. */
  engineCardId: z.string().nullable(),
  controller: seatSchema.nullable(),
  zone: z.string().nullable(),
  ordinal: z.int().nonnegative(),
  targets: z.array(targetSchema),
  descriptor: descriptorSchema,
  /** Engine text, for debugging only; never compared, hashed or sorted on. */
  label: z.string(),
});
export type LegalAction = z.infer<typeof legalActionSchema>;

export const rngCursorSchema = z.strictObject({
  engineDraws: z.int().nonnegative(),
  engineStateSha: z.string().regex(/^[0-9a-f]{16}$/),
  botDraws: z.int().nonnegative(),
});
export type RngCursor = z.infer<typeof rngCursorSchema>;

export const legalActionsSha256 = (descriptors: readonly string[]): string => sha256Hex(descriptors.join("\n"));

/**
 * A learned search's decision (#128): every value it used, so a reader recomputes the choice from the record. Rung 3
 * reads the true state (mode none, one determinization) or, fair (#183), averages one or more canonical re-deals (mode
 * canonical: the hidden zones put in a fixed order before the shuffle); rung 4 averages at least two multiset re-deals.
 */
export const searchBlockSchema = z
  .strictObject({
    rung: z.union([z.literal(3), z.literal(4)]),
    mode: z.enum(["none", "multiset", "canonical"]),
    determinizations: z.int().positive(),
    replies: z.int().nonnegative(),
    candidates: z
      .array(
        z.strictObject({
          descriptor: descriptorSchema,
          /** Position in the ranking policy's order; 0 is its own pick. */
          rank: z.int().nonnegative(),
          /** One value per determinization, each rounded to 4 decimals; null where the trial failed or was a no-op. */
          values: z.array(z.number().nullable()),
          mean: z.number().nullable(),
          fallback: z.string().nullable(),
        }),
      )
      .min(1),
    chosen: descriptorSchema,
  })
  .refine((s) => (s.rung === 3 ? (s.mode === "none" && s.determinizations === 1) || s.mode === "canonical" : s.mode === "multiset" && s.determinizations >= 2), {
    error: "rung 3 reads the true state (mode none, one determinization) or re-deals canonically (mode canonical); rung 4 needs mode multiset and at least two determinizations",
  })
  .refine((s) => s.candidates.every((c) => c.values.length === s.determinizations), { error: "every candidate needs one value per determinization" })
  .refine((s) => s.candidates.some((c) => c.descriptor === s.chosen), { error: "chosen must be one of the candidates" });
export type SearchBlock = z.infer<typeof searchBlockSchema>;

export const fullDecisionSchema = z
  .strictObject({
    k: z.int().nonnegative(),
    round: z.int().nonnegative(),
    phase: z.enum(["setup", "action", "regroup"]),
    actor: seatSchema,
    promptKind: z.enum(PROMPT_KINDS),
    legalActions: z.array(legalActionSchema).min(1),
    legalActionsSha256: hex64,
    chosen: z.strictObject({ i: z.int().nonnegative(), descriptor: descriptorSchema }),
    rngCursor: rngCursorSchema,
    evaluator: z.strictObject({ rung: z.int().min(0).max(4), version: z.string().min(1), sha256: hex64.nullable() }),
    utilities: z.array(z.number()).nullable(),
    fallback: z.string().nullable(),
    /** The match observer's logits for this state (#127), rounded to 4 decimals; absent when no observer scored it. */
    values: z.array(z.number()).optional(),
    /** A learned search's block (#128); absent for every other policy, so their records keep their bytes. */
    search: searchBlockSchema.optional(),
  })
  .refine((d) => d.legalActions.every((a, i) => a.i === i && (i === 0 || compareCodePoints(d.legalActions[i - 1].descriptor, a.descriptor) < 0)), {
    error: "legalActions must be indexed in order and sorted by descriptor (compareCodePoints), without repeats",
  })
  .refine((d) => d.legalActionsSha256 === legalActionsSha256(d.legalActions.map((a) => a.descriptor)), { error: "legalActionsSha256 does not cover legalActions" })
  .refine((d) => d.legalActions[d.chosen.i]?.descriptor === d.chosen.descriptor, { error: "chosen.i and chosen.descriptor disagree" })
  .refine((d) => d.utilities === null || d.utilities.length === d.legalActions.length, { error: "utilities needs one value per legal action" });
export type FullDecision = z.infer<typeof fullDecisionSchema>;

/** Bulk mode: enough to replay and assert (#110), about 200 bytes instead of about 2 KB per decision. */
export const compactDecisionSchema = z.strictObject({
  k: z.int().nonnegative(),
  actor: seatSchema,
  legalActionsSha256: hex64,
  chosen: descriptorSchema,
  rngCursor: rngCursorSchema,
});
export type CompactDecision = z.infer<typeof compactDecisionSchema>;

const playedSchema = z.strictObject({ cardKey: z.string().nullable(), engineCardId: z.string().min(1), count: z.int().positive() });

export const matchFooterSchema = z
  .strictObject({
    result: z.strictObject({
      winner: seatSchema.nullable(),
      endCondition: z.enum(END_CONDITIONS),
      rounds: z.int().nonnegative(),
      decisions: z.int().nonnegative(),
    }),
    /** The engine or driver error text when endCondition is error; null otherwise. */
    error: z.string().nullable(),
    /** Per seat: decisions taken, and how many the header's top rung answered itself (the rest fell back). */
    coverage: z.strictObject({ decisions: z.tuple([z.int().nonnegative(), z.int().nonnegative()]), answered: z.tuple([z.int().nonnegative(), z.int().nonnegative()]) }),
    /** Card references written into legal actions, and how many had no cardKey (logged by engine id instead). */
    gaps: z.strictObject({ cardRefs: z.int().nonnegative(), nullCardKey: z.int().nonnegative() }),
    cardsPlayed: z.tuple([z.array(playedSchema), z.array(playedSchema)]),
    baseDamage: z.tuple([z.int().nonnegative(), z.int().nonnegative()]),
    endBoard: z.tuple([z.array(z.string().min(1)), z.array(z.string().min(1))]),
    finalRngCursor: rngCursorSchema,
    /** sha256 over "actor|descriptor\n" of every chosen action in order. */
    traceSha256: hex64,
    /**
     * Present only when a match observer scored main-action states (#127): recordSha256 over every observed decision
     * record in order, valueSha256 over the float64 bits of every logit in call order.
     */
    observer: z
      .strictObject({
        version: z.string().min(1),
        sha256: hex64,
        load: z.enum(["per-prompt", "per-action"]),
        mainDecisions: z.int().nonnegative(),
        calls: z.int().nonnegative(),
        recordSha256: hex64,
        valueSha256: hex64,
      })
      .optional(),
    /** Present only when a learned search reported blocks (#128): their count and sha256 over "k|canonical block\n". */
    search: z.strictObject({ decisions: z.int().nonnegative(), searchSha256: hex64 }).optional(),
  })
  .refine((f) => f.result.winner === null || f.result.endCondition === "base_destroyed", { error: "only a destroyed base has a winner; an error, draw, timeout or stuck game has winner null" })
  .refine((f) => (f.result.endCondition === "error") === (f.error !== null), { error: "error text is present exactly when endCondition is error" });
export type MatchFooter = z.infer<typeof matchFooterSchema>;

export const matchRecordSchema = z
  .strictObject({
    header: matchHeaderSchema,
    decisions: z.array(z.union([fullDecisionSchema, compactDecisionSchema])),
    footer: matchFooterSchema,
  })
  .refine((r) => r.decisions.every((d, i) => d.k === i), { error: "decision k must be contiguous from 0" })
  .refine((r) => (r.header.recordMode === "none" ? r.decisions.length === 0 : r.decisions.every((d) => (r.header.recordMode === "full") === (typeof d.chosen === "object"))), {
    error: "every decision must match header.recordMode",
  })
  .refine((r) => r.header.recordMode === "none" || r.footer.result.decisions === r.decisions.length, { error: "footer.result.decisions must equal the number of decision records" });
export type MatchRecord = z.infer<typeof matchRecordSchema>;

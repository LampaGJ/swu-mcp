import { z } from "zod";

/**
 * @displayName SWU card-feature schemas
 * @strategicPurpose One canonical declaration of what the deterministic
 * ability-text extractor reads (the curated rule table) and emits (per-card
 * features, coverage, replay record), so the extractor, the rubric and the
 * pairing step parse the same shape at their boundaries (LampaGJ/mault#322).
 * @tacticalObjective Closed sets (side, kind, arena, trigger, repeat, source,
 * face) are enums; open sets (effect category, rule id) stay strings because
 * the curated table adds categories the grammar does not know.
 */

export const SWU_FEATURE_FACES = ["text", "deployBox", "epicAction"] as const;
export const swuFeatureFaceSchema = z.enum(SWU_FEATURE_FACES);
export type SwuFeatureFace = z.infer<typeof swuFeatureFaceSchema>;

export const swuTargetSideSchema = z.enum(["any", "friendly", "enemy", "mixed", "self", "ref"]);
export const swuTargetKindSchema = z.enum([
  "ref",
  "unit_or_base",
  "base",
  "upgrade",
  "token",
  "card",
  "unit",
  "leader",
  "player",
  "deck",
  "hand",
  "resource",
  "resources",
  "ability",
]);
export const swuTargetArenaSchema = z.enum(["any", "ground", "space", "both", "same", "other", "deck", "hand", "discard", "base"]);

export const swuTargetSchema = z.strictObject({
  side: swuTargetSideSchema,
  kind: swuTargetKindSchema,
  arena: swuTargetArenaSchema,
  quant: z.string().min(1),
  restrict: z.array(z.string()),
  text: z.string(),
});
export type SwuTarget = z.infer<typeof swuTargetSchema>;

export const swuMagnitudeSchema = z.union([z.number(), z.enum(["var", "all", "ref", "varN", "set"])]).nullable();

export const swuKeywordSchema = z.strictObject({
  keyword: z.string(),
  n: z.number().optional(),
  cost: z.string().optional(),
});
export type SwuKeyword = z.infer<typeof swuKeywordSchema>;

const featureFields = {
  n: swuMagnitudeSchema.optional(),
  target: swuTargetSchema.optional(),
  token: z.string().optional(),
  tokens: z.array(z.tuple([z.string(), swuMagnitudeSchema])).optional(),
  keywords: z.array(z.union([z.string(), swuKeywordSchema])).optional(),
  whose: z.string().optional(),
  zone: z.string().optional(),
  what: z.union([z.string(), swuTargetSchema]).optional(),
  sign: z.enum(["buff", "debuff", "set"]).optional(),
  state: z.string().optional(),
  per: z.string().optional(),
  trait: z.string().optional(),
  /** The grammar fills these; the curated table may omit them. */
  host: swuTargetSchema.optional(),
  applies: swuTargetSchema.optional(),
  check: z.string().optional(),
  conditional: z.boolean().optional(),
  frequency: z.string().optional(),
  oneShot: z.boolean().optional(),
  every: z.number().optional(),
  verb: z.string().optional(),
  dest: z.string().optional(),
};

/** Fields a grammar production or a curated entry may attach to a feature. */
export const swuFeatureFieldsSchema = z.looseObject(featureFields);
export type SwuFeatureFields = z.infer<typeof swuFeatureFieldsSchema>;

export const SWU_EFFECT_CATS = [
  "damage", "indirect_damage", "self_defeat", "defeat", "capture", "bounce", "take_control", "heal",
  "draw", "search", "look", "discard_opponent", "discard_self", "mill", "recursion", "give_token",
  "create_token", "gain_force", "move_token", "stat_mod", "grant_keyword", "blank", "self_exhaust",
  "exhaust", "ready_resource", "exhaust_resource", "restriction", "ready", "extra_attack",
  "take_initiative", "prevent_damage", "ramp", "cost_reduction", "cost_increase", "play_extra",
  "opponent_token", "remove_keyword", "copy_ability", "ignore_aspect_penalty",
] as const;

/** Effect categories only the curated table uses (curated-rules.v2.new-vocab). */
export const SWU_CURATED_EFFECT_CATS = ["attach", "extra_action", "first_strike", "recycle", "remove_trait", "tuck", "win_game"] as const;

export const swuEffectCatSchema = z.enum([...SWU_EFFECT_CATS, ...SWU_CURATED_EFFECT_CATS]);

export const SWU_CONDITION_CATS = [
  "if_you_do", "control_resources", "control", "initiative", "force", "self_state", "event_this_phase",
  "replacement_window", "target_check", "scaling", "while_other",
] as const;
export const swuConditionCatSchema = z.enum(SWU_CONDITION_CATS);

const featureBase = { rule: z.string().min(1), ...featureFields };

/** An effect feature: closed category set. */
export const swuEffectSchema = z.looseObject({ ...featureBase, cat: swuEffectCatSchema });
/** A condition feature: closed category set. */
export const swuConditionSchema = z.looseObject({ ...featureBase, cat: swuConditionCatSchema });
/** A structure or modifier feature: category names are open (curated structure items are free-form). */
export const swuFeatureSchema = z.looseObject({ ...featureBase, cat: z.string().min(1) });
export type SwuFeature = z.infer<typeof swuFeatureSchema>;
export type SwuEffect = z.infer<typeof swuEffectSchema>;

export const SWU_TRIGGER_IDS = [
  "when_played",
  "when_played_as_upgrade",
  "on_attack",
  "on_defense",
  "when_defeated",
  "attack_end",
  "on_attack_kill",
  "on_base_hit",
  "when_deployed",
  "epic_action",
  "action",
  "phase_start",
  "take_initiative",
  "reactive_friendly",
  "reactive_opponent",
  "reactive_self",
  "reactive_you",
  "reactive_other",
  "unknown_header",
  "event_resolve",
  "constant",
] as const;

export const SWU_REPEAT_CLASSES = [
  "once_on_play",
  "per_attack",
  "per_defense",
  "once_on_defeat",
  "once_per_game",
  "per_round",
  "repeatable_paid",
  "per_event",
  "constant",
  "unknown",
] as const;
export const swuRepeatClassSchema = z.enum(SWU_REPEAT_CLASSES);
export type SwuRepeatClass = z.infer<typeof swuRepeatClassSchema>;

export const swuActionCostSchema = z.strictObject({
  exhaust: z.boolean(),
  resources: z.number().int().nonnegative(),
  force: z.boolean(),
  other: z.array(z.string()),
});
export type SwuActionCost = z.infer<typeof swuActionCostSchema>;

export const swuTriggerSchema = z.strictObject({
  trigger: z.enum(SWU_TRIGGER_IDS),
  repeat: swuRepeatClassSchema,
  cost: swuActionCostSchema.optional(),
  text: z.string().optional(),
});
export type SwuTrigger = z.infer<typeof swuTriggerSchema>;

export const swuClauseSchema = z.strictObject({
  path: z.string(),
  text: z.string(),
  source: z.enum(["grammar", "curated", "none"]),
  effects: z.array(swuEffectSchema),
  conditions: z.array(swuConditionSchema),
  structure: z.array(swuFeatureSchema),
  modifiers: z.array(swuFeatureSchema),
  residue: z.array(z.string()),
  curatedId: z.string().optional(),
  wants: z.array(z.string()).optional(),
  offers: z.array(z.string()).optional(),
  shape: z.string().optional(),
});
export type SwuClause = z.infer<typeof swuClauseSchema>;

export const swuKeywordAbilitySchema = z.strictObject({
  kind: z.literal("keyword"),
  keywords: z.array(swuKeywordSchema),
  granted: z.boolean(),
  source: z.string(),
});

export const swuAbilitySchema = z.strictObject({
  kind: z.literal("ability"),
  triggers: z.array(swuTriggerSchema),
  repeat: swuRepeatClassSchema,
  granted: z.boolean(),
  clauses: z.array(swuClauseSchema),
  get grantedAbilities() {
    return z.array(swuGrantedSlotSchema);
  },
  get options() {
    return z.array(swuOptionSchema);
  },
});
export type SwuAbility = z.infer<typeof swuAbilitySchema>;

export const swuAbilityNodeSchema = z.union([swuAbilitySchema, swuKeywordAbilitySchema]);
export type SwuAbilityNode = z.infer<typeof swuAbilityNodeSchema>;

export const swuGrantedSlotSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  get abilities() {
    return z.array(swuAbilityNodeSchema);
  },
});

export const swuOptionSchema = z.strictObject({
  clauses: z.array(swuClauseSchema),
  get granted() {
    return z.array(swuGrantedSlotSchema);
  },
});

const countMap = z.record(z.string(), z.number().int());

export const swuEffectVectorSlotSchema = z.strictObject({
  count: z.number().int(),
  sumN: z.number(),
  varN: z.number().int(),
  byRepeat: countMap,
  byTarget: countMap,
  granted: z.number().int(),
  modal: z.number().int(),
});

export const swuFeatureVectorSchema = z.strictObject({
  triggers: countMap,
  effects: z.record(z.string(), swuEffectVectorSlotSchema),
  conditions: countMap,
  optionalEffects: z.number().int(),
  unclassified: z.number().int(),
});

export const swuTagSchema = z.strictObject({ tag: z.string(), why: z.string() });

export const swuCardFeaturesSchema = z.strictObject({
  cardKey: z.string().min(1),
  title: z.string(),
  subtitle: z.string().nullable(),
  type: z.string(),
  structured: z.strictObject({
    cost: z.number().nullable(),
    power: z.number().nullable(),
    hp: z.number().nullable(),
    upgradePower: z.number().nullable(),
    upgradeHp: z.number().nullable(),
    arenas: z.array(z.string()),
    aspects: z.array(z.string()),
    aspectIcons: z.array(z.string()),
    traits: z.array(z.string()),
    keywordsField: z.array(z.string()),
    unique: z.boolean(),
    deployable: z.boolean(),
  }),
  keywords: z.array(swuKeywordSchema.extend({ granted: z.boolean() })),
  keywordCheck: z.strictObject({ fieldNotInText: z.array(z.string()), textNotInField: z.array(z.string()) }),
  vector: swuFeatureVectorSchema,
  unclassified: z.array(
    z.strictObject({ face: swuFeatureFaceSchema, path: z.string(), text: z.string(), shape: z.string().optional() }),
  ),
  faces: z.strictObject({
    text: z.array(swuAbilityNodeSchema).optional(),
    deployBox: z.array(swuAbilityNodeSchema).optional(),
    epicAction: z.array(swuAbilityNodeSchema).optional(),
  }),
  tags: z.strictObject({ offers: z.array(swuTagSchema), wants: z.array(swuTagSchema) }),
});
export type SwuCardFeatures = z.infer<typeof swuCardFeaturesSchema>;

export const swuCardFeaturesFileSchema = z.array(swuCardFeaturesSchema);

/** The card row fields the extractor reads; every other column is ignored. */
export const swuFeatureInputCardSchema = z.looseObject({
  cardKey: z.string().min(1),
  title: z.string(),
  subtitle: z.string().nullish(),
  type: z.string(),
  type2: z.string().nullish(),
  cost: z.number().nullish(),
  power: z.number().nullish(),
  hp: z.number().nullish(),
  upgradePower: z.number().nullish(),
  upgradeHp: z.number().nullish(),
  arenas: z.string().nullish(),
  aspects: z.string().nullish(),
  aspectDuplicates: z.string().nullish(),
  traits: z.string().nullish(),
  keywords: z.string().nullish(),
  unique: z.boolean().nullish(),
  text: z.string().nullish(),
  deployBox: z.string().nullish(),
  epicAction: z.string().nullish(),
});
export type SwuFeatureInputCard = z.infer<typeof swuFeatureInputCardSchema>;

export const SWU_CURATED_SCHEMA_VERSION = 1;

export const swuCuratedEntrySchema = z.strictObject({
  id: z.string().min(1),
  cardKey: z.string().min(1),
  title: z.string(),
  face: swuFeatureFaceSchema,
  sourceClause: z.string().min(1),
  clauseSha256: z.string().regex(/^[0-9a-f]{64}$/),
  override: z.boolean().optional(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  newVocab: z.array(z.string()).optional(),
  features: z.strictObject({
    effects: z.array(swuEffectSchema).optional(),
    conditions: z.array(swuConditionSchema).optional(),
    structure: z.array(swuFeatureSchema).optional(),
    offers: z.array(z.string()).optional(),
    wants: z.array(z.string()).optional(),
  }),
  rationale: z.string().min(1),
  reviewedBy: z.string().nullable(),
  addedIn: z.string().min(1),
});
export type SwuCuratedEntry = z.infer<typeof swuCuratedEntrySchema>;

export const swuCuratedTableSchema = z.strictObject({
  schemaVersion: z.literal(SWU_CURATED_SCHEMA_VERSION),
  tableVersion: z.number().int().positive(),
  note: z.string().optional(),
  entries: z.array(swuCuratedEntrySchema),
});
export type SwuCuratedTable = z.infer<typeof swuCuratedTableSchema>;

export const swuUnclassifiedShapeSchema = z.strictObject({
  shape: z.string(),
  clauses: z.number().int(),
  cards: z.number().int(),
  example: z.strictObject({ cardKey: z.string(), title: z.string(), face: swuFeatureFaceSchema, clause: z.string() }),
  recommend: z.enum(["grammar_rule", "curated_entry"]),
});
export type SwuUnclassifiedShape = z.infer<typeof swuUnclassifiedShapeSchema>;

export const swuCardFeaturesCoverageSchema = z.strictObject({
  cards: z.number().int(),
  cardsWithText: z.number().int(),
  cardsFullyClassified: z.number().int(),
  clauses: z.number().int(),
  classifiedByGrammar: z.number().int(),
  classifiedByCurated: z.number().int(),
  unclassified: z.number().int(),
  clauseCoveragePct: z.number(),
  fullyParsedClauses: z.number().int(),
  fullyParsedPct: z.number(),
  contentWordCoveragePct: z.number(),
  keywordLines: z.number().int(),
  reminderOnlyParagraphs: z.number().int(),
  triggerHeaders: z.number().int(),
  triggerHeadersKnownPct: z.number(),
  distinctUnclassifiedShapes: z.number().int(),
  singletonShapes: z.number().int(),
  keywordFieldMismatchCards: z.number().int(),
  keywordFieldMismatches: z.array(
    z.strictObject({ cardKey: z.string(), title: z.string(), missingInField: z.array(z.string()) }),
  ),
  curated: z.strictObject({
    entries: z.number().int(),
    applied: z.number().int(),
    stale: z.array(z.string()),
    redundant: z.array(z.string()),
  }),
  topUnclassifiedShapes: z.array(swuUnclassifiedShapeSchema),
});
export type SwuCardFeaturesCoverage = z.infer<typeof swuCardFeaturesCoverageSchema>;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const swuCardFeaturesReplaySchema = z.strictObject({
  inputHash: sha256Hex,
  codeCommit: z.string().min(1),
  curatedTableSha256: sha256Hex,
  curatedTableVersion: z.number().int(),
  grammarVersion: z.number().int(),
  outputHashes: z.record(z.string(), sha256Hex),
});
export type SwuCardFeaturesReplay = z.infer<typeof swuCardFeaturesReplaySchema>;

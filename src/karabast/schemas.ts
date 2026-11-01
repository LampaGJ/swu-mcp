import { z } from "zod";

/**
 * @displayName Karabast socket seam schemas
 * @strategicPurpose Everything a karabast gamenode sends is foreign data (#182), and the bot's choice is built from
 * it, so every message the client reads is parsed here before any decision code sees it, and every command it sends
 * is checked against the server's allowlist and argument shapes before it leaves.
 * @tacticalObjective Zod v4 strict objects for the gamestate (Game.getState, forceteki Game.ts:1827-1895), each
 * player summary (Player.ts:1212-1270), card summaries (Card.ts:1439-1488 plus the in-play overrides), the prompt
 * state (PlayerPromptState.ts:139-159), lobbystate (Lobby.ts:346-377) and the lobby HTTP replies; the outgoing
 * `game` and `lobby` command tuples (Lobby.ts:1626-1654). Key sets follow the pinned clone 445792e: a new server key
 * fails the parse, which is how drift is noticed. Fields the client never reads keep their key but take any value.
 */

const any = z.unknown().optional();
const setIdSchema = z.strictObject({ set: z.string(), number: z.number().optional() });

const selectionKeys = { selectable: z.boolean().optional(), selected: z.boolean().optional(), unselectable: z.boolean().optional(), order: z.number().optional() };

/** One card summary: a visible card carries identity and stats, a hidden one only controller, owner, zone and selection. */
export const cardSummarySchema = z.strictObject({
  controllerId: z.string(),
  ownerId: z.string(),
  zone: z.string(),
  uuid: z.string().optional(),
  id: z.string().optional(),
  setId: setIdSchema.optional(),
  aspects: z.array(z.string()).optional(),
  name: z.string().optional(),
  power: z.number().optional(),
  hp: z.number().optional(),
  unimplemented: z.boolean().optional(),
  type: z.string().optional(),
  printedType: z.string().optional(),
  isBlanked: z.boolean().optional(),
  blockedFromPlayReason: any,
  aspectPenaltyAspects: z.array(z.string()).optional(),
  damage: z.number().optional(),
  exhausted: z.boolean().optional(),
  parentCardId: z.string().optional(),
  sentinel: z.boolean().optional(),
  cannotBeAttacked: z.boolean().optional(),
  isAttacker: z.boolean().optional(),
  isDefender: z.boolean().optional(),
  clonedCardId: any,
  clonedCardName: any,
  epicDeployActionSpent: z.boolean().optional(),
  epicActionSpent: z.boolean().optional(),
  onStartingSide: z.boolean().optional(),
  upgrades: any,
  ...selectionKeys,
});
export type CardSummary = z.infer<typeof cardSummarySchema>;

const sourceCardSchema = z.strictObject({ id: z.string().optional(), uuid: z.string(), name: z.string().optional(), setId: setIdSchema.optional(), controllerId: z.string().optional(), type: z.string().optional(), printedType: z.string().optional() });

export const buttonSchema = z.strictObject({
  text: z.union([z.string(), z.number()]).optional(),
  /** Usually a string; some prompts send a number, which the official client sends back unchanged. */
  arg: z.union([z.string(), z.number()]),
  command: z.string().optional(),
  uuid: z.string().optional(),
  method: z.string().optional(),
  disabled: z.boolean().optional(),
  gained: any,
  hasLegalEffects: any,
  label: z.string().optional(),
  optional: any,
  passArg: any,
  passText: any,
  sourceCard: sourceCardSchema.optional(),
  count: any,
});
export type Button = z.infer<typeof buttonSchema>;

export const displayCardSchema = z.strictObject({ cardUuid: z.string(), setId: setIdSchema.optional(), internalName: z.string(), selectionState: z.string(), displayText: z.string().optional(), selectionOrder: z.number().optional() });

export const distributeSchema = z.strictObject({
  type: z.string(),
  amount: z.number(),
  isIndirectDamage: z.boolean().optional(),
  canDistributeLess: z.boolean().optional(),
  canChooseNoTargets: z.boolean().optional(),
  maxTargets: z.number().optional(),
  tokenType: z.string().optional(),
});

/** Sent filled only to the player it belongs to; the other player's is `{}` (Player.ts:1214). */
export const promptStateSchema = z.strictObject({
  selectCardMode: z.string().optional(),
  selectOrder: z.boolean().optional(),
  selectNumber: z.strictObject({ min: z.number(), max: z.number() }).optional(),
  distributeAmongTargets: distributeSchema.optional(),
  batchTriggerResolution: any,
  dropdownListOptions: z.array(z.string()).optional(),
  menuTitle: z.string().optional(),
  promptTitle: z.string().optional(),
  promptDescription: z.string().optional(),
  buttons: z.array(buttonSchema).optional(),
  promptUuid: z.string().optional(),
  promptType: z.string().optional(),
  displayCards: z.array(displayCardSchema).optional(),
  perCardButtons: z.array(buttonSchema).optional(),
  isOpponentEffect: z.boolean().optional(),
  playerIsNewlyActive: z.boolean().optional(),
});
export type PromptState = z.infer<typeof promptStateSchema>;

const pileSchema = z.array(cardSummarySchema).optional();

export const playerSummarySchema = z.strictObject({
  id: z.string(),
  cardPiles: z.strictObject({ hand: pileSchema, outsideTheGame: pileSchema, capturedZone: pileSchema, resources: pileSchema, groundArena: pileSchema, spaceArena: pileSchema, discard: pileSchema, credits: pileSchema }),
  leaders: z.array(cardSummarySchema).optional(),
  base: cardSummarySchema.optional(),
  hasInitiative: z.boolean().optional(),
  availableResources: z.number().optional(),
  numCardsInDeck: z.number().optional(),
  forceToken: z.strictObject({ active: z.boolean().optional(), uuid: z.string().optional(), selectionState: z.strictObject(selectionKeys).optional() }).optional(),
  credits: pileSchema,
  topCardOfDeck: cardSummarySchema.optional(),
  promptState: promptStateSchema.optional(),
  disconnected: any,
  hasClaimedPlan: any,
  hasClaimedBlast: any,
  left: any,
  name: any,
  phase: any,
  promptedActionWindows: any,
  user: any,
  isActionPhaseActivePlayer: any,
  clock: any,
  aspects: any,
  turnTimeRemainingSeconds: any,
  mainTimeRemainingSeconds: any,
  timeRemainingStatus: any,
  timerIsRunning: any,
  availableSnapshots: any,
});
export type PlayerSummary = z.infer<typeof playerSummarySchema>;

export const gameStateSchema = z.strictObject({
  players: z.record(z.string(), playerSummarySchema),
  phase: z.string().optional(),
  winners: z.array(z.string()).optional(),
  initiativeClaimed: z.boolean().optional(),
  playerUpdate: any,
  id: any,
  manualMode: any,
  owner: any,
  newMessages: any,
  messageOffset: any,
  totalMessages: any,
  clientUIProperties: any,
  spectators: any,
  started: any,
  format: any,
  undoEnabled: any,
  ongoingEffects: any,
  animationEpoch: any,
  animationOffset: any,
  animationsTruncated: any,
  newAnimations: any,
  totalAnimations: any,
});
export type GameState = z.infer<typeof gameStateSchema>;

export const parseGameState = (raw: unknown): GameState => gameStateSchema.parse(raw);

export const lobbyUserSchema = z.looseObject({ id: z.string(), ready: z.boolean().optional() });

/**
 * lobbystate: the client reads id, users, gameOngoing and connectionLink. Users stay loose: buildLobbyUserData
 * (Lobby.ts:450-490) carries the owner's own decklist and account flags the client never reads.
 */
export const lobbyStateSchema = z.strictObject({
  id: z.string(),
  users: z.array(lobbyUserSchema),
  gameOngoing: z.boolean(),
  connectionLink: z.string().optional(),
  lobbyName: any,
  spectators: any,
  gameChat: any,
  lobbyOwnerId: any,
  isPrivate: any,
  spectateLink: any,
  gameType: any,
  userWhoMutedChat: any,
  gameFormat: any,
  rematchRequest: any,
  matchingCountdownText: any,
  cardPool: any,
  winHistory: any,
  hasConfirmedNextGame: any,
  sideboardTimeoutStatus: any,
  settings: any,
});
export type LobbyState = z.infer<typeof lobbyStateSchema>;

export const httpReplySchema = z.strictObject({ success: z.boolean(), message: z.string().optional(), error: z.string().optional(), importDeckErrors: any });

const valueDistributionSchema = z.array(z.strictObject({ uuid: z.string(), amount: z.number() }));

/** The four game commands the bot answers prompts with, plus the start-of-game setting toggle, as emitted after ('game'). */
export const gameCommandSchema = z.union([
  z.tuple([z.literal("cardClicked"), z.string()]),
  z.tuple([z.literal("menuButton"), z.union([z.string(), z.number()]), z.string()]),
  z.tuple([z.literal("perCardMenuButton"), z.union([z.string(), z.number()]), z.string(), z.string()]),
  z.tuple([z.literal("statefulPromptResults"), z.strictObject({ type: z.string(), valueDistribution: valueDistributionSchema }), z.string()]),
  z.tuple([z.literal("toggleOptionSetting"), z.literal("autoSingleTarget"), z.boolean()]),
]);
export type GameCommand = z.infer<typeof gameCommandSchema>;

export const lobbyCommandSchema = z.union([
  z.tuple([z.literal("setReadyStatus"), z.boolean()]),
  z.tuple([z.literal("startGameAsync")]),
  z.tuple([z.literal("reportScreenResolution"), z.strictObject({ width: z.number(), height: z.number() })]),
]);
export type LobbyCommand = z.infer<typeof lobbyCommandSchema>;

/**
 * @displayName Bot policy seam
 * @strategicPurpose The one interface every bot rung is written against, so a rung never touches engine objects and
 * the engine adapter (engine-view.ts over the typed driver, #110) can change without editing a policy.
 * @tacticalObjective Declares the legal-answer and game-view shapes a policy reads and the `(answers, view) => index`
 * function it implements, plus the per-policy decision counters (rule, default, fallback) every result reports.
 */

export type Keyword =
  | "ambush"
  | "bounty"
  | "coordinate"
  | "exploit"
  | "fortify"
  | "grit"
  | "hidden"
  | "overwhelm"
  | "piloting"
  | "plot"
  | "raid"
  | "restore"
  | "saboteur"
  | "sentinel"
  | "shielded"
  | "smuggle"
  | "support";

export type Zone = "hand" | "ground" | "space" | "base" | "resource" | "discard" | "deck" | "other";
export type CardKind = "unit" | "event" | "upgrade" | "leader" | "base" | "token" | "other";

/** What a hand card's parsed text does to a unit, read from features.json effect vectors. */
export interface EffectProfile {
  /** Defeats, damages, captures, bounces or takes control of a unit it may aim at an enemy. */
  removal: boolean;
  heal: boolean;
}

/** Ability facts from the parsed face in use (the leader side off the board, the unit side of a deployed leader). */
export interface AbilityProfile {
  /** An Action ability whose cost defeats a friendly unit (a token or Credit cost does not count). */
  sacrificeAction: boolean;
  whenDefeated: boolean;
  /** Resources a "When you take the initiative" trigger asks for; null without such a trigger. */
  takeInitiativeCost: number | null;
}

/** One card a policy can see: every card in play, both bases and leaders, our hand, and any card a legal answer names. */
export interface CardView {
  /** The engine's per-game object id; identity within one game only, never logged across engine versions. */
  id: string;
  cardKey: string | null;
  title: string;
  kind: CardKind;
  zone: Zone;
  mine: boolean;
  cost: number;
  /** Current power (Grit and ongoing effects included). */
  power: number;
  /** Current maximum HP. */
  hp: number;
  damage: number;
  remainingHp: number;
  keywords: ReadonlySet<Keyword>;
  /** Raid total added while attacking. */
  raid: number;
  /** A Shield token is attached. */
  shield: boolean;
  exhausted: boolean;
  /** A deployed leader unit, or a leader card on the base zone. */
  leader: boolean;
  unique: boolean;
  /** Printed aspect icons, duplicates kept. */
  aspects: readonly string[];
  /** playCalibrated, a null score taking its type's median; 0 for an unmapped card (tokens). */
  score: number;
  effects: EffectProfile;
  /** Absent in hand-built fixtures; read only by the pilot rules (#174). */
  ability?: AbilityProfile;
  /** Upgrade stat modifiers from the parsed card (an upgrade with a negative sum harms its host). */
  upgradePower: number;
  upgradeHp: number;
}

export interface SideView {
  base: CardView;
  leader: CardView;
  leaderDeployed: boolean;
  /** Units in play (both arenas), deployed leader included. */
  units: readonly CardView[];
  resources: { total: number; ready: number };
  handSize: number;
  deckSize: number;
  hasInitiative: boolean;
  /** Aspect icons the leader and base supply (for the aspect penalty). */
  aspects: readonly string[];
}

export interface MySideView extends SideView {
  hand: readonly CardView[];
  /** The costliest card in our own decklist (own information), used for the resource target. */
  maxDeckCost: number;
  /** Aspect icon counts over our own draw deck (own decklist, never its order), computed on call; absent in fixtures. */
  deckAspects?: () => Readonly<Record<string, number>>;
}

export type PromptKind =
  | "mulligan"
  | "initiativeChoice"
  | "resource"
  | "action"
  | "actionSelection"
  | "attackTarget"
  | "target"
  | "distribute"
  | "optionalTrigger"
  | "triggerOrder"
  | "menu"
  | "display"
  | "number"
  | "list"
  | "unknown";

/**
 * How a target prompt's effect lands on what is chosen. `harm` and `help` steer to enemy and friendly cards;
 * `attackWith` picks our attacker; `play` and `choose` pick the best card; `reveal` discloses; `defeatOwn`
 * is a cost or rule that defeats one of ours.
 */
export type EffectIntent = "harm" | "help" | "attackWith" | "play" | "choose" | "reveal" | "defeatOwn";

export interface PromptView {
  kind: PromptKind;
  /** The engine's menu title, e.g. "Deal 2 damage to a unit". */
  title: string;
  /** The card behind the prompt: the attacker, the ability's source, the clicked card of an action selection. */
  sourceId: string | null;
  sourceCardKey: string | null;
  intent: EffectIntent | null;
  /** The engine's effect system name, kept for the fallback counter's breakdown. */
  system: string | null;
  multiple: boolean;
  selectedIds: readonly string[];
  /** Optional-trigger text, e.g. "{keyword:ambush}". */
  abilityText: string | null;
  distribute: { type: string; amount: number; indirect: boolean; canDistributeLess: boolean; maxTargets: number | null } | null;
}

export interface GameView {
  seat: 1 | 2;
  round: number;
  phase: string;
  me: MySideView;
  opp: SideView;
  prompt: PromptView;
  /** Every card the view knows, by id (units, bases, leaders, our hand, and cards named by legal answers). */
  cards: ReadonlyMap<string, CardView>;
  /** Cards whose action this seat cancelled since the board last changed, so it does not click them again. */
  cancelled: ReadonlySet<string>;
  /** Decision randomness; only rung 0 and the fallback draw from it. */
  rnd: () => number;
}

export type AnswerKind = "card" | "button" | "display" | "perCard" | "number" | "list" | "distribute";

export interface LegalAnswer {
  kind: AnswerKind;
  /** Engine text: a button label, a card's internal name, a number. */
  label: string;
  /** `kind|label`, the spike's canonical sort key; equal for two copies of one card. */
  descriptor: string;
  cardId: string | null;
  /** For distribute answers: the adapter's assignment plan. */
  plan?: "harm" | "help";
  /** For distribute answers from the typed driver: the amounts each card receives. */
  allocation?: readonly { cardId: string; amount: number }[];
}

/** The policy contract: pick one index into `answers`. */
export type Policy = (answers: readonly LegalAnswer[], view: GameView) => number;

export interface PolicyStats {
  decisions: number;
  /** Answered by a card-data rule. */
  rule: number;
  /** Answered by a documented fixed default (first option of an unscored menu, trigger order). */
  defaulted: number;
  /** No rule applied; rung 0 chose. */
  fallback: number;
  /** Fallbacks by prompt kind and effect system. */
  fallbackBy: Record<string, number>;
}

export interface BotPolicy {
  id: string;
  version: string;
  rung: number;
  params: Readonly<Record<string, number>>;
  choose: Policy;
  /** Like choose, but returns null where no rule applies, so a policy chain can hand the decision to the rung below. */
  tryChoose: (answers: readonly LegalAnswer[], view: GameView) => number | null;
  /** The rule answer with no side effect (no counters, no loop guard), for a search that asks the rung for its order (rung 3). */
  decide?: (answers: readonly LegalAnswer[], view: GameView) => number | null;
  stats: PolicyStats;
}

export const emptyStats = (): PolicyStats => ({ decisions: 0, rule: 0, defaulted: 0, fallback: 0, fallbackBy: {} });

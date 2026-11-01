import { compareCodePoints } from "../../swu/canonical.js";
import type { CardTables } from "./tables.js";
import type { CardKind, CardView, EffectIntent, GameView, Keyword, LegalAnswer, MySideView, PromptKind, PromptView, SideView, Zone } from "./types.js";

/**
 * @displayName Engine view for the bot policies
 * @strategicPurpose The only code that reads forceteki's card objects for a bot, so the rules in rules.ts see cards
 * as data (cost, power, HP, damage, keywords) and never touch the engine.
 * @tacticalObjective Reads the engine's live card objects (zone, controller, cost, power, HP, damage, keywords,
 * Raid, Shield, exhaustion, aspects) into a GameView, names each prompt kind from the engine's active step and effect
 * system, and turns the typed driver's canonical actions (src/sims/actions.ts) into LegalAnswers with the engine card
 * behind each one.
 *
 * Prompt kinds, read from the innermost pipeline step's class: MulliganPrompt -> mulligan; HandlerMenuPrompt with
 * promptType initiative -> initiativeChoice; ResourcePrompt and VariableResourcePrompt -> resource; ActionWindow ->
 * action; ActionSelectionPrompt -> actionSelection (source: the card this seat last clicked); SelectCardPrompt whose
 * ability is an attack action -> attackTarget (source: the attacker); other SelectCardPrompt -> target, its intent
 * read from the immediate effect's system class (DamageSystem, DefeatCardSystem, CaptureSystem, ExhaustSystem,
 * MoveCardSystem, TakeControlOfUnitSystem harm; HealSystem, GiveTokenUpgradeSystem, ReadySystem help;
 * AttachUpgradeSystem by the upgrade's parsed stat sum; lasting effects, unknown systems and system-less prompts by the
 * menu title); DistributeAmongTargetsPrompt -> distribute; OptionalTriggerPrompt -> optionalTrigger; TriggeredAbility-
 * ResolutionPrompt -> triggerOrder; other handler, menu, modal, batch-trigger and pass-delay prompts -> menu; display prompts -> display;
 * NumberPrompt -> number; DropdownListPrompt -> list; anything else -> unknown (the policy's fallback).
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- engine objects are untyped JavaScript from the forceteki build */
type EngineCard = any;
type EngineGame = any;
type EnginePlayer = any;
/* eslint-enable @typescript-eslint/no-explicit-any */


const safe = <T>(f: () => T, fallback: T): T => {
  try {
    const v = f();
    return v === undefined || v === null || (typeof v === "number" && Number.isNaN(v)) ? fallback : v;
  } catch {
    return fallback;
  }
};

const ZONES: Record<string, Zone> = {
  groundArena: "ground",
  spaceArena: "space",
  base: "base",
  hand: "hand",
  resource: "resource",
  discard: "discard",
  deck: "deck",
};

const HARM = new Set(["DamageSystem", "DefeatCardSystem", "CaptureSystem", "ExhaustSystem", "MoveCardSystem", "TakeControlOfUnitSystem", "ReturnToHandSystem", "IndirectDamageToPlayerSystem"]);
const HELP = new Set(["HealSystem", "GiveTokenUpgradeSystem", "GiveShieldSystem", "GiveExperienceSystem", "ReadySystem"]);
const LASTING = /LastingEffectSystem$/;

export function intentOfTitle(title: string): EffectIntent | null {
  if (/attack with/i.test(title)) return "attackWith";
  if (/-\d+\/-\d+|-\d+\/-0|-0\/-\d+|can't|loses|defeat|damage|exhaust|capture|return .* hand|take control/i.test(title)) return "harm";
  if (/\+\d+\/\+\d+|\+\d+\/\+0|\+0\/\+\d+|gains?|heal|experience|shield|ready/i.test(title)) return "help";
  if (/discard pile|from your deck|choose a card|^play/i.test(title)) return "choose";
  if (/friendly|\byour\b/i.test(title)) return "help";
  return null;
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- engine game system */
function systemNames(g: any, depth = 0): string[] {
  if (!g || depth > 4) return [];
  const name = String(g.constructor?.name ?? "");
  const inner = g.properties?.gameSystems ?? (g.properties?.onTrue || g.properties?.onFalse ? [g.properties.onTrue, g.properties.onFalse] : null);
  return [name, ...(Array.isArray(inner) ? inner.flatMap((x: unknown) => systemNames(x, depth + 1)) : [])];
}

interface Scene {
  p: EnginePlayer;
  cards: Map<string, CardView>;
  me: MySideView;
  opp: SideView;
  prompt: PromptView;
  display: { internalName: string; cardUuid: string; selectionState?: string }[];
}

/** The typed driver's legal action (src/sims/schemas.ts LegalAction), the fields the adapter reads. */
export interface TypedAction {
  kind: string;
  label: string;
  descriptor: string;
  engineCardId: string | null;
  controller: number | null;
  zone: string | null;
  ordinal: number;
  targets: readonly { engineCardId: string | null; owner: number; zone: string; ordinal: number; amount?: number }[];
}

const TYPED_KIND: Record<string, LegalAnswer["kind"]> = {
  play: "card",
  act: "card",
  card: "card",
  resource: "card",
  display: "display",
  perCard: "perCard",
  number: "number",
  list: "list",
  distribute: "distribute",
};

interface SeatState {
  lastClicked: string | null;
  cancelled: Set<string>;
  sig: string;
  maxDeckCost: number | null;
  keyCache: Map<string, string | null>;
}

export function activeStep(game: EngineGame): EngineCard {
  let s = game.pipeline?.currentStep;
  for (let i = 0; i < 40 && s?.pipeline?.currentStep; i++) s = s.pipeline.currentStep;
  return s;
}

export class ViewBuilder {
  private readonly state: SeatState = { lastClicked: null, cancelled: new Set(), sig: "", maxDeckCost: null, keyCache: new Map() };

  constructor(
    private readonly game: EngineGame,
    private readonly seat: 1 | 2,
    private readonly tables: CardTables,
  ) {}

  get player(): EnginePlayer {
    return this.game.getPlayerById(this.seat === 1 ? "player1" : "player2");
  }

  private keyOf(c: EngineCard): string | null {
    const uuid = String(c.uuid);
    if (this.state.keyCache.has(uuid)) return this.state.keyCache.get(uuid) as string | null;
    const key = safe(() => (c.isToken?.() ? null : this.tables.keyOf(String(c.title), c.subtitle ?? null)), null);
    this.state.keyCache.set(uuid, key);
    return key;
  }

  card(c: EngineCard, me: EnginePlayer): CardView {
    const zone = ZONES[safe(() => String(c.zoneName), "")] ?? "other";
    const inPlay = zone === "ground" || zone === "space";
    const kind: CardKind = safe(() => {
      if (c.isBase()) return "base";
      if (c.isLeaderUnit?.() && inPlay) return "unit";
      if (c.isLeader()) return "leader";
      if (c.isUnit()) return "unit";
      if (c.isUpgrade()) return c.isToken() ? "token" : "upgrade";
      if (c.isEvent()) return "event";
      return "other";
    }, "other" as CardKind);
    const cardKey = this.keyOf(c);
    const hp = safe(() => (inPlay || kind === "base" ? Number(c.getHp()) : Number(c.getPrintedHp())), 0);
    const damage = safe(() => Number(c.damage), 0);
    const keywords = new Set<Keyword>(safe(() => (c.keywords as { name: string }[]).map((k) => k.name as Keyword), []));
    const up = this.tables.upgradeStats(cardKey);
    return {
      id: String(c.uuid),
      cardKey,
      title: safe(() => String(c.title), ""),
      kind,
      zone,
      mine: safe(() => c.controller === me, false),
      cost: safe(() => Number(c.cost), 0),
      power: safe(() => (inPlay ? Number(c.getPower()) : Number(c.getPrintedPower())), 0),
      hp,
      damage,
      remainingHp: safe(() => Number(c.remainingHp), hp - damage),
      keywords,
      raid: inPlay ? safe(() => Number(c.getNumericKeywordTotal("raid")), 0) : 0,
      shield: inPlay ? safe(() => Boolean(c.hasShield()), false) : false,
      exhausted: safe(() => Boolean(c.exhausted), false),
      leader: safe(() => Boolean(c.isLeader()), false),
      unique: safe(() => Boolean(c.unique), false),
      aspects: safe(() => [...(c.aspects as string[])].map(String), []),
      score: this.tables.score(cardKey),
      effects: this.tables.effects(cardKey),
      ability: this.tables.ability(cardKey, inPlay && safe(() => Boolean(c.isLeader()), false) ? "deployBox" : "text"),
      upgradePower: up.power,
      upgradeHp: up.hp,
    };
  }

  private side(p: EnginePlayer, me: EnginePlayer, cards: Map<string, CardView>): SideView {
    const put = (c: EngineCard): CardView => {
      const v = this.card(c, me);
      cards.set(v.id, v);
      return v;
    };
    const leaderCard = p.getSingleLeader();
    const units = (p.getArenaCards() as EngineCard[]).filter((c) => safe(() => c.isUnit(), false)).map(put);
    const base = put(p.base);
    const leader = cards.get(String(leaderCard.uuid)) ?? put(leaderCard);
    return {
      base,
      leader,
      leaderDeployed: safe(() => Boolean(leaderCard.deployed), false),
      units,
      resources: { total: safe(() => p.resources.length, 0), ready: safe(() => Number(p.readyResourceCount), 0) },
      handSize: safe(() => p.hand.length, 0),
      deckSize: safe(() => p.drawDeck.length, 0),
      hasInitiative: safe(() => Boolean(p.hasInitiative()), false),
      aspects: [...base.aspects, ...leader.aspects],
    };
  }

  private maxDeckCost(p: EnginePlayer): number {
    if (this.state.maxDeckCost !== null) return this.state.maxDeckCost;
    const all: EngineCard[] = [...safe(() => p.drawDeck, []), ...safe(() => p.hand, []), ...safe(() => p.resources, []), ...safe(() => p.discard, [])];
    this.state.maxDeckCost = Math.max(0, ...all.map((c) => safe(() => Number(c.cost), 0)));
    return this.state.maxDeckCost;
  }

  private prompt(step: EngineCard, p: EnginePlayer, cards: Map<string, CardView>): PromptView {
    const ps = p.promptState;
    const stepName = String(step?.constructor?.name ?? "");
    const title = safe(() => String(ps.menuTitle ?? ""), "");
    const multiple = safe(() => ps.selectCardMode === "multiple", false);
    const selectedIds = safe(() => (ps.selectedCards as EngineCard[]).map((c) => String(c.uuid)), [] as string[]);
    const base: PromptView = { kind: "unknown", title, sourceId: null, sourceCardKey: null, intent: null, system: null, multiple, selectedIds, abilityText: null, distribute: null };
    const sourceOf = (c: EngineCard): Partial<PromptView> => {
      if (!c?.uuid) return {};
      const v = cards.get(String(c.uuid)) ?? this.card(c, p);
      cards.set(v.id, v);
      return { sourceId: v.id, sourceCardKey: v.cardKey };
    };
    const kindOf = (kind: PromptKind, extra: Partial<PromptView> = {}): PromptView => ({ ...base, kind, ...extra });
    switch (stepName) {
      case "MulliganPrompt":
        return kindOf("mulligan");
      case "ResourcePrompt":
      case "VariableResourcePrompt":
        return kindOf("resource");
      case "ActionWindow":
        return kindOf("action");
      case "ActionSelectionPrompt": {
        const id = this.state.lastClicked;
        const v = id === null ? undefined : cards.get(id);
        return kindOf("actionSelection", { sourceId: id, sourceCardKey: v?.cardKey ?? null });
      }
      case "DistributeAmongTargetsPrompt": {
        const d = ps.distributeAmongTargets ?? {};
        return kindOf("distribute", {
          ...sourceOf(step.properties?.source),
          distribute: { type: String(d.type ?? ""), amount: Number(d.amount ?? 0), indirect: Boolean(d.isIndirectDamage), canDistributeLess: Boolean(d.canDistributeLess), maxTargets: d.maxTargets ?? null },
        });
      }
      case "OptionalTriggerPrompt":
        return kindOf("optionalTrigger", { abilityText: safe(() => String(step.properties.abilityText), null), ...this.sourceByUuid(step.properties?.sourceCard?.uuid, p, cards) });
      case "TriggeredAbilityResolutionPrompt":
        return kindOf("triggerOrder");
      case "NumberPrompt":
        return kindOf("number");
      case "DropdownListPrompt":
        return kindOf("list");
      case "SelectCardPrompt": {
        const src = sourceOf(step.context?.source ?? step.properties?.source);
        if (safe(() => Boolean(step.context?.ability?.isAttackAction?.()), false) && /attack/i.test(title)) return kindOf("attackTarget", src);
        const names = systemNames(step.properties?.immediateEffect);
        const system = names[0] ?? null;
        const selectable = safe(() => ps.selectableCards as EngineCard[], []);
        const allMine = selectable.length > 0 && selectable.every((c) => safe(() => c.controller === p, false));
        let intent: EffectIntent | null = null;
        if (names.includes("InitiateAttackSystem")) intent = "attackWith";
        else if (names.includes("RevealSystem")) intent = "reveal";
        else if (names.includes("PlayCardSystem")) intent = "play";
        else if (names.includes("SelectChoiceSystem")) intent = "choose";
        else if (names.includes("DefeatCardSystem") && allMine) intent = "defeatOwn";
        else if (names.includes("AttachUpgradeSystem")) {
          const id = src.sourceId;
          const up = id ? cards.get(id) : undefined;
          intent = up && up.upgradePower + up.upgradeHp < 0 ? "harm" : "help";
        } else if (names.some((n) => HARM.has(n))) intent = "harm";
        else if (names.some((n) => HELP.has(n))) intent = "help";
        else if (names.some((n) => LASTING.test(n)) || names.length === 0 || system === "SimultaneousOrSequentialSystem") {
          intent = /defeat/i.test(title) && allMine ? "defeatOwn" : intentOfTitle(title);
        }
        if (intent === null && /which copy/i.test(title)) intent = "defeatOwn";
        if (intent === null) intent = intentOfTitle(title);
        return kindOf("target", { ...src, intent, system });
      }
      default:
        if (/^Display/.test(stepName)) return kindOf("display");
        if (stepName === "HandlerMenuPrompt" && safe(() => ps.promptType === "initiative", false)) return kindOf("initiativeChoice");
        if (/^(HandlerMenu|Menu|ModalEffectSelection|HandlerMenuMultipleSelection|BatchTriggerResolution|PassDelay)/.test(stepName)) return kindOf("menu");
        return { ...base, system: stepName || null };
    }
  }

  private sourceByUuid(uuid: unknown, p: EnginePlayer, cards: Map<string, CardView>): Partial<PromptView> {
    if (typeof uuid !== "string") return {};
    const c = safe(() => this.game.findAnyCardInAnyList(uuid), null);
    if (!c) return {};
    const v = cards.get(uuid) ?? this.card(c, p);
    cards.set(v.id, v);
    return { sourceId: v.id, sourceCardKey: v.cardKey };
  }

  /** Everything the view holds except the answers: both sides, our hand, the prompt, the displayed cards. */
  private scene(): Scene {
    const game = this.game;
    const p = this.player;
    const cards = new Map<string, CardView>();
    const opp = this.side(p.opponent, p, cards);
    const mine = this.side(p, p, cards);
    const hand = (safe(() => p.hand, []) as EngineCard[]).map((c) => {
      const v = this.card(c, p);
      cards.set(v.id, v);
      return v;
    });
    const deckAspects = (): Record<string, number> => {
      const counts: Record<string, number> = {};
      for (const c of safe(() => p.drawDeck, []) as EngineCard[]) for (const a of safe(() => [...(c.aspects as string[])].map(String), [])) counts[a] = (counts[a] ?? 0) + 1;
      return counts;
    };
    const me: MySideView = { ...mine, hand, maxDeckCost: this.maxDeckCost(p), deckAspects };
    const basePrompt = this.prompt(activeStep(game), p, cards);
    const pr = safe(() => p.currentPrompt(), {} as Record<string, unknown>);
    const display = (safe(() => pr.displayCards, []) as { internalName: string; cardUuid: string; selectionState?: string }[]) ?? [];
    const shownSelected = display.filter((d) => d.selectionState === "selected").map((d) => String(d.cardUuid));
    const prompt = shownSelected.length > 0 ? { ...basePrompt, selectedIds: [...basePrompt.selectedIds, ...shownSelected] } : basePrompt;
    return { p, cards, me, opp, prompt, display };
  }

  private put(c: EngineCard, scene: Scene): string {
    const id = String(c.uuid);
    if (!scene.cards.has(id)) scene.cards.set(id, this.card(c, scene.p));
    return id;
  }

  /**
   * Builds the view and answers from the typed driver's canonical actions (src/sims/actions.ts). An action names its
   * card by engine internalName, controller, zone and ordinal, the ordinal counting copies in uuid-number order, so
   * the same order here finds the engine card behind it.
   */
  build(actions: readonly TypedAction[], rnd: () => number): { view: GameView; answers: LegalAnswer[] } {
    const scene = this.scene();
    const p = scene.p;
    const players = [this.game.getPlayerById("player1"), this.game.getPlayerById("player2")];
    const seatOf = (c: EngineCard): number => (c.controller === players[0] ? 1 : c.controller === players[1] ? 2 : 0);
    const uuidNumber = (uuid: string): string => /_(\d+)$/.exec(uuid)?.[1].padStart(12, "0") ?? uuid;
    const byUuid = (a: { uuid: string }, b: { uuid: string }): number => compareCodePoints(uuidNumber(a.uuid), uuidNumber(b.uuid));
    const selectable = [...(safe(() => p.promptState.selectableCards, []) as EngineCard[])].sort((a, b) => byUuid({ uuid: String(a.uuid) }, { uuid: String(b.uuid) }));
    const findCard = (name: string | null, seat: number | null, zone: string | null, ordinal: number): EngineCard | undefined =>
      selectable.filter((c) => c.internalName === name && (seat === null || seatOf(c) === seat) && (zone === null || c.zoneName === zone))[ordinal];
    const shown = scene.display.filter((d) => d.selectionState === "selectable" || d.selectionState === "selected").map((d) => ({ ...d, uuid: String(d.cardUuid) })).sort(byUuid);
    const answers: LegalAnswer[] = actions.map((a) => {
      const kind = TYPED_KIND[a.kind] ?? "button";
      let cardId: string | null = null;
      if (a.zone === "display") {
        const dc = shown.filter((d) => d.internalName === a.engineCardId)[a.ordinal];
        const c = dc ? safe(() => this.game.findAnyCardInAnyList(dc.uuid), null) : null;
        if (c) cardId = this.put(c, scene);
      } else if (a.engineCardId !== null) {
        const c = findCard(a.engineCardId, a.controller, a.zone, a.ordinal);
        if (c) cardId = this.put(c, scene);
      }
      const answer: LegalAnswer = { kind: a.zone === "display" && kind === "card" ? "display" : kind, label: a.label, descriptor: a.descriptor, cardId };
      if (a.kind === "distribute") {
        answer.allocation = a.targets.flatMap((t) => {
          const c = findCard(t.engineCardId, t.owner, t.zone, t.ordinal);
          return c ? [{ cardId: this.put(c, scene), amount: t.amount ?? 0 }] : [];
        });
      }
      return answer;
    });
    return { view: this.finish(scene, rnd), answers };
  }

  private finish(scene: Scene, rnd: () => number): GameView {
    const game = this.game;
    const { me, opp, prompt, cards } = scene;
    const sig = [game.roundNumber, game.currentPhase, me.handSize, me.units.length, opp.units.length, me.resources.ready, me.base.damage, opp.base.damage, me.units.filter((u) => u.exhausted).length].join("|");
    if (sig !== this.state.sig) {
      this.state.sig = sig;
      this.state.cancelled.clear();
    }
    const view: GameView = {
      seat: this.seat,
      round: safe(() => Number(game.roundNumber), 0),
      phase: safe(() => String(game.currentPhase), ""),
      me,
      opp,
      prompt,
      cards,
      cancelled: new Set(this.state.cancelled),
      rnd,
    };
    return view;
  }

  /** Records what the seat chose: the clicked card (for an action selection) and cancelled actions. */
  record(view: GameView, chosen: LegalAnswer): void {
    if (view.prompt.kind === "action" && chosen.kind === "card") this.state.lastClicked = chosen.cardId;
    if (chosen.kind === "button" && /^cancel$/i.test(chosen.label)) {
      const id = view.prompt.sourceId ?? this.state.lastClicked;
      if (id !== null) this.state.cancelled.add(id);
    }
  }

}

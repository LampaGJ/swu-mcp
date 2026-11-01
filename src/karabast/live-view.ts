import { intentOfTitle } from "../sims/policies/engine-view.js";
import type { CardTables } from "../sims/policies/tables.js";
import type { CardKind, CardView, EffectIntent, GameView, Keyword, LegalAnswer, MySideView, PromptKind, PromptView, SideView, Zone } from "../sims/policies/types.js";
import type { Seat } from "../sims/rng.js";
import type { LegalAction } from "../sims/schemas.js";
import { compareCodePoints } from "../swu/canonical.js";
import { cardsOf, type CardFacts, type CardIndex, type LiveShim, type ShimCard } from "./player-view.js";
import type { CardSummary, GameState, PlayerSummary, PromptState } from "./schemas.js";

/**
 * @displayName Rung 1 game view from a karabast player view
 * @strategicPurpose The rung 1 bot reads a GameView (src/sims/policies/types.ts), which the simulator builds from live
 * engine objects (engine-view.ts). A live client has only the gamestate one player receives, so this builds the same
 * view from that, and the bot code runs unchanged (#182).
 * @tacticalObjective Card stats from the summary (current power and HP, damage, exhaustion, Sentinel) and the pinned
 * clone's card data (cost, printed keywords, printed Raid, uniqueness: gap G4); the deck-derived facts from our own
 * decklist; the prompt kind from promptType, buttons, selectCardMode and the other prompt fields; the intent of a
 * target prompt from its menu title alone (intentOfTitle), because the effect system the simulator reads is never
 * sent (gap G3); the prompt's source card from the trigger button's sourceCard or by name from promptTitle, counting
 * a name several visible cards share. The round is counted from phase changes the builder observes.
 */

const ZONES: Record<string, Zone> = { groundArena: "ground", spaceArena: "space", base: "base", hand: "hand", resource: "resource", discard: "discard", deck: "deck" };

const uuidNumber = (uuid: string): string => /_(\d+)$/.exec(uuid)?.[1].padStart(12, "0") ?? uuid;
const byUuid = (a: string, b: string): number => compareCodePoints(uuidNumber(a), uuidNumber(b));

const TYPED_KIND: Record<string, LegalAnswer["kind"]> = { play: "card", act: "card", card: "card", resource: "card", display: "display", perCard: "perCard", number: "number", list: "list", distribute: "distribute" };

function kindOfType(type: string | undefined, inPlay: boolean): CardKind {
  if (type === undefined) return "other";
  if (type === "base") return "base";
  const leader = /leader/i.test(type);
  const unit = /unit/i.test(type);
  if (leader && unit && inPlay) return "unit";
  if (leader) return "leader";
  if (unit) return "unit";
  if (/upgrade/i.test(type)) return /token/i.test(type) ? "token" : "upgrade";
  if (type === "event") return "event";
  return "other";
}

/**
 * A target prompt's intent from its title: intentOfTitle, after three titles it misreads against the effect system
 * the simulator reads (measured in phase 1): healing is help though the title says damage, attaching an upgrade is
 * harm only when the upgrade's stats sum below zero (engine-view.ts's rule), a disclose is a reveal, and giving a
 * token is help (engine-view.ts counts GiveTokenUpgradeSystem as help, Weakness tokens included).
 */
export function titleIntent(title: string, allMine: boolean, source: CardView | undefined): EffectIntent | null {
  if (/^attach /i.test(title) && source !== undefined) return source.upgradePower + source.upgradeHp < 0 ? "harm" : "help";
  if (/\bheal\b/i.test(title)) return "help";
  if (/^disclose/i.test(title)) return "reveal";
  if (/^give .*\btokens?\b/i.test(title)) return "help";
  const intent: EffectIntent | null = /defeat/i.test(title) && allMine ? "defeatOwn" : intentOfTitle(title);
  if (intent === null && /which copy/i.test(title)) return "defeatOwn";
  return intent;
}

export interface LiveViewGaps {
  /** Target prompts whose promptTitle names several visible cards (the first by uuid order is taken). */
  ambiguousSource: number;
  /** Target prompts whose promptTitle names no visible card. */
  missingSource: number;
}

export interface LiveViewOptions {
  seat: Seat;
  seatIds: readonly [string, string];
  tables: CardTables;
  index: CardIndex;
  /** Our own main deck by engine internalName, one entry per copy (own information). */
  ownDeck: readonly string[];
}

export class LiveViewBuilder {
  private readonly memo = { lastClicked: null as string | null, cancelled: new Set<string>(), sig: "", keyCache: new Map<string, string | null>() };
  private readonly byName: Map<string, CardFacts>;
  private readonly maxDeckCost: number;
  private round = 1;
  private lastPhase: string | null = null;
  readonly gaps: LiveViewGaps = { ambiguousSource: 0, missingSource: 0 };

  constructor(private readonly opts: LiveViewOptions) {
    this.byName = new Map([...opts.index.values()].map((f) => [f.internalName, f]));
    this.maxDeckCost = Math.max(0, ...opts.ownDeck.map((n) => this.byName.get(n)?.cost ?? 0));
  }

  private get selfId(): string {
    return this.opts.seatIds[this.opts.seat - 1];
  }

  /** Counts rounds from the phases seen: a regroup followed by an action phase starts the next round. */
  observe(state: GameState): void {
    const phase = state.phase ?? null;
    if (phase === "action" && this.lastPhase === "regroup") this.round += 1;
    if (phase !== null) this.lastPhase = phase;
  }

  private facts(c: CardSummary): CardFacts | undefined {
    return c.id === undefined ? undefined : this.opts.index.get(c.id);
  }

  private keyOf(f: CardFacts | undefined): string | null {
    if (f === undefined || f.types.includes("token")) return null;
    const k = `${f.title}#${f.subtitle ?? ""}`;
    if (!this.memo.keyCache.has(k)) this.memo.keyCache.set(k, this.opts.tables.keyOf(f.title, f.subtitle));
    return this.memo.keyCache.get(k) ?? null;
  }

  card(c: CardSummary, shields: ReadonlySet<string>, zoneOverride?: Zone): CardView {
    const f = this.facts(c);
    const zone = zoneOverride ?? ZONES[c.zone] ?? "other";
    const inPlay = zone === "ground" || zone === "space";
    const kind = kindOfType(c.type, inPlay);
    const cardKey = this.keyOf(f);
    const hp = c.hp ?? 0;
    const damage = c.damage ?? 0;
    // The engine reports a leader's deploy-box keywords in every zone, the base zone included.
    const deployed = c.type !== undefined && /leader/i.test(c.type);
    const keywords = new Set<Keyword>(((deployed ? f?.unitKeywords : f?.keywords) ?? []).map((k) => k as Keyword));
    if (inPlay && c.sentinel === true) keywords.add("sentinel");
    if (inPlay && c.sentinel === false) keywords.delete("sentinel");
    const up = this.opts.tables.upgradeStats(cardKey);
    const leader = c.type !== undefined && /leader/i.test(c.type);
    return {
      id: c.uuid ?? "",
      cardKey,
      title: f?.title ?? c.name ?? "",
      kind,
      zone,
      mine: c.controllerId === this.selfId,
      cost: f?.cost ?? 0,
      power: c.power ?? 0,
      hp,
      damage,
      remainingHp: hp - damage,
      keywords,
      raid: inPlay ? ((deployed ? f?.unitRaid : f?.raid) ?? 0) : 0,
      shield: inPlay && c.uuid !== undefined && shields.has(c.uuid),
      exhausted: c.exhausted ?? false,
      leader,
      unique: f?.unique ?? false,
      aspects: c.aspects ?? f?.aspects ?? [],
      score: this.opts.tables.score(cardKey),
      effects: this.opts.tables.effects(cardKey),
      ability: this.opts.tables.ability(cardKey, inPlay && leader ? "deployBox" : "text"),
      upgradePower: up.power,
      upgradeHp: up.hp,
    };
  }

  private side(p: PlayerSummary, cards: Map<string, CardView>, shields: ReadonlySet<string>): SideView {
    const put = (c: CardSummary): CardView => {
      const v = this.card(c, shields);
      if (v.id !== "") cards.set(v.id, v);
      return v;
    };
    const arena = [...(p.cardPiles.groundArena ?? []), ...(p.cardPiles.spaceArena ?? [])];
    const units = arena.filter((c) => kindOfType(c.type, true) === "unit").map(put);
    if (p.base === undefined) throw new Error(`player ${p.id} has no base summary`);
    const base = put(p.base);
    const leaderCard = (p.leaders ?? [])[0];
    if (leaderCard === undefined) throw new Error(`player ${p.id} has no leader summary`);
    const leader = (leaderCard.uuid !== undefined ? cards.get(leaderCard.uuid) : undefined) ?? put(leaderCard);
    return {
      base,
      leader,
      leaderDeployed: leaderCard.zone === "groundArena" || leaderCard.zone === "spaceArena",
      units,
      resources: { total: (p.cardPiles.resources ?? []).length, ready: p.availableResources ?? 0 },
      handSize: (p.cardPiles.hand ?? []).length,
      deckSize: p.numCardsInDeck ?? 0,
      hasInitiative: p.hasInitiative ?? false,
      aspects: [...base.aspects, ...leader.aspects],
    };
  }

  /** Our remaining draw deck's aspect counts: the decklist minus every card we own that the gamestate shows. */
  private deckAspects(state: GameState): Record<string, number> {
    const left = new Map<string, number>();
    for (const n of this.opts.ownDeck) left.set(n, (left.get(n) ?? 0) + 1);
    for (const p of Object.values(state.players)) {
      for (const c of cardsOf(p)) {
        if (c.ownerId !== this.selfId) continue;
        const n = this.facts(c)?.internalName;
        if (n !== undefined && (left.get(n) ?? 0) > 0) left.set(n, (left.get(n) ?? 0) - 1);
      }
    }
    const counts: Record<string, number> = {};
    for (const [n, k] of [...left].sort((a, b) => compareCodePoints(a[0], b[0]))) for (const a of this.byName.get(n)?.aspects ?? []) counts[a] = (counts[a] ?? 0) + k;
    return counts;
  }

  private sourceByName(name: string | undefined, visible: readonly CardSummary[], cards: Map<string, CardView>, shields: ReadonlySet<string>, attacker = false): Partial<PromptView> {
    if (name === undefined || name === "") return {};
    // Several visible cards can share a title (a leader and a unit of one character): ours before the opponent's, in play before elsewhere.
    const rank = (c: CardSummary): number => (c.controllerId === this.selfId ? 0 : 2) + (c.zone === "groundArena" || c.zone === "spaceArena" ? 0 : 1);
    const named = visible.filter((c) => c.uuid !== undefined && (this.facts(c)?.title ?? c.name) === name && (!attacker || (c.controllerId === this.selfId && rank(c) === 0)));
    const hits = named.sort((a, b) => rank(a) - rank(b) || byUuid(a.uuid as string, b.uuid as string));
    if (hits.length === 0) {
      this.gaps.missingSource += 1;
      return {};
    }
    if (hits.length > 1 && rank(hits[0]) === rank(hits[1])) this.gaps.ambiguousSource += 1;
    return this.sourceOf(hits[0], cards, shields);
  }

  private sourceOf(c: CardSummary | undefined, cards: Map<string, CardView>, shields: ReadonlySet<string>): Partial<PromptView> {
    if (c?.uuid === undefined) return {};
    const v = cards.get(c.uuid) ?? this.card(c, shields);
    cards.set(v.id, v);
    return { sourceId: v.id, sourceCardKey: v.cardKey };
  }

  /** The prompt as the bot reads it, from what the server sends the viewer (no pipeline step, no effect system). */
  prompt(ps: PromptState, state: GameState, selectable: readonly ShimCard[], cards: Map<string, CardView>, shields: ReadonlySet<string>): PromptView {
    const visible = Object.values(state.players).flatMap(cardsOf);
    const title = ps.menuTitle ?? "";
    const multiple = ps.selectCardMode === "multiple";
    const selectedIds = visible.filter((c) => c.selected === true && c.uuid !== undefined).map((c) => c.uuid as string);
    for (const d of ps.displayCards ?? []) if (d.selectionState === "selected") selectedIds.push(d.cardUuid);
    const base: PromptView = { kind: "unknown", title, sourceId: null, sourceCardKey: null, intent: null, system: null, multiple, selectedIds: selectedIds.sort(byUuid), abilityText: null, distribute: null };
    const kindOf = (kind: PromptKind, extra: Partial<PromptView> = {}): PromptView => ({ ...base, kind, ...extra });
    const buttons = ps.buttons ?? [];
    const type = ps.promptType;
    if (buttons.some((b) => b.arg === "mulligan" || b.arg === "keep")) return kindOf("mulligan");
    if (type === "initiative") return kindOf("initiativeChoice");
    if (type === "resource") return kindOf("resource");
    if (type === "actionWindow") return kindOf("action");
    if (type === "actionSelection") {
      const id = this.memo.lastClicked;
      return kindOf("actionSelection", { sourceId: id, sourceCardKey: id === null ? null : (cards.get(id)?.cardKey ?? null) });
    }
    const d = ps.distributeAmongTargets;
    if (d !== undefined) {
      return kindOf("distribute", {
        ...this.sourceByName(ps.promptTitle, visible, cards, shields),
        distribute: { type: d.type, amount: d.amount, indirect: d.isIndirectDamage === true, canDistributeLess: d.canDistributeLess === true, maxTargets: d.maxTargets ?? null },
      });
    }
    if (type === "optionalTrigger") {
      const trigger = buttons.find((b) => b.sourceCard !== undefined);
      const src = trigger?.sourceCard === undefined ? undefined : visible.find((c) => c.uuid === trigger.sourceCard?.uuid);
      return kindOf("optionalTrigger", { abilityText: trigger?.label ?? null, ...this.sourceOf(src, cards, shields) });
    }
    if (type === "triggerWindow") return kindOf("triggerOrder");
    if (ps.selectNumber !== undefined) return kindOf("number");
    if ((ps.dropdownListOptions?.length ?? 0) > 0) return kindOf("list");
    if (type === "displayCards" || (ps.displayCards?.length ?? 0) > 0) return kindOf("display");
    if (type === "modalEffectSelection" || type === "batchTriggerResolution" || type === "passDelay") return kindOf("menu");
    if (ps.selectCardMode !== undefined && type === undefined) {
      // The attacker is not flagged isAttacker while its target is chosen, so the title alone decides.
      if (/target for attack/i.test(title)) return kindOf("attackTarget", this.sourceByName(ps.promptTitle, visible, cards, shields, true));
      const src = this.sourceByName(ps.promptTitle, visible, cards, shields);
      const allMine = selectable.length > 0 && selectable.every((c) => c.summary.controllerId === this.selfId);
      return kindOf("target", { ...src, intent: titleIntent(title, allMine, src.sourceId === undefined || src.sourceId === null ? undefined : cards.get(src.sourceId)) });
    }
    if (buttons.length > 0) return kindOf("menu");
    return base;
  }

  /**
   * The view and the answers for the viewer's canonical actions. Answers name their card the way engine-view.ts
   * does: by internalName, seat, zone and ordinal over the selectable cards in uuid-number order.
   */
  build(state: GameState, actions: readonly LegalAction[], shim: LiveShim, rnd: () => number): { view: GameView; answers: LegalAnswer[] } {
    this.observe(state);
    const [id1, id2] = this.opts.seatIds;
    const self = state.players[this.selfId];
    const other = state.players[this.selfId === id1 ? id2 : id1];
    if (self === undefined || other === undefined) throw new Error("gamestate lacks a seat");
    const shields = new Set<string>();
    for (const p of [self, other]) for (const c of cardsOf(p)) if (c.parentCardId !== undefined && this.facts(c)?.internalName === "shield") shields.add(c.parentCardId);
    const cards = new Map<string, CardView>();
    const opp = this.side(other, cards, shields);
    const mine = this.side(self, cards, shields);
    const hand = (self.cardPiles.hand ?? []).map((c) => {
      const v = this.card(c, shields);
      if (v.id !== "") cards.set(v.id, v);
      return v;
    });
    const me: MySideView = { ...mine, hand, maxDeckCost: this.maxDeckCost, deckAspects: () => this.deckAspects(state) };
    const selectable = shim.players[this.opts.seat - 1].promptState.selectableCards as ShimCard[];
    const prompt = this.prompt(self.promptState ?? {}, state, selectable, cards, shields);

    const sorted = [...selectable].sort((a, b) => byUuid(a.uuid, b.uuid));
    const seatOf = (c: ShimCard): number => (c.summary.controllerId === id1 ? 1 : c.summary.controllerId === id2 ? 2 : 0);
    const findCard = (name: string | null, seat: number | null, zone: string | null, ordinal: number): ShimCard | undefined =>
      sorted.filter((c) => c.internalName === name && (seat === null || seatOf(c) === seat) && (zone === null || c.zoneName === zone))[ordinal];
    const put = (c: ShimCard): string => {
      if (!cards.has(c.uuid)) cards.set(c.uuid, this.card(c.summary, shields));
      return c.uuid;
    };
    const visible = new Map(Object.values(state.players).flatMap(cardsOf).flatMap((c) => (c.uuid === undefined ? [] : [[c.uuid, c] as const])));
    const shown = (self.promptState?.displayCards ?? []).filter((d) => d.selectionState === "selectable" || d.selectionState === "selected").sort((a, b) => byUuid(a.cardUuid, b.cardUuid));
    const answers: LegalAnswer[] = actions.map((a) => {
      const kind = TYPED_KIND[a.kind] ?? "button";
      let cardId: string | null = null;
      if (a.zone === "display") {
        const dc = shown.filter((d) => d.internalName === a.engineCardId)[a.ordinal];
        if (dc !== undefined) {
          const known = visible.get(dc.cardUuid);
          const facts = this.byName.get(dc.internalName);
          const summary: CardSummary = known ?? { controllerId: this.selfId, ownerId: this.selfId, zone: "deck", uuid: dc.cardUuid, id: [...this.opts.index].find(([, f]) => f === facts)?.[0], type: facts?.types.includes("unit") ? "basicUnit" : facts?.types[0] };
          if (!cards.has(dc.cardUuid)) cards.set(dc.cardUuid, this.card(summary, shields, known === undefined ? "deck" : undefined));
          cardId = dc.cardUuid;
        }
      } else if (a.engineCardId !== null) {
        const c = findCard(a.engineCardId, a.controller, a.zone, a.ordinal);
        if (c) cardId = put(c);
      }
      const answer: LegalAnswer = { kind: a.zone === "display" && kind === "card" ? "display" : kind, label: a.label, descriptor: a.descriptor, cardId };
      if (a.kind === "distribute") {
        answer.allocation = a.targets.flatMap((t) => {
          const c = findCard(t.engineCardId, t.owner, t.zone, t.ordinal);
          return c ? [{ cardId: put(c), amount: t.amount ?? 0 }] : [];
        });
      }
      return answer;
    });

    const sig = [this.round, state.phase, me.handSize, me.units.length, opp.units.length, me.resources.ready, me.base.damage, opp.base.damage, me.units.filter((u) => u.exhausted).length].join("|");
    if (sig !== this.memo.sig) {
      this.memo.sig = sig;
      this.memo.cancelled.clear();
    }
    const view: GameView = { seat: this.opts.seat, round: this.round, phase: state.phase ?? "", me, opp, prompt, cards, cancelled: new Set(this.memo.cancelled), rnd };
    return { view, answers };
  }

  /** Records what the seat chose: the clicked card (for an action selection) and cancelled actions. */
  record(view: GameView, chosen: LegalAnswer): void {
    if (view.prompt.kind === "action" && chosen.kind === "card") this.memo.lastClicked = chosen.cardId;
    if (chosen.kind === "button" && /^cancel$/i.test(chosen.label)) {
      const id = view.prompt.sourceId ?? this.memo.lastClicked;
      if (id !== null) this.memo.cancelled.add(id);
    }
  }
}

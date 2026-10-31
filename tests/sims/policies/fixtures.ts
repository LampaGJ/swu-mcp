import type { CardView, GameView, Keyword, LegalAnswer, PromptView, SideView } from "../../../src/sims/policies/types.js";

let next = 0;

export function card(over: Omit<Partial<CardView>, "keywords"> & { keywords?: Iterable<Keyword> } = {}): CardView {
  const { keywords, ...rest } = over;
  const hp = over.hp ?? 3;
  const damage = over.damage ?? 0;
  return {
    id: over.id ?? `c${next++}`,
    cardKey: over.cardKey ?? null,
    title: over.title ?? "Card",
    kind: "unit",
    zone: "ground",
    mine: true,
    cost: 2,
    power: 2,
    hp,
    damage,
    remainingHp: hp - damage,
    raid: 0,
    shield: false,
    exhausted: false,
    leader: false,
    unique: false,
    aspects: [],
    score: 0,
    effects: { removal: false, heal: false },
    upgradePower: 0,
    upgradeHp: 0,
    ...rest,
    keywords: new Set(keywords ?? []),
  };
}

export const base = (mine: boolean, damage = 0): CardView =>
  card({ id: mine ? "myBase" : "oppBase", kind: "base", zone: "base", mine, hp: 30, damage, power: 0, cost: 0 });
export const leader = (mine: boolean, over: Partial<CardView> = {}): CardView =>
  card({ id: mine ? "myLeader" : "oppLeader", kind: "leader", zone: "base", mine, leader: true, cost: 5, ...over });

function side(mine: boolean, units: CardView[], over: Partial<SideView> = {}): SideView {
  return {
    base: base(mine),
    leader: leader(mine),
    leaderDeployed: false,
    units,
    resources: { total: 3, ready: 3 },
    handSize: 0,
    deckSize: 20,
    hasInitiative: false,
    aspects: [],
    ...over,
  };
}

export interface ViewSpec {
  mine?: CardView[];
  theirs?: CardView[];
  hand?: CardView[];
  me?: Partial<SideView> & { maxDeckCost?: number };
  opp?: Partial<SideView>;
  prompt?: Partial<PromptView>;
  cancelled?: string[];
}

export function view(spec: ViewSpec): GameView {
  const mine = (spec.mine ?? []).map((c) => ({ ...c, mine: true }));
  const theirs = (spec.theirs ?? []).map((c) => ({ ...c, mine: false }));
  const hand = (spec.hand ?? []).map((c) => ({ ...c, mine: true, zone: "hand" as const }));
  const me = { ...side(true, mine, spec.me), hand, handSize: hand.length, maxDeckCost: spec.me?.maxDeckCost ?? 6 };
  const opp = side(false, theirs, spec.opp);
  const cards = new Map<string, CardView>();
  for (const c of [me.base, me.leader, opp.base, opp.leader, ...mine, ...theirs, ...hand]) cards.set(c.id, c);
  const prompt: PromptView = {
    kind: "action",
    title: "Choose an action",
    sourceId: null,
    sourceCardKey: null,
    intent: null,
    system: null,
    multiple: false,
    selectedIds: [],
    abilityText: null,
    distribute: null,
    ...spec.prompt,
  };
  let state = 1;
  return { seat: 1, round: 1, phase: "action", me, opp, prompt, cards, cancelled: new Set(spec.cancelled ?? []), rnd: () => ((state = (state * 48271) % 2147483647) / 2147483647) };
}

export const cardAnswer = (c: CardView): LegalAnswer => ({ kind: "card", label: c.title, descriptor: `card|${c.title}`, cardId: c.id });
export const button = (label: string): LegalAnswer => ({ kind: "button", label, descriptor: `button|${label}`, cardId: null });

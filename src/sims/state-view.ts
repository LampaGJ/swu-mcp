/**
 * @displayName Evaluator state-view extractor
 * @strategicPurpose The evaluator (#125 to #128) may see only what the acting seat sees. This is the one place that
 * reads the engine for it, so hidden information is dropped at the emitter and RawStateView parses it again at the
 * encoder (both sides of the seam).
 * @tacticalObjective Reads named public live fields of a forceteki game (never Game.getState, which builds the whole
 * summary and advances the chat and animation cursors per viewer, forceteki Game.ts:1888 and AnimationRecorder.ts:47)
 * into a viewer-relative RawStateView: a card resolves to the release store's cardKey by normalised title and
 * subtitle (the rule the bot tables use, src/sims/policies/tables.ts:234), else to the #109 bridge's printing key (cards
 * outside the release, which the stateVersion 1 vocabulary counts as unknown), else to "~internalName"; tokens resolve
 * by title. The viewer's deck is reduced to a count multiset, the opponent's hand and deck to counts.
 */
import { compareCodePoints } from "../swu/canonical.js";
import type { EngineGame } from "./engine.js";
import { normalizeCardName } from "./policies/tables.js";
import { rawStateViewSchema, type RawStateView } from "./state.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- engine objects are untyped JavaScript from the forceteki build */
type AnyCard = any;
type AnyPlayer = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface StateViewKeys {
  /** Engine internalName to the bridge's cardKey (CardBridge.engineCardKeys), for cards the store lacks. */
  bridge: Readonly<Record<string, string>>;
  /** normalizeCardName(title, subtitle) to the store cardKey, first by code point when two cards share a name. */
  byName: Readonly<Record<string, string>>;
  /** Token title to cardKey; the vocabulary aliases every printing of a (type, title) to one index. */
  tokenKeys: Readonly<Record<string, string>>;
  /** Non-token names held by more than one store card. */
  ambiguousNames: number;
}

/** Prefix of a cardKey the bridge or the token table cannot resolve; the encoder counts it as unknown. */
export const UNRESOLVED_PREFIX = "~";

export function stateViewKeysOf(
  cards: readonly { cardKey: string; type: string; title: string; subtitle: string | null }[],
  bridge: Readonly<Record<string, string>>,
): StateViewKeys {
  const byName: Record<string, string> = {};
  const tokenKeys: Record<string, string> = {};
  let ambiguousNames = 0;
  for (const c of [...cards].sort((a, b) => compareCodePoints(a.cardKey, b.cardKey))) {
    if (c.type.includes("Token")) {
      if (tokenKeys[c.title] === undefined) tokenKeys[c.title] = c.cardKey;
      continue;
    }
    const name = normalizeCardName(c.title, c.subtitle);
    if (byName[name] === undefined) byName[name] = c.cardKey;
    else ambiguousNames++;
  }
  return { bridge, byName, tokenKeys, ambiguousNames };
}

export function cardKeyOf(c: AnyCard, keys: StateViewKeys): string {
  if (c.isToken()) return keys.tokenKeys[String(c.title)] ?? `${UNRESOLVED_PREFIX}${String(c.title)}`;
  const internal = String(c.internalName);
  return keys.byName[normalizeCardName(String(c.title), c.subtitle ?? null)] ?? keys.bridge[internal] ?? `${UNRESOLVED_PREFIX}${internal}`;
}

const PHASES = new Set(["setup", "action", "regroup"]);

export function extractStateView(game: EngineGame, viewerSeat: 1 | 2, keys: StateViewKeys): RawStateView {
  const g = game as unknown as AnyPlayer;
  const me: AnyPlayer = g.getPlayerById(viewerSeat === 1 ? "player1" : "player2");
  const opp: AnyPlayer = g.getPlayerById(viewerSeat === 1 ? "player2" : "player1");
  const keyOf = (c: AnyCard): string => cardKeyOf(c, keys);
  const unitOf = (c: AnyCard) => {
    const upgrades: AnyCard[] = [...c.upgrades];
    // Captured cards are held by the capturing unit (UnitProperties.ts:205); their identities are out of stateVersion 1.
    const captured: number = c.captureZone ? c.capturedUnits.length : 0;
    return {
      cardKey: keyOf(c),
      arena: c.zoneName === "spaceArena" ? ("space" as const) : ("ground" as const),
      power: Number(c.getPower()),
      hp: Number(c.getHp()),
      damage: Number(c.damage),
      exhausted: Boolean(c.exhausted),
      upgrades: upgrades.map(keyOf).sort(compareCodePoints),
      keywords: [...new Set<string>((c.keywords as { name: string }[]).map((k) => String(k.name)))].sort(compareCodePoints),
      shields: upgrades.filter((u) => u.isShield()).length,
      capturedCount: captured,
      isLeaderUnit: Boolean(c.isLeaderUnit()),
      isToken: Boolean(c.isToken()),
    };
  };
  const side = (p: AnyPlayer) => {
    const leader = p.getSingleLeader();
    const units = (p.getArenaCards() as AnyCard[]).filter((c) => c.isUnit()).map(unitOf);
    const discard = (p.discard as AnyCard[]).map(keyOf).sort(compareCodePoints);
    return {
      baseCardKey: keyOf(p.base),
      baseDamage: Number(p.base.damage),
      baseHp: Number(p.base.getHp()),
      leader: { cardKey: keyOf(leader), deployed: Boolean(leader.deployed), exhausted: Boolean(leader.exhausted) },
      resourcesTotal: Number(p.resources.length),
      resourcesReady: Number(p.readyResourceCount),
      handCount: Number(p.hand.length),
      deckCount: Number(p.drawDeck.length),
      discardCount: discard.length,
      discard,
      units,
      hasForceToken: Boolean(p.hasTheForce),
      credits: Number(p.creditTokenCount),
      capturedCards: units.reduce((n, u) => n + u.capturedCount, 0),
    };
  };
  const library = new Map<string, number>();
  for (const c of me.drawDeck as AnyCard[]) library.set(keyOf(c), (library.get(keyOf(c)) ?? 0) + 1);
  // forceteki leaves currentPhase null while one phase has ended and the next has not begun; a trigger can prompt there.
  const phase: string | null = g.currentPhase === null || g.currentPhase === undefined ? null : String(g.currentPhase);
  if (phase !== null && !PHASES.has(phase)) throw new Error(`state view: engine phase ${phase} is not setup, action or regroup`);
  const active: AnyPlayer | null = g.actionPhaseActivePlayer;
  return rawStateViewSchema.parse({
    schemaVersion: 1,
    round: Number(g.roundNumber),
    phase,
    hasInitiative: Boolean(me.hasInitiative()),
    initiativeClaimed: Boolean(g.isInitiativeClaimed),
    activeSeat: active === null || active === undefined ? null : active.id === me.id ? "me" : "opp",
    me: {
      ...side(me),
      hand: (me.hand as AnyCard[]).map(keyOf).sort(compareCodePoints),
      library: [...library].sort(([a], [b]) => compareCodePoints(a, b)).map(([cardKey, count]) => ({ cardKey, count })),
    },
    opp: side(opp),
  });
}

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { enumerateActions } from "../sims/actions.js";
import type { EngineButton, EngineCard, EngineGame, EnginePlayer, EnginePromptView } from "../sims/engine.js";
import type { Seat } from "../sims/rng.js";
import type { LegalAction } from "../sims/schemas.js";
import { compareCodePoints } from "../swu/canonical.js";
import { cardSummarySchema, gameCommandSchema, type Button, type CardSummary, type GameCommand, type GameState, type PlayerSummary } from "./schemas.js";

/**
 * @displayName Karabast player view to canonical actions
 * @strategicPurpose A live client sees only what the gamenode sends one player, never the engine (#182). The bot must
 * still choose among the same canonical actions the simulator enumerates, or nothing measured in the simulator
 * carries over to live play.
 * @tacticalObjective Rebuilds engine-shaped players and cards from one player's parsed gamestate: the prompt from
 * promptState, the selectable list from per-card `selectable` flags across every pile both players send (the list
 * itself is not sent, gap G1), card identity from the summary's numeric `id` through the pinned clone's card JSON.
 * Runs src/sims/actions.ts enumerateActions unchanged over them, with a recorder in place of the engine, so each
 * action's closure yields the socket command that answers it. A selectable card sent without a uuid (an opponent's
 * hidden card) cannot be clicked and is counted, never guessed.
 */

export interface CardFacts {
  internalName: string;
  title: string;
  subtitle: string | null;
  cost: number;
  unique: boolean;
  /** Keywords the card has on its own: a text line that starts with the keyword ("Grit", "Raid 1", "Bounty — ..."). */
  keywords: readonly string[];
  /** The same for a leader's deploy box, which the engine reports for a leader in any zone; the text side's for any other card. */
  unitKeywords: readonly string[];
  types: readonly string[];
  upgradePower: number | null;
  upgradeHp: number | null;
  /** Printed Raid amount from an own "Raid N" line; 0 without one. */
  raid: number;
  unitRaid: number;
  aspects: readonly string[];
}

/** Engine card facts by the numeric card id a summary carries. */
export type CardIndex = ReadonlyMap<string, CardFacts>;

const engineCardSchema = z.looseObject({
  id: z.string().min(1),
  internalName: z.string().min(1),
  title: z.string(),
  subtitle: z.string().nullish(),
  cost: z.number().nullish(),
  unique: z.boolean().nullish(),
  keywords: z.array(z.string()).nullish(),
  types: z.array(z.string()).nullish(),
  upgradePower: z.number().nullish(),
  upgradeHp: z.number().nullish(),
  text: z.string().nullish(),
  deployBox: z.string().nullish(),
  aspects: z.array(z.string()).nullish(),
});

/**
 * The keywords a card has on its own. The card data's `keywords` list names every keyword its text mentions, so a
 * conditional one ("While undamaged, this unit gains Sentinel") or one an upgrade grants its host would otherwise count.
 */
export function ownKeywords(text: string, mentioned: readonly string[]): { keywords: string[]; raid: number } {
  const known = new Set(mentioned.map((k) => k.toLowerCase()));
  const out = new Set<string>();
  let raid = 0;
  for (const line of text.split("\n")) {
    // Reminder text in parentheses ("Raid 3 (This unit gets +3/+0 while attacking.)") goes first; it can hold commas.
    for (const piece of line.replace(/\([^)]*\)/g, "").split(",")) {
      const m = /^([A-Za-z]+)(?:\s+(\d+))?(?:\s*[\u2014\u2013\-[].*)?$/.exec(piece.trim());
      if (m === null || !known.has(m[1].toLowerCase())) continue;
      out.add(m[1].toLowerCase());
      if (m[1].toLowerCase() === "raid" && m[2] !== undefined) raid += Number(m[2]);
    }
  }
  return { keywords: [...out].sort(compareCodePoints), raid };
}

/** Reads every card file of the clone's test/json/Card (the engine's own card data, tokens included). */
export function loadCardIndex(forcetekiRoot: string): CardIndex {
  const dir = path.join(forcetekiRoot, "test/json/Card");
  const index = new Map<string, CardFacts>();
  for (const file of readdirSync(dir).sort(compareCodePoints)) {
    if (!file.endsWith(".json")) continue;
    const c = engineCardSchema.parse(JSON.parse(readFileSync(path.join(dir, file), "utf8")));
    const own = ownKeywords(c.text ?? "", c.keywords ?? []);
    const unit = c.deployBox ? ownKeywords(c.deployBox, c.keywords ?? []) : own;
    index.set(c.id, {
      internalName: c.internalName,
      title: c.title,
      subtitle: c.subtitle ?? null,
      cost: c.cost ?? 0,
      unique: c.unique ?? false,
      keywords: own.keywords,
      unitKeywords: unit.keywords,
      types: c.types ?? [],
      upgradePower: c.upgradePower ?? null,
      upgradeHp: c.upgradeHp ?? null,
      raid: own.raid,
      unitRaid: unit.raid,
      aspects: c.aspects ?? [],
    });
  }
  return index;
}

/** The force token is sent as a flag on the player, not as a card summary (Player.ts:1272-1278). */
export const FORCE_TOKEN_INTERNAL_NAME = "the-force";

export interface ShimCard extends EngineCard {
  summary: CardSummary;
}

export interface ViewGaps {
  /** Selectable cards sent without a uuid: they cannot be clicked. */
  hiddenSelectable: number;
  /** Visible cards whose id the clone's card data lacks. */
  unmapped: number;
}

/** Every card summary one player summary carries, the base's upgrades included, deduplicated by uuid (a deployed leader appears twice). */
export function cardsOf(p: PlayerSummary): CardSummary[] {
  const piles = p.cardPiles;
  const all: CardSummary[] = [
    ...(piles.hand ?? []),
    ...(piles.resources ?? []),
    ...(piles.groundArena ?? []),
    ...(piles.spaceArena ?? []),
    ...(piles.discard ?? []),
    ...(piles.capturedZone ?? []),
    ...(piles.outsideTheGame ?? []),
    ...(piles.credits ?? []),
    ...(p.credits ?? []),
    ...(p.leaders ?? []),
    ...(p.base === undefined ? [] : [p.base]),
    ...(p.topCardOfDeck === undefined ? [] : [p.topCardOfDeck]),
  ];
  all.push(...(z.array(cardSummarySchema).optional().parse(p.base?.upgrades) ?? []));
  const seen = new Set<string>();
  const out: CardSummary[] = [];
  for (const c of all) {
    if (c.uuid !== undefined) {
      if (seen.has(c.uuid)) continue;
      seen.add(c.uuid);
    }
    out.push(c);
  }
  return out;
}

// EngineButton types arg as a string; a numeric arg is kept as sent, because the command must echo it.
const toButton = (b: Button): EngineButton => ({ text: b.text ?? "", arg: b.arg as string, disabled: b.disabled, uuid: b.uuid, method: b.method, command: b.command });

export interface LiveShim {
  game: EngineGame;
  players: [EnginePlayer, EnginePlayer];
  /** The commands the recorder took, in call order. */
  taken: GameCommand[];
  gaps: ViewGaps;
}

/**
 * Engine-shaped players over one viewer's gamestate. `seatIds` names seat 1 and seat 2 by user id; the viewer is
 * `seatIds[viewer - 1]`, and only the viewer's prompt and selectable flags are filled.
 */
export function liveShim(state: GameState, seatIds: readonly [string, string], viewer: Seat, index: CardIndex): LiveShim {
  const gaps: ViewGaps = { hiddenSelectable: 0, unmapped: 0 };
  const taken: GameCommand[] = [];
  const viewerId = seatIds[viewer - 1];
  const selectable: ShimCard[] = [];
  const shimPlayers = seatIds.map((id) => ({ id, trackingId: id })) as unknown as [EnginePlayer & { _prompt: EnginePromptView }, EnginePlayer & { _prompt: EnginePromptView }];
  const playerById = new Map<string, EnginePlayer>(seatIds.map((id, i) => [id, shimPlayers[i]]));
  const ownerOf = (id: string): EnginePlayer => {
    const p = playerById.get(id);
    if (p === undefined) throw new Error(`card controller ${id} is neither seat`);
    return p;
  };
  const shimCard = (c: CardSummary, internalName: string): ShimCard => ({
    summary: c,
    uuid: c.uuid ?? "",
    internalName,
    zoneName: c.zone,
    controller: ownerOf(c.controllerId),
    owner: ownerOf(c.ownerId),
    remainingHp: c.hp === undefined ? undefined : c.hp - (c.damage ?? 0),
    isBase: () => c.type === "base",
  });
  for (const id of seatIds) {
    const p = state.players[id];
    if (p === undefined) throw new Error(`gamestate has no player ${id}`);
    for (const c of cardsOf(p)) {
      if (c.id !== undefined && !index.has(c.id)) gaps.unmapped += 1;
      if (c.selectable !== true) continue;
      if (c.uuid === undefined) {
        gaps.hiddenSelectable += 1;
        continue;
      }
      const facts = c.id === undefined ? undefined : index.get(c.id);
      selectable.push(shimCard(c, facts?.internalName ?? `?${c.id ?? c.name ?? "hidden"}`));
    }
    const force = p.forceToken;
    if (force?.selectionState?.selectable === true && force.uuid !== undefined) {
      selectable.push(shimCard({ controllerId: id, ownerId: id, zone: "base", uuid: force.uuid, selectable: true }, FORCE_TOKEN_INTERNAL_NAME));
    }
  }
  const viewerState = state.players[viewerId];
  const ps = viewerState?.promptState ?? {};
  const prompt: EnginePromptView = {
    promptUuid: ps.promptUuid ?? "",
    promptType: ps.promptType ?? null,
    menuTitle: ps.menuTitle,
    buttons: (ps.buttons ?? []).map(toButton),
    selectCardMode: ps.selectCardMode ?? null,
    selectNumber: ps.selectNumber ?? null,
    distributeAmongTargets: ps.distributeAmongTargets ?? null,
    dropdownListOptions: ps.dropdownListOptions,
    displayCards: (ps.displayCards ?? []).map((d) => ({ cardUuid: d.cardUuid, internalName: d.internalName, selectionState: d.selectionState })),
    perCardButtons: (ps.perCardButtons ?? []).map(toButton),
  };
  const empty: EnginePromptView = { promptUuid: "" };
  shimPlayers.forEach((sp, i) => {
    const mine = i === viewer - 1;
    Object.assign(sp, {
      currentPrompt: () => (mine ? prompt : empty),
      promptState: { selectableCards: mine ? selectable : [], selectCardMode: mine ? (ps.selectCardMode ?? null) : null },
      getArenaCards: () => [],
      base: { damage: state.players[seatIds[i]]?.base?.damage ?? 0 },
    });
  });
  const game = {
    cardClicked: (_p: string, uuid: string) => taken.push(["cardClicked", uuid]),
    menuButton: (_p: string, arg: string | number, uuid: string) => taken.push(["menuButton", arg, uuid]),
    perCardMenuButton: (_p: string, arg: string | number, cardUuid: string, uuid: string) => taken.push(["perCardMenuButton", arg, cardUuid, uuid]),
    statefulPromptResults: (_p: string, result: { type: string; valueDistribution: { uuid: string; amount: number }[] }, uuid: string) =>
      taken.push(["statefulPromptResults", { type: result.type, valueDistribution: result.valueDistribution.map((v) => ({ uuid: v.uuid, amount: v.amount })) }, uuid]),
  } as unknown as EngineGame;
  return { game, players: shimPlayers, taken, gaps };
}

export interface LiveAction {
  action: LegalAction;
  command: GameCommand;
}

export interface LiveActions {
  actions: LiveAction[];
  gaps: ViewGaps;
  shim: LiveShim;
}

/** The viewer's canonical legal actions, each with the socket command that submits it (validated against the allowlist). */
export function liveActions(state: GameState, seatIds: readonly [string, string], viewer: Seat, cardKeys: Readonly<Record<string, string>>, index: CardIndex): LiveActions {
  const shim = liveShim(state, seatIds, viewer, index);
  const actions = enumerateActions(shim.game, shim.players, viewer, cardKeys).map((a) => {
    const before = shim.taken.length;
    a.run(() => 0);
    if (shim.taken.length !== before + 1) throw new Error(`action ${a.action.descriptor} produced ${shim.taken.length - before} commands`);
    return { action: a.action, command: gameCommandSchema.parse(shim.taken[before]) };
  });
  return { actions, gaps: shim.gaps, shim };
}

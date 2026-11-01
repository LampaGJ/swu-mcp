/**
 * @displayName Karabast client CLI context
 * @strategicPurpose The parity harness and the local-gamenode runner must play the same decks with the same rung 1
 * tables the ladder uses (#182), so their figures speak about the bot the ladder measured.
 * @tacticalObjective Loads the ladder's deck panel (the highest-placing buildable melee list of each of the six
 * largest-share archetypes, as scripts/sims/ladder.ts does) plus the owner's deck, the rung 1 tables, the clone's
 * card index, and maps an engine deck list to our own deck by internalName (own information for the live view).
 */
import path from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { loadDeck, prepareDeck } from "../sims/decks.js";
import { loadEngineCardMaps } from "../sims/card-bridge.js";
import type { SimContext } from "../sims/context.js";
import { DEFAULT_ORIGINALS_ROOT, loadCardMap } from "../bench/card-map.js";
import { loadStore } from "../../src/data.js";
import { REPO_ROOT } from "../../src/paths.js";
import { deckPanel, engineSetCodes, engineUnmappedCards, loadOpponentPool, mapCardKeyOf, storeAspectsOf } from "../../src/sims/opponents.js";
import type { DeckInput } from "../../src/sims/match.js";
import type { EngineList } from "../../src/sims/schemas.js";
import { POLICIES, PolicyChain } from "../../src/sims/policy.js";
import { parsePolicySpec, policyOf } from "../../src/sims/policies/index.js";
import { registerRungs } from "../../src/sims/policies/typed-adapter.js";
import { loadTables, type CardTables } from "../../src/sims/policies/tables.js";
import type { BotPolicy } from "../../src/sims/policies/types.js";

export const DEFAULT_DECKS = path.join(REPO_ROOT, "data/originals/decks/2026-10-17");
export const OWNER_DECK = path.join(REPO_ROOT, "tests/fixtures/decks/warrior-chewie-raid.swudb.json");

export function ladderDecks(ctx: SimContext, runDir: string, decksDir: string, forceteki: string): DeckInput[] {
  // The worktree path itself contains "karabast", which the D22 path guard (src/sims/opponents.ts:167) rejects; the real path is the main checkout.
  decksDir = realpathSync(decksDir);
  const cardMap = loadCardMap(runDir, path.join(DEFAULT_ORIGINALS_ROOT, "2026-10-16"));
  const pool = loadOpponentPool({
    archetypesFile: path.join(runDir, "meta/archetypes.json"),
    decksDir,
    cardKeyOf: mapCardKeyOf(cardMap.setNumber.byId),
    baseAspectsOf: storeAspectsOf(loadStore(runDir)),
    unmappedCards: engineUnmappedCards(engineSetCodes(forceteki)),
  });
  const panel = deckPanel(pool, { top: 6 }).map((e) => {
    if (e.list === null) throw new Error(`no buildable list for archetype ${e.archetypeId}`);
    const file = path.join(decksDir, `${e.list.key}.json`);
    return prepareDeck(ctx.bridge, JSON.parse(readFileSync(file, "utf8")), `file:data/originals/decks/${path.basename(decksDir)}/${e.list.key}.json`);
  });
  return [...panel, loadDeck(ctx.bridge, OWNER_DECK)];
}

/** Our main deck by engine internalName, one entry per copy, from the engine list the game was given. */
export function ownDeckOf(list: EngineList, forceteki: string): string[] {
  const maps = loadEngineCardMaps(forceteki);
  const internal = new Map(maps.cardMap.map((e) => [e.id, e.internalName]));
  return list.deck.flatMap((e) => {
    const name = internal.get(maps.setCodeMap[e.id] ?? "");
    if (name === undefined) throw new Error(`deck card ${e.id} is not in the clone's card map`);
    return Array.from({ length: e.count }, () => name);
  });
}

export function rung1Tables(runDir: string): CardTables {
  return loadTables({ runDir, complementarity: path.join(REPO_ROOT, "data/complementarity.json"), pairs: false });
}

/** Registers the simulator's rung1 chain (for the true-engine side) once. */
export function registerRung1(tables: CardTables): void {
  registerRungs(POLICIES, (ps) => new PolicyChain(ps as never), ["rung1"], tables);
}

export function rung1Bot(tables: CardTables): BotPolicy {
  const bot = policyOf(parsePolicySpec("rung1"), tables);
  if (bot === null) throw new Error("rung1 has no bot policy");
  return bot;
}

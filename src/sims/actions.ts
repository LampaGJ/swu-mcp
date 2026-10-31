import { compareCodePoints } from "../swu/canonical.js";
import type { EngineButton, EngineCard, EngineGame, EnginePlayer, EnginePromptView } from "./engine.js";
import type { Seat } from "./rng.js";
import type { LegalAction, PROMPT_KINDS } from "./schemas.js";

/**
 * @displayName Canonical legal actions
 * @strategicPurpose A policy's choice must never depend on the engine's enumeration order, which differs across
 * rollback (#110), and nothing random per run may reach a record: prompt uuids are uuid v1 and card uuids are a
 * per-engine-version counter.
 * @tacticalObjective Flattens one seat's current prompt into actions with descriptor `kind|card|zone|ordinal|tail`,
 * sorted by compareCodePoints. The card part is the cardKey, or `~<engine internalName>` when the bridge has none;
 * ordinal separates copies of one card in one zone. Each action carries a closure that submits it to the engine.
 */

export type PromptKind = (typeof PROMPT_KINDS)[number];

export interface CanonicalAction {
  action: LegalAction;
  run: (random: () => number) => void;
}

type Raw = Omit<LegalAction, "i" | "descriptor" | "ordinal"> & { ident: string; tail: string | null; order: number; uuidOrder: string; run: CanonicalAction["run"] };

const SURROGATE = /[\uD800-\uDFFF]/;

/** The order of compareCodePoints, faster: without surrogates, UTF-16 code-unit order is code-point order. */
export const byCodePoint = (a: string, b: string): number => (a === b ? 0 : SURROGATE.test(a) || SURROGATE.test(b) ? compareCodePoints(a, b) : a < b ? -1 : 1);

const BUTTON_KINDS: Record<string, LegalAction["kind"]> = { pass: "pass", claimInitiative: "takeInitiative", done: "done", mulligan: "mulligan", keep: "mulligan" };
const PLAY_ZONES = new Set(["hand", "resource", "discard"]);

/** forceteki prefixes modal choices with this only under NODE_ENV=test (ModalEffectSelectionPrompt.ts:69); a descriptor must not depend on the environment. */
const TEST_ONLY_PREFIX = /^\(No effect\) /;

const enabled = (buttons: readonly EngineButton[] | undefined): EngineButton[] => (buttons ?? []).filter((b) => b.disabled !== true);

const isLiveDisplayCard = (state: string): boolean => state === "selectable" || state === "selected";

/** Whether the seat must decide now; the same test enumerateActions applies, without the card lookups. */
export function hasDecision(player: EnginePlayer): boolean {
  const p = player.currentPrompt();
  if (p.distributeAmongTargets) return true;
  if ((p.dropdownListOptions?.length ?? 0) > 0 || p.selectNumber) return true;
  if ((p.perCardButtons ?? []).some((b) => b.disabled !== true) && (p.displayCards?.length ?? 0) > 0) return true;
  if ((p.displayCards ?? []).some((d) => isLiveDisplayCard(d.selectionState))) return true;
  if (player.promptState.selectableCards.length > 0) return true;
  return enabled(p.buttons).length > 0;
}

export function promptKindOf(player: EnginePlayer): PromptKind {
  const p = player.currentPrompt();
  if (p.distributeAmongTargets) return "distribute";
  if (p.selectNumber) return "number";
  if ((p.buttons ?? []).some((b) => b.arg === "mulligan" || b.arg === "keep")) return "mulligan";
  if (p.promptType === "actionWindow") return "mainAction";
  if (p.promptType === "resource") return "resource";
  if (player.promptState.selectCardMode === "multiple" && (player.promptState.selectableCards.length > 0 || (p.displayCards?.length ?? 0) > 0)) return "multiSelect";
  if (player.promptState.selectableCards.length > 0) return "target";
  return "choice";
}

const uuidNumber = (uuid: string): string => {
  const m = /_(\d+)$/.exec(uuid);
  return m === null ? uuid : m[1].padStart(12, "0");
};

const seatOf = (players: readonly [EnginePlayer, EnginePlayer], p: EnginePlayer | undefined): Seat | null => (p === players[0] ? 1 : p === players[1] ? 2 : null);

/** Indirect damage to a unit is capped by its remaining HP; what no target may take goes to a base. */
function allocate(dist: NonNullable<EnginePromptView["distributeAmongTargets"]>, order: readonly EngineCard[]): { card: EngineCard; amount: number }[] {
  const out: { card: EngineCard; amount: number }[] = [];
  let remaining = dist.amount;
  for (const c of order) {
    if (remaining <= 0 || (dist.maxTargets !== undefined && dist.maxTargets > 0 && out.length >= dist.maxTargets)) break;
    const isBase = c.isBase?.() === true;
    const cap = isBase || dist.isIndirectDamage !== true ? remaining : Math.min(remaining, c.remainingHp ?? remaining);
    if (cap > 0) {
      out.push({ card: c, amount: cap });
      remaining -= cap;
    }
  }
  if (remaining > 0 && dist.canDistributeLess !== true) {
    const base = order.find((c) => c.isBase?.() === true) ?? order[0];
    if (base !== undefined) {
      const hit = out.find((v) => v.card === base);
      if (hit !== undefined) hit.amount += remaining;
      else out.push({ card: base, amount: remaining });
    }
  }
  return out;
}

/**
 * Every legal answer of `seat` to its current prompt, canonical and sorted. `cardKeys` maps engine internalName to
 * cardKey (the bridge's engineCardKeys).
 */
export function enumerateActions(game: EngineGame, players: readonly [EnginePlayer, EnginePlayer], seat: Seat, cardKeys: Readonly<Record<string, string>>): CanonicalAction[] {
  const player = players[seat - 1];
  const prompt = player.currentPrompt();
  const selectable = player.promptState.selectableCards;
  const ident = (internalName: string): { cardKey: string | null; ident: string } => {
    const cardKey = cardKeys[internalName] ?? null;
    return { cardKey, ident: cardKey ?? `~${internalName}` };
  };
  const zoneOf = (c: EngineCard): string => `p${seatOf(players, c.controller) ?? 0}.${c.zoneName}`;
  const raws: Raw[] = [];
  const base = { targets: [] as LegalAction["targets"] };

  const dist = prompt.distributeAmongTargets;
  if (dist) {
    const targetKey = (c: EngineCard): string => `${ident(c.internalName).ident}@${zoneOf(c)}`;
    const ordered = [...selectable].sort((a, b) => byCodePoint(targetKey(a), targetKey(b)) || byCodePoint(uuidNumber(a.uuid), uuidNumber(b.uuid)));
    const ordinals = new Map<EngineCard, number>();
    const counts = new Map<string, number>();
    for (const c of ordered) {
      const key = targetKey(c);
      ordinals.set(c, counts.get(key) ?? 0);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    // One deterministic allocation per lead target: the lead first, then the rest in target order.
    for (const order of ordered.map((lead) => [lead, ...ordered.filter((c) => c !== lead)])) {
      const alloc = allocate(dist, order);
      const tail = `${dist.type}|${alloc.map((v) => `${targetKey(v.card)}#${ordinals.get(v.card)}=${v.amount}`).join(",")}`;
      raws.push({
        ...base,
        kind: "distribute",
        cardKey: null,
        engineCardId: null,
        controller: null,
        zone: null,
        targets: alloc.map((v) => ({
          cardKey: ident(v.card.internalName).cardKey,
          engineCardId: v.card.internalName,
          owner: seatOf(players, v.card.controller) ?? 1,
          zone: v.card.zoneName,
          ordinal: ordinals.get(v.card) ?? 0,
          amount: v.amount,
        })),
        label: dist.type,
        ident: "-",
        tail,
        order: 0,
        uuidOrder: "",
        run: () => game.statefulPromptResults(player.id, { type: dist.type, valueDistribution: alloc.map((v) => ({ uuid: v.card.uuid, amount: v.amount })) }, prompt.promptUuid),
      });
    }
  } else {
    for (const opt of prompt.dropdownListOptions ?? []) {
      const label = String(opt);
      raws.push({ ...base, kind: "list", cardKey: null, engineCardId: null, controller: null, zone: null, label, ident: "-", tail: label, order: 0, uuidOrder: "", run: () => game.menuButton(player.id, opt, prompt.promptUuid) });
    }
    if (prompt.selectNumber) {
      for (let n = prompt.selectNumber.min; n <= prompt.selectNumber.max; n++) {
        const label = String(n);
        raws.push({ ...base, kind: "number", cardKey: null, engineCardId: null, controller: null, zone: null, label, ident: "-", tail: label, order: 0, uuidOrder: "", run: () => game.menuButton(player.id, label, prompt.promptUuid) });
      }
    }
    const perCard = enabled(prompt.perCardButtons);
    for (const dc of prompt.displayCards ?? []) {
      const id = ident(dc.internalName);
      if (perCard.length > 0) {
        // A display prompt with per-card buttons rejects a plain click on a card ("Unexpected menu command: 'Card_N'").
        for (const b of perCard) {
          const label = String(b.text);
          raws.push({
            ...base,
            kind: "perCard",
            cardKey: id.cardKey,
            engineCardId: dc.internalName,
            controller: null,
            zone: "display",
            label,
            ident: id.ident,
            tail: label,
            order: 0,
            uuidOrder: uuidNumber(dc.cardUuid),
            run: () => game.perCardMenuButton(player.id, b.arg, dc.cardUuid, prompt.promptUuid, b.method),
          });
        }
      } else if (isLiveDisplayCard(dc.selectionState)) {
        raws.push({
          ...base,
          kind: "display",
          cardKey: id.cardKey,
          engineCardId: dc.internalName,
          controller: null,
          zone: "display",
          label: dc.internalName,
          ident: id.ident,
          tail: null,
          order: 0,
          uuidOrder: uuidNumber(dc.cardUuid),
          run: () => game.menuButton(player.id, dc.cardUuid, prompt.promptUuid, "menuButton"),
        });
      }
    }
    const cardKind: LegalAction["kind"] = prompt.promptType === "resource" ? "resource" : "card";
    for (const c of selectable) {
      const id = ident(c.internalName);
      const kind: LegalAction["kind"] = prompt.promptType === "actionWindow" ? (PLAY_ZONES.has(c.zoneName) ? "play" : "act") : cardKind;
      raws.push({
        ...base,
        kind,
        cardKey: id.cardKey,
        engineCardId: c.internalName,
        controller: seatOf(players, c.controller),
        zone: c.zoneName,
        label: c.internalName,
        ident: id.ident,
        tail: null,
        order: 0,
        uuidOrder: uuidNumber(c.uuid),
        run: () => game.cardClicked(player.id, c.uuid),
      });
    }
    enabled(prompt.buttons).forEach((b, order) => {
      const label = String(b.text);
      const tail = label.replace(TEST_ONLY_PREFIX, "");
      raws.push({
        ...base,
        kind: BUTTON_KINDS[b.arg] ?? "choose",
        cardKey: null,
        engineCardId: null,
        controller: null,
        zone: null,
        label,
        ident: "-",
        tail,
        order,
        uuidOrder: "",
        run: () => game.menuButton(player.id, b.arg, b.uuid ?? prompt.promptUuid, b.method),
      });
    });
  }

  const head = (r: Raw): string => `${r.kind}|${r.ident}|${r.zone === null ? "-" : r.controller === null ? r.zone : `p${r.controller}.${r.zone}`}`;
  const groupKey = (r: Raw): string => `${head(r)}|${r.tail ?? ""}`;
  raws.sort((a, b) => byCodePoint(groupKey(a), groupKey(b)) || byCodePoint(a.uuidOrder, b.uuidOrder) || a.order - b.order);
  const seen = new Map<string, number>();
  const out: CanonicalAction[] = [];
  for (const r of raws) {
    const g = groupKey(r);
    const ordinal = seen.get(g) ?? 0;
    seen.set(g, ordinal + 1);
    const descriptor = `${head(r)}|${ordinal}${r.tail === null ? "" : `|${r.tail}`}`;
    const action: LegalAction = { i: 0, kind: r.kind, cardKey: r.cardKey, engineCardId: r.engineCardId, controller: r.controller, zone: r.zone, ordinal, targets: r.targets, descriptor, label: r.label };
    out.push({ action, run: r.run });
  }
  const unique = new Map<string, CanonicalAction>();
  for (const a of out) if (!unique.has(a.action.descriptor)) unique.set(a.action.descriptor, a);
  const sorted = [...unique.values()].sort((a, b) => byCodePoint(a.action.descriptor, b.action.descriptor));
  sorted.forEach((a, i) => (a.action.i = i));
  return sorted;
}

import type { SwuCardFeatures, SwuClause, SwuTarget } from "./deps.js";
import { compareCodePoints } from "./deps.js";
import { walkAbilities } from "./walk.js";

const UNIT_TOKENS = new Set(["Battle Droid", "Clone Trooper", "TIE Fighter", "X-Wing", "Spy", "Beast", "Mandalorian"]);
const FRIENDLYISH = new Set(["friendly", "self", "mixed"]);

type Polarity = "any" | "self" | "friendly" | "enemy" | "ref";
const pol = (t: SwuTarget | undefined): Polarity => {
  if (!t) return "any";
  if (t.side === "self" || t.side === "friendly" || t.side === "enemy" || t.side === "ref") return t.side;
  return "any";
};
const isUnitKind = (t: SwuTarget | undefined): boolean =>
  !!t && (t.kind === "unit" || t.kind === "unit_or_base" || t.kind === "ref" || t.kind === "leader");
const traitsOf = (t: SwuTarget | undefined): string[] =>
  (t?.restrict ?? []).filter((r) => r.startsWith("trait:")).map((r) => r.slice(6).trim()).filter((r) => r !== "");
const KEYWORD_WANT = /\bwith (?:an? )?(Sentinel|Hidden|Shielded)\b/;
const asTarget = (w: unknown): SwuTarget | undefined => (typeof w === "object" && w !== null ? (w as SwuTarget) : undefined);
const keywordName = (k: string | { keyword: string }): string => (typeof k === "string" ? k : k.keyword);

/** Effects that cost the player something; a When Played made only of these is not worth replaying. */
const COSTLY_CATS = new Set(["self_defeat", "restriction", "cost_increase", "discard_self", "blank", "remove_keyword", "opponent_token", "self_exhaust", "mill"]);
const HARM_CATS = new Set(["damage", "indirect_damage", "defeat", "exhaust", "capture", "bounce"]);
const SELF_DISCARD = /\bdiscarded this way\b/i;
const ONE_SHOT_GRANT = /\bfor this (?:attack|phase|round)\b|\bthe next\b/i;
const SEARCH_OFFER: Record<string, string> = {
  deck_top: "offers:tutor-to-deck",
  play: "offers:tutor-to-play",
  discard: "offers:tutor-to-discard",
};

type TagInput = Omit<SwuCardFeatures, "tags">;

/** The effect categories of a When Played that give something worth getting again, or none. */
function replayWorthyCats(clauses: readonly SwuClause[]): string[] {
  const cats = new Set<string>();
  for (const c of clauses) {
    if (c.source === "none") continue;
    if (c.source === "curated" && c.effects.length === 0) cats.add("curated");
    for (const e of c.effects) {
      const side = pol(e.target);
      const hurtsYou = HARM_CATS.has(e.cat) && (side === "friendly" || side === "self");
      if (!COSTLY_CATS.has(e.cat) && !hurtsYou) cats.add(e.cat);
    }
  }
  return [...cats].sort(compareCodePoints);
}

/**
 * @displayName SWU offers/wants tag builder
 * @strategicPurpose Gives the pairing step a small vocabulary of what a card
 * supplies (offers:*) and what it needs (wants:*), with explicit polarity so a
 * sacrifice outlet is never confused with removal (LampaGJ/mault#325).
 * @tacticalObjective Derives tags only from classified clause features, rung-1
 * fields and curated entries; an unclassified clause contributes nothing. Each
 * tag carries the clause or rule that produced it.
 */
export function buildTags(card: TagInput): SwuCardFeatures["tags"] {
  const offers = new Map<string, string>();
  const wants = new Map<string, string>();
  const add = (m: Map<string, string>, tag: string, why: string): void => {
    if (!m.has(tag)) m.set(tag, why);
  };
  const s = card.structured;

  if (card.type === "Upgrade" || card.keywords.some((k) => k.keyword === "Piloting" && !k.granted)) {
    add(offers, "offers:upgrade-to-attach", "is an upgrade or Pilot");
  }
  for (const k of card.keywords) {
    if (k.granted) continue;
    if (k.keyword === "Grit") add(wants, "wants:self-damaged", "Grit");
    if (k.keyword === "Shielded") add(offers, "offers:give-shield-self", "Shielded");
  }

  for (const face of Object.keys(card.faces) as (keyof typeof card.faces)[]) {
    const nodes = card.faces[face];
    if (!nodes) continue;
    for (const { a, clauses, grantedBy } of walkAbilities(nodes, null)) {
      const wantsExtraAttacks = card.type !== "Event" && !(grantedBy && ONE_SHOT_GRANT.test(grantedBy.text));
      const replayCats = !a.granted && card.type === "Unit" ? replayWorthyCats(clauses) : [];
      for (const t of a.triggers) {
        const tt = t.text ?? "";
        if (t.trigger === "when_defeated" && (card.type === "Unit" || card.type === "Leader" || a.granted)) add(wants, "wants:self-defeated", `${face}: When Defeated`);
        if (t.trigger === "when_defeated" && card.type === "Unit" && !a.granted) add(offers, "offers:has-when-defeated", `${face}: When Defeated`);
        if (t.trigger === "when_played" && card.type === "Unit" && !a.granted) add(offers, "offers:has-when-played", `${face}: When Played`);
        if (/when you use a when defeated|when defeated ability/i.test(tt)) add(wants, "wants:when-defeated-cards", tt);
        if (/when played ability/i.test(tt)) add(wants, "wants:when-played-cards", tt);
        if (/friendly upgrade is defeated/i.test(tt)) add(wants, "wants:friendly-upgrade-defeated", tt);
        if (/enemy (?:[\w-]+ )*unit with an? weakness token/i.test(tt)) add(wants, "wants:enemy-weakened", tt);
        if (t.trigger === "when_played" && replayCats.length > 0) add(wants, "wants:replay-when-played", `${face}: When Played (${replayCats.join(", ")})`);
        if (wantsExtraAttacks && (t.trigger === "on_attack" || t.trigger === "attack_end" || t.trigger === "on_attack_kill")) add(wants, "wants:extra-attacks", `${face}: ${t.trigger}`);
        if (t.trigger === "action" && t.cost?.exhaust && card.type !== "Leader") add(wants, "wants:ready-unit", `${face}: Action [Exhaust]`);
        if (/friendly unit is defeated|friendly .*unit is defeated/i.test(tt)) add(wants, "wants:friendly-unit-defeated", tt);
        if (/enemy unit is defeated|unit .* among enemy units is defeated/i.test(tt)) add(wants, "wants:enemy-unit-defeated", tt);
        if (/dealt damage and survives|damage is dealt to (?:this unit|a friendly)|non-combat damage is dealt to a friendly/i.test(tt)) add(wants, "wants:damage-friendly", tt);
        if (/you play or create a unit/i.test(tt)) add(wants, "wants:units-entering", tt);
        else if (/you play another .*unit|you play a .*unit/i.test(tt)) add(wants, "wants:units-played", tt);
        if (/pilot .*attaches/i.test(tt)) add(wants, "wants:pilot-attached", tt);
        else if (/upgrade attaches|you play an upgrade on/i.test(tt)) add(wants, "wants:upgrades-attached", tt);
        if (/use the force/i.test(tt) || t.cost?.force) add(wants, "wants:the-force", tt);
        if (/\bopponent draws? \d+ or more cards/i.test(tt)) add(wants, "wants:opponent-draws", tt);
        else if (/draws? \d+ or more cards/i.test(tt)) add(wants, "wants:draw", tt);
        if (/heal/i.test(tt)) add(wants, "wants:heal", tt);
        if (/initiative/i.test(tt)) add(wants, "wants:initiative", tt);
        if (/discard/i.test(tt.replace(/\[[^\]]*\]/g, ""))) add(wants, "wants:discard-own", tt);
        if (/friendly .*unit attacks|friendly unit's attack ends/i.test(tt)) add(wants, "wants:extra-attacks", tt);
        if (/play a card from your resources/i.test(tt)) add(wants, "wants:resource-ramp", tt);
        if (/deploy a leader/i.test(tt)) add(wants, "wants:leader-deployed", tt);
      }
      for (const c of clauses) {
        if (c.source === "none") continue;
        for (const o of c.offers ?? []) add(offers, o, `curated ${c.curatedId}`);
        for (const w of c.wants ?? []) add(wants, w, `curated ${c.curatedId}`);
        const clauseWhy = `${face}: ${c.text}`;
        if (/when played ability/i.test(c.text)) add(wants, "wants:when-played-cards", clauseWhy);
        if (/\b(?:dealt damage to an enemy base this phase|enemy base was damaged this phase)/i.test(c.text)) add(wants, "wants:enemy-base-damaged", clauseWhy);
        if (/\benemy (?:[\w-]+ )*unit with an? weakness token/i.test(c.text)) add(wants, "wants:enemy-weakened", clauseWhy);
        if (/\bexhausted enemy\b|\benemy (?:[\w-]+ )*units? (?:is|are) exhausted\b/i.test(c.text)) add(wants, "wants:exhausted-enemy", clauseWhy);
        const createsToken = c.effects.some((x) => x.cat === "create_token");
        for (const e of c.effects) {
          const target = e.target;
          const p = pol(target);
          const why = `${face}: ${c.text}`;
          const keywordWant = KEYWORD_WANT.exec(target?.text ?? "");
          if (keywordWant !== null && p !== "enemy") add(wants, `wants:keyword-${keywordWant[1].toLowerCase()}`, why);
          if (target?.kind === "resource") continue;
          const selfGated = e.conditional === true && (p === "self" || p === "ref") && c.conditions.some((k) => k.cat === "self_state");
          const offersBefore = new Set(offers.keys());
          switch (e.cat) {
            case "defeat":
              if (a.granted && a.triggers.some((x) => x.trigger === "when_defeated")) break;
              if (target?.kind === "upgrade" || (target?.kind === "token" && /\b(?:experience|shield|advantage|weakness)\b/i.test(target.text))) {
                add(offers, p === "friendly" ? "offers:defeat-own-upgrade" : "offers:defeat-upgrade", why);
              } else if (isUnitKind(target) || target?.kind === "token") {
                if (p === "friendly") add(offers, "offers:defeat-friendly-unit", why);
                else if (p === "enemy") add(offers, "offers:defeat-enemy-unit", why);
                else if (p === "any") add(offers, "offers:defeat-any-unit", why);
                if (target?.kind === "token" && /credit/i.test(target.text)) add(wants, "wants:credit-tokens", why);
              }
              break;
            case "self_defeat": add(offers, "offers:defeat-self", why); break;
            case "damage":
            case "indirect_damage":
              if (p === "ref" && createsToken) break;
              if (target?.kind === "player") break;
              if (target?.kind === "base") add(offers, p === "friendly" || p === "self" ? "offers:damage-own-base" : "offers:damage-enemy-base", why);
              else if (target?.kind === "unit_or_base" && (p === "friendly" || p === "enemy")) {
                add(offers, p === "friendly" ? "offers:damage-own-base" : "offers:damage-enemy-base", why);
                add(offers, p === "friendly" ? "offers:damage-friendly-unit" : "offers:damage-enemy-unit", why);
              }
              else if (p === "friendly" || p === "self") add(offers, "offers:damage-friendly-unit", why);
              else if (p === "enemy") add(offers, "offers:damage-enemy-unit", why);
              else add(offers, "offers:damage-any-unit", why);
              break;
            case "heal": add(offers, "offers:heal", why); break;
            case "draw": add(offers, "offers:draw", why); break;
            case "search": add(offers, SEARCH_OFFER[e.dest ?? ""] ?? "offers:tutor", why); break;
            case "discard_self": add(offers, "offers:discard-own", why); break;
            case "discard_opponent": add(offers, "offers:discard-opponent", why); break;
            case "mill": add(offers, e.whose === "your" ? "offers:self-mill" : "offers:mill-opponent", why); break;
            case "recursion": add(offers, "offers:return-from-discard", why); if (!SELF_DISCARD.test(c.text)) add(wants, "wants:cards-in-discard", why); break;
            case "create_token": {
              const token = e.token ?? "";
              if (token === "" || token.toLowerCase() === "token") break;
              if (UNIT_TOKENS.has(token)) add(offers, "offers:create-token-units", why);
              else if (token === "Credit") add(offers, "offers:credit-tokens", why);
              else if (token === "Force") add(offers, "offers:the-force", why);
              else add(offers, `offers:create-${token.toLowerCase()}-token`, why);
              break;
            }
            case "give_token":
              for (const [tok] of e.tokens ?? []) {
                const tp = p === "enemy" ? "enemy" : p === "self" ? "self" : "friendly";
                if (tok === "Experience") add(offers, `offers:give-experience${tp === "friendly" ? "" : `-${tp}`}`, why);
                else if (tok === "Shield") add(offers, `offers:give-shield${tp === "friendly" ? "" : `-${tp}`}`, why);
                else if (tok === "Weakness") {
                  const opponentPicks = p === "ref" && clauses.some((x) => /\bopponent chooses\b/i.test(x.text));
                  add(offers, tp === "enemy" || opponentPicks ? "offers:give-weakness-enemy" : p === "friendly" || p === "self" ? "offers:give-weakness-own" : "offers:give-weakness", why);
                }
                else add(offers, `offers:give-${tok.toLowerCase()}`, why);
              }
              break;
            case "gain_force": add(offers, "offers:the-force", why); break;
            case "ready": if (p !== "enemy" && p !== "self" && (!target || isUnitKind(target))) add(offers, "offers:ready-unit", why); break;
            case "exhaust": add(offers, p === "friendly" ? "offers:exhaust-own" : p === "enemy" ? "offers:exhaust-enemy" : "offers:exhaust-any", why); break;
            case "self_exhaust": add(offers, "offers:exhaust-own", why); break;
            case "bounce": add(offers, target?.kind === "upgrade" ? "offers:return-upgrade" : p === "friendly" || p === "self" ? "offers:return-own-to-hand" : p === "enemy" ? "offers:bounce-enemy" : "offers:return-any-to-hand", why); break;
            case "play_extra": {
              const zone = e.zone ?? "";
              if (/discard/.test(zone)) { add(offers, "offers:play-from-discard", why); if (!SELF_DISCARD.test(c.text)) add(wants, "wants:cards-in-discard", why); }
              else if (/resources/.test(zone)) add(offers, "offers:play-from-resources", why);
              else add(offers, "offers:cheat-play", why);
              if (/(?<!non-)\bunits?\b/.test(typeof e.what === "string" ? e.what : "")) add(offers, "offers:units-entering", why);
              break;
            }
            case "ramp": add(offers, "offers:resource-ramp", why); break;
            case "ready_resource": add(offers, "offers:resource-ramp", why); break;
            case "extra_attack": add(offers, "offers:extra-attack", why); break;
            case "take_initiative": add(offers, "offers:initiative", why); break;
            case "capture": add(offers, p === "friendly" ? "offers:capture-own" : "offers:capture", why); break;
            case "stat_mod": if (e.sign === "buff" && p !== "enemy") add(offers, "offers:buff", why); break;
            case "grant_keyword":
              for (const k of e.keywords ?? []) if (p !== "enemy") add(offers, `offers:grant-${keywordName(k).toLowerCase()}`, why);
              break;
            case "attach": if (e.rule === "attach_self") add(offers, "offers:upgrade-to-attach", why); break;
            case "cost_reduction": if (/credit/i.test(c.text)) add(wants, "wants:credit-tokens", why); break;
            default: break;
          }
          if (selfGated) for (const k of [...offers.keys()]) if (!offersBefore.has(k)) offers.delete(k);
          const restr = target?.restrict ?? [];
          if (restr.includes("damaged") && p !== "enemy") add(wants, "wants:damaged-units", why);
          if (restr.includes("exhausted") && target && FRIENDLYISH.has(target.side)) add(wants, "wants:exhausted-own", why);
          if ((target && FRIENDLYISH.has(target.side)) || (target?.side === "any" && e.cat !== "damage" && e.cat !== "defeat")) {
            for (const tr of traitsOf(target)) add(wants, `wants:trait-${tr}`, why);
          }
          if (target?.kind === "token" && target && FRIENDLYISH.has(target.side)) add(wants, "wants:tokens", why);
        }
        for (const k of c.conditions) {
          const why = `${face}: ${c.text}`;
          if (k.cat === "control") {
            const what = asTarget(k.what);
            for (const tr of traitsOf(what)) add(wants, `wants:trait-${tr}`, why);
            if (what?.kind === "token" || /token/i.test(what?.text ?? "")) add(wants, "wants:tokens", why);
            if (what?.restrict.includes("damaged")) add(wants, "wants:damaged-units", why);
            if (what?.restrict.includes("exhausted")) add(wants, "wants:exhausted-own", why);
            if (/upgrade/i.test(what?.text ?? "")) add(wants, "wants:upgrades-attached", why);
            if (typeof k.n === "number" && k.n >= 2) add(wants, "wants:wide-board", why);
          }
          if (k.cat === "target_check" && k.check === "attached_is") for (const tr of traitsOf(asTarget(k.what))) add(wants, `wants:trait-${tr}`, why);
          if (k.cat === "control_resources" && face !== "epicAction") add(wants, "wants:resource-ramp", why);
          if (k.cat === "initiative") add(wants, "wants:initiative", why);
          if (k.cat === "force") add(wants, "wants:the-force", why);
          const state = k.state ?? "";
          if (k.cat === "self_state" && /damaged$|^damaged/.test(state) && state !== "undamaged") add(wants, "wants:self-damaged", why);
          if (k.cat === "self_state" && state === "upgraded") add(wants, "wants:upgrades-attached", why);
          if (k.cat === "self_state" && state === "exhausted") add(wants, "wants:exhausted-own", why);
          if (k.cat === "event_this_phase" && /friendly[^,]*defeated/i.test(c.text)) add(wants, "wants:friendly-unit-defeated", why);
          if (k.cat === "event_this_phase" && /enemy[^,]*defeated/i.test(c.text)) add(wants, "wants:enemy-unit-defeated", why);
          if (k.cat === "scaling") {
            const per = (k.per ?? "").toLowerCase();
            if (/damage on (?:your|a friendly) base/.test(per)) add(wants, "wants:own-base-damaged", why);
            else if (/damage on/.test(per)) add(wants, "wants:self-damaged", why);
            if (/damaged/.test(per)) add(wants, "wants:damaged-units", why);
            if (/upgrade|experience|shield/.test(per)) add(wants, "wants:upgrades-attached", why);
            if (/token/.test(per)) add(wants, "wants:tokens", why);
            if (/card in your hand|cards in your hand/.test(per)) add(wants, "wants:cards-in-hand", why);
            if (/discard pile/.test(per)) add(wants, "wants:cards-in-discard", why);
            if (/(?:other )?friendly .*units?|unit you control/.test(per)) add(wants, "wants:wide-board", why);
            if (/resource/.test(per)) add(wants, "wants:resource-ramp", why);
            if (/exhausted/.test(per)) add(wants, "wants:exhausted-own", why);
          }
        }
        for (const st of c.structure) {
          if (st.cat === "force_cost") add(wants, "wants:the-force", `${face}: ${c.text}`);
          if (st.cat === "select" && st.target && FRIENDLYISH.has(st.target.side)) for (const tr of traitsOf(st.target)) add(wants, `wants:trait-${tr}`, `${face}: ${c.text}`);
          if (st.cat === "attach_restriction") for (const tr of traitsOf(st.target)) add(wants, `wants:trait-${tr}`, `${face}: ${c.text}`);
        }
      }
    }
  }
  if (offers.has("offers:defeat-friendly-unit")) add(wants, "wants:sac-fodder", "defeats your own units");
  if (card.type === "Unit" || card.type === "Token Unit") for (const tr of s.traits) add(offers, `offers:is-trait-${tr}`, "printed trait");
  const asList = (m: Map<string, string>): { tag: string; why: string }[] =>
    [...m.keys()].sort(compareCodePoints).map((tag) => ({ tag, why: m.get(tag) as string }));
  return { offers: asList(offers), wants: asList(wants) };
}

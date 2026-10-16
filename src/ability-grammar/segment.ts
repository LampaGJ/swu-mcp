import type { SwuActionCost, SwuKeyword, SwuRepeatClass, SwuTrigger } from "./deps.js";
import { KW_ALT } from "./vocab.js";

const ASPECT_RUN = "(?:Aggression|Command|Cunning|Heroism|Vigilance|Villainy)";

/**
 * @displayName SWU ability-text normalizer
 * @strategicPurpose Gives every later rung one spelling of the printed text,
 * so a pattern written once matches every card.
 * @tacticalObjective NFC, straight quotes, ASCII minus before a number or X,
 * the unique marker as a word, bullets as line breaks, and concatenated
 * Disclose icons split by a space.
 */
export function normalizeText(raw: string | null | undefined): string {
  if (raw == null) return "";
  return raw
    .normalize("NFC")
    .replace(/\r/g, "")
    .replace(/non-<uq>\s*\(non-unique\)/g, "non-unique")
    .replace(/<uq>\s*\(unique\)/g, "unique")
    .replace(/non-<uq>/g, "non-unique")
    .replace(/<uq>/g, "unique")
    .replace(/<bullet>/g, "\n")
    .replace(/[‘’]/g, "'")
    .replace(/[–−](?=\d|X)/g, "-")
    .replace(new RegExp(`(${ASPECT_RUN})(?=${ASPECT_RUN})`, "g"), "$1 ")
    .replace(/[ \t]+/g, " ");
}

/** Reminder text is parenthesised; it is removed before parsing. */
export function stripReminders(s: string): { text: string; removed: number } {
  let out = "";
  let depth = 0;
  let removed = 0;
  for (const ch of s) {
    if (ch === "(") {
      depth++;
      removed++;
      continue;
    }
    if (ch === ")" && depth > 0) {
      depth--;
      continue;
    }
    if (depth === 0) out += ch;
  }
  return { text: out.replace(/\s+([.,;:])/g, "$1").replace(/\s{2,}/g, " ").trim(), removed };
}

/**
 * Pulls curly-quoted granted abilities out of a paragraph, replacing each with
 * a ⟦G<n>⟧ slot. A short quote with no colon is a reference, not a grant, and
 * stays inline.
 */
export function extractGranted(p: string): { body: string; granted: string[] } {
  const granted: string[] = [];
  let out = "";
  let i = 0;
  while (i < p.length) {
    const ch = p[i];
    if (ch === "“") {
      const j = p.indexOf("”", i + 1);
      const end = j === -1 ? p.length : j;
      const q = p.slice(i + 1, end).trim();
      if (!q.includes(":") && q.length < 40) {
        out += q;
        i = end + 1;
        continue;
      }
      granted.push(q);
      out += `⟦G${granted.length - 1}⟧`;
      i = end + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return { body: out, granted };
}

/** A header is the text before the first colon, when it is one phrase and the colon does not open a quoted ability. */
export function splitHeader(p: string): { header: string | null; body: string } {
  const k = p.indexOf(":");
  if (k <= 0 || k > 120) return { header: null, body: p };
  const head = p.slice(0, k).trim();
  const rest = p.slice(k + 1).trim();
  if (/[.!?]\s/.test(head) || head.includes("⟦")) return { header: null, body: p };
  if (rest.startsWith("⟦G")) return { header: null, body: p };
  if (rest === "") return { header: null, body: p };
  return { header: head, body: rest };
}

export function splitSentences(body: string): string[] {
  return body
    .split(/(?<=[.!?])\s+(?=[A-Z⟦"])|(?<=:)\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^[.,;:]+$/.test(s));
}

type TriggerId = SwuTrigger["trigger"];

const TRIGGER_RULES: readonly (readonly [RegExp, TriggerId, SwuRepeatClass | null])[] = [
  [/^When Played$/i, "when_played", "once_on_play"],
  [/^When played as a unit$/i, "when_played", "once_on_play"],
  [/^When (?:played|deployed) as an upgrade$/i, "when_played_as_upgrade", "once_on_play"],
  [/^On Attack$/i, "on_attack", "per_attack"],
  [/^On Defense$/i, "on_defense", "per_defense"],
  [/^When this unit is attacked$/i, "on_defense", "per_defense"],
  [/^When attached unit is attacked$/i, "on_defense", "per_defense"],
  [/^When Defeated$/i, "when_defeated", "once_on_defeat"],
  [/^When Attack Ends$/i, "attack_end", "per_attack"],
  [/^When (?:this|attached) unit completes an attack$/i, "attack_end", "per_attack"],
  [/^When this unit attacks and defeats a unit$/i, "on_attack_kill", "per_attack"],
  [/^When this unit deals combat damage to (?:a|an opponent's) base$/i, "on_base_hit", "per_attack"],
  [/^When Deployed$/i, "when_deployed", "once_on_play"],
  [/^Epic Action(?: \[(.*)\])?$/i, "epic_action", "once_per_game"],
  [/^Action(?: \[(.*)\])?$/i, "action", null],
  [/^When the (?:regroup|first action) phase starts$/i, "phase_start", "per_round"],
  [/^At the (?:start|end) of /i, "phase_start", "per_round"],
  [/^When you take the initiative$/i, "take_initiative", "per_round"],
  [/^When (?:a|another) friendly .*$/i, "reactive_friendly", "per_event"],
  [/^When (?:an )?(?:enemy|opponent).*$|^When an opponent .*$/i, "reactive_opponent", "per_event"],
  [/^When (?:this|attached) (?:unit|upgrade) .*$/i, "reactive_self", "per_event"],
  [/^When you .*$/i, "reactive_you", "per_event"],
  [/^When .*$/i, "reactive_other", "per_event"],
];

export function parseActionCost(costText: string | undefined): SwuActionCost {
  const c: SwuActionCost = { exhaust: false, resources: 0, force: false, other: [] };
  if (!costText) return c;
  for (const part of costText.split(/,\s*/)) {
    const p = part.trim();
    let m: RegExpMatchArray | null;
    if (/^exhaust$/i.test(p)) c.exhaust = true;
    else if ((m = p.match(/^(\d+) resources?$/i))) c.resources = Number(m[1]);
    else if (/^use the force$/i.test(p)) c.force = true;
    else c.other.push(p);
  }
  return c;
}

/** Splits a compound header on "/" and maps each part to a trigger and a repeat class. */
export function parseHeader(header: string): SwuTrigger[] {
  const triggers: SwuTrigger[] = [];
  for (const part of header.split("/").map((s) => s.trim())) {
    let hit: SwuTrigger | null = null;
    for (const [re, id, repeat] of TRIGGER_RULES) {
      const m = part.match(re);
      if (!m) continue;
      if (id === "action" || id === "epic_action") {
        const cost = parseActionCost(m[1]);
        const rep: SwuRepeatClass = id === "epic_action" ? "once_per_game" : cost.exhaust ? "per_round" : "repeatable_paid";
        hit = { trigger: id, repeat: rep, cost, text: part };
      } else hit = { trigger: id, repeat: repeat ?? "unknown", text: part };
      break;
    }
    triggers.push(hit ?? { trigger: "unknown_header", repeat: "unknown", text: part });
  }
  return triggers;
}

export const KW_ITEM = `(?:${KW_ALT})(?: \\d+| \\[[^\\]]*\\])?`;
const KW_LINE = new RegExp(`^(?:${KW_ITEM})(?:(?:,| and|, and) (?:${KW_ITEM}))*\\.?$`);
const KW_ITEM_G = new RegExp(`(${KW_ALT})(?: (\\d+)| \\[([^\\]]*)\\])?`, "g");

export function parseKeywordList(s: string): SwuKeyword[] {
  const out: SwuKeyword[] = [];
  for (const m of s.matchAll(KW_ITEM_G)) {
    const k: SwuKeyword = { keyword: m[1] };
    if (m[2] != null) k.n = Number(m[2]);
    if (m[3] != null) {
      k.cost = m[3];
      const r = m[3].match(/(\d+) resources?/);
      if (r) k.n = Number(r[1]);
    }
    out.push(k);
  }
  return out;
}

export function isKeywordLine(s: string): boolean {
  return KW_LINE.test(s);
}

import { z } from "zod";
import { compareCodePoints } from "../swu/canonical.js";
import type { SleeperSim } from "./sleepers-schema.js";

/**
 * @displayName Sleeper-card simulator view
 * @strategicPurpose Pilot sensitivity for the sleeper report (LampaGJ/swu-mcp#184): does a card's value in the
 * owner's deck change when a stronger computer pilot plays it? Computer play is its own tier (decision D21): it is
 * shown beside tournament figures, never pooled with them.
 * @tacticalObjective Parses the pinned swap records (data/pinned/sim-ladder-v1/warrior-deck-*.json), turns each
 * swap into a paired effect (variant wins minus base wins on the same seeds, normal interval from the discordant
 * pairs), and, where the same swap ran under the rules bot and a lookahead bot, their difference.
 */

const share = z.looseObject({ wins: z.number().int(), n: z.number().int().positive() });
const paired = z.looseObject({ baseOnly: z.number().int().nonnegative(), variantOnly: z.number().int().nonnegative(), pValue: z.number() });

export const simRecordSchema = z.looseObject({
  label: z.string(),
  policy: z.looseObject({ spec: z.string(), rung: z.number().int() }),
  results: z.array(z.looseObject({ name: z.string(), swaps: z.array(z.string()), share, vsFirst: paired.nullable() })),
});
export type SimRecord = z.infer<typeof simRecordSchema>;

export const SIM_LABEL =
  "computer play (forceteki rules engine, scripted bots), not human results; never pooled with tournament figures (D21)";
export const SIM_CAVEAT =
  "The lookahead bots (rung 3 and rung3v) see the opponent's hidden cards inside their trial games (issue #183), so their figures are biased, probably against cards that rely on surprise. The rules bot (rung 1) has no lookahead and is not affected.";
const Z95 = 1.959964;
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4 || 0;

const pilotOf = (rec: SimRecord): { pilot: string; kind: "rules" | "lookahead" } =>
  rec.policy.rung <= 1
    ? { pilot: `rules bot (${rec.policy.spec})`, kind: "rules" }
    : { pilot: `lookahead bot (${rec.policy.spec})`, kind: "lookahead" };

/** Effect of a swap on the same seeds: (variantOnly - baseOnly) / n with the paired-difference variance. */
export function pairedEffect(baseOnly: number, variantOnly: number, n: number): { effect: number; se: number } {
  const d = (variantOnly - baseOnly) / n;
  const variance = Math.max(0, (baseOnly + variantOnly) / n - d * d) / n;
  return { effect: d, se: Math.sqrt(variance) };
}

export function simulatorView(
  records: readonly { name: string; sha256: string; record: SimRecord }[],
  cardKeyOf: (setNumber: string) => string | undefined,
  deck: string,
  opponents: string,
): SleeperSim {
  type Effect = SleeperSim["cards"][string]["effects"][number];
  interface Raw {
    sig: string;
    kind: "rules" | "lookahead";
    pilot: string;
    experiment: string;
    effect: number;
    se: number;
  }
  const cards = new Map<string, { effects: Effect[]; raw: Raw[] }>();
  for (const { record } of records) {
    const { pilot, kind } = pilotOf(record);
    for (const r of record.results) {
      if (r.vsFirst === null || r.swaps.length === 0) continue;
      const { effect, se } = pairedEffect(r.vsFirst.baseOnly, r.vsFirst.variantOnly, r.share.n);
      const sig = [...r.swaps].sort(compareCodePoints).join(",");
      const roles = new Map<string, { role: "added" | "removed"; copies: number }>();
      for (const swap of r.swaps) {
        const [out, into] = swap.split(">");
        for (const [id, role] of [
          [out, "removed"],
          [into, "added"],
        ] as const) {
          const key = cardKeyOf(id);
          if (key === undefined) continue;
          const tag = `${key}\u0000${role}`;
          const cur = roles.get(tag) ?? { role, copies: 0 };
          cur.copies += 1;
          roles.set(tag, cur);
        }
      }
      for (const [tag, { role, copies }] of roles) {
        const key = tag.split("\u0000")[0];
        const entry = cards.get(key) ?? { effects: [], raw: [] };
        entry.effects.push({
          experiment: r.name,
          role,
          copies,
          swaps: r.swaps,
          pilot,
          pilotKind: kind,
          effect: r4(effect),
          low: r4(effect - Z95 * se),
          high: r4(effect + Z95 * se),
          games: r.share.n,
          pValue: r.vsFirst.pValue,
        });
        entry.raw.push({ sig: `${sig}|${role}`, kind, pilot, experiment: r.name, effect, se });
        cards.set(key, entry);
      }
    }
  }
  const out: SleeperSim["cards"] = {};
  for (const key of [...cards.keys()].sort(compareCodePoints)) {
    const { effects, raw } = cards.get(key) as { effects: Effect[]; raw: Raw[] };
    const pilotSensitivity: SleeperSim["cards"][string]["pilotSensitivity"] = [];
    for (const rules of raw.filter((x) => x.kind === "rules")) {
      for (const look of raw.filter((x) => x.kind === "lookahead" && x.sig === rules.sig)) {
        const value = look.effect - rules.effect;
        const se = Math.sqrt(look.se ** 2 + rules.se ** 2);
        pilotSensitivity.push({
          experiment: rules.experiment,
          lookahead: look.pilot,
          value: r4(value),
          low: r4(value - Z95 * se),
          high: r4(value + Z95 * se),
        });
      }
    }
    out[key] = { effects, pilotSensitivity };
  }
  return {
    label: SIM_LABEL,
    caveat: SIM_CAVEAT,
    deck,
    opponents,
    records: Object.fromEntries(records.map((r) => [r.name, r.sha256]).sort((a, b) => compareCodePoints(a[0], b[0]))),
    cards: out,
  };
}

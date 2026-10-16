import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { complementarityTableSchema, type ComplementarityTable, type SynergyCard } from "../../src/synergy/schema.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The committed table, parsed exactly as the run parses it. */
export const COMMITTED_TABLE: ComplementarityTable = complementarityTableSchema.parse(
  JSON.parse(readFileSync(path.join(REPO_ROOT, "data/complementarity.json"), "utf8")),
);

interface CardSpec {
  type?: string;
  cost?: number | null;
  aspects?: string[];
  icons?: string[];
  traits?: string[];
  offers?: string[];
  wants?: string[];
  /** One ability per entry: repeat class, clause text, optional effect magnitude. */
  abilities?: { repeat: string; text: string; n?: number | string; trigger?: string; triggerText?: string }[];
  /** Tag -> why, when the test needs the origin lookup to find an ability. */
  why?: Record<string, string>;
  subtitle?: string | null;
}

export function mk(cardKey: string, title: string, spec: CardSpec = {}): SynergyCard {
  const aspects = spec.aspects ?? [];
  return {
    cardKey,
    title,
    subtitle: spec.subtitle ?? null,
    type: spec.type ?? "Unit",
    structured: { cost: spec.cost === undefined ? 2 : spec.cost, aspects, aspectIcons: spec.icons ?? aspects, traits: spec.traits ?? [] },
    faces: {
      text: (spec.abilities ?? []).map((a) => ({
        kind: "ability",
        repeat: a.repeat,
        triggers: a.trigger === undefined ? [] : [{ trigger: a.trigger, text: a.triggerText }],
        clauses: [{ text: a.text, effects: a.n === undefined ? [] : [{ n: a.n }], conditions: [] }],
        options: [],
        grantedAbilities: [],
      })),
    },
    tags: {
      offers: (spec.offers ?? []).map((tag) => ({ tag, why: spec.why?.[tag] ?? "x" })),
      wants: (spec.wants ?? []).map((tag) => ({ tag, why: spec.why?.[tag] ?? "x" })),
    },
  };
}

/** A two-row table, so trio shapes can be built from named tags without the committed weights. */
export function table(
  rows: { id: string; offers: Record<string, number>; wants: Record<string, number>; strength?: number }[],
): ComplementarityTable {
  return complementarityTableSchema.parse({
    schemaVersion: 1,
    tableVersion: 1,
    rows: rows.map((r) => ({ ...r, strength: r.strength ?? 1, reason: `${r.id} reason`, example: null })),
  });
}

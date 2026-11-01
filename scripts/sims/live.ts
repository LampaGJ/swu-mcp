/**
 * @displayName Live stats writer helpers
 * @strategicPurpose One place that turns a policy spec and a seed range into the provenance block and the heartbeat
 * options every sims writer shares (#178 of #104), so the four writers cannot drift apart.
 * @tacticalObjective provenanceOf reads the policy header (src/sims/policies/index.ts policyHeader) for the name and
 * params hash; KEEP_ALIVE_MS keeps a long pool batch from reading as a stalled job in sims:watch. Nothing here reaches a
 * pinned record: the payload goes to the heartbeat only.
 */
import type { Provenance } from "../../src/sims/live-stats.js";
import { parsePolicySpec, policyHeader } from "../../src/sims/policies/index.js";

/** A rung 3 batch of 480 games takes minutes between ticks; the keepalive rewrites the latest heartbeat on this interval. */
export const KEEP_ALIVE_MS = 15_000;

export function provenanceOf(o: { specs: readonly string[]; seeds?: { from: number; to: number } | null; enginePin?: string | null; codeCommit?: string | null; run?: string | null }): Provenance {
  return {
    policies: [...new Set(o.specs)].map((s) => {
      const h = policyHeader(parsePolicySpec(s));
      return { name: h.spec, paramsSha256: h.paramsSha256 };
    }),
    seeds: o.seeds ?? null,
    enginePin: o.enginePin ?? null,
    codeCommit: o.codeCommit ?? null,
    run: o.run ?? null,
  };
}

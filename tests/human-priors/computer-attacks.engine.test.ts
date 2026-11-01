import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadContext, DEFAULT_ORIGINALS, DEFAULT_RUN, type SimContext } from "../../scripts/sims/context.js";
import { prepareDeck } from "../../scripts/sims/decks.js";
import { attackEventSchema, type AttackEvent } from "../../scripts/human-priors/attack-patterns.js";
import { registerRecorder } from "../../scripts/human-priors/computer-attacks.js";
import { REPO_ROOT } from "../../src/paths.js";
import { DEFAULT_FORCETEKI } from "../../src/sims/engine-pin.js";
import { playMatch, type DeckInput, type MatchSpec } from "../../src/sims/match.js";
import { POLICIES, PolicyChain } from "../../src/sims/policy.js";
import { loadTables } from "../../src/sims/policies/tables.js";
import { registerRungs } from "../../src/sims/policies/typed-adapter.js";

/** [engine] The computer-play attack recorder (#181) observes rung 1 without changing a single choice. */

const hasEngine = existsSync(path.join(DEFAULT_FORCETEKI, "build/server/game/core/Game.js")) && existsSync(path.join(DEFAULT_RUN, "replay.json")) && existsSync(DEFAULT_ORIGINALS);

describe.skipIf(!hasEngine)("[engine] computer-play attack recorder", () => {
  let ctx: SimContext;
  let decks: [DeckInput, DeckInput];
  let tables: ReturnType<typeof loadTables>;
  beforeAll(() => {
    ctx = loadContext({ forceteki: DEFAULT_FORCETEKI, run: DEFAULT_RUN, originals: DEFAULT_ORIGINALS, "no-memo": false });
    tables = loadTables({ runDir: DEFAULT_RUN, complementarity: path.join(REPO_ROOT, "data/complementarity.json"), pairs: false });
    const deck = (rel: string) => prepareDeck(ctx.bridge, JSON.parse(readFileSync(path.join(REPO_ROOT, rel), "utf8")), "file:" + rel);
    decks = [deck("tests/fixtures/decks/warrior-chewie-raid.swudb.json"), deck("data/originals/decks/2026-10-17/melee-6563300e-ae56-49d6-b88c-b3ea0151a4da.json")];
  }, 60_000);

  it("plays rung 1's exact trace and writes strict attack events with both boards", { timeout: 120_000 }, async () => {
    const spec: MatchSpec = { seed: "185", decks, policies: ["rung1", "rung1"], recordMode: "compact", undo: false, codeCommit: "test" };
    delete POLICIES.rung1;
    registerRungs(POLICIES, (ps) => new PolicyChain(ps as never), ["rung1"], tables);
    const plain = await playMatch(ctx.engine, spec, ctx.bridge.engineCardKeys);
    const events: { e: Omit<AttackEvent, "won">; seat: 1 | 2 }[] = [];
    const open: { flush: () => void }[] = [];
    registerRecorder(tables, () => "g185", (e, seat) => events.push({ e, seat }), (r) => open.push(r));
    const recorded = await playMatch(ctx.engine, spec, ctx.bridge.engineCardKeys);
    for (const r of open) r.flush();
    delete POLICIES.rung1;
    expect(recorded.record.footer.traceSha256).toBe(plain.record.footer.traceSha256);
    expect(events.length).toBeGreaterThan(3);
    for (const { e } of events) expect(attackEventSchema.safeParse({ ...e, won: 1 }).success).toBe(true);
    expect(events.filter(({ e }) => e.after !== null).length).toBeGreaterThan(events.length / 2);
    expect(new Set(events.map(({ seat }) => seat))).toEqual(new Set([1, 2]));
  });
});

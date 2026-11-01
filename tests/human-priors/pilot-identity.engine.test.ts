import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadContext, DEFAULT_ORIGINALS, DEFAULT_RUN, type SimContext } from "../../scripts/sims/context.js";
import { prepareDeck } from "../../scripts/sims/decks.js";
import { REPO_ROOT } from "../../src/paths.js";
import { DEFAULT_FORCETEKI } from "../../src/sims/engine-pin.js";
import { playMatch, replayMatch, type DeckInput, type MatchSpec } from "../../src/sims/match.js";
import { humanPolicy, loadPriors, priorsDir } from "../../scripts/human-priors/pilot.js";
import type { LookaheadCounters } from "../../src/sims/policies/rung3.js";
import { POLICIES, PolicyChain } from "../../src/sims/policy.js";
import { parsePolicySpec, policyHeader } from "../../src/sims/policies/index.js";
import { inputsOf, registerRungs } from "../../src/sims/policies/typed-adapter.js";
import { loadTables } from "../../src/sims/policies/tables.js";

/**
 * [engine] The human-trained pilot (#181, D104) must leave every existing policy as it was: these trace hashes and
 * parameter hashes were taken from main before the pilot's code existed, and must not move.
 */

const hasPriors = existsSync(path.join(priorsDir(1), "manifest.json"));
const hasEngine = existsSync(path.join(DEFAULT_FORCETEKI, "build/server/game/core/Game.js")) && existsSync(path.join(DEFAULT_RUN, "replay.json")) && existsSync(DEFAULT_ORIGINALS);

const TRACES: [string, [string, string], string][] = [
  ["181", ["rung3:k=3", "rung1"], "2f53ef8d85b4ce755ccd6898fa1099ba3c25b535422a86014be1f0eabf1f48d5"],
  ["182", ["rung3:k=8,sacGuard=1,handCap=1", "rung1:sacGuard=1,handCap=1"], "18643472d2b12057e597e3b92b53940cf099aeb59dc6c71bddf8a77914592ad7"],
  ["183", ["rung1", "rung0"], "35457bb216362d78528a4706d7e41ab4a97ee038f52121461c8f053338bd300a"],
];
const PARAMS: [string, string][] = [
  ["rung3:k=3", "2134975cb5f9d1d9780de53526aeecc9796dee996ad44e0ea1d6c1063e746c4f"],
  ["rung3:k=8", "15de7a05de373f65de29a3ccd4de4c691422b47176b5f80065ed546d5efbc856"],
  ["rung3:k=8,sacGuard=1,handCap=1", "475e84415283492ce95b193c0e79c303b95636e8dd59f2d49ec9d5c681d8b5c3"],
  ["rung1", "587af70cb95bb0e4512c2a0154955f47d1ee0f0d9ce65c71194918ada9c46a07"],
  ["rung3v:k=8,ev=v1,horizon=round,noPass=1", "83404ab2dd4f78aa2ca85a0c5f3d3706ce5c73bd8c1713f6747ee1fe7df15682"],
];

describe("existing policy identity (#181)", () => {
  it.each(PARAMS)("%s keeps its params hash", (name, sha) => {
    expect(policyHeader(parsePolicySpec(name)).paramsSha256).toBe(sha);
  });
});

describe.skipIf(!hasEngine)("[engine] existing policy traces are unchanged by the human-trained pilot (#181)", () => {
  let ctx: SimContext;
  let warrior: DeckInput;
  let cadBane: DeckInput;
  let tables: ReturnType<typeof loadTables>;
  beforeAll(() => {
    ctx = loadContext({ forceteki: DEFAULT_FORCETEKI, run: DEFAULT_RUN, originals: DEFAULT_ORIGINALS, "no-memo": false });
    tables = loadTables({ runDir: DEFAULT_RUN, complementarity: path.join(REPO_ROOT, "data/complementarity.json"), pairs: false });
    registerRungs(POLICIES, (ps) => new PolicyChain(ps as never), [...new Set(TRACES.flatMap(([, ps]) => ps))], tables);
    const deck = (rel: string) => prepareDeck(ctx.bridge, JSON.parse(readFileSync(path.join(REPO_ROOT, rel), "utf8")), "file:" + rel);
    warrior = deck("tests/fixtures/decks/warrior-chewie-raid.swudb.json");
    cadBane = deck("data/originals/decks/2026-10-17/melee-6563300e-ae56-49d6-b88c-b3ea0151a4da.json");
  }, 60_000);

  it.each(TRACES)("seed %s %j plays the pinned trace", { timeout: 120_000 }, async (seed, policies, sha) => {
    const spec: MatchSpec = { seed, decks: [warrior, cadBane], policies, recordMode: "compact", undo: true, codeCommit: "test" };
    const { record } = await playMatch(ctx.engine, spec, ctx.bridge.engineCardKeys);
    expect(record.footer.error).toBeNull();
    expect(record.footer.traceSha256).toBe(sha);
  });

  it.skipIf(!hasPriors)("rung3h searches with rollbacks that restore the full state, and its record replays by descriptor to the same trace", { timeout: 120_000 }, async () => {
    const spec = parsePolicySpec("rung3h:hk=3");
    if (spec.kind !== "human") throw new Error("not a human spec");
    const priors = loadPriors(priorsDir(1));
    POLICIES["rung3h:k=8,hk=3,hp=v1"] = () => new PolicyChain([humanPolicy(tables, spec.params, { ...inputsOf(spec, tables), humanModels: priors.sha256.models, humanCardPrior: priors.sha256.cardPrior }, priors)] as never);
    const keys = ctx.bridge.engineCardKeys;
    const m: MatchSpec = { seed: "184", decks: [warrior, cadBane], policies: ["rung3h:k=8,hk=3,hp=v1", "rung1"], recordMode: "compact", undo: true, codeCommit: "test" };
    const { record, session } = await playMatch(ctx.engine, m, keys, { verifyRollback: true });
    expect(record.footer.error).toBeNull();
    if (session === null) throw new Error("no session");
    const counters = (session.opts.chains[0].top as unknown as { counters: LookaheadCounters }).counters;
    expect(counters.searches).toBeGreaterThan(3);
    expect(session.search.rollbacks).toBe(counters.trials);
    expect(session.search.verified).toBe(session.search.rollbacks);
    expect(record.header.policies[0]).toMatchObject({ rung: 3, policyId: "rung3-human", policyVersion: "1", paramsSha256: policyHeader(spec).paramsSha256, inputs: { humanModels: priors.sha256.models } });
    const oracle = await replayMatch(ctx.engine, JSON.parse(JSON.stringify(record)), keys, { byDescriptor: true });
    expect(oracle.mismatch).toBeNull();
    expect(oracle.traceSha256).toBe(record.footer.traceSha256);
  });
});

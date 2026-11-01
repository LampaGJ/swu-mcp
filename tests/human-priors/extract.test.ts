import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decisionRecordSchema } from "../../scripts/human-priors/decisions.js";
import { extractDecisions, manifestSchema } from "../../scripts/human-priors/extract-decisions.js";
import { jsonl, PLAYERS, resolver, unit, type RowIn } from "./fixtures.js";

const t = (s: number) => "2026-01-01T00:00:" + String(s).padStart(2, "0") + ".000Z";
const trooper = { name: "Alpha Trooper", set: "TST", number: 1 };

const game1: RowIn[] = [
  { ts: t(1), actionType: "play_unit", card: trooper, seat1Units: [unit("Alpha Trooper")] },
  { ts: t(2), actor: "B", actionType: "pass", seat1Units: [unit("Alpha Trooper")] },
  { ts: t(3), actionType: "attack", card: trooper, target: "base", seat1Units: [unit("Alpha Trooper", { exhausted: true })] },
  { ts: t(4), actor: "B", actionType: "forfeit", label: 0, seat1Units: [unit("Alpha Trooper", { exhausted: true })] },
];
const game2: RowIn[] = [{ game: "GID-0002", ts: t(5), actionType: "resource" }, { game: "GID-0002", ts: t(6), actor: "B", actionType: "claim_initiative" }];

function inputs(): string {
  const dir = mkdtempSync(path.join(process.env.TMPDIR ?? "tmp", "hp-extract-"));
  writeFileSync(path.join(dir, "training-1.jsonl"), jsonl(game1.slice(0, 3)));
  // Overlaps file 1 by one row, interleaves a second game, and holds one malformed and one empty line.
  writeFileSync(path.join(dir, "training-2.jsonl"), jsonl([game1[2], game2[0], game1[3], game2[1]]) + "{not json\n\n");
  writeFileSync(path.join(dir, "notes.txt"), "ignored");
  return dir;
}

describe("extractDecisions", () => {
  it("writes byte-identical output on a rerun, with a manifest naming inputHash, codeCommit and outputHash", async () => {
    const dir = inputs();
    const out1 = path.join(dir, "out1");
    const out2 = path.join(dir, "out2");
    mkdirSync(out1);
    const m1 = await extractDecisions({ inputDir: dir, outDir: out1, resolver, codeCommit: "abc1234" });
    const m2 = await extractDecisions({ inputDir: dir, outDir: out2, resolver, codeCommit: "abc1234" });
    expect(m2).toEqual(m1);
    expect(manifestSchema.safeParse(m1).success).toBe(true);
    expect(m1.codeCommit).toBe("abc1234");
    expect(m1.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(m1.output.file).toBe("decisions-" + m1.outputHash.slice(0, 12) + ".jsonl.gz");
    const files1 = readdirSync(out1).sort();
    expect(files1).toEqual(readdirSync(out2).sort());
    for (const f of files1) expect(readFileSync(path.join(out2, f)).equals(readFileSync(path.join(out1, f)))).toBe(true);

    expect(m1.totals).toMatchObject({ rows: 8, invalidRows: 1, duplicateRows: 1, uniqueRows: 6, games: 2, records: 6 });
    const body = gunzipSync(readFileSync(path.join(out1, m1.output.file))).toString("utf8");
    const recs = body.trim().split("\n").map((l) => decisionRecordSchema.parse(JSON.parse(l)));
    expect(recs).toHaveLength(6);
    expect(recs.filter((r) => r.kind === "attack")[0].attacks?.chosen).toBe(0);
    const everything = body + JSON.stringify(m1);
    for (const secret of [PLAYERS.A.id, PLAYERS.A.name, PLAYERS.B.id, PLAYERS.B.name, "GID-0001", "GID-0002"]) expect(everything).not.toContain(secret);
  });

  it("changes the input hash when an input byte changes", async () => {
    const dir = inputs();
    const a = await extractDecisions({ inputDir: dir, outDir: path.join(dir, "a"), resolver, codeCommit: "abc1234" });
    writeFileSync(path.join(dir, "training-1.jsonl"), jsonl(game1.slice(0, 2)));
    const b = await extractDecisions({ inputDir: dir, outDir: path.join(dir, "b"), resolver, codeCommit: "abc1234" });
    expect(b.inputHash).not.toBe(a.inputHash);
  });
});

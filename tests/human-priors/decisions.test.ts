import { describe, expect, it } from "vitest";
import { boundaryRow, decisionRecordSchema, decisionsForGame, parsedRowSchema, rebuildAttacks, serializeRecords, type BoardUnit, type ParsedRow } from "../../scripts/human-priors/decisions.js";
import { PLAYERS, rawRow, resolver, unit, type RowIn } from "./fixtures.js";

const parse = (rows: RowIn[], file = 0): ParsedRow[] =>
  rows.map((r, line) => {
    const p = boundaryRow(rawRow(r), { file, line });
    if (p === null) throw new Error("fixture row " + String(line) + " did not parse");
    return p;
  });

const trooper = { name: "Alpha Trooper", set: "TST", number: 1 };
const fighter = { name: "Beta Fighter", set: "TST", number: 2 };
const t = (s: number) => "2026-01-01T00:00:" + String(s).padStart(2, "0") + ".000Z";

describe("boundary schema (D22, D102)", () => {
  it("drops player names and ids and hashes the game id before anything is kept", () => {
    const [p] = parse([{ ts: t(0), actionType: "pass" }]);
    const text = JSON.stringify(p);
    for (const secret of [PLAYERS.A.id, PLAYERS.A.name, PLAYERS.B.id, PLAYERS.B.name, "GID-0001"]) expect(text).not.toContain(secret);
    expect(p.game).toMatch(/^[0-9a-f]{16}$/);
    expect(p.actor).not.toBe(p.other);
    expect(parsedRowSchema.safeParse({ ...p, activePlayerName: "x" }).success).toBe(false);
  });

  it("refuses a row with a missing game id or a non-numeric scalar", () => {
    const bad = rawRow({ ts: t(0), actionType: "pass" });
    (bad.metadata as Record<string, unknown>).gameId = "";
    expect(boundaryRow(bad, { file: 0, line: 0 })).toBeNull();
    const bad2 = rawRow({ ts: t(0), actionType: "pass", extra: { activePlayerResources: "3" } });
    expect(boundaryRow(bad2, { file: 0, line: 0 })).toBeNull();
  });
});

describe("decisionsForGame", () => {
  it("re-orients the fixed-seat lists to the acting player with the seat vote, using the previous row as the before-state", () => {
    // Seat one is player B: the activePlayer* lists always show B's board.
    const rows = parse([
      { ts: t(1), actor: "B", actionType: "play_unit", card: trooper, seat1Units: [unit("Alpha Trooper", { exhausted: true })], seat2Units: [] },
      { ts: t(2), actor: "A", actionType: "play_unit", card: fighter, seat1Units: [unit("Alpha Trooper", { exhausted: true })], seat2Units: [unit("Beta Fighter", { exhausted: true })] },
      { ts: t(3), actor: "B", actionType: "pass", seat1Units: [unit("Alpha Trooper", { exhausted: true })], seat2Units: [unit("Beta Fighter", { exhausted: true })] },
    ]);
    const recs = decisionsForGame(rows, resolver);
    expect(recs.map((r) => r.seat)).toEqual([1, 2, 1]);
    expect(recs[0].before).toBeNull();
    // Row 2 (actor A, seat 2): its before is row 1's after, and A's own list is the seat-2 list (empty then).
    expect(recs[1].before?.me).toEqual([]);
    expect(recs[1].before?.opp.map((u) => u.card)).toEqual(["T1000001"]);
    // Row 3 (actor B, seat 1): me is B's board.
    expect(recs[2].before?.me.map((u) => u.card)).toEqual(["T1000001"]);
    expect(recs[2].before?.opp.map((u) => u.card)).toEqual(["T1000002"]);
    expect(recs[1].me.leader).toBe("TL000001");
    expect(recs[1].opp.base).toBe("TB000002");
  });

  it("leaves seat and boards null when no row votes", () => {
    const recs = decisionsForGame(parse([{ ts: t(1), actionType: "pass" }, { ts: t(2), actor: "B", actionType: "pass" }]), resolver);
    expect(recs.map((r) => [r.seat, r.before])).toEqual([
      [null, null],
      [null, null],
    ]);
  });

  it("drops duplicate rows across files and orders by timestamp, then file, then line", () => {
    const a = parse([{ ts: t(2), actionType: "pass" }, { ts: t(3), actor: "B", actionType: "claim_initiative" }], 0);
    const b = parse([{ ts: t(1), actor: "B", actionType: "resource" }, { ts: t(2), actionType: "pass" }], 1);
    const recs = decisionsForGame([...a, ...b], resolver);
    expect(recs.map((r) => r.kind)).toEqual(["resource", "pass", "claim_initiative"]);
    expect(recs.map((r) => r.i)).toEqual([0, 1, 2]);
  });

  it("is order-free: shuffled input gives byte-identical serialized output that passes the strict record schema", () => {
    const rows = parse([
      { ts: t(1), actionType: "play_unit", card: trooper, seat1Units: [unit("Alpha Trooper", { exhausted: true })] },
      { ts: t(2), actor: "B", actionType: "pass", seat1Units: [unit("Alpha Trooper", { exhausted: true })] },
      { ts: t(3), actionType: "attack", card: trooper, target: "base", seat1Units: [unit("Alpha Trooper", { exhausted: true })] },
    ]);
    const one = serializeRecords(decisionsForGame(rows, resolver));
    const two = serializeRecords(decisionsForGame([rows[2], rows[0], rows[1]], resolver));
    expect(two).toBe(one);
    for (const line of one.trim().split("\n")) expect(decisionRecordSchema.safeParse(JSON.parse(line)).success).toBe(true);
  });

  it("flags a likely undo: a board that returns to an earlier state in the same turn marks the rows between as undone", () => {
    const board0 = [unit("Alpha Trooper")];
    const rows = parse([
      { ts: t(1), actionType: "play_unit", card: trooper, seat1Units: board0 },
      { ts: t(2), actionType: "attack", card: trooper, target: "base", seat1Units: [unit("Alpha Trooper", { exhausted: true })] },
      { ts: t(3), actionType: "pass", seat1Units: board0 },
      { ts: t(4), actor: "B", actionType: "pass", seat1Units: board0 },
    ]);
    const recs = decisionsForGame(rows, resolver);
    expect(recs.map((r) => [r.flags.undone, r.flags.revert])).toEqual([
      [false, false],
      [true, false],
      [false, true],
      [false, false],
    ]);
  });

  it("labels each row with the actor's game result, marks forfeits, and nulls a conflicting label", () => {
    const recs = decisionsForGame(parse([{ ts: t(1), actionType: "pass", label: 1 }, { ts: t(2), actor: "B", actionType: "forfeit", label: 0 }]), resolver);
    expect(recs.map((r) => [r.won, r.forfeit])).toEqual([
      [1, true],
      [0, true],
    ]);
    const conflict = decisionsForGame(parse([{ ts: t(1), actionType: "pass", label: 1 }, { ts: t(2), actor: "B", actionType: "pass", label: 1 }]), resolver);
    expect(conflict.map((r) => r.won)).toEqual([null, null]);
  });

  it("rebuilds the legal attacks from the before-board, matches the chosen one, and keeps the after-board and next base damage", () => {
    const before1 = [unit("Alpha Trooper"), unit("Delta Scout", { arena: "space" }), unit("Beta Fighter", { exhausted: true })];
    const before2 = [unit("Gamma Wall", { keywords: ["Sentinel"] }), unit("Beta Fighter"), unit("Delta Scout", { arena: "space" })];
    const rows = parse([
      { ts: t(1), actionType: "play_unit", card: trooper, seat1Units: before1, seat2Units: before2 },
      {
        ts: t(2),
        actionType: "attack",
        card: trooper,
        target: { name: "Gamma Wall" },
        seat1Units: [unit("Alpha Trooper", { exhausted: true, damage: 2 }), before1[1], before1[2]],
        seat2Units: [before2[1], before2[2]],
        seat2Discard: ["Gamma Wall"],
      },
      { ts: t(3), actor: "B", actionType: "pass", meBaseDamage: 0, oppBaseDamage: 0, seat1Units: [], seat2Units: [] },
    ]);
    const recs = decisionsForGame(rows, resolver);
    const atk = recs[1];
    expect(atk.kind).toBe("attack");
    expect(atk.card).toBe("T1000001");
    expect(atk.target).toBe("T1000003");
    // Ground: only the Sentinel may be attacked; space: no enemy Sentinel, so the enemy unit and the base.
    expect(atk.attacks?.options).toEqual([
      ["T1000001", "ground", "T1000003"],
      ["T1000004", "space", "T1000004"],
      ["T1000004", "space", "base"],
    ]);
    expect(atk.attacks?.chosen).toBe(0);
    expect(atk.after?.opp.map((u) => u.card)).toEqual(["T1000002", "T1000004"]);
    expect(atk.after?.me[0]).toMatchObject({ card: "T1000001", damage: 2, exhausted: true });
    expect(atk.next).toEqual({ meBaseDamage: 0, oppBaseDamage: 0 });
    expect(recs[0].attacks).toBeUndefined();
  });

  it("marks a second log row of the same combat as a repeat with no chosen option", () => {
    const rows = parse([
      { ts: t(1), actionType: "play_unit", card: trooper, seat1Units: [unit("Alpha Trooper")], seat2Units: [] },
      { ts: t(2), actionType: "attack", card: trooper, target: "base", seat1Units: [unit("Alpha Trooper", { exhausted: true })] },
      { ts: t(3), actionType: "attack", card: trooper, target: "base", seat1Units: [unit("Alpha Trooper", { exhausted: true })] },
    ]);
    const recs = decisionsForGame(rows, resolver);
    expect(recs[1].attacks?.chosen).toBe(0);
    expect(recs[1].flags.repeat).toBe(false);
    expect(recs[2].attacks?.chosen).toBeNull();
    expect(recs[2].flags.repeat).toBe(true);
  });
});

describe("ambiguous titles", () => {
  it("resolves a title-only attack target against the defender's before-board", () => {
    const rows = parse([
      { ts: t(1), actionType: "play_unit", card: trooper, seat1Units: [unit("Alpha Trooper")], seat2Units: [unit("Omega Gate, Second Face")] },
      { ts: t(2), actionType: "attack", card: trooper, target: { name: "Omega Gate" }, seat1Units: [unit("Alpha Trooper", { exhausted: true })], seat2Units: [] },
    ]);
    const atk = decisionsForGame(rows, resolver)[1];
    expect(atk.target).toBe("T1000006");
    expect(atk.attacks?.chosen).toBe(0);
  });

  it("names a side's leader from its own leader-card rows before the title", () => {
    const rows = parse([
      { ts: t(1), actionType: "leader_ability", card: { name: "Leader Alpha", set: "TST", number: 9, type: "leader" } },
      { ts: t(2), actor: "B", actionType: "pass" },
    ]);
    const recs = decisionsForGame(rows, resolver);
    expect(recs[0].me.leader).toBe("TL000009");
    expect(recs[1].opp.leader).toBe("TL000009");
    expect(recs[1].me.leader).toBe("TL000002");
  });

  it("drops token upgrades the spectator listed as board entries, so they are neither units nor attackers", () => {
    const rows = parse([
      { ts: t(1), actionType: "play_unit", card: trooper, seat1Units: [unit("Alpha Trooper"), unit("Shield", { power: 0, hp: 0 })], seat2Units: [] },
      { ts: t(2), actionType: "attack", card: trooper, target: "base", seat1Units: [unit("Alpha Trooper", { exhausted: true }), unit("Shield", { power: 0, hp: 0 })] },
    ]);
    const atk = decisionsForGame(rows, resolver)[1];
    expect(atk.before?.me.map((x) => x.card)).toEqual(["T1000001"]);
    expect(atk.attacks?.options).toEqual([["T1000001", "ground", "base"]]);
    expect(atk.after?.me.map((x) => x.card)).toEqual(["T1000001"]);
  });

  it("keeps the total resource count beside the ready one", () => {
    const [r] = decisionsForGame(parse([{ ts: t(1), actionType: "pass", extra: { activePlayerResources: 2, activePlayerResourceCards: 5 } }]), resolver);
    expect([r.me.resources, r.me.totalResources]).toEqual([2, 5]);
  });
});

describe("rebuildAttacks", () => {
  const u = (card: string, o: Partial<BoardUnit> = {}): BoardUnit => ({ card, cost: 1, power: 1, hp: 1, damage: 0, exhausted: false, arena: "ground", kw: [], up: 0, ...o });
  it("lets a Saboteur ignore a Sentinel and never lists an exhausted attacker", () => {
    expect(rebuildAttacks([u("S", { kw: ["Saboteur"] }), u("E", { exhausted: true })], [u("W", { kw: ["Sentinel"] }), u("X")])).toEqual([
      ["S", "ground", "W"],
      ["S", "ground", "X"],
      ["S", "ground", "base"],
    ]);
  });
});

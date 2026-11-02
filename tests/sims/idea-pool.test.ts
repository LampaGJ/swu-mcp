import { describe, expect, it } from "vitest";
import { buildInputOf, parseIdeaPool, parseJudgeScores, resolveIdeas } from "../../src/sims/idea-pool.js";

const POOL = `# Branch T0.0 (proven) — raw ideas
IDEA 1 | T00-1 | Snoke Experience Ladder | S-1 | Snoke 05010006 | base Shield Generator Complex 09010022
key: Jerjerrod 08010094; Dume 05010055; Vaneé 05010082; No Glory, Only Results 04010043
returning: none
wins: text

IDEA 2 | T00-2 | Snoke Upgrade Tower | S-1 | Snoke | base Fortress of the Great Mothers 08010019
key: Jerjerrod; Dume; Vaneé 05010082; Clone of the Zillo Beast 09010065; Mystery Card

IDEA 1 | T02-1 | name: Mandalorian Doubling under Hemlock | slot 1 S-5 | leader Doctor Hemlock 09010003 | base Origin Tree 09010024
key: Jerjerrod; Dume; Death Trooper 0101033
`;

describe("idea pool parser", () => {
  const ideas = parseIdeaPool(POOL);

  it("reads every idea's id, name, leader, base and key cards, in either header form", () => {
    expect(ideas.map((i) => i.id)).toEqual(["T00-1", "T00-2", "T02-1"]);
    expect(ideas[2].name).toBe("Mandalorian Doubling under Hemlock");
    expect(ideas[2].leader).toEqual({ name: "Doctor Hemlock", key: "09010003" });
    expect(ideas[0].base).toEqual({ name: "Shield Generator Complex", key: "09010022" });
    expect(ideas[0].key.map((k) => k.key)).toEqual(["08010094", "05010055", "05010082", "04010043"]);
    expect(ideas[2].key[2]).toEqual({ name: "Death Trooper", key: "0101033" });
  });

  it("reads the 'key cards:' spelling one branch uses", () => {
    const [idea] = parseIdeaPool("IDEA 1 | T02-1 | name: N | slot 1 S-5 | leader Doctor Hemlock 09010003 | base Origin Tree 09010024\nkey cards: Moff Jerjerrod 08010094; Koska Reeves 08010079\nhow it wins: text");
    expect(idea.key.map((k) => k.key)).toEqual(["08010094", "08010079"]);
  });

  it("refuses an idea with no key line instead of building it from the anchors alone", () => {
    expect(() => parseIdeaPool("IDEA 1 | X-1 | N | S-1 | Lone 01010001 | base B 01010002\ncards: A 01010003\n")).toThrow(/X-1/);
  });

  it("refuses a pool file with no idea in it, so a renamed header never reads as an empty branch", () => {
    expect(() => parseIdeaPool("# Branch T0.4\nIdea 1 | X-1 | N | S-1 | Lone 01010001 | base B 01010002\nwins: text\n")).toThrow(/no idea/);
  });

  it("refuses a key line that comes before any idea header", () => {
    expect(() => parseIdeaPool("key: A 01010003\nIDEA 1 | X-1 | N | S-1 | Lone 01010001 | base B 01010002\nkey: A 01010003\n")).toThrow(/before any idea/);
  });

  it("fills a bare name from the same name keyed elsewhere in the pool, then from the card table, and names what it cannot place", () => {
    const titles = (name: string): string[] => (name === "Unknown" ? ["1", "2"] : []);
    const r = resolveIdeas(ideas, titles);
    expect(r.ideas[1].leader.key).toBe("05010006");
    expect(r.ideas[1].key.slice(0, 2).map((k) => k.key)).toEqual(["08010094", "05010055"]);
    expect(r.unresolved).toEqual([{ idea: "T00-2", name: "Mystery Card" }]);
  });

  it("uses the card table only when exactly one card bears the name", () => {
    const r = resolveIdeas(parseIdeaPool("IDEA 1 | X-1 | N | S-1 | Lone 01010001 | base B 01010002\nkey: Unique; Shared"), (name) => (name === "Unique" ? ["03010003"] : ["1", "2"]));
    expect(r.ideas[0].key.map((k) => k.key)).toEqual(["03010003", null]);
    expect(r.unresolved).toEqual([{ idea: "X-1", name: "Shared" }]);
  });

  it("turns an idea into a build_deck input: key cards at two copies, anchors at two, excluded cards left out of mustInclude", () => {
    const r = resolveIdeas(ideas, () => []);
    expect(buildInputOf(r.ideas[1], { anchors: ["08010094", "05010055"], copies: 2, exclude: ["09010065"] })).toEqual({
      leader: "05010006",
      base: "08010019",
      name: "T00-2 Snoke Upgrade Tower",
      mustInclude: [
        { card: "05010055", count: 2 },
        { card: "05010082", count: 2 },
        { card: "08010094", count: 2 },
      ],
      exclude: ["09010065"],
    });
  });
});

describe("judge scores", () => {
  it("joins the anonymised judge lines to idea ids through the anon map", () => {
    const judges = "I01|4|4|4|6|condition unmet|few token makers\nI02|5|3|5|5||Credit-removal risk\n";
    const map = "I01\tT10-8\tCommandos Take Over\nI02\tT06-1\tCredit Factory\n";
    const s = parseJudgeScores(judges, map);
    expect(s.get("T10-8")).toEqual({ anonId: "I01", surprise: 4, win: 4, fits: 4, covers: 6, flags: "condition unmet", risk: "few token makers", dots: 0 });
    expect(s.get("T06-1")?.flags).toBe("");
  });

  it("reads the dot-vote line into each idea's dots", () => {
    const s = parseJudgeScores("I01|4|4|4|6|a|b\nI02|5|3|5|5||c\nDOTS|I02 2|I01 1\n", "I01\tT10-8\tA\nI02\tT06-1\tB\n");
    expect(s.get("T06-1")?.dots).toBe(2);
    expect(s.get("T10-8")?.dots).toBe(1);
    expect(() => parseJudgeScores("I01|4|4|4|6|a|b\nDOTS|I01 x\n", "I01\tT10-8\tA\n")).toThrow(/DOTS/);
    expect(() => parseJudgeScores("I01|4|4|4|6|a|b\nDOTS|I07 1\n", "I01\tT10-8\tA\n")).toThrow(/I07/);
  });

  it("refuses a line it cannot read rather than dropping it", () => {
    expect(() => parseJudgeScores("I01|x|4|4|6|a|b\n", "I01\tT10-8\tName\n")).toThrow(/I01/);
    expect(() => parseJudgeScores("I09|4|4|4|6|a|b\n", "I01\tT10-8\tName\n")).toThrow(/I09/);
  });
});

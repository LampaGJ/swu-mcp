import { describe, expect, it } from "vitest";
import { clusteredContrast, covers, measure, type BenchGame, type CardValue } from "../../scripts/bench/meta-defense.js";

const icons: Record<string, string[]> = {
  ME: ["Vigilance"],
  MB: ["Command"],
  EL: ["Aggression"],
  EB: ["Cunning"],
  answer: ["Vigilance"],
  filler: ["Command"],
  offAspect: ["Heroism"],
};
const iconsOf = (key: string): string[] | undefined => icons[key];

/** 30 wins holding the answer 20 times and 30 losses holding it 5 times; the filler shows evenly. */
function games(): BenchGame[] {
  return Array.from({ length: 60 }, (_, i) => {
    const won = i < 30 ? 1 : 0;
    const hasAnswer = won === 1 ? i < 20 : i < 35;
    const cards = [...(hasAnswer ? ["answer"] : []), ...(i % 2 === 0 ? ["filler"] : []), "offAspect"];
    return [
      { leader: "ME", base: "MB", won, cards },
      { leader: "EL", base: "EB", won: (1 - won) as 0 | 1, cards: [] },
    ] as const;
  });
}

describe("covers", () => {
  it("needs every icon, duplicates included", () => {
    expect(covers(["Vigilance", "Command"], ["Vigilance"])).toBe(true);
    expect(covers(["Vigilance"], ["Vigilance", "Vigilance"])).toBe(false);
  });
});

describe("measure", () => {
  const values = measure(games(), new Map([["EL", new Map([["answer", ["key-units"]]])]]), iconsOf, [
    "answer",
    "filler",
    "offAspect",
    "neverSeen",
  ]);

  it("scores answers and eligible controls against the archetype leader, skipping uncovered and unseen cards", () => {
    expect(values.map((v) => [v.card, v.answer])).toEqual([
      ["answer", true],
      ["filler", false],
    ]);
    const answer = values[0];
    expect(answer.winners).toBe(30);
    expect(answer.losers).toBe(30);
    expect(answer.logRatio).toBeCloseTo(Math.log(20.5 / 31) - Math.log(5.5 / 31), 10);
    expect(values[1].logRatio).toBeCloseTo(0, 10);
  });
});

describe("clusteredContrast", () => {
  const v = (card: string, answer: boolean, logRatio: number): CardValue => ({
    leader: "L",
    card,
    answer,
    threats: [],
    logRatio,
    winners: 30,
    losers: 30,
  });

  it("reports the answer and control means, their difference and seeded card-clustered intervals", () => {
    const values = [v("a1", true, 1), v("a2", true, 0.6), v("c1", false, 0), v("c2", false, 0.2), v("c3", false, -0.2)];
    const out = clusteredContrast(values, { iterations: 500, seed: "t" });
    expect(out.answers.value).toBe(0.8);
    expect(out.controls.value).toBe(0);
    expect(out.difference.value).toBe(0.8);
    expect(out.difference.cards).toBe(5);
    expect((out.difference.low as number) <= 0.8 && 0.8 <= (out.difference.high as number)).toBe(true);
    expect(clusteredContrast(values, { iterations: 500, seed: "t" })).toEqual(out);
  });
});

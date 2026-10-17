import { describe, expect, it } from "vitest";
import { renderFullMarkdown, renderPublicMarkdown } from "../../scripts/bench/real-play-md.js";

const ciObj = { value: 0.5, low: 0.4, high: 0.6, n: 7 };
const group = {
  pairs: { pairs: 3, measured: 2, meanLogLift: ciObj, mhRiskDifferenceByLeader: ciObj },
  randomMatched: { meanLogLift: ciObj },
};
const report = {
  run: "2026-01-01",
  inputs: { decks: { decks: 11, snapshots: [] }, humanGames: { games: 424242, sides: 848484 } },
  windows: { humanGames: { capturedThrough: "2026-02-02", reachesOrder: 9 }, decks: {}, releaseDatesFromRun: {} },
  deckCoInclusion: { "pooled-conditioned": { "excluding-trait-only": group } },
  humanGames: {
    coOccurrence: { "coOccurrence-conditioned": { "excluding-trait-only": group } },
    interactionAndWins: { "excluding-trait-only": group },
  },
  pairsV1Agreement: {},
  fungible: {},
  trios: { all: {} },
  simulations: { "excluding-trait-only": group },
};

describe("real-play markdown", () => {
  it("public output never carries human-game results, even when the report holds them", () => {
    const md = renderPublicMarkdown(report);
    expect(md).not.toMatch(/human game|Human game|Karabast|424242|848484|2026-02-02/);
    expect(md).not.toContain("## (b)");
    expect(md).toContain("not published (docs/decisions.md D22)");
    expect(md).toContain("Decklists (11 unique Premier lists)");
  });

  it("full output keeps the human-game section for local reports", () => {
    const md = renderFullMarkdown(report);
    expect(md).toContain("## (b) Human games");
    expect(md).toContain("424242 games");
    expect(md).toContain("do not commit or publish");
  });
});

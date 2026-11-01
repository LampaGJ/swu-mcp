import { describe, expect, it } from "vitest";
import { decklistManifestSchema, decklistRowsPageSchema, nameVariants, statOf } from "../../src/meta/decklist-capture.js";

describe("decklist capture seam", () => {
  it("reads a two-faced leader by its front face and a zero typed for the letter O", () => {
    expect(nameVariants("Chancellor Palpatine // Darth Sidious | Playing Both Sides")).toContain(
      "Chancellor Palpatine | Playing Both Sides",
    );
    expect(nameVariants("C-3P0 | Human-Cyborg Relations")).toContain("C-3PO | Human-Cyborg Relations");
    expect(nameVariants("B2EM0 | That's Two Lies")).toContain("B2EMO | That's Two Lies");
    expect(nameVariants("Darth Vader | Victor Squadron Leader")).toEqual(["Darth Vader | Victor Squadron Leader"]);
    expect(nameVariants("TIE/ln Fighter")).toEqual(["TIE/ln Fighter"]);
  });

  it("reads printed numbers given as text or numbers", () => {
    expect([statOf("4"), statOf(3), statOf(null), statOf(""), statOf("X")]).toEqual([4, 3, null, null, null]);
  });

  it("parses an upstream page with unknown extra fields and rejects one missing the deck key", () => {
    const row = {
      guid: "g",
      tournamentId: 1,
      standing: 3,
      leaderName: "L",
      baseName: "B",
      tournament: { startDate: "2026-09-01T00:00:00.000Z", extra: 1 },
      player: { name: "someone" },
      cards: [{ count: 2, section: "MainDeck", cardName: "C", card: { cost: 2, power: "3", hp: 4 } }],
      matchRecord: "3-2-0",
      newUpstreamField: true,
    };
    expect(decklistRowsPageSchema.parse({ decklists: [row], totalCount: 1 }).decklists[0].guid).toBe("g");
    expect(decklistRowsPageSchema.safeParse({ decklists: [{ ...row, guid: undefined }], totalCount: 1 }).success).toBe(false);
  });

  it("the manifest this repo writes is strict", () => {
    expect(decklistManifestSchema.safeParse({ kind: "swumetastats-decklists" }).success).toBe(false);
  });
});

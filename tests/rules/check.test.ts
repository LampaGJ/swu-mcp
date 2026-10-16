import { describe, expect, it } from "vitest";
import { articleStamp, evaluate, versionOfFileName, type Observed, type Pinned } from "../../src/rules/check.js";

const pinned: Pinned = {
  rulesVersion: "8.0",
  fetchedAt: "2026-10-16",
  pdfSha256: "a".repeat(64),
  pdfBytes: 1000,
  url: "https://cdn.example/SWH_Comp_Rules_v8_0_e26603c6e1.pdf",
  fileName: "SWH_Comp_Rules_v8_0_e26603c6e1.pdf",
};

const quiet: Observed = {
  pdfHead: { status: 200, contentLength: 1000, lastModified: null },
  listedFileNames: [],
  rulesArticles: [{ title: "Comprehensive Rules Update", publishOn: "2025-03-07T18:00:00.000Z", updatedAt: "2025-03-07T16:12:44.323Z" }],
  newestArticle: null,
};

describe("evaluate", () => {
  it("is current when nothing changed", () => {
    expect(evaluate(pinned, quiet)).toEqual({ status: "current", reasons: [] });
  });

  it("flags a different CR filename and names the version", () => {
    const out = evaluate(pinned, { ...quiet, listedFileNames: ["SWH_Comp_Rules_v9_0_ffff.pdf", pinned.fileName] });
    expect(out.status).toBe("newer-available");
    expect(out.reasons).toHaveLength(1);
    expect(out.reasons[0]).toContain("version 9.0");
  });

  it("flags the same version under a different hash", () => {
    expect(evaluate(pinned, { ...quiet, listedFileNames: ["SWH_Comp_Rules_v8_0_zzzz.pdf"] }).reasons[0]).toContain("pinned SWH_Comp_Rules_v8_0_e26603c6e1.pdf");
  });

  it("flags a rules article dated after the pin date, but not one on or before it", () => {
    const article = (stamp: string) => ({ title: "Comprehensive Rules Update: Icons", publishOn: stamp, updatedAt: null });
    expect(evaluate(pinned, { ...quiet, rulesArticles: [article("2026-10-17T10:00:00.000Z")] }).status).toBe("newer-available");
    expect(evaluate(pinned, { ...quiet, rulesArticles: [article("2026-10-16T23:00:00.000Z")] }).status).toBe("current");
  });

  it("flags a moved or resized pinned PDF and a hash mismatch", () => {
    expect(evaluate(pinned, { ...quiet, pdfHead: { status: 404, contentLength: null, lastModified: null } }).status).toBe("newer-available");
    expect(evaluate(pinned, { ...quiet, pdfHead: { status: 200, contentLength: 2000, lastModified: null } }).status).toBe("newer-available");
    expect(evaluate(pinned, { ...quiet, downloadedSha256: "b".repeat(64) }).status).toBe("newer-available");
    expect(evaluate(pinned, { ...quiet, downloadedSha256: pinned.pdfSha256 }).status).toBe("current");
  });
});

describe("helpers", () => {
  it("reads the version out of a CR filename", () => {
    expect(versionOfFileName("SWH_Comp_Rules_v8_0_e26603c6e1.pdf")).toBe("8.0");
    expect(versionOfFileName("rules.pdf")).toBeNull();
  });

  it("takes the later of publishOn and updatedAt", () => {
    expect(articleStamp({ title: "t", publishOn: "2026-01-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" })).toBe("2026-02-01T00:00:00.000Z");
    expect(articleStamp({ title: "t", publishOn: null, updatedAt: null })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { dataReleaseSchema } from "../src/data-release.js";

const pin = (dataVersion: string) => ({
  dataVersion,
  tag: `data-${dataVersion}`,
  asset: `swu-mcp-data-${dataVersion}.tar.gz`,
  url: `https://github.com/LampaGJ/swu-mcp/releases/download/data-${dataVersion}/swu-mcp-data-${dataVersion}.tar.gz`,
  sha256: "a".repeat(64),
  bytes: 1,
  buildHash: "b".repeat(64),
});

describe("data release pin", () => {
  it.each(["2026-10-17", "2026-10-17.r2", "2026-10-17.r10"])("accepts dataVersion %s", (v) => {
    expect(dataReleaseSchema.safeParse(pin(v)).success).toBe(true);
  });

  it.each(["2026-10-17.r1", "2026-10-17.r0", "2026-10-17x", "17-10-2026", "2026-02-30", "2026-13-45.r2"])("rejects dataVersion %s", (v) => {
    expect(dataReleaseSchema.safeParse(pin(v)).success).toBe(false);
  });
});

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRawPrintings } from "../../scripts/lib/raw-pages.js";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const roots: string[] = [];

function fixture(): { dir: string; manifestSha: string; page1: string } {
  const root = mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "raw-pages-"));
  roots.push(root);
  const dir = path.join(root, "raw-pages");
  mkdirSync(dir);
  const page1 = `${JSON.stringify({ data: [] })}\n`;
  writeFileSync(path.join(dir, "page-0001.json"), page1);
  const manifest = `${JSON.stringify({
    version: 1,
    label: "t",
    baseUrl: "https://example.test",
    startedAt: "2026-10-16T00:00:00.000Z",
    finishedAt: "2026-10-16T00:01:00.000Z",
    complete: true,
    pageCount: 1,
    pages: [{ page: 1, url: "https://example.test/1", status: 200, fetchedAt: "2026-10-16T00:00:30.000Z", byteLength: Buffer.byteLength(page1), sha256: sha(page1) }],
  })}\n`;
  writeFileSync(path.join(dir, "manifest.json"), manifest);
  return { dir, manifestSha: sha(manifest), page1 };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loadRawPrintings", () => {
  it("returns the printings and the manifest sha for intact pages", () => {
    const { dir, manifestSha } = fixture();
    expect(loadRawPrintings(dir, manifestSha)).toEqual({ printings: [], rawManifestSha256: manifestSha });
  });

  it("throws when the manifest differs from the pinned sha", () => {
    const { dir } = fixture();
    expect(() => loadRawPrintings(dir, "0".repeat(64))).toThrow(/differs from the raw manifest/);
  });

  it("throws naming the page when its bytes drifted but the length held", () => {
    const { dir, manifestSha, page1 } = fixture();
    writeFileSync(path.join(dir, "page-0001.json"), page1.replace("data", "dxta"));
    expect(() => loadRawPrintings(dir, manifestSha)).toThrow(/page-0001\.json: sha256/);
  });

  it("throws naming the page when its byteLength differs from the manifest", () => {
    const { dir, manifestSha, page1 } = fixture();
    writeFileSync(path.join(dir, "page-0001.json"), `${page1}\n`);
    expect(() => loadRawPrintings(dir, manifestSha)).toThrow(/page-0001\.json: byteLength/);
  });
});

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDataSource } from "../src/data-source.js";
import type { DataRelease } from "../src/data-release.js";

const work = mkdtempSync(path.join(os.tmpdir(), "swu-data-source-"));
const quiet = (): void => undefined;
let archive: Buffer;
let release: DataRelease;
let server: Server;
let base: string;
let requests = 0;

function makeDir(name: string): string {
  const dir = path.join(work, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  const src = makeDir("fixture-src");
  mkdirSync(path.join(src, "llm"));
  writeFileSync(path.join(src, "llm/cards.toon"), "cards[0]:\n");
  const tarPath = path.join(work, "fixture.tar.gz");
  tar.create({ sync: true, gzip: true, file: tarPath, cwd: src, portable: true }, ["llm/cards.toon"]);
  archive = readFileSync(tarPath);
  release = {
    dataVersion: "2026-01-01",
    tag: "data-2026-01-01",
    asset: "fixture.tar.gz",
    url: "http://127.0.0.1:1/unreachable.tar.gz",
    sha256: createHash("sha256").update(archive).digest("hex"),
    bytes: archive.length,
    buildHash: "0".repeat(64),
  };
  server = createServer((req, res) => {
    requests += 1;
    if (req.url === "/start") {
      res.writeHead(302, { location: "/asset.tar.gz" }).end();
    } else if (req.url === "/asset.tar.gz") {
      res.writeHead(200, { "content-length": archive.length }).end(archive);
    } else if (req.url === "/tampered.tar.gz") {
      res.writeHead(200).end(Buffer.concat([archive.subarray(0, archive.length - 1), Buffer.from([archive.at(-1)! ^ 1])]));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  rmSync(work, { recursive: true, force: true });
});

describe("resolveDataSource", () => {
  it("prefers SWU_MCP_DATA over a local run and the cache", async () => {
    const repoRoot = makeDir("order-repo");
    mkdirSync(path.join(repoRoot, "data/runs/2026-02-02"), { recursive: true });
    const dir = await resolveDataSource({ env: { SWU_MCP_DATA: "/somewhere/else", SWU_MCP_CACHE: makeDir("order-cache") }, repoRoot, release, log: quiet });
    expect(dir).toBe("/somewhere/else");
  });

  it("uses the newest local run when running from a checkout", async () => {
    const repoRoot = makeDir("local-repo");
    for (const date of ["2026-01-05", "2026-03-09", "2026-02-02"]) mkdirSync(path.join(repoRoot, "data/runs", date), { recursive: true });
    const dir = await resolveDataSource({ env: { SWU_MCP_CACHE: makeDir("local-cache") }, repoRoot, release, log: quiet });
    expect(dir).toBe(path.join(repoRoot, "data/runs/2026-03-09"));
  });

  it("uses the cache when it holds the pinned version, without any network call", async () => {
    const cache = makeDir("cached");
    mkdirSync(path.join(cache, release.dataVersion, "llm"), { recursive: true });
    writeFileSync(path.join(cache, release.dataVersion, "llm/cards.toon"), "cards[0]:\n");
    const before = requests;
    const dir = await resolveDataSource({ env: { SWU_MCP_CACHE: cache }, repoRoot: makeDir("cached-repo"), release, log: quiet });
    expect(dir).toBe(path.join(cache, release.dataVersion));
    expect(requests).toBe(before);
  });

  it("downloads through a redirect, verifies, extracts into the cache and reuses it", async () => {
    const cache = path.join(work, "download-cache");
    const env = { SWU_MCP_CACHE: cache, SWU_MCP_DATA_URL: `${base}/start` };
    const messages: string[] = [];
    const dir = await resolveDataSource({ env, repoRoot: makeDir("download-repo"), release, log: (message) => messages.push(message) });
    expect(dir).toBe(path.join(cache, release.dataVersion));
    expect(readFileSync(path.join(dir, "llm/cards.toon"), "utf8")).toBe("cards[0]:\n");
    expect(readdirSync(cache)).toEqual([release.dataVersion]);
    expect(messages.some((message) => message.includes("downloading"))).toBe(true);
    const before = requests;
    await resolveDataSource({ env, repoRoot: makeDir("download-repo-2"), release, log: quiet });
    expect(requests).toBe(before);
  });

  it("rejects a download whose sha256 differs from the pin and creates no cache", async () => {
    const cache = path.join(work, "tampered-cache");
    const env = { SWU_MCP_CACHE: cache, SWU_MCP_DATA_URL: `${base}/tampered.tar.gz` };
    await expect(resolveDataSource({ env, repoRoot: makeDir("tampered-repo"), release, log: quiet })).rejects.toThrow(/sha256/);
    expect(existsSync(cache)).toBe(false);
  });

  it("rejects a download whose size differs from the pin", async () => {
    const cache = path.join(work, "size-cache");
    const env = { SWU_MCP_CACHE: cache, SWU_MCP_DATA_URL: `${base}/asset.tar.gz` };
    await expect(resolveDataSource({ env, repoRoot: makeDir("size-repo"), release: { ...release, bytes: archive.length + 10 }, log: quiet })).rejects.toThrow(/expected/);
    await expect(resolveDataSource({ env, repoRoot: makeDir("size-repo-2"), release: { ...release, bytes: archive.length - 1 }, log: quiet })).rejects.toThrow(/larger than the pinned/);
  });

  it("fails with a clear error when the server answers 404", async () => {
    const env = { SWU_MCP_CACHE: makeDir("404-cache"), SWU_MCP_DATA_URL: `${base}/missing` };
    await expect(resolveDataSource({ env, repoRoot: makeDir("404-repo"), release, log: quiet })).rejects.toThrow(/404/);
  });
});

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import envPaths from "env-paths";
import * as tar from "tar";
import { z } from "zod";
import { newestRun } from "./data.js";
import { loadDataRelease, type DataRelease } from "./data-release.js";
import { REPO_ROOT } from "./paths.js";

/**
 * @displayName Data source resolver
 * @strategicPurpose Seam gate for downloaded data: bytes from the network are checked against the sha256 and size
 * pinned in src/data-release.json before anything is extracted, so a wrong or tampered asset never reaches the server.
 * @tacticalObjective Picks the data directory: SWU_MCP_DATA, then the newest data/runs/<date> of a checkout, then a
 * per-user cache holding the pinned release (downloaded, verified, extracted to a temp dir, renamed into place).
 * Logs to stderr only; stdout is the MCP stream.
 */

export interface DataSourceOptions {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  release?: DataRelease;
  log?: (message: string) => void;
}

const envSchema = z.object({
  SWU_MCP_DATA: z.string().min(1).optional(),
  SWU_MCP_DATA_URL: z.url().optional(),
  SWU_MCP_CACHE: z.string().min(1).optional(),
});

const log = (message: string): void => console.error(`swu-mcp: ${message}`);

export function cacheRootOf(env: NodeJS.ProcessEnv): string {
  return envSchema.parse(env).SWU_MCP_CACHE ?? envPaths("swu-mcp", { suffix: "" }).cache;
}

const isComplete = (dir: string): boolean => existsSync(path.join(dir, "llm/cards.toon"));

export async function resolveDataSource(options: DataSourceOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const say = options.log ?? log;
  const parsed = envSchema.parse(env);
  if (parsed.SWU_MCP_DATA !== undefined) return path.resolve(parsed.SWU_MCP_DATA);

  const local = newestRun(path.join(options.repoRoot ?? REPO_ROOT, "data/runs"));
  if (local !== undefined) return local;

  const release = options.release ?? loadDataRelease();
  const cacheRoot = cacheRootOf(env);
  const target = path.join(cacheRoot, release.dataVersion);
  if (isComplete(target)) return target;

  await downloadRelease({ release, url: parsed.SWU_MCP_DATA_URL ?? release.url, cacheRoot, target, say });
  return target;
}

async function fetchVerified(release: DataRelease, url: string, say: (message: string) => void): Promise<Buffer> {
  say(`downloading data ${release.dataVersion} (${(release.bytes / 1e6).toFixed(1)} MB) from ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || response.body === null) throw new Error(`download failed: ${url} answered ${response.status} ${response.statusText}`);
  const chunks: Buffer[] = [];
  let received = 0;
  let nextReport = 0.25;
  for await (const chunk of response.body) {
    received += chunk.length;
    // The pin fixes the size, so stop reading a body that is already too long.
    if (received > release.bytes) throw new Error(`data download is larger than the pinned ${release.bytes} bytes; refusing it`);
    chunks.push(Buffer.from(chunk));
    if (received / release.bytes >= nextReport) {
      say(`downloaded ${Math.round((received / release.bytes) * 100)}%`);
      nextReport += 0.25;
    }
  }
  const body = Buffer.concat(chunks);
  if (body.length !== release.bytes) throw new Error(`data download is ${body.length} bytes, expected ${release.bytes} from src/data-release.json; nothing was extracted`);
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (sha256 !== release.sha256) throw new Error(`data download sha256 ${sha256} does not match the pinned ${release.sha256}; nothing was extracted`);
  return body;
}

async function downloadRelease(args: { release: DataRelease; url: string; cacheRoot: string; target: string; say: (message: string) => void }): Promise<void> {
  const { release, url, cacheRoot, target, say } = args;
  const body = await fetchVerified(release, url, say);
  mkdirSync(cacheRoot, { recursive: true });
  const staging = mkdtempSync(path.join(cacheRoot, `.staging-${release.dataVersion}-`));
  try {
    await pipeline(Readable.from([body]), tar.extract({ cwd: staging }));
    if (!isComplete(staging)) throw new Error("data archive does not contain llm/cards.toon");
    try {
      renameSync(staging, target);
    } catch (error) {
      // A concurrent first run may have installed the same verified data already.
      if (!isComplete(target)) throw error;
      rmSync(staging, { recursive: true, force: true });
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  say(`data ${release.dataVersion} cached at ${target}`);
}

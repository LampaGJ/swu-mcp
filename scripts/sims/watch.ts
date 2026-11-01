/**
 * @displayName sims:watch terminal view
 * @strategicPurpose One window onto every running simulation job, from any terminal (#178 of #104, D99).
 * @tacticalObjective Polls the heartbeats of the main checkout and every linked worktree (`git worktree list
 * --porcelain`) every 2 s and redraws the blocks src/sims/watch.ts renders; q or Ctrl-C quits. Off a terminal, or with
 * --once, it prints one frame and exits. It is a viewer, not a batch job, so it emits no progress of its own, and it
 * writes nothing. It reads the clock because it shows heartbeat ages; it produces no data.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/sims/watch.ts [--all] [--once] [--interval 2] [--no-color]
 */
import { parseArgs, styleText } from "node:util";
import { REPO_ROOT } from "../../src/paths.js";
import { isAlive, listSources } from "../../src/sims/sources.js";
import { discoverJobs, plain, renderScreen, type Paint, type Source } from "../../src/sims/watch.js";

const WORKTREE_REFRESH_MS = 30_000;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { all: { type: "boolean", default: false }, once: { type: "boolean", default: false }, interval: { type: "string", default: "2" }, "no-color": { type: "boolean", default: false } },
  });
  const tty = process.stdout.isTTY === true;
  const paint: Paint = tty && values["no-color"] !== true ? (f, t) => styleText(f, t) : plain;
  const frame = (sources: Source[]): string => {
    const nowMs = Date.now();
    const found = discoverJobs(sources, nowMs, isAlive);
    return `${renderScreen({ jobs: found.jobs, all: values.all === true, skipped: found.skipped, sources, nowMs, paint }).join("\n")}\n`;
  };

  let sources = await listSources(REPO_ROOT);
  if (values.once === true || !tty || !process.stdin.isTTY) {
    process.stdout.write(frame(sources));
    return;
  }

  const out = process.stdout;
  out.write("\x1b[?1049h\x1b[?25l");
  let refreshed = Date.now();
  const draw = (): void => {
    out.write(`\x1b[H${frame(sources).split("\n").map((l) => `${l}\x1b[K`).join("\n")}\x1b[J`);
    if (Date.now() - refreshed > WORKTREE_REFRESH_MS) {
      refreshed = Date.now();
      void listSources(REPO_ROOT).then((s) => {
        sources = s;
      });
    }
  };
  const timer = setInterval(draw, Math.max(0.5, Number(values.interval)) * 1000);
  const quit = (): void => {
    clearInterval(timer);
    out.write("\x1b[?25h\x1b[?1049l");
    process.stdin.setRawMode(false);
    process.exit(0);
  };
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (b) => {
    const k = b.toString();
    if (k === "q" || k === "Q" || k === "\x03") quit();
  });
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  draw();
}

await main();

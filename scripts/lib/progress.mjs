/**
 * progress.mjs — pollable heartbeat for long-running scripts.
 * Writes reports/.progress/<job>.json (latest snapshot, overwritten) + <job>.jsonl (append history),
 * so an agent/human can `cat reports/.progress/<job>.json` for live status without blocking or
 * parsing \r terminal output. Plain Node (Date.now allowed — this is NOT a Workflow script).
 *
 * Vendored copy of ~/.claude/lib/progress.mjs (LampaGJ/mault#52 review item 4): the
 * original lives outside this repo, so any committed script importing it by absolute
 * path only runs on this one machine. This copy is checked in so `pnpm score:capture-quality`
 * runs anywhere the repo is cloned, including CI/Docker.
 *
 *   import { progress } from './lib/progress.mjs';
 *   const p = progress('my-scan', { total: 80_000_000, everyN: 1_000_000 });
 *   for (...) { ...; p.tick(done, { found: out.length, phase: 'scan' }); }
 *   p.done({ found: out.length });
 *
 * Added for #178: every record also carries pid, games_per_s (done per second to two decimals; rate_per_s stays the
 * rounded integer) and moved_ts (when a tick, log or done last wrote). An extra may be a function, called only when a
 * record is written, so a costly payload (the sims live stats) is built once per write. With opts.keepAliveMs the
 * latest file is rewritten with a fresh ts on that interval (history untouched, timer unref'd) so a viewer can tell a
 * long batch from a dead process; moved_ts then tells a live process that is not moving.
 */
/* global setInterval, clearInterval */
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';

export function progress(job, opts = {}) {
  const { dir = 'reports/.progress', total = null, everyMs = 5000, everyN = null, keepAliveMs = null } = opts;
  mkdirSync(dir, { recursive: true });
  const latest = path.join(dir, `${job}.json`);
  const hist = path.join(dir, `${job}.jsonl`);
  const start = Date.now();
  let lastT = 0, lastN = 0, lastExtra = {}, movedAt = start, timer = null;
  const write = (done, extra, moved = true) => {
    const now = Date.now();
    if (moved) { movedAt = now; lastExtra = typeof extra === 'function' ? extra() : extra; }
    const rate = done / Math.max((now - start) / 1000, 0.001);
    const rec = {
      ts: new Date(now).toISOString(), job, done, total,
      pct: total ? Math.round((done / total) * 1000) / 10 : null,
      rate_per_s: Math.round(rate),
      games_per_s: Math.round(rate * 100) / 100,
      eta_s: total && rate ? Math.round((total - done) / rate) : null,
      elapsed_s: Math.round((now - start) / 1000),
      pid: process.pid,
      moved_ts: new Date(movedAt).toISOString(),
      ...lastExtra,
    };
    const line = JSON.stringify(rec);
    writeFileSync(latest, line + '\n');
    if (moved) appendFileSync(hist, line + '\n');
    return rec;
  };
  if (keepAliveMs) {
    timer = setInterval(() => write(lastN, lastExtra, false), keepAliveMs);
    timer.unref();
  }
  return {
    tick(done, extra = {}) {
      const now = Date.now();
      if ((everyN && done - lastN >= everyN) || (now - lastT >= everyMs)) { lastT = now; lastN = done; write(done, extra); }
    },
    log(extra = {}) { write(lastN, extra); },           // force-emit a phase/status line
    done(extra = {}) {
      if (timer) clearInterval(timer);
      write(total ?? lastN, () => ({ phase: 'done', ...(typeof extra === 'function' ? extra() : extra) }));
    },
  };
}

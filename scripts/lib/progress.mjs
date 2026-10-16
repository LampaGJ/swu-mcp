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
 */
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';

export function progress(job, opts = {}) {
  const { dir = 'reports/.progress', total = null, everyMs = 5000, everyN = null } = opts;
  mkdirSync(dir, { recursive: true });
  const latest = path.join(dir, `${job}.json`);
  const hist = path.join(dir, `${job}.jsonl`);
  const start = Date.now();
  let lastT = 0, lastN = 0;
  const write = (done, extra) => {
    const now = Date.now();
    const rate = done / Math.max((now - start) / 1000, 0.001);
    const rec = {
      ts: new Date(now).toISOString(), job, done, total,
      pct: total ? Math.round((done / total) * 1000) / 10 : null,
      rate_per_s: Math.round(rate),
      eta_s: total && rate ? Math.round((total - done) / rate) : null,
      elapsed_s: Math.round((now - start) / 1000),
      ...extra,
    };
    const line = JSON.stringify(rec);
    writeFileSync(latest, line + '\n');
    appendFileSync(hist, line + '\n');
    return rec;
  };
  return {
    tick(done, extra = {}) {
      const now = Date.now();
      if ((everyN && done - lastN >= everyN) || (now - lastT >= everyMs)) { lastT = now; lastN = done; write(done, extra); }
    },
    log(extra = {}) { write(lastN, extra); },           // force-emit a phase/status line
    done(extra = {}) { write(total ?? lastN, { phase: 'done', ...extra }); },
  };
}

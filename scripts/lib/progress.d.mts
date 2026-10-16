export interface Progress {
  tick(done: number, extra?: Record<string, unknown>): void;
  log(extra?: Record<string, unknown>): void;
  done(extra?: Record<string, unknown>): void;
}
export function progress(job: string, opts?: { dir?: string; total?: number | null; everyMs?: number; everyN?: number | null }): Progress;

/** An extra is spread into the record; a function is called only when a record is written. */
export type ProgressExtra = Record<string, unknown> | (() => Record<string, unknown>);

export interface ProgressOptions {
  dir?: string;
  total?: number | null;
  everyMs?: number;
  everyN?: number | null;
  /** Rewrite the latest file with a fresh ts on this interval (unref'd timer, history untouched). */
  keepAliveMs?: number | null;
}

export interface Progress {
  tick(done: number, extra?: ProgressExtra): void;
  log(extra?: ProgressExtra): void;
  done(extra?: ProgressExtra): void;
}

export function progress(job: string, opts?: ProgressOptions): Progress;

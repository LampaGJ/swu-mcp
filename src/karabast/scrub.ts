/**
 * @displayName Karabast identifier scrubber
 * @strategicPurpose Game streams may be kept for training and analysis, but player names, player ids and game ids
 * must never leave a git-ignored path or appear in output (owner ruling 2026-11-01, D102 on main). Scrubbing at the
 * socket seam, before a message is recorded or read by the bot, makes every stream identifier-free by construction,
 * and the decision layer replays from exactly what was kept.
 * @tacticalObjective Replaces every known identifier (user ids, the server's `anonymous <id prefix>` usernames,
 * learned usernames, lobby ids, game ids) with a stable token, in string values and object keys, longest first;
 * `leaks` lists any identifier still present, for the end-of-run check over every file written.
 */

export class Scrubber {
  private readonly pairs = new Map<string, string>();
  private ordered: [string, string][] = [];

  constructor(users: readonly { id: string; token: string }[]) {
    for (const u of users) {
      this.learn(u.id, u.token);
      this.learn(`anonymous ${u.id.slice(0, 6)}`, u.token);
    }
  }

  /** Adds an identifier; identifiers shorter than 6 characters are refused, because they would match card text. */
  learn(identifier: string, token: string): void {
    if (identifier.length < 6 || this.pairs.has(identifier)) return;
    this.pairs.set(identifier, token);
    this.ordered = [...this.pairs].sort((a, b) => b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1));
  }

  private text(s: string): string {
    let out = s;
    for (const [id, token] of this.ordered) if (out.includes(id)) out = out.split(id).join(token);
    return out;
  }

  /** A deep copy with every identifier replaced, in values and keys. */
  scrub<T>(value: T): T {
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") return this.text(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [this.text(k), walk(x)]));
      return v;
    };
    return walk(value) as T;
  }

  /** The identifiers that appear in `text`. */
  leaks(text: string): string[] {
    return this.ordered.filter(([id]) => text.includes(id)).map(([id]) => id);
  }
}

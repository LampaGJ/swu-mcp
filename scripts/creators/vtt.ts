export interface Cue {
  /** Cue start in seconds. */
  start: number;
  text: string;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

function timeToSeconds(stamp: string): number {
  const parts = stamp.split(":").map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** A YouTube auto-caption cue repeats the previous line, then adds the new one; a 10 ms cue repeats it again. */
const REPEAT_WINDOW = 2;

/**
 * Parses WebVTT into one cue per distinct caption line. Inline timing and styling tags are stripped, and a line equal
 * to one of the last REPEAT_WINDOW emitted lines is dropped, which removes the rolling auto-caption repeats while
 * keeping the start time of the line's first appearance.
 */
export function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of vtt.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const timing = lines.findIndex((line) => line.includes("-->"));
    if (timing < 0) continue;
    const startMatch = /^\s*((?:\d+:)?\d+:\d+(?:\.\d+)?)\s*-->/.exec(lines[timing]);
    if (startMatch === null) continue;
    const start = timeToSeconds(startMatch[1]);
    for (const raw of lines.slice(timing + 1)) {
      const text = raw
        .replace(/<[^>]*>/g, "")
        .replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, (entity) => ENTITIES[entity])
        .replace(/\s+/g, " ")
        .trim();
      if (text === "") continue;
      if (cues.slice(-REPEAT_WINDOW).some((cue) => cue.text === text)) continue;
      cues.push({ start, text });
    }
  }
  return cues;
}

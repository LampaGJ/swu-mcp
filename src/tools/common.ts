import { encode } from "@toon-format/toon";
import { z } from "zod";
import { splitCell, type CardRow, type CardStore } from "../data.js";
import type { ToolResult } from "../tools.js";

export function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: encode(value) }] };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export const round = (x: number, places: number): number => Math.round(x * 10 ** places) / 10 ** places || 0;

export const lower = (value: string | null | undefined): string => (value ?? "").toLowerCase();

export const cardRef = {
  cardKey: z.string().min(1).optional().describe("Exact cardKey, for example 0101033"),
  title: z.string().min(1).optional().describe("Exact card title, case-insensitive"),
  subtitle: z.string().optional().describe("Exact subtitle, case-insensitive; narrows a title shared by several leaders"),
};

export function resolveCard(store: CardStore, args: { cardKey?: string; title?: string; subtitle?: string }): CardRow | string {
  if (args.cardKey !== undefined) return store.byKey.get(args.cardKey) ?? `no card with cardKey ${args.cardKey}`;
  if (args.title === undefined) return "give cardKey, or title with an optional subtitle";
  const title = args.title.toLowerCase();
  const subtitle = args.subtitle?.toLowerCase();
  const matches = store.cards.filter((card) => lower(card.title) === title && (subtitle === undefined || lower(card.subtitle) === subtitle));
  if (matches.length === 0) return `no card titled "${args.title}"${args.subtitle === undefined ? "" : ` with subtitle "${args.subtitle}"`}`;
  if (matches.length > 1) return `"${args.title}" matches ${matches.length} cards (${matches.map((m) => `${m.cardKey} ${m.subtitle ?? ""}`.trim()).join("; ")}); pass the cardKey or a subtitle`;
  return matches[0];
}

export function hasValue(cell: string | null, wanted: string): boolean {
  const target = wanted.toLowerCase();
  return splitCell(cell).some((item) => item.toLowerCase() === target);
}

/** Builds a handler wrapper that turns a failing data load into a tool error instead of a thrown exception. */
export function guardedBy<D>(load: (store: CardStore) => D) {
  return (handler: (store: CardStore, data: D, input: unknown) => ToolResult): ((store: CardStore, input: unknown) => ToolResult) =>
    (store, input) => {
      let data: D;
      try {
        data = load(store);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
      return handler(store, data, input);
    };
}

import { encode } from "@toon-format/toon";
import { splitCell, type CardStore } from "../data.js";
import type { ToolResult } from "../tools.js";

export function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: encode(value) }] };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export const lower = (value: string | null | undefined): string => (value ?? "").toLowerCase();

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

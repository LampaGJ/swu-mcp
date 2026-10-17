import { encode } from "@toon-format/toon";
import { splitCell } from "../data.js";
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

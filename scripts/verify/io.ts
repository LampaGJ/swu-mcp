// Verify-local JSON loading. Imports only node:fs and zod, so the audit can share it without importing production code.
import { readFileSync } from "node:fs";
import { z } from "zod";

/** Every foreign file passes through here: a schema failure names the file and the offending path. */
export function parseAt<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${label}: ${z.prettifyError(result.error)}`);
  return result.data;
}

export const readJson = <T>(file: string, schema: z.ZodType<T>): T => parseAt(schema, JSON.parse(readFileSync(file, "utf8")), file);

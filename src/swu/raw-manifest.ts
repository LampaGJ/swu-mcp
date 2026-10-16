// Ported from mault packages/server/src/lib/adapters/swu/raw-cache.ts (swuRawCacheManifestSchema only).
import { z } from "zod";

/** `sha256` and `byteLength` describe the raw, uncompressed page body. */
export const swuRawCacheManifestSchema = z.strictObject({
  version: z.literal(1),
  label: z.string().min(1),
  baseUrl: z.string().min(1),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  complete: z.boolean(),
  pageCount: z.number().int().nonnegative(),
  pages: z.array(
    z.strictObject({
      page: z.number().int().positive(),
      url: z.string().min(1),
      status: z.number().int(),
      fetchedAt: z.iso.datetime(),
      byteLength: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
});
export type SwuRawCacheManifest = z.infer<typeof swuRawCacheManifestSchema>;

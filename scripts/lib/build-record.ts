import { z } from "zod";

/** The two fields every consumer of data/runs/<date>/build.json reads; other keys pass through. */
export const buildRecordSchema = z.looseObject({ date: z.iso.date(), buildHash: z.string().regex(/^[0-9a-f]{64}$/) });

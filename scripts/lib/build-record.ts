import { z } from "zod";
import { hex64 } from "../../src/schemas/hash.js";

/** The two fields every consumer of data/runs/<date>/build.json reads; other keys pass through. */
export const buildRecordSchema = z.looseObject({ date: z.iso.date(), buildHash: hex64 });

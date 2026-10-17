import { z } from "zod";

export const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

// Ported from mault packages/shared/src/adapters/swu/set-rotation.ts (JSDoc tags dropped).
export interface SwuSetRotation {
  block: string;
  releaseOrder: number;
}

// Source: https://starwarsunlimited.com/articles/updates-and-rotations
// Sets rotate out in batches of 3; SOR, SHD, TWI rotate out together when the seventh set (LAW) releases.
// Set 9 is Homeworlds (https://starwarsunlimited.com/products/set-9-homeworlds); that page gives no set
// code, so HMW is the code the synced catalogue uses.
const ROTATION_BY_SET: ReadonlyMap<string, SwuSetRotation> = new Map([
  ["SOR", { block: "year-1", releaseOrder: 1 }],
  ["SHD", { block: "year-1", releaseOrder: 2 }],
  ["TWI", { block: "year-1", releaseOrder: 3 }],
  ["JTL", { block: "year-2", releaseOrder: 4 }],
  ["LOF", { block: "year-2", releaseOrder: 5 }],
  ["SEC", { block: "year-2", releaseOrder: 6 }],
  ["LAW", { block: "year-3", releaseOrder: 7 }],
  ["ASH", { block: "year-3", releaseOrder: 8 }],
  ["HMW", { block: "year-3", releaseOrder: 9 }],
]);

/** The rotation block and release order of a set code, or null for a set not in the committed list. */
export function swuSetRotation(setCode: string): SwuSetRotation | null {
  return ROTATION_BY_SET.get(setCode.toUpperCase()) ?? null;
}

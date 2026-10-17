import { describe, expect, it } from "vitest";

import { sha256Hex } from "../../src/swu/canonical.js";

const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("sha256Hex", () => {
  it("hashes a string, a Buffer and an offset Uint8Array view by their own bytes", () => {
    expect(sha256Hex("abc")).toBe(ABC);
    expect(sha256Hex(Buffer.from("abc"))).toBe(ABC);
    const backing = Uint8Array.from(Buffer.from("xxabcyy"));
    const view = backing.subarray(2, 5);
    expect(view.byteOffset).toBe(2);
    expect(sha256Hex(view)).toBe(sha256Hex(Uint8Array.from(view)));
    expect(sha256Hex(view)).toBe(ABC);
  });
});

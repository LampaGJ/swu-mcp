import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BANNED = /Date\.now|new Date|Math\.random|localeCompare|\bIntl\./;

describe("synergy manipulation is free of nondeterminism hazards", () => {
  const files = [
    ...readdirSync(path.join(ROOT, "src/synergy")).map((f) => path.join(ROOT, "src/synergy", f)),
    path.join(ROOT, "src/tools/synergy.ts"),
    path.join(ROOT, "scripts/synergy.ts"),
  ];

  it.each(files)("%s has no clock, randomness or locale-sensitive call", (file) => {
    const code = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(BANNED);
  });
});

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codeCommit } from "../../scripts/lib/code-commit.js";

const roots: string[] = [];

function repo(): string {
  const root = mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "code-commit-"));
  roots.push(root);
  const run = (...args: string[]): void => {
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { stdio: "ignore" });
  };
  run("init", "-q");
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
  run("add", "src/a.ts");
  run("commit", "-q", "-m", "init");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("codeCommit", () => {
  it("an untracked file outside src leaves a src scope clean and makes whole-tree dirty", () => {
    const root = repo();
    writeFileSync(path.join(root, "notes.txt"), "x\n");
    expect(codeCommit(["src"], root)).toMatch(/^[0-9a-f]{40}$/);
    expect(codeCommit("whole-tree", root)).toMatch(/^[0-9a-f]{40}-dirty$/);
  });

  it("a modified tracked file under src makes a src scope dirty", () => {
    const root = repo();
    writeFileSync(path.join(root, "src/a.ts"), "export const a = 2;\n");
    expect(codeCommit(["src"], root)).toMatch(/^[0-9a-f]{40}-dirty$/);
  });
});

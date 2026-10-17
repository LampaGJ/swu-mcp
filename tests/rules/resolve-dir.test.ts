import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRulesDir } from "../../src/rules/store.js";
import { REPO_ROOT } from "./helpers.js";

function releaseLayout(): string {
  mkdirSync(path.join(REPO_ROOT, "tmp"), { recursive: true });
  const root = mkdtempSync(path.join(REPO_ROOT, "tmp/rules-layout-"));
  mkdirSync(path.join(root, "llm"));
  mkdirSync(path.join(root, "rules"));
  writeFileSync(path.join(root, "rules/sections.json"), "{}");
  return root;
}

describe("resolveRulesDir", () => {
  it("finds rules beside llm/ in a release package, the directory a loaded CardStore reports", () => {
    const root = releaseLayout();
    expect(resolveRulesDir(path.join(root, "llm"), {})).toBe(path.join(root, "rules"));
  });

  it("finds rules inside the package directory itself", () => {
    const root = releaseLayout();
    expect(resolveRulesDir(root, {})).toBe(path.join(root, "rules"));
  });

  it("lets SWU_MCP_RULES win", () => {
    const root = releaseLayout();
    expect(resolveRulesDir(path.join(root, "llm"), { SWU_MCP_RULES: "/elsewhere" })).toBe("/elsewhere");
  });
});

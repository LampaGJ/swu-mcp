import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "tmp", "data", "reports", "node_modules", "scripts/curation", "scripts/rubric", "scripts/embed"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["tests/**/*.ts"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
);

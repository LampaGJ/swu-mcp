import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".claude", "dist", "tmp", "data", "reports", "node_modules", "scripts/curation", "scripts/rubric", "scripts/embed"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["**/*.mjs"], languageOptions: { globals: { process: "readonly", console: "readonly" } } },
  { files: ["tests/**/*.ts"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
);

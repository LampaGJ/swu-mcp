// Bundles src/server.ts into one executable dist/server.js so `npx github:LampaGJ/swu-mcp` needs no runtime install step.
import { build } from "esbuild";
import { chmodSync } from "node:fs";

await build({
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
  // Some bundled CommonJS dependencies call require() on Node built-ins, which an ES module bundle does not define.
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);' },
  logLevel: "warning",
});
chmodSync("dist/server.js", 0o755);

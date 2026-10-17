import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CardStore } from "./data.js";
import { registerResources } from "./resources.js";
import { rulesFor } from "./rules/store.js";
import { TOOLS } from "./tools.js";

export function createServer(store: CardStore): McpServer {
  const server = new McpServer({ name: "swu-mcp", version: "0.1.0" });
  for (const [name, tool] of Object.entries(TOOLS)) {
    server.registerTool(
      name,
      { title: tool.title, description: tool.description, inputSchema: tool.shape, annotations: { readOnlyHint: true } },
      (args: unknown) => tool.handler(store, args),
    );
  }
  server.registerResource(
    "rules-core-primer",
    "rules://core-primer",
    {
      title: "Core rules primer",
      description: "Verbatim official text of the core Comprehensive Rules sections, each line prefixed by its section id. Read before searching.",
      mimeType: "text/markdown",
    },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: rulesFor(store.dataDir).primer }] }),
  );
  registerResources(server, store);
  return server;
}

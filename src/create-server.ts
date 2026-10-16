import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CardStore } from "./data.js";
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
  return server;
}

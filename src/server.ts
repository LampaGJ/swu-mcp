import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./create-server.js";
import { loadStore } from "./data.js";
import { resolveDataSource } from "./data-source.js";

const store = loadStore(await resolveDataSource());
console.error(`swu-mcp: ${store.cards.length} cards from ${store.dataDir}`);
await createServer(store).connect(new StdioServerTransport());

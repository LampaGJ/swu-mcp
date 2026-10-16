import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./create-server.js";
import { loadStore, resolveDataDir } from "./data.js";

const store = loadStore(resolveDataDir());
console.error(`swu-mcp: ${store.cards.length} cards from ${store.dataDir}`);
await createServer(store).connect(new StdioServerTransport());

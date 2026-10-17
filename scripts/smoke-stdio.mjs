// Starts an MCP server over stdio from the given command, lists its tools and calls data_version.
// Usage: node scripts/smoke-stdio.mjs <command> [args...]   (set SWU_MCP_DATA / SWU_MCP_CACHE in the environment as needed)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [command, ...args] = process.argv.slice(2);
if (command === undefined) throw new Error("usage: smoke-stdio.mjs <command> [args...]");
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command, args, env: { ...process.env }, stderr: "inherit" }));
const { tools } = await client.listTools();
const result = await client.callTool({ name: "data_version", arguments: {} });
const first = result.content[0];
console.log(`tools=${tools.length} data_version.isError=${result.isError === true}`);
console.log(first.type === "text" ? first.text.split("\n").slice(0, 4).join("\n") : first.type);
await client.close();

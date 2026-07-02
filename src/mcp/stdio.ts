import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initBackends } from "../backends.js";
import { buildMcpServer } from "./server.js";

/**
 * stdio entry point — for local MCP clients (Claude Desktop / Claude Code) that
 * launch the server as a subprocess. Nothing may be written to stdout except the
 * JSON-RPC stream, so all logging goes to stderr (see initBackends).
 */
async function main() {
  const backends = await initBackends();
  const server = buildMcpServer(backends);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] stdio server ready");
}

main().catch((err) => {
  console.error("[mcp] fatal:", err);
  process.exit(1);
});

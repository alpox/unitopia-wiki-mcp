import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { config } from "../config.js";
import { initBackends } from "../backends.js";
import { buildMcpServer } from "./server.js";

/**
 * Streamable-HTTP entry point — for remote MCP clients (ChatGPT / Gemini
 * connectors, and remote Claude). Backends load once; a fresh McpServer is bound
 * per session. Sessions are keyed by the `mcp-session-id` header the SDK issues
 * on `initialize`.
 */
async function main() {
  const backends = await initBackends();
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  // Client → server (initialize + tool calls).
  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport | undefined =
      sessionId ? transports[sessionId] : undefined;

    if (!transport) {
      if (sessionId || !isInitializeRequest(req.body)) {
        return res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: no valid session ID" },
          id: null,
        });
      }
      // New session: create a transport and bind a fresh server.
      const t = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = t;
        },
      });
      t.onclose = () => {
        if (t.sessionId) delete transports[t.sessionId];
      };
      await buildMcpServer(backends).connect(t);
      transport = t;
    }

    await transport.handleRequest(req, res, req.body);
  });

  // Server → client SSE stream (GET) and session teardown (DELETE).
  const bySession = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) return res.status(400).send("Invalid or missing session ID");
    await transport.handleRequest(req, res);
  };
  app.get("/mcp", bySession);
  app.delete("/mcp", bySession);

  app.listen(config.mcpPort, "0.0.0.0", () => {
    console.error(`[mcp] streamable-HTTP server on http://0.0.0.0:${config.mcpPort}/mcp`);
  });
}

main().catch((err) => {
  console.error("[mcp] fatal:", err);
  process.exit(1);
});

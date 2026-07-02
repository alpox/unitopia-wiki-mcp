import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Backends } from "../backends.js";
import * as tools from "./tools.js";

/** Wrap any JSON-serialisable result as an MCP text tool result. */
const json = (data: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});

/**
 * Build the Unitopia knowledgebase MCP server: a small, token-lean tool surface
 * over the shared retrieval/resolution backends. Descriptions are terse on
 * purpose — tool schemas sit in the client's context on every request.
 */
export function buildMcpServer(backends: Backends): McpServer {
  const server = new McpServer({
    name: "unitopia-kb",
    version: "1.0.0",
  });

  server.registerTool(
    "search",
    {
      title: "Search the knowledgebase",
      description:
        "Search the Unitopia wiki. Returns ranked hits as {id, title, snippet}. Snippets are short — call `fetch` with an id for the full page. Use only when you need wiki facts.",
      inputSchema: {
        query: z.string().describe("Natural-language search query (German)."),
        k: z.number().int().positive().max(20).optional().describe("Max hits (default 6)."),
      },
    },
    async (args) => json(await tools.search(backends, args)),
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch a full page",
      description:
        "Fetch the full body of one page by its `id` (conceptId from `search`). Also returns 1-hop neighbours and subpage variants as {id, title} to fetch next.",
      inputSchema: {
        id: z.string().describe("conceptId of the page (from a `search` hit)."),
        maxChars: z.number().int().positive().optional().describe("Truncate body (default 4000)."),
      },
    },
    async (args) => json(await tools.fetch(backends, args)),
  );

  server.registerTool(
    "list_category",
    {
      title: "List a category's members",
      description:
        "Answer 'list all X' questions. Returns matching categories with their members as {id, title}. If ambiguous, returns candidate category names to retry.",
      inputSchema: {
        query: z.string().describe("What to list, e.g. 'welche Gilden gibt es'."),
      },
    },
    async (args) => json(await tools.listCategory(backends, args)),
  );

  server.registerTool(
    "route",
    {
      title: "Compute a route between rooms",
      description:
        "Compute a deterministic in-game path from room `from` to room `to` (steps + copyable 'tue …' command + ASCII excerpt). If the rooms are ambiguous, returns candidate pages+rooms; re-call with `page` set to the chosen page.",
      inputSchema: {
        from: z.string().describe("Start room name."),
        to: z.string().describe("Destination room name."),
        page: z.string().describe("Optional area page (conceptId) to disambiguate.").optional(),
      },
    },
    async (args) => json(await tools.route(backends, args)),
  );

  server.registerTool(
    "map",
    {
      title: "Show an area map",
      description:
        "Render an ASCII sub-map for an area. Without `page` returns candidate pages and their named sub-maps; re-call with `page` and `anchor` (a sub-map name) to render one.",
      inputSchema: {
        area: z.string().describe("Area/region to show, e.g. 'Hafen'."),
        page: z.string().describe("Optional page (conceptId) to render.").optional(),
        anchor: z.string().describe("Optional sub-map name on that page.").optional(),
      },
    },
    async (args) => json(await tools.map(backends, args)),
  );

  return server;
}

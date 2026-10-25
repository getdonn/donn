// SSE-only MCP server (legacy HTTP+SSE transport): GET /sse, POST /messages. No Streamable HTTP.
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
const port = Number(process.env.PORT ?? 4020);
const transports = new Map();
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  console.log(`[mcp-sse] ${req.method} ${url.pathname}`);
  if (req.method === "GET" && url.pathname === "/sse") {
    const t = new SSEServerTransport("/messages", res);
    transports.set(t.sessionId, t);
    const s = new McpServer({ name: "sse-stub", version: "0.0.1" });
    s.tool("ping_stub", "Returns pong", { who: z.string().optional() }, async () => ({ content: [{ type: "text", text: "pong" }] }));
    await s.connect(t);
  } else if (req.method === "POST" && url.pathname === "/messages") {
    const t = transports.get(url.searchParams.get("sessionId"));
    if (!t) { res.writeHead(404).end(); return; }
    await t.handlePostMessage(req, res);
  } else { res.writeHead(404).end(); }
}).listen(port, "127.0.0.1", () => console.log(`[mcp-sse] listening ${port}`));

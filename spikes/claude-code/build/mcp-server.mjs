// Spike: minimal stdio MCP server exposing one tool. Throwaway.
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const results = {
  initialize: (p) => ({
    protocolVersion: p.protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: "zz-probe", version: "0.0.0" },
  }),
  "tools/list": () => ({
    tools: [{ name: "persona_ping", description: "Spike probe tool", inputSchema: { type: "object", properties: {} } }],
  }),
  "tools/call": () => ({ content: [{ type: "text", text: "pong: ZZ-MCP-CODEWORD" }] }),
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const handler = results[msg.method];
  send(handler ? { id: msg.id, result: handler(msg.params ?? {}) } : { id: msg.id, error: { code: -32601, message: "not found" } });
});

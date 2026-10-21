// A minimal stdio MCP server for the Codex e2e; reports whether ZZ_TOKEN reached it (never its value).
/* global process */
/* eslint-disable turbo/no-undeclared-env-vars -- the variable the e2e forwards */
import { createInterface } from "node:readline";

const send = (msg) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const token = process.env.ZZ_TOKEN
  ? `token-set-${process.env.ZZ_TOKEN.length}`
  : "token-unset";
const results = {
  initialize: (p) => ({
    protocolVersion: p.protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: "zz-probe", version: "0.0.0" },
  }),
  "tools/list": () => ({
    tools: [
      {
        name: "persona_ping",
        description: "Spike probe tool",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }),
  "tools/call": () => ({
    content: [{ type: "text", text: `pong: ZZ-MCP-CODEWORD ${token}` }],
  }),
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const handler = results[msg.method];
  send(
    handler
      ? { id: msg.id, result: handler(msg.params ?? {}) }
      : { id: msg.id, error: { code: -32601, message: "not found" } },
  );
});

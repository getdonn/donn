import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "http://127.0.0.1:4020/sse",
  description: "SSE-only stub MCP server (spike)",
});

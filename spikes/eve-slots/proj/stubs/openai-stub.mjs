// OpenAI-compatible /v1/chat/completions stub. First call per request: tool call eve__search; else text.
import http from "node:http";
const port = Number(process.env.PORT ?? 4010);
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let j = {}; try { j = JSON.parse(body); } catch {}
    const names = (j.tools ?? []).map((t) => t.function?.name);
    const sawTool = (j.messages ?? []).some((m) => m.role === "tool");
    console.log(`[openai-stub] ${req.method} ${req.url} model=${j.model} tools=${names.join(",")} sawTool=${sawTool} headers.x-donn=${req.headers["x-donn"]} auth=${req.headers.authorization}`);
    if (req.url.endsWith("/chat/completions")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: j.model };
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (!sawTool && names.includes("eve__search")) {
        send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "eve__search", arguments: JSON.stringify({ query: "ping stub" }) } }] } }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" } }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      send({ ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.end("data: [DONE]\n\n");
    } else { res.writeHead(404).end(); }
  });
}).listen(port, "127.0.0.1", () => console.log(`[openai-stub] listening ${port}`));

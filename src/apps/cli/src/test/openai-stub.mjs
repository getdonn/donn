// Test-only: an OpenAI-compatible /v1/chat/completions stub for the agent e2e (copied from
// spikes/eve-runner/runtime/proj/stubs/openai-stub.mjs; spikes are never imported). It streams
// the text "stubbed", or first calls tool $STUB_TOOL with $STUB_ARGS when offered, and logs the
// model, tools, tool results, Authorization and x-team per request. PORT=0 picks a free port;
// the first line names it.
/* eslint-disable turbo/no-undeclared-env-vars -- the stub's own settings, from the e2e */
import http from "node:http";

const port = Number(process.env.PORT ?? 4010);
const host = process.env.HOST ?? "127.0.0.1";
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let j = {};
    try {
      j = JSON.parse(body);
    } catch {
      // Not JSON: logged as is.
    }
    const names = (j.tools ?? []).map((t) => t.function?.name);
    const sawTool = (j.messages ?? []).some((m) => m.role === "tool");
    const toolMsg = (j.messages ?? [])
      .filter((m) => m.role === "tool")
      .map((m) => JSON.stringify(m.content).slice(0, 400));
    console.log(
      `[openai-stub] ${req.method} ${req.url} model=${j.model} tools=${names.join(",")} toolResults=${toolMsg.join(" | ")} x-team=${req.headers["x-team"]} auth=${req.headers.authorization}`,
    );
    if (!req.url.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const base = {
      id: "c1",
      object: "chat.completion.chunk",
      created: 1,
      model: j.model,
    };
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const tool = process.env.STUB_TOOL;
    if (tool && !sawTool && names.includes(tool)) {
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: {
                    name: tool,
                    arguments: process.env.STUB_ARGS ?? "{}",
                  },
                },
              ],
            },
          },
        ],
      });
      send({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      });
    } else {
      send({
        ...base,
        choices: [
          { index: 0, delta: { role: "assistant", content: "stubbed" } },
        ],
      });
      send({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
    }
    send({
      ...base,
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    res.end("data: [DONE]\n\n");
  });
});
server.listen(port, host, () =>
  console.log(`[openai-stub] listening ${host}:${server.address().port}`),
);

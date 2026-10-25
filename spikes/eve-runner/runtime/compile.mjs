// Spike: run the real @getdonn/adapter-eve compile into proj/, as `donn agent create` would.
// Usage: node compile.mjs <gatewayBaseURL> [target]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgs = join(here, "../../../src/packages");
const { default: adapter, patchAgentTs } = await import(
  join(pkgs, "adapters/eve/dist/index.js")
);
const { corpus } = await import(join(pkgs, "adapter-sdk/dist/conformance/index.js"));

const baseURL = process.argv[2] ?? "http://127.0.0.1:4010/v1";
const target = process.argv[3] ?? "local";
const proj = join(here, "proj");
const base = corpus.find((c) => c.name === "minimal").ir;

const output = adapter.compile({
  personaId: "team/solo",
  ir: {
    ...base,
    instructions: [{ id: "role", inline: "Answer briefly." }],
    models: {
      gateway: {
        type: "openai-compatible",
        baseURL,
        apiKey: "secret://spike/key",
        headers: { "x-team": "payments" },
      },
      default: "stub-model",
    },
    targets: { eve: { contextWindow: 128000 } },
    agents: {
      spike: { template: "eve:blank", target, path: "agents/spike", env: {} },
    },
  },
  agent: "spike",
  frameworkVersion: "0.83.2",
  texts: {},
  project: { hasSandbox: false, existing: ["agent/agent.ts"] },
});
for (const [path, file] of Object.entries(output.files)) {
  if (!("content" in file)) throw new Error(`unexpected copy: ${path}`);
  mkdirSync(dirname(join(proj, path)), { recursive: true });
  writeFileSync(join(proj, path), file.content);
}
const agentTs = join(proj, "agent/agent.ts");
const patched = patchAgentTs(readFileSync(agentTs, "utf8"));
if (patched.ok) writeFileSync(agentTs, patched.text);
console.log(JSON.stringify({ files: Object.keys(output.files), secretEnv: output.secretEnv,
  patched: patched.ok, report: output.report, portability: output.portability }, null, 2));

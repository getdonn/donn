// Throwaway: compile a minimal persona into a copy of kody-eve-template (a path template) with
// the built @getdonn/adapter-eve, write donn's slots and patch agent.ts, like `create` would.
//   node kody-slots.mjs <agentDir>
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const repo = new URL("../../../", import.meta.url).pathname;
const { default: adapter, patchAgentTs } = await import(
  join(repo, "src/packages/adapters/eve/dist/index.js")
);
const { corpus } = await import(join(repo, "src/packages/adapter-sdk/dist/conformance/index.js"));

const dir = process.argv[2];
const walk = (d) =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [relative(dir, p)];
  });
const existing = walk(join(dir, "agent"));

const base = corpus.find((c) => c.name === "minimal").ir;
const output = adapter.compile({
  personaId: "team/solo",
  ir: {
    ...base,
    instructions: [{ id: "role", inline: "Review against the project persona." }],
    models: {
      gateway: {
        type: "openai-compatible",
        baseURL: "http://127.0.0.1:4000/v1",
        apiKey: "secret://spike/key",
      },
      default: "stub-model",
    },
    targets: { eve: { contextWindow: 128000 } },
    agents: {
      kody: { template: "templates/kody", target: "self-host", path: "agents/kody", env: {} },
    },
  },
  agent: "kody",
  frameworkVersion: "0.83.2",
  texts: {},
  project: { hasSandbox: existing.includes("agent/sandbox.ts"), existing },
});
for (const [path, file] of Object.entries(output.files)) {
  if (!("content" in file)) throw new Error(`unexpected copy: ${path}`);
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), file.content);
}
const patched = patchAgentTs(readFileSync(join(dir, "agent/agent.ts"), "utf8"));
console.log("agent.ts patch:", patched.ok ? "ok" : patched.hint);
if (patched.ok) writeFileSync(join(dir, "agent/agent.ts"), patched.text);
console.log("files:", Object.keys(output.files).join(", "));
console.log("secretEnv:", Object.keys(output.secretEnv).join(", "));
console.log(
  "report:",
  JSON.stringify(
    [...(output.report?.entries ?? []), ...(output.portability ?? [])].map((e) => ({
      code: e.code,
      blocking: e.blocking,
      field: e.field ?? e.service,
      message: (e.message ?? e.reason ?? "").slice(0, 140),
    })),
    null,
    1,
  ),
);

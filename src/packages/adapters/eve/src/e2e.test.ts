import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { corpus } from "@getdonn/adapter-sdk/conformance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import adapter, { patchAgentTs } from "./index.js";

// Opt-in (DONN_E2E=1): compile a persona into a copy of a real eve template, run the real eve
// against a stub OpenAI-compatible gateway, send one HTTP-channel turn, and check the gateway
// saw the call with the configured key and header. Needs network (GitHub, npm) and the `gh`
// and `pnpm` CLIs. See docs/planning/24-adapter-eve.md, section 6.

const run = promisify(execFile);
const EVE = "0.83.2";
const TEMPLATE = "apps/templates/eve-slack-agent-template";
const KEY = "e2e-test-key";

interface Seen {
  url: string;
  model: string;
  authorization?: string;
  team?: string;
}

describe.skipIf(process.env.DONN_E2E !== "1")("e2e: real eve", () => {
  let dir = "";
  let gateway: Server | undefined;
  let eve: ChildProcess | undefined;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "donn-eve-e2e-"));
  });

  afterAll(async () => {
    if (eve?.pid !== undefined) {
      try {
        process.kill(-eve.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await new Promise<void>((done) =>
      gateway ? gateway.close(() => done()) : done(),
    );
    if (process.env.DONN_E2E_KEEP === "1") console.log(`kept ${dir}`);
    else if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("answers a turn through the configured gateway", async () => {
    // 1. The template at the pinned tag.
    const tree = JSON.parse(
      (
        await run(
          "gh",
          ["api", `repos/vercel/eve/git/trees/eve@${EVE}?recursive=1`],
          { maxBuffer: 64 * 1024 * 1024 },
        )
      ).stdout,
    ) as { tree: { path: string; type: string }[] };
    const files = tree.tree
      .filter((e) => e.type === "blob" && e.path.startsWith(`${TEMPLATE}/`))
      .map((e) => e.path.slice(TEMPLATE.length + 1));
    for (const file of files) {
      const { stdout } = await run(
        "gh",
        [
          "api",
          `repos/vercel/eve/contents/${TEMPLATE}/${file}?ref=eve@${EVE}`,
          "-H",
          "Accept: application/vnd.github.raw",
        ],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), stdout);
    }

    // The template's Slack channel needs Vercel Connect; this test is about the model route.
    rmSync(join(dir, "agent/channels"), { recursive: true, force: true });
    rmSync(join(dir, "pnpm-lock.yaml"));
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    delete pkg.packageManager;
    delete pkg.dependencies["@vercel/connect"];
    Object.assign(pkg.dependencies, {
      eve: EVE,
      ai: "^7.0.152",
      "@ai-sdk/openai-compatible": "^3",
    });
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));

    // 2. A stub gateway: records requests, answers a streamed chat completion.
    const seen: Seen[] = [];
    gateway = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk));
      req.on("end", () => {
        const json = JSON.parse(body || "{}") as { model?: string };
        seen.push({
          url: req.url ?? "",
          model: json.model ?? "",
          authorization: req.headers["authorization"],
          team: req.headers["x-team"] as string | undefined,
        });
        if (!req.url?.endsWith("/chat/completions")) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const base = {
          id: "c1",
          object: "chat.completion.chunk",
          created: 1,
          model: json.model,
        };
        const send = (o: object) => res.write(`data: ${JSON.stringify(o)}\n\n`);
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
        send({
          ...base,
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((ok) => gateway!.listen(0, "127.0.0.1", ok));
    const gatewayPort = (gateway.address() as AddressInfo).port;

    // 3. Compile, write donn's files, patch agent.ts.
    const base = corpus.find((c) => c.name === "minimal")!.ir;
    const output = adapter.compile({
      personaId: "team/solo",
      ir: {
        ...base,
        instructions: [{ id: "role", inline: "Answer briefly." }],
        models: {
          gateway: {
            type: "openai-compatible",
            baseURL: `http://127.0.0.1:${gatewayPort}/v1`,
            apiKey: "secret://e2e/key",
            headers: { "x-team": "payments" },
          },
          default: "stub-model",
        },
        targets: { eve: { contextWindow: 128000 } },
        agents: {
          e2e: {
            template: "eve:eve-slack-agent",
            target: "local",
            path: "agents/e2e",
            env: {},
          },
        },
      },
      agent: "e2e",
      frameworkVersion: EVE,
      texts: {},
      project: {
        hasSandbox: false,
        hasRouteAuth: files.some((f) =>
          /^agent\/channels\/eve(?:\.(?:ts|mts|js|mjs|cjs)|\/)/.test(f),
        ),
        existing: files.filter((f) => f.startsWith("agent/")),
      },
    });
    for (const [path, file] of Object.entries(output.files)) {
      if (!("content" in file)) throw new Error(`unexpected copy: ${path}`);
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), file.content);
    }
    const patched = patchAgentTs(
      readFileSync(join(dir, "agent/agent.ts"), "utf8"),
    );
    if (!patched.ok) throw new Error(patched.hint);
    writeFileSync(join(dir, "agent/agent.ts"), patched.text);
    const [keyName] = Object.keys(output.secretEnv);
    expect(keyName).toMatch(/^DONN_SECRET_/);

    // 4. Install. pnpm 12 can exit non-zero on ERR_PNPM_IGNORED_BUILDS after a complete install.
    try {
      await run("pnpm", ["install"], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      const text = String((error as { stderr?: string }).stderr ?? error);
      if (!text.includes("ERR_PNPM_IGNORED_BUILDS")) throw error;
    }

    // 5. eve dev (eve start refuses session routes with 401 outside dev).
    const port = 20000 + Math.floor(Math.random() * 20000);
    const log: string[] = [];
    eve = spawn(
      "pnpm",
      ["exec", "eve", "dev", "--no-ui", "--port", String(port)],
      {
        cwd: dir,
        detached: true,
        env: {
          ...process.env,
          // vitest sets NODE_ENV=test, which changes how eve runs.
          NODE_ENV: "development",
          [keyName!]: KEY,
          PORT: String(port),
        },
      },
    );
    eve.stdout?.on("data", (c: Buffer) => log.push(String(c)));
    eve.stderr?.on("data", (c: Buffer) => log.push(String(c)));
    const baseUrl = `http://127.0.0.1:${port}`;
    const until = async (what: string, ok: () => Promise<boolean>) => {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        if (await ok().catch(() => false)) return;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(
        `timed out waiting for ${what}\n${log.join("").slice(-3000)}`,
      );
    };
    await until("eve health", async () => {
      return (await fetch(`${baseUrl}/eve/v1/health`)).ok;
    });

    // 6. One HTTP-channel turn.
    let started = 0;
    let sessionId = "";
    await until("session accepted", async () => {
      const res = await fetch(`${baseUrl}/eve/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Say hello." }),
      });
      started = res.status;
      sessionId =
        ((await res.json().catch(() => ({}))) as { sessionId?: string })
          .sessionId ?? sessionId;
      return res.status === 202;
    });
    expect(started).toBe(202);
    try {
      await until("the gateway call", async () => seen.length > 0);
    } catch (error) {
      const stream = await fetch(
        `${baseUrl}/eve/v1/session/${sessionId}/stream?startIndex=0`,
        { signal: AbortSignal.timeout(5000) },
      )
        .then((r) => r.text())
        .catch((e: unknown) => `(stream unavailable: ${String(e)})`);
      throw new Error(
        `${String(error)}\nsession stream:\n${stream.slice(0, 3000)}`,
        { cause: error },
      );
    }

    const call = seen.find((s) => s.url.endsWith("/chat/completions"))!;
    expect(call.model).toBe("stub-model");
    expect(call.authorization).toBe(`Bearer ${KEY}`);
    expect(call.team).toBe("payments");
  }, 600_000);
});

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Probe } from "@getdonn/adapter-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEve } from "../test/fake-eve.js";
import { seed, zz, type Seeded } from "../test/seed.js";

// `donn agent env` and `donn agent exec` against a temp project and a path template.
// See docs/planning/25-agent-runner.md, sections 1 and 5.

const probe: Probe = {
  platform: process.platform,
  readFile: async () => undefined,
  listDir: async () => undefined,
  run: async (command, args) => {
    if (command === "npm" && args[1] === "eve")
      return { exitCode: 0, stdout: '["0.83.2"]', stderr: "" };
    return { exitCode: 1, stdout: "", stderr: `unexpected ${command}` };
  },
};

const PERSONA = (target: string, extra = "") => `apiVersion: donn/v0
kind: Persona
metadata:
  name: checkout-api
extends:
  - team/payments
instructions:
  - id: checkout-overview
    position: replace(payments-overview)
    inline: Checkout overview.
models:
  gateway:
    type: openai-compatible
    baseURL: https://llm.corp/v1
    apiKey: secret://env/GATEWAY_KEY
  default: gpt-5
agents:
  define:
    kody:
      template: ./templates/kody
      target: ${target}
${extra}      env:
        GREETING: hello
        API_TOKEN: secret://env/API_TOKEN
targets:
  eve:
    contextWindow: 128000
`;

let s: Seeded;
let spawner: ReturnType<typeof fakeEve>;
let env: Record<string, string>;
const put = (path: string, text: string) => {
  mkdirSync(dirname(join(s.repo, path)), { recursive: true });
  writeFileSync(join(s.repo, path), text);
};
const setup = (target = "local", extra = "") => {
  put(".donn/persona.yaml", PERSONA(target, extra));
};
beforeEach(() => {
  s = seed();
  env = { GATEWAY_KEY: "sk-gw-SECRET", API_TOKEN: "tok-SECRET" };
  put(".donn/templates/kody/package.json", '{ "name": "kody" }\n');
  put(
    ".donn/templates/kody/agent/agent.ts",
    'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-6-luna-fast" });\n',
  );
  spawner = fakeEve({
    replies: [
      {
        when: (c) => c.command === "pnpm",
        effect: (c) => {
          mkdirSync(join(c.cwd, "node_modules/eve"), { recursive: true });
        },
      },
    ],
  });
  setup();
});
afterEach(() => s.cleanup());

const run = (argv: string[], extraEnv: Record<string, string> = {}) => {
  // `--project` goes before any `--`: what follows it is the command's.
  const at = argv.indexOf("--");
  const ours = at === -1 ? argv : argv.slice(0, at);
  const rest = at === -1 ? [] : argv.slice(at);
  return zz(["agent", ...ours, "--project", s.repo, ...rest], {
    cwd: s.root,
    home: s.home,
    env: { ...env, ...extraEnv },
    probe,
    spawn: spawner,
  });
};
const create = async () => {
  const r = await run(["create", "kody"]);
  expect(r.stderr).not.toContain("error");
  expect(r.code).toBe(0);
};

describe("donn agent env", () => {
  it("prints names and refs, never a value, without --resolve", async () => {
    await create();
    const r = await run(["env", "kody"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("-SECRET");
    expect(r.stdout).toContain("API_TOKEN= # secret://env/API_TOKEN");
    expect(r.stdout).toContain("GREETING=hello");
    expect(r.stdout).toMatch(/AI_GATEWAY_API_KEY=|DONN_SECRET_1= # secret:/);
    expect(r.stdout).toContain(
      "# DONN_ROUTE_TOKEN: set at run time (route-auth)",
    );
    expect(r.stdout).not.toMatch(/^DONN_ROUTE_TOKEN=/m);
    const json = await run(["env", "kody", "--format", "json"]);
    expect(json.stdout).not.toContain("-SECRET");
    const entries = JSON.parse(json.stdout).env;
    expect(entries).toContainEqual({
      name: "API_TOKEN",
      source: "secret",
      ref: "secret://env/API_TOKEN",
      why: "persona-secret",
    });
    expect(entries).toContainEqual({
      name: "GREETING",
      source: "plain",
      value: "hello",
      why: "template-variable",
    });
    expect(entries).toContainEqual({
      name: "DONN_ROUTE_TOKEN",
      source: "runtime",
      why: "route-auth",
    });
    expect(entries.some((e: { why: string }) => e.why === "gateway-key")).toBe(
      true,
    );
  });

  it("--resolve prints the values", async () => {
    await create();
    const r = await run(["env", "kody", "--resolve"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("API_TOKEN=tok-SECRET");
    const json = await run(["env", "kody", "--resolve", "--json"]);
    expect(JSON.parse(json.stdout).env).toContainEqual({
      name: "API_TOKEN",
      source: "secret",
      ref: "secret://env/API_TOKEN",
      value: "tok-SECRET",
      why: "persona-secret",
    });
  });

  it("fails naming the variable and the ref when a secret does not resolve", async () => {
    await create();
    delete env.API_TOKEN;
    const r = await run(["env", "kody", "--resolve", "--json"]);
    expect(r.code).not.toBe(0);
    const error = JSON.parse(r.stdout).error ?? JSON.parse(r.stderr).error;
    expect(error.code).toBe("secret-unresolved");
    expect(error.failures).toEqual([
      expect.objectContaining({
        name: "API_TOKEN",
        ref: "secret://env/API_TOKEN",
      }),
    ]);
  });

  it("lists WORKFLOW_POSTGRES_URL for world: postgres", async () => {
    setup("self-host", "      world: postgres\n");
    await create();
    const r = await run(["env", "kody", "--json"]);
    expect(JSON.parse(r.stdout).env).toContainEqual({
      name: "WORKFLOW_POSTGRES_URL",
      source: "runtime",
      why: "world-database",
    });
  });

  it("--resolve writes run-time entries as comments only", async () => {
    setup("self-host", "      world: postgres\n");
    await create();
    const r = await run(["env", "kody", "--resolve"]);
    expect(r.stdout).not.toMatch(/^(DONN_ROUTE_TOKEN|WORKFLOW_POSTGRES_URL)=/m);
    expect(r.stdout).toContain(
      "# WORKFLOW_POSTGRES_URL: set at run time (world-database)",
    );
  });

  it("stops on an incomplete create and on a changed target", async () => {
    await create();
    const manifest = join(s.repo, "agents/kody/.donn/agent.json");
    const saved = readFileSync(manifest, "utf8");
    writeFileSync(
      manifest,
      JSON.stringify({ ...JSON.parse(saved), state: "incomplete" }),
    );
    const incomplete = await run(["env", "kody", "--json"]);
    expect(incomplete.stdout + incomplete.stderr).toContain("agent-incomplete");
    writeFileSync(manifest, saved);
    setup("self-host");
    const changed = await run(["env", "kody", "--json"]);
    expect(changed.stdout + changed.stderr).toContain("recreate-needed");
  });

  it("stops for an agent that was never created", async () => {
    const r = await run(["env", "kody", "--json"]);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("agent-not-created");
  });
});

describe("donn agent exec", () => {
  it("runs the command in the agent dir with the resolved env, returning its code", async () => {
    await create();
    spawner.calls.length = 0;
    const spawned = fakeEve({
      replies: [{ when: (c) => c.command === "echo", exitCode: 3 }],
    });
    spawner = spawned;
    const r = await run(["exec", "kody", "--", "echo", "hi"], {
      NODE_ENV: "test",
      DONN_ROUTE_TOKEN: "rt-1",
    });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(3);
    const call = spawned.calls.find((c) => c.command === "echo")!;
    expect(call.args).toEqual(["hi"]);
    expect(call.cwd).toBe(join(s.repo, "agents/kody"));
    expect(call.env.API_TOKEN).toBe("tok-SECRET");
    expect(call.env.GREETING).toBe("hello");
    expect(call.env.NODE_ENV).toBe("production");
    expect(call.env.DONN_ROUTE_TOKEN).toBe("rt-1");
    expect(r.stdout + r.stderr).not.toContain("tok-SECRET");
  });

  it("leaves DONN_ROUTE_TOKEN unset when the caller has none", async () => {
    await create();
    spawner = fakeEve();
    await run(["exec", "kody", "--", "true"]);
    expect(spawner.calls[0]!.env.DONN_ROUTE_TOKEN).toBeUndefined();
  });

  it("refuses to start with an unresolvable secret", async () => {
    await create();
    delete env.API_TOKEN;
    spawner = fakeEve();
    const r = await run(["exec", "kody", "--", "true"]);
    expect(r.code).not.toBe(0);
    expect(spawner.calls).toHaveLength(0);
  });

  it("forwards SIGTERM to the child and stops listening afterwards", async () => {
    await create();
    const kills: string[] = [];
    let finish: (code: number) => void = () => undefined;
    const calls: string[] = [];
    spawner = Object.assign(
      () => {
        calls.push("spawn");
        return {
          pid: 1,
          exited: new Promise<number>((resolve) => (finish = resolve)),
          kill: (signal?: string) => {
            kills.push(signal ?? "");
            finish(143);
          },
        };
      },
      { calls: [] },
    ) as unknown as ReturnType<typeof fakeEve>;
    const before = process.listenerCount("SIGTERM");
    const pending = run(["exec", "kody", "--", "serve"]);
    await vi.waitFor(() => expect(calls).toEqual(["spawn"]));
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    process.emit("SIGTERM");
    const r = await pending;
    expect(kills).toEqual(["SIGTERM"]);
    expect(r.code).toBe(143);
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("needs a command after --", async () => {
    await create();
    const r = await run(["exec", "kody"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("nothing to run");
  });
});

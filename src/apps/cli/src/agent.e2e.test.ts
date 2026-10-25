import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Opt-in (DONN_E2E=1; needs Docker, network and pnpm): `donn agent` with the built binary and
// real eve 0.83.2. Creates from `eve:blank` and from `eve:eve-slack-agent` (fetched at the tag,
// commit and digest verified), runs the blank agent through the daemon with one turn reaching a
// stub gateway, then builds a self-host agent, runs its image with `docker run --init` and the
// socket mounted, and sends one turn through the same stub. A temp DONN_HOME and project; the
// containers and images it makes are removed by name. See docs/planning/25-agent-runner.md §8.

const ENABLED = process.env.DONN_E2E === "1";
const PACKAGE = join(import.meta.dirname, "..");
const BIN = join(PACKAGE, "dist/bin.js");
const STUB = join(import.meta.dirname, "test/openai-stub.mjs");
const EVE = "0.83.2";
const SUFFIX = randomBytes(4).toString("hex");
const IMAGE = `donn-agent-e2e-${SUFFIX}`;
const CONTAINER = `donn-agent-e2e-${SUFFIX}`;
const KEY = `sk-e2e-${randomBytes(8).toString("hex")}`;
const KEY_VAR = "DONN_E2E_GATEWAY_KEY";
const ROUTE_TOKEN = randomBytes(16).toString("hex");
// Docker Desktop reaches the host's loopback through host.docker.internal; Linux needs the
// stub on every interface and the host-gateway alias.
const STUB_HOST = process.platform === "darwin" ? "127.0.0.1" : "0.0.0.0";

// Created in beforeAll, so a skipped run leaves nothing behind.
let work = "";
let home = "";
let project = "";
let stub: ChildProcess | undefined;
let stubPort = 0;
const stubLog: string[] = [];
let containersBefore = new Set<string>();
let imagesBefore = new Set<string>();

function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const persona = (baseURL: string) => `apiVersion: donn/v0
kind: Persona
metadata: { name: agent-e2e }
models:
  gateway:
    type: openai-compatible
    baseURL: ${baseURL}
    apiKey: secret://env/${KEY_VAR}
    headers: { x-team: payments }
  default: stub-model
agents:
  define:
    blank: { template: "eve:blank", target: local }
    slack: { template: "eve:eve-slack-agent", target: local }
    boxed: { template: "eve:blank", target: self-host }
targets:
  eve:
    contextWindow: 128000
`;

const donn = (args: string[], timeout = 600_000) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd: project,
    env: { ...process.env, DONN_HOME: home, [KEY_VAR]: KEY },
    encoding: "utf8",
    timeout,
  });

const json = (run: ReturnType<typeof donn>) => {
  expect(run.status, `${run.stdout}\n${run.stderr.slice(-4000)}`).toBe(0);
  return JSON.parse(run.stdout) as Record<string, unknown>;
};

const docker = (args: string[], options: { env?: NodeJS.ProcessEnv } = {}) =>
  spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 600_000,
    ...(options.env && { env: options.env }),
  });

const names = (args: string[]) =>
  new Set(
    docker(args)
      .stdout.split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );
const sandboxContainers = () =>
  names(["ps", "-a", "--filter", "name=eve-sbx-", "--format", "{{.Names}}"]);
const templateImages = () =>
  names([
    "image",
    "ls",
    "eve-sandbox-template",
    "--format",
    "{{.Repository}}:{{.Tag}}",
  ]);

async function until<T>(
  ms: number,
  check: () => T | undefined | Promise<T | undefined>,
): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== undefined || Date.now() >= deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** One turn: POST /eve/v1/session with the route token; the stub's request lines it caused. */
async function turn(url: string, token: string): Promise<string[]> {
  const from = stubLog.length;
  const refused = await fetch(new URL("eve/v1/session", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Say hello." }),
  });
  expect(refused.status).toBe(401);
  const response = await fetch(new URL("eve/v1/session", url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ message: "Say hello." }),
  });
  expect(await response.json()).toMatchObject({
    ok: true,
    status: "accepted",
  });
  // The stub asks for one bash call, so the turn opens the Docker sandbox, then answers.
  const lines = await until(120_000, () => {
    const seen = stubLog.slice(from).filter((l) => l.includes(" POST "));
    return seen.some((l) => l.includes('toolResults="')) ? seen : undefined;
  });
  expect(lines, stubLog.slice(from).join("\n")).toBeDefined();
  return lines!;
}

describe.skipIf(!ENABLED)("e2e: donn agent with real eve", () => {
  beforeAll(async () => {
    execFileSync("pnpm", ["build"], { cwd: PACKAGE, stdio: "ignore" });
    containersBefore = sandboxContainers();
    imagesBefore = templateImages();
    work = mkdtempSync(join(tmpdir(), "donn-agent-e2e-"));
    home = join(work, "home");
    project = join(work, "project");
    put(join(home, "config.yaml"), `personas: ${join(work, "personas")}\n`);
    mkdirSync(join(work, "personas"), { recursive: true });

    stub = spawn(process.execPath, [STUB], {
      env: {
        ...process.env,
        PORT: "0",
        HOST: STUB_HOST,
        STUB_TOOL: "bash",
        STUB_ARGS: JSON.stringify({ command: "uname -s" }),
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let rest = "";
    stub.stdout!.setEncoding("utf8");
    stub.stdout!.on("data", (chunk: string) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      stubLog.push(...lines);
    });
    const listening = await until(10_000, () =>
      stubLog
        .map((l) => /listening .*:(\d+)$/.exec(l)?.[1])
        .find((p) => p !== undefined),
    );
    stubPort = Number(listening);
    expect(stubPort).toBeGreaterThan(0);
    put(
      join(project, ".donn/persona.yaml"),
      persona(`http://127.0.0.1:${stubPort}/v1`),
    );
  }, 300_000);

  afterAll(() => {
    if (work !== "" && existsSync(home)) donn(["daemon", "stop"], 60_000);
    docker(["rm", "-f", CONTAINER]);
    docker(["rmi", "-f", IMAGE]);
    docker(["volume", "rm", "-f", `${CONTAINER}-eve`]);
    // Only what this run made: sandbox containers and template images that were not there.
    const containers = [...sandboxContainers()].filter(
      (c) => !containersBefore.has(c),
    );
    if (containers.length > 0) docker(["rm", "-f", ...containers]);
    const images = [...templateImages()].filter((i) => !imagesBefore.has(i));
    if (images.length > 0) docker(["rmi", ...images]);
    stub?.kill();
    if (work !== "") rmSync(work, { recursive: true, force: true });
  }, 120_000);

  it("creates from eve:blank and eve:eve-slack-agent at the pinned eve", () => {
    for (const [name, extra] of [
      ["blank", []],
      // Slack Connect is Vercel-only: blocking at local, so accepted for the create.
      ["slack", ["--accept-portability"]],
      ["boxed", []],
    ] as const) {
      const created = json(donn(["agent", "create", name, ...extra, "--json"]));
      expect(created.frameworkVersion).toBe(EVE);
      const dir = join(project, "agents", name);
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      expect(pkg.dependencies?.eve ?? pkg.devDependencies?.eve).toBe(EVE);
      expect(readFileSync(join(dir, "agent/agent.ts"), "utf8")).toContain(
        "...donn",
      );
      expect(existsSync(join(dir, ".git"))).toBe(false);
      expect(
        JSON.parse(readFileSync(join(dir, ".donn/agent.json"), "utf8")),
      ).toMatchObject({ state: "complete", frameworkVersion: EVE });
    }
    // The slack template is eve's own, not eve init's scaffold.
    expect(
      existsSync(join(project, "agents/slack/agent/channels/slack.ts")),
    ).toBe(true);
    const listed = json(donn(["agent", "list", "--json"])) as {
      agents: { name: string; state: string; current: boolean }[];
    };
    expect(listed.agents.map((a) => [a.name, a.state, a.current])).toEqual([
      ["blank", "created", true],
      ["boxed", "created", true],
      ["slack", "created", true],
    ]);
  }, 900_000);

  it("passes doctor's agent checks", () => {
    const run = donn(["doctor", "--json"], 120_000);
    const checks = (
      JSON.parse(run.stdout) as {
        checks: { id: string; status: string; message: string }[];
      }
    ).checks.filter((c) => c.id.startsWith("agent:"));
    expect(checks.length).toBe(15);
    expect(
      checks.filter((c) => c.status !== "ok"),
      JSON.stringify(checks, null, 2),
    ).toEqual([]);
  }, 180_000);

  it("runs the blank agent through the daemon; one turn reaches the gateway with the key and header", async () => {
    expect(donn(["daemon", "start"], 60_000).status).toBe(0);
    const ran = json(donn(["agent", "run", "blank", "--json"])) as {
      agent: { url: string; token: string };
    };
    expect(ran.agent.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const lines = await turn(ran.agent.url, ran.agent.token);
    for (const line of lines) {
      expect(line).toContain(`auth=Bearer ${KEY}`);
      expect(line).toContain("x-team=payments");
      expect(line).toContain("model=stub-model");
    }
    expect(json(donn(["agent", "stop", "blank", "--json"]))).toMatchObject({
      stopped: true,
    });
    expect(donn(["daemon", "stop"], 60_000).status).toBe(0);
  }, 900_000);

  it("builds the self-host agent; its image serves one turn through the gateway", async () => {
    // Inside the container the host's stub is host.docker.internal: a persona edit and a sync.
    put(
      join(project, ".donn/persona.yaml"),
      persona(`http://host.docker.internal:${stubPort}/v1`),
    );
    const synced = json(donn(["agent", "sync", "boxed", "--json"]));
    expect(synced.written).toEqual(["agent/lib/donn/config.ts"]);

    // A stale list of prepared images from an earlier build: eve build must not leave it.
    const dir = join(project, "agents/boxed");
    put(
      join(dir, ".output/.eve/compile/sandbox-prepared-artifacts.json"),
      JSON.stringify({
        entries: [
          {
            artifact: { imageReference: "eve-sandbox-template:stale-e2e" },
            nodeId: "__root__",
            providerName: "docker",
          },
        ],
        kind: "eve-sandbox-prepared-artifacts",
        version: 2,
      }),
    );
    const built = json(donn(["agent", "build", "boxed", "--json"])) as {
      sandboxImages: string[];
    };
    expect(built.sandboxImages).toHaveLength(1);
    expect(built.sandboxImages[0]).toMatch(/^eve-sandbox-template:/);
    expect(built.sandboxImages).not.toContain("eve-sandbox-template:stale-e2e");
    const envFile = JSON.parse(
      readFileSync(join(dir, "deploy/donn/env.json"), "utf8"),
    ) as { env: { name: string; source: string }[]; sandboxImage: string };
    expect(envFile.sandboxImage).toBe(built.sandboxImages[0]);

    const image = docker([
      "build",
      "-q",
      "-f",
      join(dir, "deploy/donn/Dockerfile"),
      "-t",
      IMAGE,
      dir,
    ]);
    expect(image.status, image.stderr).toBe(0);

    // The values the container needs, as `donn agent env --resolve` prints them; passed to
    // docker by name (`-e NAME`), never on its command line.
    const resolved = json(
      donn(["agent", "env", "boxed", "--resolve", "--format", "json"]),
    ) as { env: { name: string; value?: string }[] };
    const values: Record<string, string> = { DONN_ROUTE_TOKEN: ROUTE_TOKEN };
    for (const e of resolved.env)
      if (e.value !== undefined) values[e.name] = e.value;
    expect(Object.values(values)).toContain(KEY);
    const started = docker(
      [
        "run",
        "-d",
        "--init",
        "--name",
        CONTAINER,
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "-v",
        `${CONTAINER}-eve:/agent/.eve`,
        "-p",
        "127.0.0.1::3000",
        "--add-host",
        "host.docker.internal:host-gateway",
        ...Object.keys(values).flatMap((name) => ["-e", name]),
        IMAGE,
      ],
      { env: { ...process.env, ...values } },
    );
    expect(started.status, started.stderr).toBe(0);
    const port = docker(["port", CONTAINER, "3000"])
      .stdout.split("\n")[0]
      ?.trim();
    expect(port).toMatch(/^127\.0\.0\.1:\d+$/);
    const url = `http://${port}/`;
    const healthy = await until(60_000, async () => {
      const r = await fetch(new URL("eve/v1/health", url)).catch(
        () => undefined,
      );
      return r?.ok ? true : undefined;
    });
    expect(healthy, docker(["logs", CONTAINER]).stderr).toBe(true);
    const lines = await turn(url, ROUTE_TOKEN);
    for (const line of lines) {
      expect(line).toContain(`auth=Bearer ${KEY}`);
      expect(line).toContain("x-team=payments");
    }
    docker(["rm", "-f", CONTAINER]);
    docker(["volume", "rm", `${CONTAINER}-eve`]);
  }, 900_000);
});

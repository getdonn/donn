import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Probe } from "@getdonn/adapter-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentProbe,
  agentProject,
  createAgent,
  SECRETS,
} from "./test/created-agent.js";
import { fakeEve, type FakeEve } from "./test/fake-eve.js";
import { seed, zz, type Seeded } from "./test/seed.js";

// `donn doctor`'s lines per created agent. See docs/planning/25-agent-runner.md, section 7.

let s: Seeded;
beforeEach(() => {
  s = seed();
});
afterEach(() => s.cleanup());

const agentDir = () => join(s.repo, "agents/kody");
const read = (path: string) => readFileSync(join(agentDir(), path), "utf8");
const write = (path: string, text: string) =>
  writeFileSync(join(agentDir(), path), text);

/** agentProbe's answers, `docker info` as given, and claude/codex installed for the rest. */
function doctorProbe(docker: { exitCode: number; stderr?: string }): Probe & {
  dockerCalls: string[][];
} {
  const base = agentProbe();
  return {
    ...base,
    run: async (command, args) => {
      if (command === "docker") {
        base.dockerCalls.push(args);
        return {
          exitCode: docker.exitCode,
          stdout: docker.exitCode === 0 ? "28.3.3\n" : "",
          stderr: docker.stderr ?? "",
        };
      }
      if (command === "npm") return base.run(command, args);
      return { exitCode: 0, stdout: "2.1.306 (Claude Code)\n", stderr: "" };
    },
  };
}

type Fetch = typeof fetch;
const answering =
  (seen: string[] = []): Fetch =>
  async (input) => {
    seen.push(String(input));
    return new Response("not found", { status: 404 });
  };
const silent: Fetch = async () => {
  throw new TypeError("fetch failed");
};

type Check = { id: string; status: string; message: string; fix?: string };
async function doctor(
  options: {
    docker?: { exitCode: number; stderr?: string };
    fetch?: Fetch;
    spawn?: FakeEve;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const probe = doctorProbe(options.docker ?? { exitCode: 0 });
  const r = await zz(["doctor", "--json"], {
    cwd: s.repo,
    home: s.home,
    env: SECRETS,
    probe,
    fetch: options.fetch ?? answering(),
    spawn: options.spawn ?? fakeEve(),
    ...(options.sleep && { sleep: options.sleep }),
  });
  const checks = (JSON.parse(r.stdout) as { checks: Check[] }).checks;
  const agents = checks.filter((c) => c.id.startsWith("agent"));
  const byId = Object.fromEntries(agents.map((c) => [c.id, c]));
  return { r, checks, agents, byId, probe };
}

const LOCAL_IDS = [
  "agent:kody:eve",
  "agent:kody:docker",
  "agent:kody:gateway",
  "agent:kody:agent-ts",
  "agent:kody:files",
];

describe("donn doctor: created agents", () => {
  it("adds nothing without created agents", async () => {
    agentProject(s);
    const { agents } = await doctor();
    expect(agents).toEqual([]);
  });

  it("is all ok for a healthy local agent, after secrets", async () => {
    agentProject(s);
    await createAgent(s);
    const seen: string[] = [];
    const { checks, agents, probe } = await doctor({ fetch: answering(seen) });
    expect(agents.map((c) => c.id)).toEqual(LOCAL_IDS);
    expect(agents.every((c) => c.status === "ok")).toBe(true);
    const ids = checks.map((c) => c.id);
    expect(ids.indexOf("agent:kody:eve")).toBe(ids.indexOf("secrets") + 1);
    expect(agents[0]!.message).toContain("0.83.2");
    // The gateway answered (a 404 is an answer), at the persona's baseURL.
    expect(seen).toEqual(["https://llm.corp/v1"]);
    expect(probe.dockerCalls[0]?.[0]).toBe("info");
  });

  it("keeps a space between a long check id and its message", async () => {
    agentProject(s);
    await createAgent(s);
    const r = await zz(["doctor"], {
      cwd: s.repo,
      home: s.home,
      env: SECRETS,
      probe: doctorProbe({ exitCode: 0 }),
      fetch: answering(),
      spawn: fakeEve(),
    });
    expect(r.stdout).toMatch(/^ok {6}agent:kody:agent-ts agents\/kody\//m);
    expect(r.stdout).toMatch(/^ok {6}config {4}\//m);
  });

  it("errors on a pinned eve outside the adapter's range", async () => {
    agentProject(s);
    await createAgent(s);
    const pkg = JSON.parse(read("package.json"));
    pkg.dependencies.eve = "0.84.0";
    write("package.json", JSON.stringify(pkg));
    const { r, byId } = await doctor();
    expect(byId["agent:kody:eve"]).toMatchObject({ status: "error" });
    expect(byId["agent:kody:eve"]!.message).toContain("0.84.0");
    expect(byId["agent:kody:eve"]!.message).toContain(">=0.83.2 <0.84.0");
    expect(byId["agent:kody:eve"]!.fix).toBeDefined();
    expect(r.code).toBe(1);
  });

  it("warns when Docker is not reachable", async () => {
    agentProject(s);
    await createAgent(s);
    const { byId } = await doctor({
      docker: {
        exitCode: 1,
        stderr:
          "Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n",
      },
    });
    expect(byId["agent:kody:docker"]).toMatchObject({ status: "warn" });
    expect(byId["agent:kody:docker"]!.message).toContain(
      "Cannot connect to the Docker daemon",
    );
    expect(byId["agent:kody:docker"]!.fix).toBeDefined();
  });

  it("warns, never errors, when the gateway does not answer", async () => {
    agentProject(s);
    await createAgent(s);
    const { byId } = await doctor({ fetch: silent });
    expect(byId["agent:kody:gateway"]).toMatchObject({ status: "warn" });
    expect(byId["agent:kody:gateway"]!.message).toContain(
      "https://llm.corp/v1",
    );
  });

  it("skips the gateway when the persona no longer has one", async () => {
    agentProject(s);
    await createAgent(s);
    const file = join(s.repo, ".donn/persona.yaml");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(/models:\n(?: {2}.*\n)+/, ""),
    );
    const { byId } = await doctor({ fetch: silent });
    expect(byId["agent:kody:gateway"]).toMatchObject({ status: "skipped" });
  });

  it("errors when agent.ts no longer spreads donn", async () => {
    agentProject(s);
    await createAgent(s);
    expect(read("agent/agent.ts")).toContain("...donn");
    write(
      "agent/agent.ts",
      'import { defineAgent } from "eve";\nexport default defineAgent({ model: "x" });\n',
    );
    const { byId } = await doctor();
    expect(byId["agent:kody:agent-ts"]).toMatchObject({ status: "error" });
    expect(byId["agent:kody:agent-ts"]!.fix).toContain("...donn");
  });

  it("errors when agent.ts is not one donn recognises", async () => {
    agentProject(s);
    await createAgent(s);
    write("agent/agent.ts", "export default 1;\n");
    const { byId } = await doctor();
    expect(byId["agent:kody:agent-ts"]).toMatchObject({ status: "error" });
    expect(byId["agent:kody:agent-ts"]!.fix).toContain("...donn");
  });

  it("errors when a file of the manifest is missing", async () => {
    agentProject(s);
    await createAgent(s);
    const manifest = JSON.parse(read(".donn/agent.json"));
    const owned = Object.keys(manifest.files).sort()[0]!;
    rmSync(join(agentDir(), owned));
    const { byId } = await doctor();
    expect(byId["agent:kody:files"]).toMatchObject({ status: "error" });
    expect(byId["agent:kody:files"]!.message).toContain(owned);
    expect(byId["agent:kody:files"]!.fix).toContain("donn agent sync kody");
  });

  it("checks a vercel agent's Vercel CLI, and not Docker", async () => {
    agentProject(s, "vercel");
    await createAgent(s);
    const spawn = fakeEve({
      replies: [
        {
          when: (c) => c.args.includes("vercel"),
          lines: ["Vercel CLI 50.1.0", "50.1.0"],
        },
      ],
    });
    const { byId, agents } = await doctor({ spawn });
    expect(agents.map((c) => c.id)).toEqual([
      "agent:kody:eve",
      "agent:kody:gateway",
      "agent:kody:agent-ts",
      "agent:kody:files",
      "agent:kody:vercel",
    ]);
    expect(byId["agent:kody:vercel"]).toMatchObject({ status: "ok" });
    expect(byId["agent:kody:vercel"]!.message).toContain("50.1.0");
    expect(spawn.calls.at(-1)?.args).toEqual(["exec", "vercel", "--version"]);
    expect(spawn.calls.at(-1)?.cwd).toBe(agentDir());
  });

  it("warns when the Vercel CLI does not run", async () => {
    agentProject(s, "vercel");
    await createAgent(s);
    const spawn = fakeEve({
      replies: [
        {
          when: (c) => c.args.includes("vercel"),
          exitCode: 1,
          lines: ['Command "vercel" not found'],
        },
      ],
    });
    const { byId } = await doctor({ spawn });
    expect(byId["agent:kody:vercel"]).toMatchObject({ status: "warn" });
    expect(byId["agent:kody:vercel"]!.fix).toContain("pnpm install");
  });

  it("warns when the Vercel CLI does not answer in time, and stops it", async () => {
    agentProject(s, "vercel");
    await createAgent(s);
    const spawn = fakeEve({
      replies: [{ when: (c) => c.args.includes("vercel"), hold: true }],
    });
    const waits: number[] = [];
    const { byId } = await doctor({
      spawn,
      sleep: async (ms) => void waits.push(ms),
    });
    expect(byId["agent:kody:vercel"]).toMatchObject({ status: "warn" });
    expect(byId["agent:kody:vercel"]!.message).toContain("10s");
    expect(waits).toContain(10_000);
    expect(spawn.calls.at(-1)?.kills).toContain("SIGKILL");
  });

  it("errors when a vercel agent's package.json lost its vercel dev dependency", async () => {
    agentProject(s, "vercel");
    await createAgent(s);
    const pkg = JSON.parse(read("package.json"));
    delete pkg.devDependencies.vercel;
    write("package.json", JSON.stringify(pkg));
    const { byId } = await doctor();
    expect(byId["agent:kody:vercel"]).toMatchObject({ status: "error" });
    expect(byId["agent:kody:vercel"]!.fix).toContain("vercel@");
  });

  it("reports a manifest that does not parse on the agent's files line, and goes on", async () => {
    agentProject(s);
    await createAgent(s);
    writeFileSync(join(agentDir(), ".donn/agent.json"), "{ nope");
    const { agents, checks } = await doctor();
    expect(agents).toMatchObject([{ id: "agent:kody:files", status: "error" }]);
    expect(agents[0]!.message).toContain("agent.json");
    expect(agents[0]!.fix).toContain("donn agent create kody");
    expect(checks.map((c) => c.id)).toContain("managed");
  });

  it("errors on an agents index that cannot be read", async () => {
    agentProject(s);
    await createAgent(s);
    const index = join(s.home, "agents/index.json");
    rmSync(index);
    mkdirSync(index);
    const { agents, checks } = await doctor();
    expect(agents).toMatchObject([{ id: "agents", status: "error" }]);
    expect(agents[0]!.message).toContain("index.json");
    expect(checks.map((c) => c.id)).toContain("managed");
  });

  it("errors on an unreadable agents index", async () => {
    agentProject(s);
    await createAgent(s);
    writeFileSync(join(s.home, "agents/index.json"), "{ nope");
    const { agents, r } = await doctor();
    expect(agents).toMatchObject([{ id: "agents", status: "error" }]);
    expect(agents[0]!.fix).toContain("index.json");
    expect(r.code).toBe(1);
  });

  it("warns about a created agent its persona no longer declares", async () => {
    agentProject(s);
    await createAgent(s);
    const file = join(s.repo, ".donn/persona.yaml");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(/agents:\n[\s\S]*?(?=targets:)/, ""),
    );
    const { agents } = await doctor();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: "agent:kody:orphan",
      status: "warn",
    });
    expect(agents[0]!.fix).toContain("agents/kody");
    expect(agents[0]!.fix).toContain("index.json");
  });
});

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Probe } from "@getdonn/adapter-sdk";
import {
  AgentAddOutput,
  AgentBuildOutput,
  AgentCreateOutput,
  AgentDeployOutput,
  AgentEnvOutput,
  AgentListOutput,
  AgentLogsOutput,
  AgentRunOutput,
  AgentStopOutput,
  AgentSyncOutput,
  AgentTemplatesOutput,
  COMMAND_OUTPUTS,
  CapabilitiesOutput,
  CompileOutput,
  DiffOutput,
  DoctorOutput,
  ErrorEnvelope,
  ListOutput,
  LoginOutput,
  LogoutOutput,
  ManagedBuildOutput,
  ManagedCheckOutput,
  PublishOutput,
  PullOutput,
  ResolveExplainOutput,
  ResolveOutput,
  StatusOutput,
  SwitchOutput,
  WhoamiOutput,
  WriteOutput,
} from "@getdonn/cli-schemas";
import { startMockRegistry } from "@getdonn/registry-api/mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { agentLogPath } from "./agent/run.js";
import { createCli } from "./cli.js";
import {
  agentProbe,
  agentProject,
  createAgent,
  installingEve,
  SECRETS,
  START_LINES,
} from "./test/created-agent.js";
import {
  COMPLETED,
  INPUT_REQUIRED,
  PREREQUISITE,
  SECRET_PREREQUISITE,
} from "./test/eve-add/recordings.js";
import { fakeEve, type FakeEve } from "./test/fake-eve.js";
import {
  installedProbe,
  safeManaged,
  seed,
  zz,
  type Seeded,
} from "./test/seed.js";

// The --json output of every command the GUI's bridge allows, parsed with the schemas of
// @getdonn/cli-schemas (docs/planning/26-gui.md section 4). The schemas are strict: a field the
// CLI adds fails here until the schema learns it.

/** Keys of COMMAND_OUTPUTS a real run has parsed, checked against the whole table at the end. */
const covered = new Set<string>();

/** Parses `stdout` as the output of `key` (and as nothing looser) and returns it. */
function parses(key: string, stdout: string): unknown {
  const schema = (COMMAND_OUTPUTS as Record<string, z.ZodType | undefined>)[
    key
  ];
  expect(schema, `COMMAND_OUTPUTS has "${key}"`).toBeDefined();
  const value: unknown = JSON.parse(stdout);
  covered.add(key);
  return schema!.parse(value);
}

const errorOf = (stdout: string) => ErrorEnvelope.parse(JSON.parse(stdout));

let s: Seeded;
beforeEach(() => {
  s = seed();
});
afterEach(() => s.cleanup());

const here = (extra: Partial<Parameters<typeof zz>[1]> = {}) => ({
  cwd: s.repo,
  home: s.home,
  ...extra,
});

describe("persona commands", () => {
  it("list", async () => {
    const r = await zz(["list", "--json"], here());
    expect(r.code).toBe(0);
    const out = parses("list", r.stdout) as {
      personas: { path?: string }[];
    };
    expect(out.personas.length).toBeGreaterThan(0);
    for (const persona of out.personas)
      expect(persona.path ?? "/").toMatch(/^\//);
    expect(ListOutput).toBe(COMMAND_OUTPUTS["list"]);
  });

  it("resolve (and --explain, which --json answers the same way)", async () => {
    const r = await zz(["resolve", "--json"], here());
    expect(r.code, r.stderr).toBe(0);
    parses("resolve", r.stdout);
    const explain = await zz(["resolve", "--explain", "--json"], here());
    expect(JSON.parse(explain.stdout)).toEqual(JSON.parse(r.stdout));
    expect(ResolveExplainOutput).toBe(ResolveOutput);
    // A user overlay and a named persona resolve the same shape.
    const named = await zz(
      ["resolve", "team/payments", "--no-overlay", "--json"],
      here(),
    );
    expect(named.code, named.stderr).toBe(0);
    parses("resolve", named.stdout);
  });

  it("compile, and compile --dry-run", async () => {
    const r = await zz(["compile", "--json"], here());
    expect(r.code, r.stderr).toBe(0);
    const out = parses("compile", r.stdout) as { plan: { steps: unknown[] } };
    expect(out.plan.steps.length).toBeGreaterThan(0);
    const dry = await zz(["compile", "--dry-run", "--json"], here());
    expect(dry.code, dry.stderr).toBe(0);
    parses("compile", dry.stdout);
    const codex = await zz(["compile", "--harness", "codex", "--json"], here());
    expect(codex.code, codex.stderr).toBe(0);
    parses("compile", codex.stdout);
    const agents = await zz(
      ["compile", "--harness", "agents-md", "--json"],
      here(),
    );
    expect(agents.code, agents.stderr).toBe(0);
    parses("compile", agents.stdout);
    expect(CompileOutput).toBe(COMMAND_OUTPUTS["compile"]);
  });

  it("capabilities, with and without --detect, and for one harness", async () => {
    for (const args of [[], ["--detect"], ["--harness", "codex"]]) {
      const r = await zz(["capabilities", ...args, "--json"], here());
      expect(r.code, r.stderr).toBe(0);
      parses("capabilities", r.stdout);
    }
    expect(CapabilitiesOutput).toBe(COMMAND_OUTPUTS["capabilities"]);
  });

  it("diff", async () => {
    const r = await zz(["diff", "org/base", "team/payments", "--json"], here());
    expect(r.code, r.stderr).toBe(0);
    const out = parses("diff", r.stdout) as { changes: unknown[] };
    expect(out.changes.length).toBeGreaterThan(0);
    const same = await zz(["diff", "team/payments", "--json"], here());
    expect(same.code, same.stderr).toBe(0);
    parses("diff", same.stdout);
    expect(DiffOutput).toBe(COMMAND_OUTPUTS["diff"]);
  });

  it("switch: show, set, set the default, clear", async () => {
    const shows = await zz(["switch", "--json"], here());
    expect(shows.code, shows.stderr).toBe(0);
    parses("switch", shows.stdout);

    const none = await zz(["switch", "--default", "--json"], here());
    expect(none.code, none.stderr).toBe(0);
    expect(JSON.parse(none.stdout)).toEqual({
      persona: null,
      source: "default",
    });
    parses("switch", none.stdout);

    const set = await zz(["switch", "org/base", "--json"], here());
    expect(set.code, set.stderr).toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({
      scope: "project",
      persona: "org/base",
    });
    parses("switch", set.stdout);

    const shown = await zz(["switch", "--json"], here());
    expect(JSON.parse(shown.stdout)).toMatchObject({ source: "switch" });
    parses("switch", shown.stdout);

    const def = await zz(["switch", "--default", "org/base", "--json"], here());
    expect(def.code, def.stderr).toBe(0);
    parses("switch", def.stdout);
    parses(
      "switch",
      (await zz(["switch", "--default", "--json"], here())).stdout,
    );

    const cleared = await zz(["switch", "--clear", "--json"], here());
    expect(cleared.code, cleared.stderr).toBe(0);
    expect(JSON.parse(cleared.stdout)).toMatchObject({ persona: "org/base" });
    parses("switch", cleared.stdout);

    const nothing = await zz(["switch", "--clear", "--json"], here());
    expect(JSON.parse(nothing.stdout)).toEqual({
      scope: "project",
      persona: null,
    });
    parses("switch", nothing.stdout);
    expect(SwitchOutput).toBe(COMMAND_OUTPUTS["switch"]);
  });

  it("write: created, unchanged, stale (--check) and removed", async () => {
    for (const [args, status] of [
      [[], "created"],
      [[], "unchanged"],
      [["--check"], "unchanged"],
      [["--remove"], "removed"],
      [["--check"], "stale"],
    ] as const) {
      const r = await zz(
        ["write", "--harness", "agents-md", ...args, "--json"],
        here(),
      );
      expect(JSON.parse(r.stdout)).toMatchObject({ status });
      parses("write", r.stdout);
    }
    expect(WriteOutput).toBe(COMMAND_OUTPUTS["write"]);
  });

  it("doctor", async () => {
    const r = await zz(["doctor", "--json"], here());
    const out = parses("doctor", r.stdout) as { checks: unknown[] };
    expect(out.checks.length).toBeGreaterThan(0);
    const fixed = await zz(["doctor", "--fix", "--json"], here());
    parses("doctor", fixed.stdout);
    expect(DoctorOutput).toBe(COMMAND_OUTPUTS["doctor"]);
  });

  it("status without a daemon", async () => {
    const r = await zz(["status", "--json"], here());
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ daemon: false });
    parses("status", r.stdout);
    expect(StatusOutput).toBe(COMMAND_OUTPUTS["status"]);
  });
});

// A locked org layer, the way managed.test.ts builds one.
const ORG = `apiVersion: donn/v0
kind: Persona
metadata: { name: acme }
instructions:
  - id: conduct
    inline: Review kindly.
permissions:
  deny: ["Bash(rm -rf:*)"]
locks:
  - permissions.deny
  - instructions[conduct]
`;

describe("managed commands", () => {
  const machine = (org: string) => {
    mkdirSync(join(s.personas, "org"), { recursive: true });
    writeFileSync(join(s.personas, "org/acme.yaml"), org);
  };

  it("managed build, and managed check", async () => {
    machine(ORG);
    const out = join(s.root, "bundle");
    const r = await zz(
      [
        "managed",
        "build",
        "--layer",
        "org/acme",
        "--os",
        "linux",
        "--out",
        out,
        "--json",
      ],
      here(),
    );
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ out });
    parses("managed build", r.stdout);

    // Nothing locked enforces nothing: a notice.
    machine(ORG.replace(/locks:[\s\S]*$/, ""));
    const quiet = await zz(
      [
        "managed",
        "build",
        "--layer",
        "org/acme",
        "--os",
        "linux",
        "--out",
        join(s.root, "quiet"),
        "--json",
      ],
      here(),
    );
    expect(JSON.parse(quiet.stdout)).toHaveProperty("notice");
    parses("managed build", quiet.stdout);

    const check = await zz(["managed", "check", "--json"], here());
    expect(check.code).toBe(1);
    expect(JSON.parse(check.stdout)).toMatchObject({ state: "missing" });
    parses("managed check", check.stdout);
    expect(ManagedBuildOutput).toBe(COMMAND_OUTPUTS["managed build"]);
    expect(ManagedCheckOutput).toBe(COMMAND_OUTPUTS["managed check"]);
  });

  it("managed build refused: report and out: null", async () => {
    machine(
      ORG.replace(
        "locks:",
        "mcp:\n  servers:\n    vault:\n      url: https://x.example/mcp\n      headers:\n        Authorization: secret://vault/token\nlocks:\n  - mcp.servers.vault",
      ),
    );
    const r = await zz(
      [
        "managed",
        "build",
        "--layer",
        "org/acme",
        "--os",
        "linux",
        "--out",
        join(s.root, "refused"),
        "--json",
      ],
      here(),
    );
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ out: null });
    parses("managed build", r.stdout);
  });
});

// ---- the registry -------------------------------------------------------------------------

const EXAMPLES = join(import.meta.dirname, "../../../../examples/personas");
const TOKEN = "tok-schema-check-9f3a";
const noKeychain: Probe = { ...installedProbe, platform: "win32" };

describe("registry commands", () => {
  let registry: Awaited<ReturnType<typeof startMockRegistry>>;
  let root: string;
  let home: string;
  let cwd: string;
  beforeEach(async () => {
    registry = await startMockRegistry({ token: TOKEN });
    root = mkdtempSync(join(tmpdir(), "donn-schemas-"));
    home = join(root, "home");
    cwd = join(root, "cwd");
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    cpSync(EXAMPLES, join(root, "personas"), { recursive: true });
    writeFileSync(
      join(home, "config.yaml"),
      `personas: ${join(root, "personas")}\nregistry:\n  url: ${registry.url}\n`,
    );
  });
  afterEach(async () => {
    await registry.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const run = (
    argv: string[],
    extra: Partial<Parameters<typeof zz>[1]> & { token?: string | false } = {},
  ) => {
    const { token = TOKEN, env, ...rest } = extra;
    return zz(argv, {
      cwd,
      home,
      secretProbe: noKeychain,
      ...rest,
      env: { ...(token !== false && { DONN_REGISTRY_TOKEN: token }), ...env },
    });
  };

  it("whoami: signed out and signed in", async () => {
    const out = await run(["whoami", "--json"], { token: false });
    expect(JSON.parse(out.stdout)).toEqual({ loggedIn: false });
    parses("whoami", out.stdout);
    const who = await run(["whoami", "--json"]);
    expect(who.code, who.stderr).toBe(0);
    expect(JSON.parse(who.stdout)).toMatchObject({ loggedIn: true });
    parses("whoami", who.stdout);
    expect(WhoamiOutput).toBe(COMMAND_OUTPUTS["whoami"]);
  });

  it("login with a token, login through the browser, logout", async () => {
    const token = await run(
      ["login", registry.url, "--token-stdin", "--json"],
      {
        token: false,
        stdin: async () => `${TOKEN}\n`,
      },
    );
    expect(token.code, token.stderr).toBe(0);
    expect(JSON.parse(token.stdout)).toHaveProperty("tokenStore");
    parses("login", token.stdout);

    let stdout = "";
    let stderr = "";
    const cli = createCli({
      env: { DONN_NO_DAEMON: "1", DONN_HOME: home },
      cwd,
      stdout: { write: (text: string) => (stdout += text) },
      stderr: { write: (text: string) => (stderr += text) },
      probe: installedProbe,
      secretProbe: noKeychain,
      managed: safeManaged(),
      // The first wait finishes the sign-in as alice, at the link the CLI printed.
      sleep: async () => {
        const link = /Open (\S+) and confirm/.exec(stderr)![1]!;
        registry.completeLogin(link, { email: "alice@corp.com" });
      },
    });
    const browser = {
      code: await cli.run(["login", registry.url, "--no-browser", "--json"]),
      stdout,
      stderr,
    };
    expect(browser.code, browser.stderr).toBe(0);
    expect(JSON.parse(browser.stdout)).toHaveProperty("expiresAt");
    parses("login", browser.stdout);
    expect(LoginOutput).toBe(COMMAND_OUTPUTS["login"]);

    const out = await run(["logout", "--json"], { token: false });
    expect(JSON.parse(out.stdout)).toEqual({ loggedOut: true });
    parses("logout", out.stdout);
    const again = await run(["logout", "--json"], { token: false });
    expect(JSON.parse(again.stdout)).toEqual({ loggedOut: false });
    parses("logout", again.stdout);
    expect(LogoutOutput).toBe(COMMAND_OUTPUTS["logout"]);
  });

  it("publish (dry run, new, unchanged) and pull", async () => {
    const dry = await run(["publish", "org/acme", "--dry-run", "--json"]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({ dryRun: true });
    parses("publish", dry.stdout);

    const first = await run(["publish", "org/acme", "--json"]);
    expect(first.code, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ version: 1 });
    parses("publish", first.stdout);

    const same = await run(["publish", "org/acme", "--json"]);
    expect(JSON.parse(same.stdout)).toMatchObject({ unchanged: true });
    parses("publish", same.stdout);
    expect(PublishOutput).toBe(COMMAND_OUTPUTS["publish"]);

    // A cache that has not seen the layer yet.
    rmSync(join(home, "cache"), { recursive: true, force: true });
    const pulled = await run(["pull", "--json"]);
    expect(pulled.code, pulled.stderr).toBe(0);
    const out = parses("pull", pulled.stdout) as { changes: unknown[] };
    expect(out.changes.length).toBeGreaterThan(0);
    parses("pull", (await run(["pull", "--json"])).stdout);
    expect(PullOutput).toBe(COMMAND_OUTPUTS["pull"]);

    // A layer that now resolves from the registry cache has no file to edit.
    const listed = parses("list", (await run(["list", "--json"])).stdout) as {
      personas: { ref: string; source: string; path?: string }[];
    };
    const acme = listed.personas.find((p) => p.ref === "org/acme")!;
    expect(acme.source).toBe("registry");
    expect(acme).not.toHaveProperty("path");
  });
});

// ---- agents -------------------------------------------------------------------------------

describe("agent commands", () => {
  const agent = (
    argv: string[],
    extra: Partial<Parameters<typeof zz>[1]> = {},
  ) =>
    zz(["agent", ...argv, "--project", s.repo, "--json"], {
      cwd: s.root,
      home: s.home,
      env: SECRETS,
      probe: agentProbe(),
      spawn: fakeEve(),
      ...extra,
    });

  it("create --dry-run and create", async () => {
    agentProject(s);
    const dry = await agent(["create", "kody", "--dry-run"], {
      spawn: installingEve(),
    });
    expect(dry.code, dry.stderr).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({ dryRun: true });
    parses("agent create", dry.stdout);

    const created = await agent(["create", "kody"], { spawn: installingEve() });
    expect(created.code, created.stderr).toBe(0);
    parses("agent create", created.stdout);
    expect(AgentCreateOutput).toBe(COMMAND_OUTPUTS["agent create"]);
  });

  describe("on a created agent", () => {
    beforeEach(async () => {
      agentProject(s);
      await createAgent(s);
    });

    it("list, and status with the agent in it", async () => {
      const r = await agent(["list"]);
      expect(r.code, r.stderr).toBe(0);
      const out = parses("agent list", r.stdout) as { agents: unknown[] };
      expect(out.agents).toHaveLength(1);
      expect(AgentListOutput).toBe(COMMAND_OUTPUTS["agent list"]);
      const status = await zz(["status", "--json"], here());
      expect(JSON.parse(status.stdout).agents).toHaveLength(1);
      expect(StatusOutput.parse(JSON.parse(status.stdout))).toBeDefined();
    });

    it("sync, and sync --dry-run with an edited file", async () => {
      const file = join(s.repo, ".donn/persona.yaml");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace(
          "inline: Checkout overview.",
          "inline: Checkout overview v2.",
        ),
      );
      const dry = await agent(["sync", "kody", "--dry-run"]);
      expect(dry.code, dry.stderr).toBe(0);
      expect(JSON.parse(dry.stdout)).toMatchObject({ dryRun: true });
      parses("agent sync", dry.stdout);
      const r = await agent(["sync", "kody"]);
      expect(r.code, r.stderr).toBe(0);
      const out = parses("agent sync", r.stdout) as { written: string[] };
      expect(out.written.length).toBeGreaterThan(0);
      expect(AgentSyncOutput).toBe(COMMAND_OUTPUTS["agent sync"]);
    });

    it("env, with and without --resolve", async () => {
      const r = await agent(["env", "kody"]);
      expect(r.code, r.stderr).toBe(0);
      parses("agent env", r.stdout);
      const resolved = await agent(["env", "kody", "--resolve"]);
      expect(resolved.code, resolved.stderr).toBe(0);
      expect(resolved.stdout).toContain("tok-SECRET");
      parses("agent env", resolved.stdout);
      expect(AgentEnvOutput).toBe(COMMAND_OUTPUTS["agent env"]);
    });

    it("stop (nothing running) and logs", async () => {
      const stop = await agent(["stop", "kody"]);
      expect(JSON.parse(stop.stdout)).toEqual({
        agent: "kody",
        stopped: false,
      });
      parses("agent stop", stop.stdout);
      expect(AgentStopOutput).toBe(COMMAND_OUTPUTS["agent stop"]);

      const path = agentLogPath(s.home, s.repo, "kody");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "2026-10-25T00:00:00.000Z one\n");
      const logs = await agent(["logs", "kody"]);
      expect(logs.code, logs.stderr).toBe(0);
      parses("agent logs", logs.stdout);
      expect(AgentLogsOutput).toBe(COMMAND_OUTPUTS["agent logs"]);
    });

    it("run, in the foreground until SIGINT", async () => {
      const spawn = fakeEve({
        replies: [
          { eve: ["build"], lines: ["built"] },
          { eve: ["start"], lines: START_LINES(), hold: true },
        ],
      });
      const before = process.listenerCount("SIGINT");
      const pending = agent(["run", "kody"], { spawn });
      await vi.waitFor(() =>
        expect(spawn.calls.some((c) => c.args.includes("start"))).toBe(true),
      );
      await vi.waitFor(() =>
        expect(process.listenerCount("SIGINT")).toBe(before + 1),
      );
      process.emit("SIGINT");
      const r = await pending;
      const out = parses("agent run", r.stdout) as { agent: { token: string } };
      expect(out.agent.token).toMatch(/^[0-9a-f]{64}$/);
      // A foreground run once printed its exited promise as `exited: {}`.
      expect(out.agent).not.toHaveProperty("exited");
      expect(JSON.parse(r.stdout).agent).not.toHaveProperty("exited");
      expect(AgentRunOutput).toBe(COMMAND_OUTPUTS["agent run"]);
    });
  });

  it("templates", async () => {
    const r = await zz(["agent", "templates", "--json"], here());
    expect(r.code, r.stderr).toBe(0);
    parses("agent templates", r.stdout);
    expect(AgentTemplatesOutput).toBe(COMMAND_OUTPUTS["agent templates"]);
  });

  describe("add", () => {
    beforeEach(async () => {
      agentProject(s);
      await createAgent(s);
    });

    it("needs-answer (a question and a secret), needs-prerequisite, completed", async () => {
      for (const [lines, exitCode, status] of [
        [INPUT_REQUIRED, 2, "needs-answer"],
        [SECRET_PREREQUISITE, 2, "needs-answer"],
        [PREREQUISITE, 2, "needs-prerequisite"],
        [COMPLETED, 0, "completed"],
      ] as const) {
        const spawn = fakeEve({
          replies: [{ eve: ["add"], lines: [...lines], exitCode }],
        });
        const r = await agent(["add", "kody", "channel/github"], { spawn });
        expect(r.code, r.stdout).toBe(exitCode);
        const out = parses("agent add", r.stdout) as { status: string };
        expect(out.status).toBe(status);
      }
      expect(AgentAddOutput).toBe(COMMAND_OUTPUTS["agent add"]);
    });
  });

  describe("build and deploy", () => {
    const put = (path: string, text: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    };

    it("build (self-host)", async () => {
      agentProject(s, "self-host");
      await createAgent(s);
      const spawn: FakeEve = fakeEve({
        replies: [
          {
            eve: ["build"],
            lines: ["built"],
            effect: (c) => {
              put(join(c.cwd, ".output/server/index.mjs"), "// server\n");
              put(
                join(
                  c.cwd,
                  ".output/.eve/compile/sandbox-prepared-artifacts.json",
                ),
                JSON.stringify({
                  entries: [
                    {
                      artifact: { imageReference: "eve-sandbox-template:abc" },
                      nodeId: "__root__",
                      providerName: "docker",
                    },
                  ],
                  kind: "eve-sandbox-prepared-artifacts",
                  version: 2,
                }),
              );
            },
          },
        ],
      });
      const r = await agent(["build", "kody"], { spawn });
      expect(r.code, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout).sandboxImages).toHaveLength(1);
      parses("agent build", r.stdout);
      expect(AgentBuildOutput).toBe(COMMAND_OUTPUTS["agent build"]);
    });

    it("deploy (vercel)", async () => {
      agentProject(s, "vercel");
      await createAgent(s);
      const spawn = fakeEve({
        replies: [
          {
            when: (c) => c.args.includes("vercel"),
            lines: ["Vercel CLI 50.1.0"],
          },
          {
            eve: ["link"],
            effect: (c) => {
              put(join(c.cwd, ".vercel/project.json"), "{}\n");
            },
          },
          {
            eve: ["deploy"],
            lines: [
              "building",
              "Production: https://kody-abc123.vercel.app [3s]",
            ],
          },
        ],
      });
      // GREETING is already set in Vercel: reported as `existing`, not overwritten.
      const runInput = async (_c: string, args: string[]) =>
        args[4] === "GREETING"
          ? { exitCode: 1, stdout: "", stderr: "already exists" }
          : { exitCode: 0, stdout: "", stderr: "" };
      const plan = await agent(["deploy", "kody", "--dry-run"], {
        spawn,
        runInput,
      });
      expect(plan.code, plan.stderr).toBe(0);
      expect(JSON.parse(plan.stdout)).toMatchObject({ dryRun: true });
      parses("agent deploy", plan.stdout);
      const first = await agent(["deploy", "kody", "--yes"], {
        spawn,
        runInput,
      });
      expect(first.code, first.stderr).toBe(0);
      expect(JSON.parse(first.stdout)).toMatchObject({
        existing: ["GREETING"],
        url: "https://kody-abc123.vercel.app",
      });
      parses("agent deploy", first.stdout);
      // Everything is set by now: nothing pushed, no `existing`.
      const second = await agent(["deploy", "kody", "--yes"], {
        spawn,
        runInput,
      });
      expect(second.code, second.stderr).toBe(0);
      expect(JSON.parse(second.stdout)).toMatchObject({ pushed: [] });
      parses("agent deploy", second.stdout);
      expect(AgentDeployOutput).toBe(COMMAND_OUTPUTS["agent deploy"]);
    });
  });
});

// ---- errors -------------------------------------------------------------------------------

describe("the error envelope", () => {
  /**
   * Every command in the table, run so that it fails. A `BROKEN` command has no input to get
   * wrong, so it runs in a home whose config.yaml is not valid; `status` and `doctor` report
   * problems instead of failing, and `managed check` answers a state (exit 1), so they have no error case.
   */
  const FAILING: Record<string, string[] | null> = {
    list: ["list"],
    switch: ["switch", "nope/missing"],
    resolve: ["resolve", "team/missing"],
    compile: ["compile", "team/missing"],
    capabilities: ["capabilities", "--harness", "nope"],
    diff: ["diff", "team/missing"],
    status: null,
    doctor: null,
    whoami: ["whoami"],
    login: ["login", "not a url", "--token-stdin"],
    logout: ["logout"],
    pull: ["pull"],
    publish: ["publish", "org/missing"],
    write: ["write", "--harness", "claude-code"],
    "managed build": ["managed", "build", "--os", "beos"],
    "managed check": null,
    "agent list": ["agent", "list"],
    "agent create": ["agent", "create", "nobody"],
    "agent sync": ["agent", "sync", "nobody"],
    "agent env": ["agent", "env", "nobody"],
    "agent run": ["agent", "run", "nobody"],
    "agent stop": ["agent", "stop", "nobody"],
    "agent build": ["agent", "build", "nobody"],
    "agent deploy": ["agent", "deploy", "nobody"],
    "agent logs": ["agent", "logs", "nobody"],
    "agent add": ["agent", "add", "nobody", "channel/github"],
    "agent templates": null,
  };

  const BROKEN = new Set([
    "list",
    "whoami",
    "logout",
    "agent list",
    "agent stop",
  ]);

  for (const [key, argv] of Object.entries(FAILING)) {
    if (argv === null) continue;
    it(`${key} fails as an ErrorEnvelope`, async () => {
      if (BROKEN.has(key))
        writeFileSync(join(s.home, "config.yaml"), "personas: [\n");
      const r = await zz([...argv, "--json"], {
        cwd: s.repo,
        home: s.home,
        probe: agentProbe(),
        stdin: async () => "",
      });
      expect(r.code, `${r.stdout}${r.stderr}`).not.toBe(0);
      const error = errorOf(r.stdout).error;
      expect(error.code).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(error.message).not.toBe("");
    });
  }

  it("a resolver error carries a message naming the ref and the layer", async () => {
    const file = join(s.repo, ".donn/persona.yaml");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("- team/payments", "- team/ghost"),
    );
    const r = await zz(["resolve", "--json"], here());
    expect(r.code).not.toBe(0);
    expect(errorOf(r.stdout).error).toMatchObject({
      code: "missing-ref",
      message: "missing-ref: ref=team/ghost, from=project/persona",
      ref: "team/ghost",
    });
  });

  it("keeps whatever details come with the code and message", () => {
    const parsed = ErrorEnvelope.parse({
      error: { code: "x", message: "m", fix: "do it", names: ["a"], n: 1 },
    });
    expect(parsed.error).toMatchObject({ fix: "do it", names: ["a"], n: 1 });
    expect(() => ErrorEnvelope.parse({ error: { message: "m" } })).toThrow();
    // Every envelope carries a message (errors.ts gives a resolver error its text form).
    expect(() => ErrorEnvelope.parse({ error: { code: "x" } })).toThrow();
  });
});

describe("the table", () => {
  it("has every command the bridge allows, each parsed from a real run above", () => {
    expect(Object.keys(COMMAND_OUTPUTS).sort()).toEqual(
      [
        "list",
        "switch",
        "resolve",
        "compile",
        "capabilities",
        "diff",
        "status",
        "doctor",
        "whoami",
        "login",
        "logout",
        "pull",
        "publish",
        "write",
        "managed build",
        "managed check",
        "agent list",
        "agent create",
        "agent sync",
        "agent env",
        "agent run",
        "agent stop",
        "agent build",
        "agent deploy",
        "agent logs",
        "agent add",
        "agent templates",
      ].sort(),
    );
    for (const key of Object.keys(COMMAND_OUTPUTS)) {
      expect(covered.has(key), `${key} was parsed from real output`).toBe(true);
    }
  });
});

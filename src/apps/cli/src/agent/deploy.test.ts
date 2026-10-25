import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentProbe,
  agentProject,
  createAgent,
  SECRETS,
} from "../test/created-agent.js";
import { fakeEve, type FakeEve } from "../test/fake-eve.js";
import { valuesFor } from "./deploy.js";
import { seed, zz, type Seeded } from "../test/seed.js";

// `donn agent deploy` for vercel: link, push the env names after confirmation, eve deploy.
// See docs/planning/25-agent-runner.md, section 4 `vercel`.

let s: Seeded;
beforeEach(() => {
  s = seed();
});
afterEach(() => s.cleanup());

const agentDir = () => join(s.repo, "agents/kody");
const URL_LINE = "Production: https://kody-abc123.vercel.app [3s]";

const eve = (
  options: { deployExit?: number; vercelExit?: number; link?: boolean } = {},
): FakeEve =>
  fakeEve({
    replies: [
      {
        when: (c) => c.args.includes("vercel"),
        exitCode: options.vercelExit ?? 0,
        lines: ["Vercel CLI 50.1.0"],
      },
      {
        eve: ["link"],
        effect: (c) => {
          mkdirSync(join(c.cwd, ".vercel"), { recursive: true });
          writeFileSync(join(c.cwd, ".vercel/project.json"), "{}\n");
        },
      },
      {
        eve: ["deploy"],
        lines: ["building", URL_LINE],
        exitCode: options.deployExit ?? 0,
      },
    ],
  });

interface Pushed {
  command: string;
  args: string[];
  input: string | undefined;
  cwd: string | undefined;
}

function pushing(
  failOn?: string,
  stderr: (input: string | undefined) => string = (i) => `boom ${i}`,
) {
  const pushed: Pushed[] = [];
  const runInput = async (
    command: string,
    args: string[],
    input?: string,
    options?: { cwd?: string },
  ) => {
    pushed.push({ command, args, input, cwd: options?.cwd });
    return args[4] === failOn
      ? { exitCode: 1, stdout: "", stderr: stderr(input) }
      : { exitCode: 0, stdout: "", stderr: "" };
  };
  return { pushed, runInput };
}

const deploy = (
  args: string[],
  spawn: FakeEve,
  runInput: ReturnType<typeof pushing>["runInput"],
  confirm?: (question: string) => Promise<boolean | undefined>,
) =>
  zz(["agent", "deploy", "kody", "--project", s.repo, ...args], {
    cwd: s.root,
    home: s.home,
    env: SECRETS,
    probe: agentProbe(),
    spawn,
    runInput,
    ...(confirm && { managed: { confirm } }),
  });

const errorOf = (r: { stdout: string }) => JSON.parse(r.stdout).error;

const manifest = () =>
  JSON.parse(readFileSync(join(agentDir(), ".donn/agent.json"), "utf8"));

const create = async (target = "vercel") => {
  agentProject(s, target);
  await createAgent(s);
};

describe("donn agent deploy", () => {
  it("links an unlinked agent, pushes new names through stdin, then deploys", async () => {
    await create();
    const questions: string[] = [];
    const { pushed, runInput } = pushing();
    const spawn = eve();
    const r = await deploy([], spawn, runInput, async (q) => {
      questions.push(q);
      return true;
    });
    expect(r.stderr).not.toContain("error");
    expect(r.code).toBe(0);

    const calls = spawn.calls.map((c) => c.args.join(" "));
    expect(calls).toEqual([
      "exec vercel --version",
      "exec eve link --non-interactive --project kody",
      "exec eve deploy --non-interactive --yes",
    ]);
    // The confirmation lists names, never values.
    expect(questions).toEqual(["Set these 3 variables in Vercel production?"]);
    expect(r.stdout).toContain("DONN_SECRET_1");
    expect(r.stdout).toContain("API_TOKEN");
    expect(r.stdout).toContain("GREETING");
    expect(r.stdout).not.toContain("-SECRET");
    expect(r.stdout).not.toContain("DONN_ROUTE_TOKEN");
    // Values go on stdin, never in argv.
    expect(pushed.map((p) => p.args)).toEqual([
      ["exec", "vercel", "env", "add", "API_TOKEN", "production"],
      ["exec", "vercel", "env", "add", "DONN_SECRET_1", "production"],
      ["exec", "vercel", "env", "add", "GREETING", "production"],
    ]);
    expect(pushed.map((p) => p.input)).toEqual([
      "tok-SECRET",
      "sk-gw-SECRET",
      "hello",
    ]);
    expect(pushed.every((p) => p.cwd === agentDir())).toBe(true);
    expect(JSON.stringify(pushed.map((p) => p.args))).not.toContain("-SECRET");
    expect(r.stdout).toContain("https://kody-abc123.vercel.app");
    expect(manifest().pushedEnv).toEqual([
      "API_TOKEN",
      "DONN_SECRET_1",
      "GREETING",
    ]);
    expect(JSON.stringify(manifest())).not.toContain("-SECRET");
  });

  it("does not link a linked agent, and a second deploy pushes only new names", async () => {
    await create();
    const first = pushing();
    await deploy(["--yes"], eve(), first.runInput);
    expect(first.pushed).toHaveLength(3);

    const second = pushing();
    const spawn = eve();
    const r = await deploy(["--yes"], spawn, second.runInput);
    expect(r.code).toBe(0);
    expect(second.pushed).toEqual([]);
    expect(spawn.calls.map((c) => c.args.join(" "))).toEqual([
      "exec vercel --version",
      "exec eve deploy --non-interactive --yes",
    ]);

    // A name the persona gains later is the only one pushed.
    const file = join(s.repo, ".donn/persona.yaml");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "        GREETING: hello\n",
        "        GREETING: hello\n        EXTRA: more\n",
      ),
    );
    const third = pushing();
    await zz(["agent", "sync", "kody", "--project", s.repo], {
      cwd: s.root,
      home: s.home,
      env: SECRETS,
      probe: agentProbe(),
      spawn: eve(),
    });
    const r3 = await deploy(["--yes"], eve(), third.runInput);
    expect(r3.code).toBe(0);
    expect(third.pushed.map((p) => p.args[4])).toEqual(["EXTRA"]);
    expect(manifest().pushedEnv).toContain("EXTRA");
  });

  it("--yes skips the prompt", async () => {
    await create();
    const { pushed, runInput } = pushing();
    const r = await deploy(["--yes"], eve(), runInput, async () => {
      throw new Error("must not ask");
    });
    expect(r.code).toBe(0);
    expect(pushed).toHaveLength(3);
  });

  it("declined: nothing is resolved, linked, pushed or deployed", async () => {
    await create();
    const { pushed, runInput } = pushing();
    const spawn = eve();
    const r = await deploy([], spawn, runInput, async () => false);
    expect(r.code).toBe(1);
    expect(pushed).toEqual([]);
    expect(spawn.calls.map((c) => c.args.join(" "))).toEqual([
      "exec vercel --version",
    ]);
    expect(existsSync(join(agentDir(), ".vercel"))).toBe(false);
  });

  it("--json without --yes fails with the names before resolving any secret", async () => {
    await create();
    const { pushed, runInput } = pushing();
    const r = await zz(
      ["agent", "deploy", "kody", "--project", s.repo, "--json"],
      {
        cwd: s.root,
        home: s.home,
        // No secret values: resolving would fail with secret-unresolved instead.
        env: {},
        probe: agentProbe(),
        spawn: eve(),
        runInput,
      },
    );
    expect(r.code).toBe(1);
    const error = errorOf(r);
    expect(error.code).toBe("confirmation-required");
    expect(error.names).toEqual(["API_TOKEN", "DONN_SECRET_1", "GREETING"]);
    expect(pushed).toEqual([]);
  });

  it("no terminal and no --yes fails with confirmation-required", async () => {
    await create();
    const { runInput } = pushing();
    const r = await deploy(["--json"], eve(), runInput, async () => undefined);
    expect(r.code).toBe(1);
    expect(errorOf(r).code).toBe("confirmation-required");
  });

  it("a secret that does not resolve stops after the confirmation, naming variable and ref", async () => {
    await create();
    const { pushed, runInput } = pushing();
    const spawn = eve();
    const r = await zz(
      ["agent", "deploy", "kody", "--project", s.repo, "--yes", "--json"],
      {
        cwd: s.root,
        home: s.home,
        env: { GATEWAY_KEY: "x" },
        probe: agentProbe(),
        spawn,
        runInput,
      },
    );
    expect(r.code).toBe(1);
    expect(errorOf(r).code).toBe("secret-unresolved");
    // Stopped before any Vercel project was created or linked.
    expect(spawn.calls.some((c) => c.args.includes("link"))).toBe(false);
    expect(r.stdout).toContain("API_TOKEN");
    expect(r.stdout).toContain("secret://env/API_TOKEN");
    expect(pushed).toEqual([]);
  });

  it("an existing variable is kept, recorded and reported; the deploy goes on", async () => {
    await create();
    const { pushed, runInput } = pushing(
      "API_TOKEN",
      () => 'Error: Environment Variable "API_TOKEN" Already Exists',
    );
    const text = await deploy(["--yes"], eve(), runInput);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(
      "API_TOKEN already set in Vercel; not overwritten",
    );
    expect(text.stdout).toContain("deployed kody");
    expect(pushed).toHaveLength(3);
    expect(manifest().pushedEnv).toEqual([
      "API_TOKEN",
      "DONN_SECRET_1",
      "GREETING",
    ]);
  });

  it("--json lists the existing variables", async () => {
    await create();
    const { runInput } = pushing("GREETING", () => "already exists");
    const r = await deploy(["--yes", "--json"], eve(), runInput);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      pushed: ["API_TOKEN", "DONN_SECRET_1"],
      existing: ["GREETING"],
    });
  });

  it("another refusal carries Vercel's words with the value masked, and a fix", async () => {
    await create();
    const { runInput } = pushing(
      "DONN_SECRET_1",
      (input) => `Error: invalid value ${input} for this project\nTry again`,
    );
    const r = await deploy(["--yes", "--json"], eve(), runInput);
    expect(r.code).toBe(1);
    const error = errorOf(r);
    expect(error.code).toBe("vercel-env-failed");
    expect(error.tail).toEqual([
      "Error: invalid value *** for this project",
      "Try again",
    ]);
    expect(error.fix).toContain("donn agent deploy kody");
    expect(r.stdout + r.stderr).not.toContain("sk-gw-SECRET");
    expect(manifest().pushedEnv).toEqual(["API_TOKEN"]);
  });

  it("a first deploy asks even with no variable to set; a later one does not", async () => {
    await create();
    await deploy(["--yes"], eve(), pushing().runInput);

    const later: string[] = [];
    const quiet = await deploy([], eve(), pushing().runInput, async (q) => {
      later.push(q);
      return true;
    });
    expect(quiet.code).toBe(0);
    expect(later).toEqual([]);

    await rm(join(agentDir(), ".vercel"), { recursive: true });
    const asked: string[] = [];
    const spawn = eve();
    const declined = await deploy([], spawn, pushing().runInput, async (q) => {
      asked.push(q);
      return false;
    });
    expect(asked).toEqual(["Link kody to a Vercel project and deploy it?"]);
    expect(declined.code).toBe(1);
    expect(spawn.calls.some((c) => c.args.includes("link"))).toBe(false);

    const json = await deploy(["--json"], eve(), pushing().runInput);
    expect(errorOf(json)).toMatchObject({
      code: "confirmation-required",
      names: [],
    });
  });

  it("a failed vercel env add stops, names the variable not the value, records what was pushed", async () => {
    await create();
    const { pushed, runInput } = pushing("DONN_SECRET_1");
    const spawn = eve();
    const r = await deploy(["--yes", "--json"], spawn, runInput);
    expect(r.code).toBe(1);
    expect(errorOf(r)).toMatchObject({
      code: "vercel-env-failed",
      name: "DONN_SECRET_1",
    });
    expect(r.stdout + r.stderr).not.toContain("sk-gw-SECRET");
    expect(pushed).toHaveLength(2);
    expect(manifest().pushedEnv).toEqual(["API_TOKEN"]);
    expect(spawn.calls.some((c) => c.args.includes("deploy"))).toBe(false);
  });

  it("eve deploy failing is eve-failed with the tail", async () => {
    await create();
    const { runInput } = pushing();
    const r = await deploy(
      ["--yes", "--json"],
      eve({ deployExit: 1 }),
      runInput,
    );
    expect(r.code).toBe(1);
    expect(errorOf(r).code).toBe("eve-failed");
    // The names were pushed, so the next deploy does not push them again.
    expect(manifest().pushedEnv).toHaveLength(3);
  });

  it("a missing Vercel CLI is vercel-cli-missing", async () => {
    await create();
    const { pushed, runInput } = pushing();
    const r = await deploy(
      ["--yes", "--json"],
      eve({ vercelExit: 1 }),
      runInput,
    );
    expect(r.code).toBe(1);
    expect(errorOf(r).code).toBe("vercel-cli-missing");
    // create --force refuses a complete agent: only the dev dependency is the fix.
    expect(errorOf(r).fix).toBe("pnpm add -D vercel@50.1.0 in agents/kody");
    expect(pushed).toEqual([]);
  });

  it("refuses a stale agent before anything leaves the machine: agent-stale", async () => {
    await create();
    const file = join(s.repo, ".donn/persona.yaml");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "inline: Checkout overview.",
        "inline: Checkout overview v2.",
      ),
    );
    const { pushed, runInput } = pushing();
    const spawn = eve();
    const r = await deploy(["--yes", "--json"], spawn, runInput);
    expect(r.code).toBe(1);
    expect(errorOf(r)).toMatchObject({
      code: "agent-stale",
      fix: "donn agent sync kody",
    });
    expect(spawn.calls).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it("--json prints the names pushed, the url and no value", async () => {
    await create();
    const { runInput } = pushing();
    const r = await deploy(["--yes", "--json"], eve(), runInput);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({
      agent: "kody",
      pushed: ["API_TOKEN", "DONN_SECRET_1", "GREETING"],
      url: "https://kody-abc123.vercel.app",
    });
    expect(r.stdout).not.toContain("-SECRET");
  });

  it.each(["local", "self-host"])(
    "refuses a %s agent with target-not-deployable",
    async (target) => {
      await create(target);
      const { pushed, runInput } = pushing();
      const r = await deploy(["--yes", "--json"], eve(), runInput);
      expect(r.code).toBe(1);
      expect(errorOf(r).code).toBe("target-not-deployable");
      expect(errorOf(r).fix).toBe(
        target === "self-host"
          ? "donn agent build kody"
          : "donn agent run kody",
      );
      expect(pushed).toEqual([]);
    },
  );
});

describe("valuesFor", () => {
  it("stops with secret-unresolved naming a variable without a value, never pushing ''", () => {
    const entries = [
      {
        name: "GREETING",
        source: "plain",
        value: "hello",
        why: "template-variable",
      },
      {
        name: "API_TOKEN",
        source: "secret",
        ref: "secret://env/API_TOKEN",
        why: "persona-secret",
      },
    ] as const;
    expect(() => valuesFor(["GREETING", "API_TOKEN"], [...entries])).toThrow(
      expect.objectContaining({
        code: "secret-unresolved",
        message: expect.stringContaining("API_TOKEN"),
        details: {
          failures: [
            {
              name: "API_TOKEN",
              ref: "secret://env/API_TOKEN",
              reason: "no value resolved",
            },
          ],
        },
      }),
    );
    expect(valuesFor(["GREETING"], [...entries])).toEqual(
      new Map([["GREETING", "hello"]]),
    );
  });
});

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import adapter from "@getdonn/adapter-eve";
import type { Probe, TemplateInfo } from "@getdonn/adapter-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEve, type FakeEveCall } from "../test/fake-eve.js";
import { seed, zz, type Seeded } from "../test/seed.js";
import { tarball, type TarEntry } from "../test/tarball.js";
import { StoreError } from "@getdonn/store-local";
import { CliError } from "../errors.js";
import { leftForInspection } from "./create.js";
import { templateDigest } from "./digest.js";
import { extractDir } from "./tar.js";

// `donn agent create` end to end against a temp project, a fake eve and a stub fetch.
// See docs/planning/25-agent-runner.md, section 2.

const COMMIT = "9f73f9dbe5841253657b9037614cb43887937fe8";
const SECRET = "sk-test-SECRET";

const PERSONA = `# The checkout API's project persona.
apiVersion: donn/v0
kind: Persona
metadata:
  name: checkout-api # keep in sync with the repo name

extends:
  - team/payments

# Instructions every harness reads.
instructions:
  - id: checkout-overview
    position: replace(payments-overview)
    file: ./instructions/checkout-overview.md

models:
  gateway:
    type: openai-compatible
    baseURL: https://llm.corp/v1
    apiKey: secret://env/GATEWAY_KEY
  default: gpt-5

targets:
  eve:
    contextWindow: 128000 # the gateway's window
`;

const AGENT_TS = `import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-6-luna-fast",
  reasoning: "high",
});
`;

const TEMPLATE: TarEntry[] = [
  {
    name: "package.json",
    data: `${JSON.stringify(
      {
        name: "voice",
        private: true,
        packageManager: "pnpm@11.25.0",
        dependencies: { eve: "^0.80.0", zod: "4.5.4" },
      },
      null,
      2,
    )}\n`,
  },
  {
    name: "pnpm-workspace.yaml",
    data: "# the template's own settings\nallowBuilds:\n  esbuild: true\nminimumReleaseAgeExclude:\n  - ai\n",
  },
  { name: ".gitignore", data: "node_modules\n.env*.local\n" },
  {
    name: "tsconfig.json",
    data: '{ "compilerOptions": { "strict": true } }\n',
  },
  { name: "agent/agent.ts", data: AGENT_TS },
  { name: "agent/instructions.md", data: "You answer calls.\n" },
  { name: "sub/.git/HEAD", data: "ref: refs/heads/main\n" },
];

const realCompile = adapter.compile.bind(adapter);
const repoPath = (slug: string) => `apps/templates/${slug}`;
const archive = (slug: string, entries = TEMPLATE) =>
  tarball({
    top: "eve-eve-0.83.2",
    comment: COMMIT,
    entries: entries.map((e) => ({
      ...e,
      name: `${repoPath(slug)}/${e.name}`,
    })),
  });

function row(slug: string, services: TemplateInfo["services"]): TemplateInfo {
  const digest = templateDigest(
    extractDir(archive(slug), `${repoPath(slug)}/`),
  );
  return { slug, title: slug, repoPath: repoPath(slug), digest, services };
}

const probe: Probe = {
  platform: process.platform,
  readFile: async () => undefined,
  listDir: async () => undefined,
  run: async (command, args) => {
    if (command === "npm" && args[1] === "eve")
      return {
        exitCode: 0,
        stdout: '["0.83.1","0.83.2","0.84.0"]',
        stderr: "",
      };
    if (command === "npm" && args[1] === "vercel")
      return { exitCode: 0, stdout: "50.1.0\n", stderr: "" };
    if (command === "git")
      return {
        exitCode: 0,
        stdout: `${COMMIT}\trefs/tags/eve@0.83.2\n`,
        stderr: "",
      };
    return { exitCode: 1, stdout: "", stderr: `unexpected ${command}` };
  },
};

const fetchStub = (slug: string) =>
  (async () =>
    new Response(archive(slug), { status: 200 })) as unknown as typeof fetch;

const isInstall = (call: FakeEveCall) =>
  call.command === "pnpm" && call.args[0] === "install";
const isInit = (call: FakeEveCall) => call.args.includes("init");

/** What `pnpm install` leaves behind. */
const installed = (call: FakeEveCall) => {
  mkdirSync(join(call.cwd, "node_modules/eve"), { recursive: true });
};

/** What `eve init <dir> --non-interactive` creates in an existing package (T3). */
const initialised = (call: FakeEveCall) => {
  const dir = call.args[call.args.indexOf("init") + 1]!;
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  put("agent/agent.ts", AGENT_TS);
  put(
    "agent/channels/eve.ts",
    'import { eveChannel } from "eve/channels/eve";\nexport default eveChannel({});\n',
  );
  put("agent/instructions.md", "You are a helpful agent.\n");
  put(
    "pnpm-workspace.yaml",
    "minimumReleaseAge: 0\nallowBuilds:\n  esbuild: true\n",
  );
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  pkg.dependencies = { eve: "^0.83.2", ai: "^7.0.137", zod: "4.5.4" };
  put("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
  put("node_modules/eve/package.json", "{}");
};

let s: Seeded;
beforeEach(() => {
  s = seed();
  writeFileSync(join(s.repo, ".donn/persona.yaml"), PERSONA);
});
afterEach(() => {
  vi.restoreAllMocks();
  s.cleanup();
});

const agentDir = (name = "voice") => join(s.repo, "agents", name);
const read = (path: string) => readFileSync(path, "utf8");
const manifest = (name = "voice") =>
  JSON.parse(read(join(agentDir(name), ".donn/agent.json")));

/** Every file under `dir`, as paths relative to it. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)));
}

async function create(
  args: string[],
  options: {
    spawn?: ReturnType<typeof fakeEve>;
    slug?: string;
    cwd?: string;
    probe?: Probe;
  } = {},
) {
  const spawn =
    options.spawn ??
    fakeEve({ replies: [{ when: isInstall, effect: installed }] });
  const result = await zz(["agent", "create", ...args], {
    cwd: options.cwd ?? s.repo,
    home: s.home,
    env: { GATEWAY_KEY: SECRET },
    probe: options.probe ?? probe,
    spawn,
    fetch: fetchStub(options.slug ?? "eve-voice-template"),
  });
  return { ...result, spawn };
}

const voice = () =>
  vi
    .spyOn(adapter, "templates")
    .mockReturnValue([row("eve-voice-template", ["ai-gateway"])]);

describe("donn agent create", () => {
  it("creates an eve:<slug> agent: template, donn's files, agent.ts, manifest, install", async () => {
    voice();
    const { code, stdout, stderr, spawn } = await create(
      [
        "voice",
        "--template",
        "eve:eve-voice-template",
        "--target",
        "local",
        "--project",
        s.repo,
        "--json",
      ],
      { cwd: s.root },
    );
    expect(stderr).not.toContain("error");
    expect(code).toBe(0);
    const dir = agentDir();

    // Declared in the project persona, comments intact.
    const persona = read(join(s.repo, ".donn/persona.yaml"));
    expect(persona).toContain("# The checkout API's project persona.");
    expect(persona).toContain("# the gateway's window");
    expect(persona).toMatch(
      /agents:\n {2}define:\n {4}voice:\n {6}template: eve:eve-voice-template\n {6}target: local\n/,
    );

    // The template, without its nested .git.
    expect(read(join(dir, "agent/instructions.md"))).toBe(
      "You answer calls.\n",
    );
    expect(existsSync(join(dir, "sub/.git"))).toBe(false);

    // donn's files and the one-time agent.ts edit.
    for (const file of [
      "agent/lib/donn/config.ts",
      "agent/lib/donn/env.ts",
      "agent/lib/donn/route-auth.ts",
      "agent/channels/eve.ts",
      "agent/instructions/donn.md",
      "agent/skills/donn-run-payment-sim/SKILL.md",
    ])
      expect(existsSync(join(dir, file)), file).toBe(true);
    const agentTs = read(join(dir, "agent/agent.ts"));
    expect(agentTs).toContain('import { donn } from "./lib/donn/config";');
    expect(agentTs).toContain("...donn");
    expect(agentTs).not.toContain("gpt-6-luna-fast");

    // Dependencies pinned, the agent's own workspace file edited in place.
    const pkg = JSON.parse(read(join(dir, "package.json")));
    expect(pkg.dependencies).toMatchObject({
      eve: "0.83.2",
      ai: "^7.0.152",
      "@ai-sdk/openai-compatible": "^3",
      zod: "4.5.4",
    });
    expect(pkg.devDependencies?.vercel).toBeUndefined();
    const workspace = read(join(dir, "pnpm-workspace.yaml"));
    expect(workspace).toContain("# the template's own settings");
    expect(workspace).toMatch(
      /allowBuilds:\n {2}esbuild: true\n {2}cbor-extract: false/,
    );
    expect(workspace).toMatch(
      /minimumReleaseAgeExclude:\n {2}- ai\n {2}- eve@0\.83\.2/,
    );

    // .gitignore keeps the template's lines and gains the missing ones.
    expect(read(join(dir, ".gitignore"))).toBe(
      "node_modules\n.env*.local\n.env*\n.output/\n.vercel/\n.eve/\n",
    );

    // One install, in place, not frozen and not --ignore-workspace.
    const installs = spawn.calls.filter(isInstall);
    expect(installs.map((c) => [c.command, ...c.args])).toEqual([
      ["pnpm", "install"],
    ]);
    expect(installs[0]!.cwd).toBe(dir);

    // The manifest.
    const m = manifest();
    expect(m).toMatchObject({
      agent: "voice",
      persona: "project/persona",
      adapter: "eve",
      frameworkVersion: "0.83.2",
      template: "eve:eve-voice-template",
      target: "local",
      path: "agents/voice",
      agentTs: "patched",
      state: "complete",
    });
    expect([...m.edits].sort()).toEqual([
      ".gitignore",
      "agent/agent.ts",
      "package.json",
      "pnpm-workspace.yaml",
    ]);
    expect(m.files["agent/skills/donn-run-payment-sim/SKILL.md"]).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(Object.values(m.files)).not.toContain("copy");
    expect(Object.keys(m.files)).toContain("agent/lib/donn/config.ts");

    // Known to this home.
    expect(JSON.parse(read(join(s.home, "agents/index.json"))).agents).toEqual([
      { project: s.repo, name: "voice", path: "agents/voice" },
    ]);

    // --json and the reports.
    const body = JSON.parse(stdout);
    expect(body).toMatchObject({
      agent: "voice",
      dir,
      frameworkVersion: "0.83.2",
      files: m.files,
    });
    expect(body.report.adapter).toBe("eve");
    expect(body.portability).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ service: "route-auth", blocking: false }),
      ]),
    );
    // Under --json the reports are in the body; warnings still go to stderr.
    expect(stderr).not.toContain("advisory:");
    expect(stderr).toContain("skipLibCheck");
  });

  it("creates eve:blank with eve init in a staging folder outside the repo; the repo's workspace is untouched", async () => {
    const rootFiles = {
      "package.json": '{ "name": "checkout", "private": true }\n',
      "pnpm-workspace.yaml": "packages:\n  - agents/*\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    };
    for (const [file, text] of Object.entries(rootFiles))
      writeFileSync(join(s.repo, file), text);
    const spawn = fakeEve({
      replies: [
        { when: isInit, effect: initialised },
        { when: isInstall, effect: installed },
      ],
    });
    const { code, stdout, stderr } = await create(
      ["blank", "--template", "eve:blank", "--target", "local"],
      { spawn },
    );
    expect(stderr).not.toContain("error:");
    expect(code).toBe(0);
    for (const [file, text] of Object.entries(rootFiles))
      expect(read(join(s.repo, file))).toBe(text);

    const [init] = spawn.calls.filter(isInit);
    expect(init).toBeDefined();
    const staging = init!.args[init!.args.indexOf("init") + 1]!;
    expect(init!.args).toEqual([
      "--package=eve@0.83.2",
      "dlx",
      "eve",
      "init",
      staging,
      "--non-interactive",
    ]);
    expect(init!.cwd).toBe(staging);
    expect(relative(s.repo, staging).startsWith("..")).toBe(true);
    expect(existsSync(staging)).toBe(false);
    expect(init!.env.NODE_ENV).toBe("production");

    const dir = agentDir("blank");
    expect(spawn.calls.filter(isInstall).map((c) => c.cwd)).toEqual([dir]);
    expect(read(join(dir, "agent/instructions.md"))).toBe(
      "You are a helpful agent.\n",
    );
    // The staged install is not carried over; the agent installs in place.
    expect(existsSync(join(dir, "node_modules/eve/package.json"))).toBe(false);
    expect(JSON.parse(read(join(dir, "package.json"))).dependencies.eve).toBe(
      "0.83.2",
    );
    // eve init's scaffolded channel is dropped for local: donn writes and owns its own.
    const channel = read(join(dir, "agent/channels/eve.ts"));
    expect(channel).toContain("donnToken");
    expect(channel).not.toContain("eveChannel({})");
    expect(stderr).not.toContain("blocking:");
    expect(stderr).toContain("advisory: route-auth (local)");
    expect(manifest("blank").state).toBe("complete");
    expect(Object.keys(manifest("blank").files)).toContain(
      "agent/channels/eve.ts",
    );
    expect(stdout).toContain("created agents/blank");
    expect(stdout).toContain("donn agent run blank");
  });

  it("keeps eve init's channel for eve:blank on vercel", async () => {
    const spawn = fakeEve({
      replies: [
        { when: isInit, effect: initialised },
        { when: isInstall, effect: installed },
      ],
    });
    const { code } = await create(
      ["blank", "--template", "eve:blank", "--target", "vercel"],
      { spawn },
    );
    expect(code).toBe(0);
    expect(read(join(agentDir("blank"), "agent/channels/eve.ts"))).toContain(
      "eveChannel({})",
    );
    expect(Object.keys(manifest("blank").files)).not.toContain(
      "agent/channels/eve.ts",
    );
  });

  it("copies a path template without its .git, and records the template's virtual path", async () => {
    const tpl = join(s.repo, ".donn/templates/kody");
    for (const [file, text] of [
      ["package.json", '{ "name": "kody" }\n'],
      ["agent/agent.ts", AGENT_TS],
      [".git/HEAD", "ref: refs/heads/main\n"],
      ["node_modules/eve/index.js", ""],
    ] as const) {
      mkdirSync(dirname(join(tpl, file)), { recursive: true });
      writeFileSync(join(tpl, file), text);
    }
    const { code, stderr } = await create([
      "kody",
      "--template",
      "./templates/kody",
      "--target",
      "local",
    ]);
    expect(stderr).not.toContain("error:");
    expect(code).toBe(0);
    const dir = agentDir("kody");
    expect(existsSync(join(dir, ".git"))).toBe(false);
    expect(existsSync(join(dir, "node_modules/eve/index.js"))).toBe(false);
    expect(read(join(dir, "agent/agent.ts"))).toContain("...donn");
    expect(manifest("kody").template).toBe("project/templates/kody");
    expect(stderr).toContain("portability-unknown");
    // The template itself is untouched.
    expect(existsSync(join(tpl, ".git/HEAD"))).toBe(true);
  });

  describe("a template from outside the project", () => {
    // The source is a plain folder, not a git checkout.
    const plain: Probe = {
      ...probe,
      run: async (command, args) =>
        command === "git" && args[0] === "-C"
          ? { exitCode: 128, stdout: "", stderr: "not a git repository" }
          : probe.run(command, args),
    };
    const outside = (name = "kody-tpl") => {
      const dir = join(s.root, name);
      for (const [file, text] of [
        [
          "package.json",
          '{ "name": "kody", "dependencies": { "eve": "^0.83.2" } }\n',
        ],
        ["agent/agent.ts", AGENT_TS],
      ] as const) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), text);
      }
      return dir;
    };
    const vendored = () => join(s.repo, ".donn/templates");
    const flags = ["--target", "local"];

    it("creates an agent from a folder outside the project", async () => {
      const tpl = outside();
      const { code, stderr } = await create(
        ["kody", "--template", tpl, ...flags],
        { probe: plain },
      );
      expect(stderr).not.toContain("error:");
      expect(code).toBe(0);
      expect(read(join(s.repo, ".donn/persona.yaml"))).toContain(
        "template: ./templates/kody-tpl",
      );
      expect(existsSync(join(vendored(), "kody-tpl/agent/agent.ts"))).toBe(
        true,
      );
      const record = JSON.parse(read(join(vendored(), "sources.json")));
      expect(record.templates["kody-tpl"].source).toBe(tpl);
      expect(read(join(agentDir("kody"), "agent/agent.ts"))).toContain(
        "...donn",
      );
      expect(manifest("kody").template).toBe("project/templates/kody-tpl");
      // Staging folders are gone and the source is untouched.
      expect(existsSync(join(tpl, "agent/agent.ts"))).toBe(true);
    });

    it("names the vendored template with --template-name", async () => {
      const tpl = outside();
      const { code } = await create(
        ["kody", "--template", tpl, "--template-name", "mine", ...flags],
        { probe: plain },
      );
      expect(code).toBe(0);
      expect(read(join(s.repo, ".donn/persona.yaml"))).toContain(
        "template: ./templates/mine",
      );
      expect(existsSync(join(vendored(), "mine/package.json"))).toBe(true);
      expect(existsSync(join(vendored(), "kody-tpl"))).toBe(false);
    });

    it("a dry run vendors nothing and says what it would", async () => {
      const tpl = outside();
      const before = read(join(s.repo, ".donn/persona.yaml"));
      const { code, stdout, stderr } = await create(
        ["kody", "--template", tpl, ...flags, "--dry-run"],
        { probe: plain },
      );
      expect(stderr).not.toContain("error:");
      expect(code).toBe(0);
      expect(stdout).toContain(
        `would vendor ${tpl} into .donn/templates/kody-tpl`,
      );
      expect(stdout).toContain("+       template: ./templates/kody-tpl");
      expect(existsSync(vendored())).toBe(false);
      expect(read(join(s.repo, ".donn/persona.yaml"))).toBe(before);
      expect(existsSync(agentDir("kody"))).toBe(false);
    });

    it("a dry run reports the vendoring in --json", async () => {
      const tpl = outside();
      const { stdout } = await create(
        ["kody", "--template", tpl, ...flags, "--dry-run", "--json"],
        { probe: plain },
      );
      expect(JSON.parse(stdout).vendored).toEqual({
        name: "kody-tpl",
        path: ".donn/templates/kody-tpl",
        source: tpl,
      });
      expect(existsSync(vendored())).toBe(false);
    });

    it("a stopped create vendors nothing", async () => {
      const tpl = outside();
      // The template's channel uses route auth: a blocking entry on a path template.
      vi.spyOn(adapter, "compile").mockImplementation((...args) => {
        const out = realCompile(...args);
        return {
          ...out,
          portability: [
            {
              service: "connect",
              target: "local",
              instead: "x",
              blocking: true,
            },
          ],
        } as typeof out;
      });
      const before = read(join(s.repo, ".donn/persona.yaml"));
      const { code, stdout } = await create(
        ["kody", "--template", tpl, ...flags, "--json"],
        { probe: plain },
      );
      expect(code).toBe(1);
      expect(JSON.parse(stdout).error.code).toBe("portability-blocking");
      expect(existsSync(vendored())).toBe(false);
      expect(read(join(s.repo, ".donn/persona.yaml"))).toBe(before);
      expect(existsSync(agentDir("kody"))).toBe(false);
    });

    it("a name taken by an unvendored folder leaves the persona alone", async () => {
      const tpl = outside();
      mkdirSync(join(vendored(), "kody-tpl"), { recursive: true });
      const before = read(join(s.repo, ".donn/persona.yaml"));
      const { code, stdout } = await create(
        ["kody", "--template", tpl, ...flags, "--json"],
        { probe: plain },
      );
      expect(code).toBe(1);
      expect(JSON.parse(stdout).error.code).toBe("vendor-name-taken");
      expect(read(join(s.repo, ".donn/persona.yaml"))).toBe(before);
      expect(existsSync(agentDir("kody"))).toBe(false);
    });

    it("refuses a source inside the project's templates", async () => {
      const tpl = join(vendored(), "inner");
      mkdirSync(join(tpl, "agent"), { recursive: true });
      writeFileSync(join(tpl, "package.json"), '{"dependencies":{"eve":"1"}}');
      const { code, stdout } = await create(
        ["kody", "--template", tpl, ...flags, "--json"],
        { probe: plain },
      );
      expect(code).toBe(1);
      expect(JSON.parse(stdout).error.code).toBe("vendor-source-inside");
    });

    it("removes a newly vendored template when the persona write fails", async () => {
      const tpl = outside();
      const file = join(s.repo, ".donn/persona.yaml");
      const before = read(file);
      // The persona changes after it was read: writeDeclaration refuses.
      vi.spyOn(adapter, "compile").mockImplementation((...args) => {
        writeFileSync(file, `${before}# edited\n`);
        return realCompile(...args);
      });
      const { code, stdout } = await create(
        ["kody", "--template", tpl, ...flags, "--json"],
        { probe: plain },
      );
      expect(code).toBe(1);
      expect(JSON.parse(stdout).error.code).toBe("persona-changed");
      expect(existsSync(join(vendored(), "kody-tpl"))).toBe(false);
      const sources = join(vendored(), "sources.json");
      expect(
        existsSync(sources)
          ? Object.keys(JSON.parse(read(sources)).templates)
          : [],
      ).toEqual([]);
    });

    it("says so when a refreshed copy stays after the persona write fails", async () => {
      const tpl = outside();
      const first = await create(["kody", "--template", tpl, ...flags], {
        probe: plain,
      });
      expect(first.code, first.stderr).toBe(0);
      // A second agent from the same source refreshes the recorded copy.
      const file = join(s.repo, ".donn/persona.yaml");
      const before = read(file);
      vi.spyOn(adapter, "compile").mockImplementation((...args) => {
        writeFileSync(file, `${before}# edited\n`);
        return realCompile(...args);
      });
      const { code, stdout, stderr } = await create(
        ["kody2", "--template", tpl, ...flags, "--json"],
        { probe: plain },
      );
      expect(code).toBe(1);
      expect(JSON.parse(stdout).error.code).toBe("persona-changed");
      expect(stderr).toContain(".donn/templates/kody-tpl was refreshed from");
      expect(existsSync(join(vendored(), "kody-tpl/agent/agent.ts"))).toBe(
        true,
      );
    });

    it("refuses a different source for a name already vendored", async () => {
      const first = outside();
      const second = outside("other/kody-tpl");
      writeFileSync(join(second, "agent/extra.ts"), "export {};\n");
      const one = await create(["kody", "--template", first, ...flags], {
        probe: plain,
      });
      expect(one.code, one.stderr).toBe(0);
      const before = read(join(s.repo, ".donn/persona.yaml"));
      const { code, stdout } = await create(
        ["kody2", "--template", second, ...flags, "--json"],
        { probe: plain },
      );
      expect(code).toBe(1);
      const error = JSON.parse(stdout).error;
      expect(error.code).toBe("vendor-name-taken");
      expect(error.message).toContain(first);
      expect(error.fix).toBe(
        "--template-name <another-name>, or donn agent vendor " +
          `${second} --name kody-tpl to replace it`,
      );
      expect(read(join(s.repo, ".donn/persona.yaml"))).toBe(before);
      expect(existsSync(join(vendored(), "kody-tpl/agent/extra.ts"))).toBe(
        false,
      );
      const record = JSON.parse(read(join(vendored(), "sources.json")));
      expect(record.templates["kody-tpl"].source).toBe(first);
      expect(existsSync(agentDir("kody2"))).toBe(false);
    });

    it("says refreshed when the same source is vendored again", async () => {
      const tpl = outside();
      await create(["kody", "--template", tpl, ...flags], { probe: plain });
      const { code, stderr } = await create(
        ["kody2", "--template", tpl, ...flags],
        { probe: plain },
      );
      expect(code, stderr).toBe(0);
      expect(stderr).toContain(
        "refreshed kody-tpl: 0 added, 0 changed, 0 removed",
      );
    });

    it("a dry run says the template was staged, not that it was not fetched", async () => {
      const tpl = outside();
      const { stdout } = await create(
        ["kody", "--template", tpl, ...flags, "--dry-run"],
        { probe: plain },
      );
      expect(stdout).not.toContain("does not fetch");
      expect(stdout).toContain("staged to check it");
    });

    it("names create's flags in the vendor-name-taken hint", async () => {
      const tpl = outside();
      mkdirSync(join(vendored(), "kody-tpl"), { recursive: true });
      const { stdout } = await create(
        ["kody", "--template", tpl, ...flags, "--json"],
        { probe: plain },
      );
      expect(JSON.parse(stdout).error.fix).toBe(
        "--template-name <another-name>, or move the folder away",
      );
    });

    it("names donn agent vendor in the vendor-local-edits hint", async () => {
      const tpl = outside();
      const first = await create(["kody", "--template", tpl, ...flags], {
        probe: plain,
      });
      expect(first.code, first.stderr).toBe(0);
      writeFileSync(join(vendored(), "kody-tpl/extra.txt"), "edited\n");
      const { code, stdout } = await create(
        ["kody2", "--template", tpl, ...flags, "--json"],
        { probe: plain },
      );
      expect(code).toBe(1);
      const error = JSON.parse(stdout).error;
      expect(error.code).toBe("vendor-local-edits");
      expect(error.fix).toBe(
        `donn agent vendor ${tpl} --name kody-tpl --force`,
      );
    });

    it("compares a declared agent's template with the vendored path", async () => {
      const tpl = outside();
      writeFileSync(
        join(s.repo, ".donn/persona.yaml"),
        `${PERSONA}\nagents:\n  define:\n    kody:\n      template: ./templates/kody-tpl\n      target: local\n`,
      );
      mkdirSync(join(vendored(), "kody-tpl/agent"), { recursive: true });
      writeFileSync(join(vendored(), "kody-tpl/agent/agent.ts"), AGENT_TS);
      writeFileSync(join(vendored(), "kody-tpl/package.json"), "{}\n");
      const same = await create(["kody", "--template", tpl, "--json"], {
        probe: plain,
      });
      expect(same.code, same.stderr).toBe(0);
      expect(existsSync(join(vendored(), "sources.json"))).toBe(false);
    });

    it("a declared agent with a different vendor source is agent-declared", async () => {
      const other = outside("other");
      writeFileSync(
        join(s.repo, ".donn/persona.yaml"),
        `${PERSONA}\nagents:\n  define:\n    kody:\n      template: ./templates/kody-tpl\n      target: local\n`,
      );
      const { code, stdout } = await create(
        ["kody", "--template", other, "--json"],
        { probe: plain },
      );
      expect(code).toBe(1);
      expect(JSON.parse(stdout).error).toMatchObject({
        code: "agent-declared",
        flags: ["--template"],
      });
      expect(existsSync(vendored())).toBe(false);
    });
  });

  it("leaves a failed create incomplete, refuses to reuse it, and recovers with --force", async () => {
    voice();
    const failing = fakeEve({
      replies: [
        {
          when: isInstall,
          lines: [{ line: "ERR_PNPM_FETCH_404", stream: "stderr" }],
          exitCode: 1,
        },
      ],
    });
    const args = [
      "voice",
      "--template",
      "eve:eve-voice-template",
      "--target",
      "local",
      "--json",
    ];
    const first = await create(args, { spawn: failing });
    expect(first.code).toBe(1);
    expect(JSON.parse(first.stdout).error).toMatchObject({
      code: "install-failed",
      tail: ["ERR_PNPM_FETCH_404"],
      dir: agentDir(),
      fix: "donn agent create voice --force",
    });
    expect(manifest().state).toBe("incomplete");

    const second = await create(args);
    expect(JSON.parse(second.stdout).error).toMatchObject({
      code: "agent-incomplete",
      fix: "donn agent create voice --force",
    });

    writeFileSync(join(agentDir(), "leftover.txt"), "x");
    const third = await create([...args, "--force"]);
    expect(third.code).toBe(0);
    expect(manifest().state).toBe("complete");
    expect(existsSync(join(agentDir(), "leftover.txt"))).toBe(false);
  });

  it("names --force for a known error that is not a CliError; a bug stays as it is", () => {
    const store = Object.assign(new StoreError("bad mount"), {
      file: "/x/config.yaml",
    });
    const left = leftForInspection(
      store,
      "voice",
      "/p/agents/voice",
      "agents/voice",
    );
    expect(left).toBeInstanceOf(CliError);
    expect(left).toMatchObject({
      code: "store",
      details: {
        file: "/x/config.yaml",
        dir: "/p/agents/voice",
        fix: "donn agent create voice --force",
      },
    });
    expect((left as Error).message).toContain(
      "agents/voice is left for inspection",
    );
    const bug = new TypeError("boom");
    expect(leftForInspection(bug, "voice", "/p", "p")).toBe(bug);
  });

  it("refuses a non-empty path without a manifest, even with --force", async () => {
    voice();
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(join(agentDir(), "mine.txt"), "keep");
    const { code, stdout, spawn } = await create([
      "voice",
      "--template",
      "eve:eve-voice-template",
      "--target",
      "local",
      "--force",
      "--json",
    ]);
    expect(code).toBe(1);
    expect(JSON.parse(stdout).error.code).toBe("agent-exists");
    expect(read(join(agentDir(), "mine.txt"))).toBe("keep");
    expect(spawn.calls).toEqual([]);
    // Refused before anything is placed: the persona does not declare it either.
    expect(read(join(s.repo, ".donn/persona.yaml"))).toBe(PERSONA);
  });

  it("stops at a blocking portability entry before writing the agent", async () => {
    vi.spyOn(adapter, "templates").mockReturnValue([
      row("eve-slack-agent", ["connect", "ai-gateway"]),
    ]);
    const { code, stdout, stderr, spawn } = await create(
      ["slack", "--template", "eve:eve-slack-agent", "--target", "local"],
      { slug: "eve-slack-agent" },
    );
    expect(code).toBe(1);
    expect(stderr).toContain("blocking: connect (local)");
    expect(stderr).toContain("error: ");
    expect(stderr).toContain("--accept-portability");
    expect(stdout).toBe("");
    expect(existsSync(agentDir("slack"))).toBe(false);
    expect(spawn.calls).toEqual([]);
    expect(stderr).not.toContain("declared agents.define");
    expect(read(join(s.repo, ".donn/persona.yaml"))).toBe(PERSONA);
  });

  it("declares a refused agent once the blocking entry is accepted", async () => {
    vi.spyOn(adapter, "templates").mockReturnValue([
      row("eve-slack-agent", ["connect", "ai-gateway"]),
    ]);
    const args = ["slack", "--template", "eve:eve-slack-agent"];
    const refused = await create([...args, "--target", "local"], {
      slug: "eve-slack-agent",
    });
    expect(refused.code).toBe(1);
    const { code, stderr } = await create(
      [...args, "--target", "local", "--accept-portability"],
      { slug: "eve-slack-agent" },
    );
    expect(code).toBe(0);
    expect(stderr).toContain("declared agents.define.slack");
    expect(read(join(s.repo, ".donn/persona.yaml"))).toMatch(
      /agents:\n {2}define:\n {4}slack:\n/,
    );
  });

  it("refuses to declare under a locked agents.define, naming the layer and writing nothing", async () => {
    const org = join(s.personas, "org/base.yaml");
    writeFileSync(
      org,
      read(org).replace("locks:\n", "locks:\n  - agents.define\n"),
    );
    const before = read(join(s.repo, ".donn/persona.yaml"));
    const { code, stdout } = await create([
      "voice",
      "--template",
      "eve:eve-voice-template",
      "--target",
      "local",
      "--json",
    ]);
    expect(code).toBe(1);
    expect(JSON.parse(stdout).error).toMatchObject({
      code: "agent-locked",
      layer: "org/base",
    });
    expect(read(join(s.repo, ".donn/persona.yaml"))).toBe(before);
    expect(existsSync(agentDir())).toBe(false);
  });

  it("--dry-run shows the edit and writes nothing", async () => {
    voice();
    const before = read(join(s.repo, ".donn/persona.yaml"));
    const { code, stdout, stderr, spawn } = await create([
      "voice",
      "--template",
      "eve:eve-voice-template",
      "--target",
      "local",
      "--dry-run",
    ]);
    expect(stderr).not.toContain("error:");
    expect(code).toBe(0);
    expect(stdout).toContain("+ agents:");
    expect(stdout).toContain("+     voice:");
    expect(read(join(s.repo, ".donn/persona.yaml"))).toBe(before);
    expect(existsSync(agentDir())).toBe(false);
    expect(existsSync(join(s.home, "agents"))).toBe(false);
    expect(spawn.calls).toEqual([]);
  });

  it("needs --template and --target for an agent the persona does not declare", async () => {
    const { code, stdout } = await create(["voice", "--json"]);
    expect(code).toBe(1);
    expect(JSON.parse(stdout).error.code).toBe("agent-not-declared");
  });

  it("writes no secret value anywhere", async () => {
    voice();
    const { code, stdout } = await create([
      "voice",
      "--template",
      "eve:eve-voice-template",
      "--target",
      "self-host",
      "--json",
    ]);
    expect(code).toBe(0);
    expect(stdout).not.toContain(SECRET);
    const roots = [agentDir(), join(s.home, "agents"), join(s.repo, ".donn")];
    let seen = 0;
    for (const root of roots)
      for (const file of walk(root)) {
        seen++;
        expect(read(join(root, file)), file).not.toContain(SECRET);
      }
    expect(seen).toBeGreaterThan(10);
    // The ref is there, the value is not.
    expect(read(join(agentDir(), "agent/lib/donn/config.ts"))).toContain(
      "process.env.",
    );
  });

  it("adds the Vercel CLI as a pinned dev dependency for target vercel", async () => {
    voice();
    const { code } = await create([
      "voice",
      "--template",
      "eve:eve-voice-template",
      "--target",
      "vercel",
    ]);
    expect(code).toBe(0);
    const pkg = JSON.parse(read(join(agentDir(), "package.json")));
    expect(pkg.devDependencies).toEqual({ vercel: "50.1.0" });
  });
});

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentProbe,
  agentProject,
  createAgent,
  SECRETS,
} from "../test/created-agent.js";
import { fakeEve, type FakeEve } from "../test/fake-eve.js";
import { seed, zz, type Seeded } from "../test/seed.js";

// `donn agent build` for self-host: eve build on the host, then donn's deploy files.
// See docs/planning/25-agent-runner.md, section 4 `self-host`.

const IMAGE = "eve-sandbox-template:abc123";
const ARTIFACTS = JSON.stringify({
  entries: [
    {
      artifact: { imageReference: IMAGE },
      nodeId: "__root__",
      providerName: "docker",
    },
  ],
  kind: "eve-sandbox-prepared-artifacts",
  version: 2,
});

let s: Seeded;
beforeEach(() => {
  s = seed();
});
afterEach(() => s.cleanup());

const agentDir = () => join(s.repo, "agents/kody");
const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** `eve build` writes `.output/` (and the prepared-artifacts file unless `artifacts` is false). */
const building = (artifacts: string | false = ARTIFACTS): FakeEve =>
  fakeEve({
    replies: [
      {
        eve: ["build"],
        lines: ["built"],
        effect: (c) => {
          put(join(c.cwd, ".output/server/index.mjs"), "// server\n");
          if (artifacts !== false)
            put(
              join(
                c.cwd,
                ".output/.eve/compile/sandbox-prepared-artifacts.json",
              ),
              artifacts,
            );
        },
      },
    ],
  });

const build = (
  args: string[] = [],
  spawn: FakeEve = building(),
  probe = agentProbe(),
) =>
  zz(["agent", "build", "kody", "--project", s.repo, ...args], {
    cwd: s.root,
    home: s.home,
    env: SECRETS,
    probe,
    spawn,
  });

const createSelfHost = async (world?: "postgres") => {
  agentProject(s, "self-host");
  if (world !== undefined) {
    const file = join(s.repo, ".donn/persona.yaml");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "      target: self-host\n",
        `      target: self-host\n      world: ${world}\n`,
      ),
    );
  }
  await createAgent(s);
};

const DOCKERFILE = `# Written by donn agent build; donn owns this file.
FROM node:26-slim
COPY --from=docker:28.3-cli /usr/local/bin/docker /usr/local/bin/docker
COPY .output /agent/.output
WORKDIR /agent
ENV HOST=0.0.0.0 PORT=3000 NODE_ENV=production
VOLUME /agent/.eve
CMD ["node", ".output/server/index.mjs"]
`;

const manifest = () =>
  JSON.parse(readFileSync(join(agentDir(), ".donn/agent.json"), "utf8"));

describe("donn agent build", () => {
  it("writes the Dockerfile and env.json, records them under deploy, prints both images", async () => {
    await createSelfHost();
    const r = await build();
    expect(r.stderr).not.toContain("error");
    expect(r.code).toBe(0);
    expect(
      readFileSync(join(agentDir(), "deploy/donn/Dockerfile"), "utf8"),
    ).toBe(DOCKERFILE);
    const env = JSON.parse(
      readFileSync(join(agentDir(), "deploy/donn/env.json"), "utf8"),
    );
    expect(env).toEqual({
      env: [
        {
          name: "API_TOKEN",
          source: "secret",
          ref: "secret://env/API_TOKEN",
          why: "persona-secret",
        },
        {
          name: "DONN_ROUTE_TOKEN",
          source: "runtime",
          why: "route-auth",
        },
        {
          name: "GREETING",
          source: "plain",
          value: "hello",
          why: "template-variable",
        },
        {
          name: "DONN_SECRET_1",
          source: "secret",
          ref: "secret://env/GATEWAY_KEY",
          why: "gateway-key",
        },
      ].sort((a, b) => a.name.localeCompare(b.name)),
      sandboxImage: IMAGE,
      mounts: ["/var/run/docker.sock:/var/run/docker.sock"],
      volumes: ["/agent/.eve"],
      proxy: ["/eve/", "/.well-known/workflow/"],
    });
    const m = manifest();
    expect(Object.keys(m.deploy).sort()).toEqual([
      "deploy/donn/Dockerfile",
      "deploy/donn/env.json",
    ]);
    expect(m.deploy["deploy/donn/Dockerfile"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(m.files["deploy/donn/Dockerfile"]).toBeUndefined();
    expect(r.stdout).toContain(IMAGE);
    expect(r.stdout).toContain(
      "docker build -f deploy/donn/Dockerfile -t kody .",
    );
    expect(r.stdout).toContain(`docker save ${IMAGE}`);
  });

  it("env.json holds no secret value nor an empty one", async () => {
    await createSelfHost();
    await build();
    const text = readFileSync(join(agentDir(), "deploy/donn/env.json"), "utf8");
    expect(text).not.toContain("sk-gw-SECRET");
    expect(text).not.toContain("tok-SECRET");
    for (const e of JSON.parse(text).env)
      if (e.source !== "plain") expect(e).not.toHaveProperty("value");
  });

  it("builds on the host with no secret in eve's env", async () => {
    await createSelfHost();
    const spawn = building();
    const probe = agentProbe();
    await build([], spawn, probe);
    const call = spawn.calls.find((c) => c.args.includes("build"))!;
    expect(call.args).toEqual(["exec", "eve", "build"]);
    expect(call.env.NODE_ENV).toBe("production");
    expect(probe.dockerCalls[0]).toEqual(["info"]);
  });

  it("--json prints { agent, dir, dockerfile, envFile, sandboxImages, report }", async () => {
    await createSelfHost();
    const r = await build(["--json"]);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({
      agent: "kody",
      dir: agentDir(),
      dockerfile: join(agentDir(), "deploy/donn/Dockerfile"),
      envFile: join(agentDir(), "deploy/donn/env.json"),
      sandboxImages: [IMAGE],
    });
    expect(out.report).toBeDefined();
  });

  it("without the prepared-artifacts file there is no sandbox image, and it says so", async () => {
    await createSelfHost();
    const r = await build([], building(false));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no sandbox image");
    const env = JSON.parse(
      readFileSync(join(agentDir(), "deploy/donn/env.json"), "utf8"),
    );
    expect(env.sandboxImage).toBeNull();
  });

  it("a malformed prepared-artifacts file stops the build", async () => {
    await createSelfHost();
    const r = await build(["--json"], building("{ nope"));
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout).error.code).toBe("invalid-sandbox-artifacts");
    expect(existsSync(join(agentDir(), "deploy/donn/Dockerfile"))).toBe(false);
  });

  it("stops with docker-unreachable before building", async () => {
    await createSelfHost();
    const spawn = building();
    const probe = {
      ...agentProbe(),
      run: async () => ({ exitCode: 1, stdout: "", stderr: "no daemon" }),
    };
    const r = await build(["--json"], spawn, probe);
    const error = JSON.parse(r.stdout).error;
    expect(error.code).toBe("docker-unreachable");
    expect(error.fix).toContain("start Docker");
    expect(spawn.calls).toEqual([]);
  });

  it("a failed eve build is eve-failed", async () => {
    await createSelfHost();
    const spawn = fakeEve({ replies: [{ eve: ["build"], exitCode: 2 }] });
    const r = await build(["--json"], spawn);
    expect(JSON.parse(r.stdout).error.code).toBe("eve-failed");
  });

  it.each([
    ["local", "donn agent run kody"],
    ["vercel", "donn agent deploy kody"],
  ])("refuses a %s agent", async (target, fix) => {
    agentProject(s, target);
    await createAgent(s);
    const r = await build(["--json"]);
    const error = JSON.parse(r.stdout).error;
    expect(error.code).toBe("target-not-buildable");
    expect(error).toMatchObject({ target, fix });
  });

  it("refuses an agent that is not created", async () => {
    agentProject(s, "self-host");
    const r = await build(["--json"]);
    expect(JSON.parse(r.stdout).error.code).toBe("agent-not-created");
  });

  it("world: postgres bootstraps the schema before the server and lists the database", async () => {
    await createSelfHost("postgres");
    put(
      join(agentDir(), "node_modules/@workflow/world-postgres/package.json"),
      '{ "name": "@workflow/world-postgres", "version": "5.0.4" }\n',
    );
    const r = await build();
    expect(r.code).toBe(0);
    const docker = readFileSync(
      join(agentDir(), "deploy/donn/Dockerfile"),
      "utf8",
    );
    expect(docker).toBe(`# Written by donn agent build; donn owns this file.
FROM node:26-slim
COPY --from=docker:28.3-cli /usr/local/bin/docker /usr/local/bin/docker
RUN npm install --prefix /bootstrap --no-save --ignore-scripts @workflow/world-postgres@5.0.4
COPY .output /agent/.output
WORKDIR /agent
ENV HOST=0.0.0.0 PORT=3000 NODE_ENV=production
VOLUME /agent/.eve
CMD ["sh", "-c", "/bootstrap/node_modules/.bin/bootstrap && exec node .output/server/index.mjs"]
`);
    const env = JSON.parse(
      readFileSync(join(agentDir(), "deploy/donn/env.json"), "utf8"),
    );
    expect(env.env).toContainEqual({
      name: "WORKFLOW_POSTGRES_URL",
      source: "runtime",
      why: "world-database",
    });
  });

  it("world: postgres without the package installed stops", async () => {
    await createSelfHost("postgres");
    const r = await build(["--json"]);
    expect(JSON.parse(r.stdout).error.code).toBe("world-package-missing");
  });

  it("refuses a hand-edited deploy file unless --force, and sync leaves deploy alone", async () => {
    await createSelfHost();
    await build();
    const file = join(agentDir(), "deploy/donn/Dockerfile");
    writeFileSync(file, `${DOCKERFILE}RUN echo mine\n`);
    const refused = await build(["--json"]);
    expect(JSON.parse(refused.stdout).error.code).toBe("owned-file-edited");
    expect(readFileSync(file, "utf8")).toContain("echo mine");

    const synced = await zz(
      ["agent", "sync", "kody", "--project", s.repo, "--json"],
      { cwd: s.root, home: s.home, env: SECRETS, probe: agentProbe() },
    );
    expect(synced.code).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("echo mine");
    expect(Object.keys(manifest().deploy)).toHaveLength(2);

    const forced = await build(["--force"]);
    expect(forced.code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(DOCKERFILE);
  });

  it("refuses a stale agent before building: agent-stale, sync first", async () => {
    await createSelfHost();
    const file = join(s.repo, ".donn/persona.yaml");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "inline: Checkout overview.",
        "inline: Checkout overview v2.",
      ),
    );
    const spawn = building();
    const r = await build(["--json"], spawn);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error).toMatchObject({
      code: "agent-stale",
      fix: "donn agent sync kody",
    });
    expect(spawn.calls).toHaveLength(0);
    expect(existsSync(join(agentDir(), "deploy/donn/Dockerfile"))).toBe(false);

    const synced = await zz(["agent", "sync", "kody", "--project", s.repo], {
      cwd: s.root,
      home: s.home,
      env: SECRETS,
      probe: agentProbe(),
    });
    expect(synced.code).toBe(0);
    expect((await build()).code).toBe(0);
  });

  it("a second build over untouched files is fine, and list reports built", async () => {
    await createSelfHost();
    await build();
    expect((await build()).code).toBe(0);
    const list = await zz(["agent", "list", "--project", s.repo, "--json"], {
      cwd: s.root,
      home: s.home,
      env: SECRETS,
      probe: agentProbe(),
    });
    expect(JSON.parse(list.stdout).agents[0].state).toBe("built");
  });
});

import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Probe } from "@getdonn/adapter-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEve } from "../test/fake-eve.js";
import { quietIo, seed, zz, type Seeded } from "../test/seed.js";
import { projectContext } from "./load.js";
import { syncAgent } from "./sync.js";

// `donn agent list` and `donn agent sync` against a temp project and a path template.
// See docs/planning/25-agent-runner.md, sections 1 and 3.

const AGENT_TS = `import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-6-luna-fast",
});
`;

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

const SKILL = (name: string) =>
  `---\nname: ${name}\ndescription: Does ${name}.\n---\nDo ${name}.\n`;

let s: Seeded;
beforeEach(() => {
  s = seed();
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(s.repo, path)), { recursive: true });
    writeFileSync(join(s.repo, path), text);
  };
  put(".donn/templates/kody/package.json", '{ "name": "kody" }\n');
  put(".donn/templates/kody/agent/agent.ts", AGENT_TS);
  put(".donn/skills/extra/SKILL.md", SKILL("extra"));
  put(
    ".donn/persona.yaml",
    `apiVersion: donn/v0
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
      target: local
targets:
  eve:
    contextWindow: 128000
`,
  );
});
afterEach(() => s.cleanup());

const run = (argv: string[]) =>
  zz(["agent", ...argv, "--project", s.repo], {
    cwd: s.root,
    home: s.home,
    env: { GATEWAY_KEY: "sk-test-SECRET" },
    probe,
    spawn: fakeEve({
      replies: [
        {
          when: (c) => c.command === "pnpm",
          effect: (c) => {
            mkdirSync(join(c.cwd, "node_modules/eve"), { recursive: true });
          },
        },
      ],
    }),
  });

const persona = () => join(s.repo, ".donn/persona.yaml");
const dir = () => join(s.repo, "agents/kody");
const rows = async () =>
  JSON.parse((await run(["list", "--json"])).stdout).agents;
const SKILL_FILE = "agent/skills/donn-extra/SKILL.md";
const create = async () => {
  const r = await run(["create", "kody"]);
  expect(r.stderr).not.toContain("error");
  expect(r.code).toBe(0);
};
const addSkill = () =>
  writeFileSync(
    persona(),
    readFileSync(persona(), "utf8") +
      "skills:\n  include:\n    - ./skills/extra\n",
  );

describe("donn agent list", () => {
  it("shows an inherited agent as available, then created and current", async () => {
    expect(await rows()).toEqual([
      expect.objectContaining({
        name: "kody",
        target: "local",
        state: "available",
        current: false,
      }),
    ]);
    await create();
    expect(await rows()).toEqual([
      expect.objectContaining({
        name: "kody",
        template: "project/templates/kody",
        path: "agents/kody",
        state: "created",
        current: true,
      }),
    ]);
    const text = await run(["list"]);
    expect(text.stdout).toMatch(
      /kody\s+project\/templates\/kody\s+local\s+created\s+current/,
    );
  });

  it("marks a persona change stale, and a target change recreate needed", async () => {
    await create();
    addSkill();
    expect((await rows())[0]).toMatchObject({
      state: "created",
      current: false,
    });
    writeFileSync(
      persona(),
      readFileSync(persona(), "utf8").replace(
        "target: local",
        "target: self-host",
      ),
    );
    expect((await rows())[0]).toMatchObject({ recreate: "target" });
    expect((await run(["list"])).stdout).toContain("recreate needed (target)");
  });
});

describe("donn agent sync", () => {
  it("writes a new skill and removes a dropped one", async () => {
    await create();
    expect(existsSync(join(dir(), SKILL_FILE))).toBe(false);
    addSkill();
    const synced = await run(["sync", "kody"]);
    expect(synced.code).toBe(0);
    expect(synced.stdout).toContain(`wrote agents/kody/${SKILL_FILE}`);
    expect(existsSync(join(dir(), SKILL_FILE))).toBe(true);
    expect((await rows())[0].current).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(dir(), ".donn/agent.json"), "utf8"),
    );
    expect(Object.keys(manifest.files)).toContain(SKILL_FILE);

    writeFileSync(
      persona(),
      readFileSync(persona(), "utf8").replace(
        "    - ./skills/extra\n",
        "    - ./skills/extra\n  exclude:\n    - donn-extra\n    - extra\n",
      ),
    );
    const dropped = await run(["sync", "kody", "--json"]);
    expect(JSON.parse(dropped.stdout).removed).toContain(SKILL_FILE);
    expect(existsSync(join(dir(), SKILL_FILE))).toBe(false);
  });

  it("--dry-run writes nothing and lists what would change", async () => {
    await create();
    addSkill();
    const dry = await run(["sync", "kody", "--dry-run", "--json"]);
    expect(JSON.parse(dry.stdout).written).toContain(SKILL_FILE);
    expect(existsSync(join(dir(), SKILL_FILE))).toBe(false);
  });

  it("a sync waits for another one's lock: neither sees the other's files as edited", async () => {
    await create();
    // Changes a file donn already wrote, so a write the first did not see reads as an edit.
    writeFileSync(
      persona(),
      readFileSync(persona(), "utf8").replace(
        "inline: Checkout overview.",
        "inline: Checkout overview v2.",
      ),
    );
    const io = {
      ...quietIo({
        cwd: s.root,
        home: s.home,
        env: { GATEWAY_KEY: "sk-test-SECRET" },
      }),
      probe,
    };
    const ctx = async () => projectContext(io, s.repo);
    // The first stops between its compile and its writes until the second is done, or for
    // 300 ms if the second has to wait for it.
    // eslint-disable-next-line prefer-const -- read by the first sync's callback before it is set
    let second!: Promise<unknown>;
    const first = syncAgent(await ctx(), io, "kody", {
      onCompiled: () =>
        Promise.race([
          second.catch(() => undefined),
          new Promise((r) => setTimeout(r, 300)),
        ]).then(() => undefined),
    });
    second = (async () => syncAgent(await ctx(), io, "kody"))();
    const results = await Promise.allSettled([first, second]);
    expect(results).toEqual([
      expect.objectContaining({ status: "fulfilled" }),
      expect.objectContaining({ status: "fulfilled" }),
    ]);
    expect((await rows())[0]).toMatchObject({ current: true });
  });

  it("stops at an edited owned file, naming it; --force overwrites", async () => {
    await create();
    addSkill();
    const owned = join(dir(), "agent/lib/donn/config.ts");
    writeFileSync(owned, "// mine\n");
    const stopped = await run(["sync", "kody", "--json"]);
    expect(stopped.code).not.toBe(0);
    expect(stopped.stderr + stopped.stdout).toContain("owned-file-edited");
    expect(stopped.stderr + stopped.stdout).toContain(
      "agent/lib/donn/config.ts",
    );
    expect(existsSync(join(dir(), SKILL_FILE))).toBe(false);
    const forced = await run(["sync", "kody", "--force"]);
    expect(forced.code).toBe(0);
    expect(readFileSync(owned, "utf8")).not.toBe("// mine\n");
  });

  it("--dry-run stops at an edited owned file too; --force reports it and writes nothing", async () => {
    await create();
    addSkill();
    const owned = join(dir(), "agent/lib/donn/config.ts");
    writeFileSync(owned, "// mine\n");
    const stopped = await run(["sync", "kody", "--dry-run", "--json"]);
    expect(stopped.code).not.toBe(0);
    expect(stopped.stdout + stopped.stderr).toContain("owned-file-edited");
    const forced = await run([
      "sync",
      "kody",
      "--dry-run",
      "--force",
      "--json",
    ]);
    expect(forced.code).toBe(0);
    expect(JSON.parse(forced.stdout).edited).toEqual([
      "agent/lib/donn/config.ts",
    ]);
    expect(readFileSync(owned, "utf8")).toBe("// mine\n");
    expect(existsSync(join(dir(), SKILL_FILE))).toBe(false);
  });

  it("refuses recreate-needed without writing, and never touches agent.ts", async () => {
    await create();
    const before = readFileSync(join(dir(), "agent/agent.ts"), "utf8");
    addSkill();
    writeFileSync(
      persona(),
      readFileSync(persona(), "utf8").replace(
        "target: local",
        "target: self-host",
      ),
    );
    const r = await run(["sync", "kody", "--json"]);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("recreate-needed");
    expect(r.stdout + r.stderr).toContain('"field": "target"');
    expect(existsSync(join(dir(), SKILL_FILE))).toBe(false);
    expect(readFileSync(join(dir(), "agent/agent.ts"), "utf8")).toBe(before);
  });

  it("refuses an agent that was not created", async () => {
    const r = await run(["sync", "kody", "--json"]);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("agent-not-created");
  });
});

// With a gateway, each subagent's agent.ts spreads its donnSubagent entry: create edits it once,
// sync edits one it has not seen (a subagent added later, a gateway added later).
// See docs/planning/24-adapter-eve.md, section 2.
describe("subagents through the gateway", () => {
  const RESEARCHER = `import { defineAgent } from "eve";

export default defineAgent({
  description: "Research a topic.",
  model: "openai/gpt-5.6-terra",
  tool: false,
});
`;
  const IMPORT = 'import { donnSubagent } from "../../lib/donn/config";';
  const SUB = "agent/subagents/researcher/agent.ts";
  const template = (path: string, text: string) => {
    mkdirSync(dirname(join(s.repo, ".donn/templates/kody", path)), {
      recursive: true,
    });
    writeFileSync(join(s.repo, ".donn/templates/kody", path), text);
  };
  const manifest = () =>
    JSON.parse(readFileSync(join(dir(), ".donn/agent.json"), "utf8"));
  const config = () =>
    readFileSync(join(dir(), "agent/lib/donn/config.ts"), "utf8");
  const noGateway = () =>
    writeFileSync(
      persona(),
      readFileSync(persona(), "utf8").replace(
        /models:\n(?: {2}.*\n)+/,
        "models:\n  default: openai/gpt-5\n",
      ),
    );

  it("create edits each subagent once, records it, and reports the replaced model", async () => {
    template(SUB, RESEARCHER);
    const r = await run(["create", "kody"]);
    expect(r.stderr).not.toContain("error");
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(
      "subagent researcher's own model openai/gpt-5.6-terra is replaced by the gateway's gpt-5",
    );
    const text = readFileSync(join(dir(), SUB), "utf8");
    expect(text).toContain(IMPORT);
    expect(text).toContain(
      "  tool: false,\n  ...donnSubagent.researcher,\n});",
    );
    expect(text).toContain('model: "openai/gpt-5.6-terra"');
    expect(config()).toContain("export const donnSubagent = {");
    expect(manifest().edits).toContain(SUB);
    expect(manifest().files[SUB]).toBeUndefined();
    // The template is untouched.
    expect(
      readFileSync(join(s.repo, ".donn/templates/kody", SUB), "utf8"),
    ).toBe(RESEARCHER);
  });

  it("a second sync changes nothing", async () => {
    template(SUB, RESEARCHER);
    await create();
    const before = readFileSync(join(dir(), SUB), "utf8");
    const r = await run(["sync", "kody", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ written: [], removed: [] });
    expect(readFileSync(join(dir(), SUB), "utf8")).toBe(before);
    expect((await rows())[0].current).toBe(true);
  });

  it("sync edits a subagent added after create, and list calls the agent stale until then", async () => {
    await create();
    mkdirSync(dirname(join(dir(), SUB)), { recursive: true });
    writeFileSync(join(dir(), SUB), RESEARCHER);
    expect((await rows())[0].current).toBe(false);
    const dry = await run(["sync", "kody", "--dry-run", "--json"]);
    expect(JSON.parse(dry.stdout).written).toContain(SUB);
    expect(readFileSync(join(dir(), SUB), "utf8")).toBe(RESEARCHER);
    const r = await run(["sync", "kody", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).written).toEqual(
      expect.arrayContaining([SUB, "agent/lib/donn/config.ts"]),
    );
    expect(readFileSync(join(dir(), SUB), "utf8")).toContain(
      "...donnSubagent.researcher",
    );
    expect(manifest().edits).toContain(SUB);
    expect((await rows())[0].current).toBe(true);
  });

  it("refuses a subagent it cannot edit, naming the file, before writing anything", async () => {
    template(
      SUB,
      'import { defineDynamic } from "eve";\nexport default defineDynamic({ events: {} });\n',
    );
    const r = await run(["create", "kody", "--json"]);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("agent-ts-unrecognised");
    expect(r.stdout + r.stderr).toContain(SUB);
    expect(existsSync(dir())).toBe(false);
  });

  it("without a gateway nothing changes: no edit, no donnSubagent, no entry", async () => {
    noGateway();
    template(SUB, RESEARCHER);
    const r = await run(["create", "kody"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("subagent researcher");
    expect(readFileSync(join(dir(), SUB), "utf8")).toBe(RESEARCHER);
    expect(config()).not.toContain("donnSubagent");
    expect(manifest().edits).not.toContain(SUB);
  });

  it("a gateway removed later keeps an edited subagent building on its own model", async () => {
    template(SUB, RESEARCHER);
    await create();
    noGateway();
    const r = await run(["sync", "kody"]);
    expect(r.code).toBe(0);
    expect(config()).toContain(
      "export const donnSubagent = {\n  researcher: {},\n};",
    );
    expect(readFileSync(join(dir(), SUB), "utf8")).toContain(
      "...donnSubagent.researcher",
    );
  });
});

void rmSync;

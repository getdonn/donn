import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import adapter, { portability } from "@getdonn/adapter-eve";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentProbe,
  agentProject,
  createAgent,
  SECRETS,
} from "../test/created-agent.js";
import {
  COMPLETED,
  FAILED_BUILD_POLICY,
  INPUT_REQUIRED,
  PREREQUISITE,
  PREREQUISITE_MIXED,
  SECRET_PREREQUISITE,
  SECRET_QUESTION,
} from "../test/eve-add/recordings.js";
import { fakeEve, type FakeEve, type FakeEveCall } from "../test/fake-eve.js";
import { seed, zz, type Seeded } from "../test/seed.js";
import { askAnswers, parseAnswer, type AgentQuestion } from "./questions.js";

// `donn agent add`: eve add's question protocol, replayed from the spike's recordings
// (docs/planning/26-gui.md, the 2026-10-25 amendment; 25-agent-runner.md §6). And
// `donn agent templates`.

let s: Seeded;
beforeEach(() => {
  s = seed();
});
afterEach(() => s.cleanup());

const agentDir = () => join(s.repo, "agents/kody");
const ITEM = "channel/github";

/** The arguments after `exec eve` of each eve call. */
const eveArgs = (spawn: FakeEve) =>
  spawn.calls.map((c) => c.args.slice(c.args.indexOf("eve") + 1));

const answered = (c: FakeEveCall) => c.args.includes("--answer");

/** eve add: the question first, the prerequisite once answered. */
const askingEve = () =>
  fakeEve({
    replies: [
      {
        eve: ["add"],
        when: (c) => !answered(c),
        lines: INPUT_REQUIRED,
        exitCode: 2,
      },
      { eve: ["add"], lines: PREREQUISITE, exitCode: 2 },
    ],
  });

const add = (argv: string[], extra: Partial<Parameters<typeof zz>[1]> = {}) =>
  zz(["agent", "add", "kody", ITEM, ...argv, "--project", s.repo], {
    cwd: s.root,
    home: s.home,
    env: SECRETS,
    probe: agentProbe(),
    ...extra,
  });

describe("donn agent add", () => {
  beforeEach(async () => {
    agentProject(s);
    await createAgent(s);
  });

  it("returns eve's question with the command that continues it, exit 2", async () => {
    const spawn = askingEve();
    const r = await add(["--json"], { spawn });
    expect(r.code, r.stdout).toBe(2);
    expect(JSON.parse(r.stdout)).toEqual({
      status: "needs-answer",
      item: ITEM,
      question: {
        key: "github-events",
        message: "What should this GitHub App respond to?",
        kind: "multi-select",
        required: true,
        options: [
          expect.objectContaining({ id: "issue_comment" }),
          expect.objectContaining({ id: "pull_request_review_comment" }),
          expect.objectContaining({ id: "issues" }),
          {
            id: "pull_request",
            label: "New PRs",
            hint: "Add comments to new pull requests.",
          },
        ],
        recommended: ["issue_comment", "pull_request_review_comment"],
      },
      // eve's next.args: installed, so --skip-install; the asked key is left to answer.
      continue: [
        "agent",
        "add",
        "kody",
        ITEM,
        "--skip-install",
        "--project",
        s.repo,
        "--json",
      ],
    });
    expect(eveArgs(spawn)).toEqual([["add", ITEM, "--non-interactive"]]);
    expect(spawn.calls[0]!.cwd).toBe(agentDir());
    expect(spawn.calls[0]!.command).toBe("pnpm");
    // Progress, never the question's JSON, goes to stderr under --json.
    expect(r.stderr).toContain("Installed channel/github");
    expect(r.stderr).toContain("Checking Vercel setup...");
    expect(r.stderr).not.toContain('"version":1');
  });

  it("passes an answer to eve as --answer key=<JSON>; a local agent is shown the prerequisite", async () => {
    const spawn = askingEve();
    const r = await add(
      ["--skip-install", '--answer=github-events=["pull_request"]', "--json"],
      { spawn },
    );
    expect(r.code, r.stdout).toBe(2);
    expect(eveArgs(spawn)).toEqual([
      [
        "add",
        ITEM,
        "--non-interactive",
        "--skip-install",
        "--answer",
        'github-events=["pull_request"]',
      ],
    ]);
    expect(JSON.parse(r.stdout)).toEqual({
      status: "needs-prerequisite",
      item: ITEM,
      prerequisite: {
        kind: "command",
        code: "vercel-project-link",
        message:
          "GitHub setup requires a linked Vercel project. Run `eve link`, then retry.",
        command: "eve link",
      },
      continue: [
        "agent",
        "add",
        "kody",
        ITEM,
        "--skip-install",
        '--answer=github-events=["pull_request"]',
        "--project",
        s.repo,
        "--json",
      ],
      fix: expect.stringContaining("eve link"),
    });
    // Not a vercel agent: donn does not run eve link.
    expect(eveArgs(spawn).some((a) => a[0] === "link")).toBe(false);
  });

  it("takes --answer key=<JSON> as two arguments, encoding a value that is not JSON", async () => {
    const spawn = fakeEve({
      replies: [{ eve: ["add"], lines: COMPLETED }],
    });
    const r = await add(
      [
        "--answer",
        "app-name=donn-kody",
        "--answer",
        "private=true",
        "--answer=events=[1]",
        "--json",
      ],
      { spawn },
    );
    expect(r.code, r.stdout).toBe(0);
    expect(eveArgs(spawn)[0]).toEqual([
      "add",
      ITEM,
      "--non-interactive",
      "--answer",
      'app-name="donn-kody"',
      "--answer",
      "private=true",
      "--answer",
      "events=[1]",
    ]);
  });

  it("refuses an answer without a question's key, running nothing", async () => {
    for (const answer of ["=1", "1a=2", "no-value", "--yes=1"]) {
      const spawn = fakeEve();
      const r = await add([`--answer=${answer}`, "--json"], { spawn });
      expect(r.code, answer).toBe(1);
      expect(JSON.parse(r.stdout).error.code, answer).toBe("invalid-answer");
      expect(spawn.calls).toEqual([]);
    }
  });

  it("reports eve's completion", async () => {
    const spawn = fakeEve({ replies: [{ eve: ["add"], lines: COMPLETED }] });
    const r = await add(["--json"], { spawn });
    expect(r.code, r.stdout).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      status: "completed",
      item: ITEM,
      completedItems: [ITEM],
    });
    expect(r.stderr).toContain("GitHub App: donn-kody");
    const human = await add([], { spawn });
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("added channel/github to kody");
  });

  it("fails as eve-add-failed with eve's failureCode and rolledBack", async () => {
    const spawn = fakeEve({
      replies: [{ eve: ["add"], lines: FAILED_BUILD_POLICY, exitCode: 1 }],
    });
    const r = await add(["--json"], { spawn });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error).toMatchObject({
      code: "eve-add-failed",
      message: expect.stringContaining("pnpm approve-builds"),
      item: ITEM,
      failureCode: "pnpm_build_policy",
      rolledBack: true,
    });
  });

  it("reads eve's events from either stream", async () => {
    const spawn = fakeEve({
      replies: [{ eve: ["add"], lines: PREREQUISITE_MIXED, exitCode: 2 }],
    });
    const r = await add(["--json"], { spawn });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({
      status: "needs-prerequisite",
      prerequisite: { code: "vercel-project-link" },
      continue: expect.arrayContaining([
        '--answer=github-events=["issue_comment","pull_request"]',
      ]),
    });
  });

  it("an exit without an event is eve-failed, with the last lines", async () => {
    const spawn = fakeEve({
      replies: [{ eve: ["add"], lines: ["boom"], exitCode: 1 }],
    });
    const r = await add(["--json"], { spawn });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error).toMatchObject({
      code: "eve-failed",
      exitCode: 1,
      tail: ["boom"],
    });
  });

  it("holds the agent's lock while eve runs", async () => {
    const locks = () =>
      readdirSync(join(s.home, "agents"), { recursive: true }).filter((p) =>
        String(p).endsWith("kody.lock"),
      );
    let held: unknown[] = [];
    const spawn = fakeEve({
      replies: [
        {
          eve: ["add"],
          lines: COMPLETED,
          effect: () => {
            held = locks();
          },
        },
      ],
    });
    const r = await add(["--json"], { spawn });
    expect(r.code, r.stdout).toBe(0);
    expect(held).toHaveLength(1);
    expect(locks()).toEqual([]);
  });

  it("asks on a terminal and continues with the answer", async () => {
    const spawn = fakeEve({
      replies: [
        {
          eve: ["add"],
          when: (c) => !answered(c),
          lines: INPUT_REQUIRED,
          exitCode: 2,
        },
        { eve: ["add"], lines: COMPLETED },
      ],
    });
    const prompts: string[] = [];
    const r = await add([], {
      spawn,
      ask: async (prompt) => {
        prompts.push(prompt);
        return "1, 4";
      },
    });
    expect(r.code, r.stderr).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(r.stderr).toContain("What should this GitHub App respond to?");
    expect(r.stderr).toContain("New PRs");
    expect(eveArgs(spawn)).toEqual([
      ["add", ITEM, "--non-interactive"],
      [
        "add",
        ITEM,
        "--non-interactive",
        "--skip-install",
        "--answer",
        'github-events=["issue_comment","pull_request"]',
      ],
    ]);
    expect(r.stdout).toContain("added channel/github to kody");
  });

  it("without a terminal, prints the question and the command to answer it", async () => {
    const r = await add([], { spawn: askingEve() });
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("What should this GitHub App respond to?");
    expect(r.stdout).toContain("pull_request");
    expect(r.stdout).toContain(
      `donn agent add kody channel/github --skip-install --project ${s.repo} --answer 'github-events=<JSON>'`,
    );
  });

  it("names the variable of a secret question; never asks it, never takes it on the command line", async () => {
    const spawn = fakeEve({
      replies: [{ eve: ["add"], lines: SECRET_PREREQUISITE, exitCode: 2 }],
    });
    const r = await add(["--json"], { spawn });
    expect(r.code, r.stdout).toBe(2);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({
      status: "needs-answer",
      question: {
        key: "github-private-key",
        kind: "environment",
        variable: "GITHUB_APP_PRIVATE_KEY",
        message: "Set GITHUB_APP_PRIVATE_KEY, then retry setup.",
        required: true,
      },
      fix: expect.stringContaining("GITHUB_APP_PRIVATE_KEY"),
    });
    expect(out.continue).toContain('--answer=github-events=["pull_request"]');
    expect(
      out.continue.some((a: string) => a.startsWith("--answer=github-private")),
    ).toBe(false);

    // On a terminal too: named, not asked.
    const human = await add([], {
      spawn,
      ask: async () => {
        throw new Error("a secret question is never asked");
      },
    });
    expect(human.code).toBe(2);
    expect(human.stdout).toContain("set GITHUB_APP_PRIVATE_KEY");

    // Known from that event: an answer on the command line is refused before eve runs.
    const before = spawn.calls.length;
    const refused = await add(
      ["--answer=github-private-key=s3cr3t-VALUE", "--json"],
      { spawn },
    );
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stdout).error).toMatchObject({
      code: "secret-question",
      key: "github-private-key",
      variable: "GITHUB_APP_PRIVATE_KEY",
      fix: expect.stringContaining("GITHUB_APP_PRIVATE_KEY"),
    });
    expect(refused.stdout + refused.stderr).not.toContain("s3cr3t-VALUE");
    expect(spawn.calls).toHaveLength(before);
  });

  it("treats the wire's environment question the same way", async () => {
    const spawn = fakeEve({
      replies: [{ eve: ["add"], lines: SECRET_QUESTION, exitCode: 2 }],
    });
    const r = await add(["--json"], { spawn });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({
      status: "needs-answer",
      question: {
        key: "github-webhook-secret",
        kind: "environment",
        variable: "GITHUB_WEBHOOK_SECRET",
      },
    });
    const refused = await add(
      ["--answer", "github-webhook-secret=x", "--json"],
      {
        spawn,
      },
    );
    expect(JSON.parse(refused.stdout).error.code).toBe("secret-question");
  });

  it("refuses an agent that is not created", async () => {
    const r = await zz(
      ["agent", "add", "nobody", ITEM, "--project", s.repo, "--json"],
      { cwd: s.root, home: s.home, env: SECRETS, spawn: fakeEve() },
    );
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("agent-not-declared");
  });
});

describe("donn agent add on a vercel agent", () => {
  beforeEach(async () => {
    agentProject(s, "vercel");
    await createAgent(s);
  });

  it("runs eve link for the prerequisite, then continues", async () => {
    let linked = false;
    const spawn = fakeEve({
      replies: [
        {
          eve: ["link"],
          effect: (c) => {
            linked = true;
            mkdirSync(join(c.cwd, ".vercel"), { recursive: true });
            writeFileSync(join(c.cwd, ".vercel/project.json"), "{}\n");
          },
        },
        {
          eve: ["add"],
          when: () => !linked,
          lines: PREREQUISITE,
          exitCode: 2,
        },
        { eve: ["add"], lines: COMPLETED },
      ],
    });
    const r = await add(['--answer=github-events=["pull_request"]', "--json"], {
      spawn,
    });
    expect(r.code, r.stdout).toBe(0);
    expect(eveArgs(spawn)).toEqual([
      [
        "add",
        ITEM,
        "--non-interactive",
        "--answer",
        'github-events=["pull_request"]',
      ],
      ["link", "--non-interactive", "--project", "kody"],
      [
        "add",
        ITEM,
        "--non-interactive",
        "--skip-install",
        "--answer",
        'github-events=["pull_request"]',
      ],
    ]);
    expect(existsSync(join(agentDir(), ".vercel/project.json"))).toBe(true);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: "completed" });
  });

  it("runs a prerequisite once: back again, it is the user's", async () => {
    const spawn = fakeEve({
      replies: [{ eve: ["add"], lines: PREREQUISITE, exitCode: 2 }],
    });
    const r = await add(["--json"], { spawn });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({
      status: "needs-prerequisite",
    });
    expect(eveArgs(spawn).map((a) => a[0])).toEqual(["add", "link", "add"]);
  });
});

describe("questions on a terminal", () => {
  const ask = (lines: string[]) => {
    const asked: string[] = [];
    return {
      asked,
      io: {
        stderr: { write: () => true },
        ask: async (prompt: string) => {
          asked.push(prompt);
          return lines.shift();
        },
      },
    };
  };
  const options = [
    { id: "a", label: "A" },
    { id: "b", label: "B", disabled: true, disabledReason: "no" },
    { id: "c", label: "C" },
  ];

  it("reads each kind's answer as eve's JSON", async () => {
    const cases: [AgentQuestion, string[], [string, string][]][] = [
      [
        { key: "ok", message: "OK?", kind: "confirm", required: true },
        ["y"],
        [["ok", "true"]],
      ],
      [
        {
          key: "ok",
          message: "OK?",
          kind: "confirm",
          required: true,
          recommended: true,
        },
        [""],
        [["ok", "true"]],
      ],
      [
        { key: "name", message: "Name", kind: "text", required: true },
        ["", "kody"],
        [["name", '"kody"']],
      ],
      [
        { key: "one", message: "One", kind: "select", required: true, options },
        ["2", "c"],
        [["one", '"c"']],
      ],
      [
        {
          key: "many",
          message: "Many",
          kind: "multi-select",
          required: true,
          options,
          recommended: ["a"],
        },
        [""],
        [["many", '["a"]']],
      ],
      [
        {
          key: "pick",
          message: "Pick",
          kind: "editable-select",
          required: true,
          options,
          editable: {
            key: "pick-other",
            optionId: "c",
            label: "Other value",
            recommended: "x",
          },
        },
        ["3", ""],
        [
          ["pick", '"c"'],
          ["pick-other", '"x"'],
        ],
      ],
    ];
    for (const [question, lines, expected] of cases) {
      const { io } = ask([...lines]);
      expect(await askAnswers(io, question), question.kind).toEqual(expected);
    }
  });

  it("gives up without a terminal, and never asks a secret", async () => {
    const none = ask([]);
    expect(
      await askAnswers(none.io, {
        key: "k",
        message: "m",
        kind: "text",
        required: true,
      }),
    ).toBeUndefined();
    const secret = ask(["x"]);
    expect(
      await askAnswers(secret.io, {
        key: "k",
        message: "m",
        kind: "environment",
        required: true,
        variable: "K",
      }),
    ).toBeUndefined();
    expect(secret.asked).toEqual([]);
  });

  it("parses --answer as key=<JSON>, a value that is not JSON as a string", () => {
    expect(parseAnswer('k=["a"]')).toEqual(["k", '["a"]']);
    expect(parseAnswer("k=a=b")).toEqual(["k", '"a=b"']);
    expect(parseAnswer("k.x=")).toEqual(["k.x", '""']);
    expect(parseAnswer("k=12")).toEqual(["k", "12"]);
    for (const bad of ["k", "=v", "1k=v", "k k=v"]) {
      expect(() => parseAnswer(bad), bad).toThrow(/key/);
    }
  });
});

describe("donn agent templates", () => {
  it("lists the adapter's templates, each with its Vercel-only services, and blank", async () => {
    // No project needed.
    const r = await zz(["agent", "templates", "--json"], {
      cwd: s.root,
      home: s.home,
    });
    expect(r.code, r.stdout).toBe(0);
    const { templates } = JSON.parse(r.stdout) as {
      templates: {
        slug: string;
        title: string;
        services: string[];
        vercelOnly: boolean;
        inRepo: boolean;
      }[];
    };
    expect(templates.map((t) => t.slug)).toEqual([
      ...adapter.templates().map((t) => t.slug),
      "blank",
    ]);
    expect(templates.at(-1)).toEqual({
      slug: "blank",
      title: "Blank agent",
      services: [],
      vercelOnly: false,
      inRepo: false,
    });
    for (const t of templates.slice(0, -1)) {
      const blocking = (["local", "self-host"] as const).some((target) =>
        portability(`eve:${t.slug}`, target).some((e) => e.blocking),
      );
      expect(t.vercelOnly, t.slug).toBe(blocking);
      expect(t.inRepo).toBe(true);
    }
    const bySlug = Object.fromEntries(templates.map((t) => [t.slug, t]));
    expect(bySlug["eve-voice-template"]).toMatchObject({
      services: ["ai-gateway"],
      vercelOnly: false,
    });
    expect(bySlug["eve-coding-agent-template"]).toMatchObject({
      vercelOnly: true,
    });

    const human = await zz(["agent", "templates"], {
      cwd: s.root,
      home: s.home,
    });
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("eve:eve-voice-template");
    expect(human.stdout).toContain("eve:blank");
  });
});

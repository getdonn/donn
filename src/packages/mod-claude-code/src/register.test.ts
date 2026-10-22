import { beforeEach, describe, expect, it } from "vitest";
import type { Hook, Mod$, Options, ProcessRunResult } from "./api.js";
import { register } from "./register.js";

// A stand-in engine: `on` collects hooks; `$` records what the mod does.

type Tree = { type: unknown; props: object | null; children: unknown[] };
(globalThis as { h?: unknown }).h = (
  type: unknown,
  props: object | null,
  ...children: unknown[]
): Tree => ({ type, props, children });

function engine(
  env: Record<string, string>,
  reply: (argv: readonly string[]) => ProcessRunResult,
  options: Options = {},
  cwd: () => Promise<string> = async () => "/repo",
) {
  const hooks = new Map<string, Hook>();
  const runs: (readonly string[])[] = [];
  const statuses: (string | undefined)[] = [];
  const invalidated: string[] = [];
  /** The files `$.fs.read` sees, by absolute path. */
  const files = new Map<string, string>();
  const $ = {
    env: { get: async (name: string) => env[name] },
    session: { cwd },
    process: {
      run: async (argv: readonly string[]) => {
        runs.push(argv);
        return reply(argv);
      },
    },
    ui: {
      status: (text: string | undefined) => statuses.push(text),
      invalidate: (event: string) => invalidated.push(event),
      resolve: () => ({ Box: "Box", Text: "Text" }),
    },
    command: { register: async () => undefined },
    fs: {
      read: async (path: string) => {
        const text = files.get(path);
        if (text === undefined) throw new Error(`ENOENT: ${path}`);
        return text;
      },
    },
  } as unknown as Mod$;
  register(
    (event: string, matcherOrHook: object | Hook, hook?: Hook) =>
      hooks.set(event, (hook ?? matcherOrHook) as Hook),
    options,
  );
  const call = (event: string, e: unknown = {}, below: unknown = "BELOW") =>
    (
      hooks.get(event)! as (
        $: Mod$,
        e: unknown,
        next: (e: unknown) => Promise<unknown>,
      ) => Promise<unknown>
    )($, e, async () => below);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { call, settle, runs, statuses, invalidated, files };
}

const json = (value: unknown): ProcessRunResult => ({
  exitCode: 0,
  stdout: JSON.stringify(value),
  stderr: "",
});
const LAUNCHED = {
  ZZPERSONA_PERSONA: "team/payments",
  ZZPERSONA_SOURCE: "switch",
};
const FOLDER = json({ persona: "team/platform", source: "project" });

describe("register", () => {
  let e: ReturnType<typeof engine>;
  beforeEach(() => {
    e = engine(LAUNCHED, () => FOLDER);
  });

  it("runs the CLI once per session start, not per render", async () => {
    await e.call("session.start");
    await e.settle();
    await e.call("ui.render", { component: "AbovePrompt" });
    await e.call("ui.render", { component: "AbovePrompt" });
    expect(e.runs).toEqual([["zzpersona", "switch", "--json"]]);
  });

  it("draws the band above what other mods draw", async () => {
    await e.call("session.start");
    await e.settle();
    const tree = (await e.call("ui.render", {
      component: "AbovePrompt",
    })) as Tree;
    expect(tree.type).toBe("Box");
    expect(tree.children).toContainEqual({
      type: "Text",
      props: { dimColor: true },
      children: ["persona team/payments · switch"],
    });
    expect(tree.children).toContain("BELOW");
  });

  it("nudges once, and /persona clears it", async () => {
    await e.call("session.start");
    await e.settle();
    expect(e.statuses).toEqual([
      "this folder uses team/platform (project); this session runs team/payments. /persona switch team/platform, then relaunch",
    ]);
    await e.call("ui.render", { component: "AbovePrompt" });
    await e.call("command.run", { command: "persona", args: "" });
    expect(e.statuses.at(-1)).toBeUndefined();
    expect(e.statuses.filter((s) => s !== undefined)).toHaveLength(1);
  });

  it("answers /persona with the CLI's result", async () => {
    await e.call("session.start");
    await e.settle();
    const out = (await e.call("command.run", {
      command: "persona",
      args: "bogus",
    })) as { text: string };
    expect(out.text).toContain("usage: /persona");
    const shown = (await e.call("command.run", {
      command: "persona",
      args: "",
    })) as { text: string };
    expect(shown.text).toBe(
      "this session runs team/payments (switch)\nthis folder uses team/platform (project)",
    );
  });

  it("prints a CLI error from /persona", async () => {
    const failing = engine(LAUNCHED, (argv) =>
      argv[1] === "switch" && argv[2] === "team/nope"
        ? {
            exitCode: 1,
            stdout:
              '{"error":{"code":"unknown-persona","message":"no persona named team/nope"}}',
            stderr: "",
          }
        : FOLDER,
    );
    await failing.call("session.start");
    await failing.settle();
    const out = (await failing.call("command.run", {
      command: "persona",
      args: "switch team/nope",
    })) as { text: string };
    expect(out.text).toBe("zzpersona: no persona named team/nope");
  });

  it("respects the band and nudge settings", async () => {
    const quiet = engine(LAUNCHED, () => FOLDER, { band: false, nudge: false });
    await quiet.call("session.start");
    await quiet.settle();
    expect(quiet.statuses).toEqual([]);
    expect(await quiet.call("ui.render", { component: "AbovePrompt" })).toBe(
      "BELOW",
    );
  });

  it("shows a folder with no persona as such, not as an error", async () => {
    const bare = engine({}, () => ({
      exitCode: 1,
      stdout: '{"error":{"code":"no-persona","message":"no persona here"}}',
      stderr: "",
    }));
    await bare.call("session.start");
    await bare.settle();
    expect(bare.statuses).toEqual([]);
    expect(await bare.call("ui.render", { component: "AbovePrompt" })).toBe(
      "BELOW",
    );
    const out = (await bare.call("command.run", {
      command: "persona",
      args: "",
    })) as { text: string };
    expect(out.text).toBe(
      "this session runs no persona (it was not started by zzpersona claude)\nthis folder uses no persona",
    );
  });

  it("yields the band to a survey, and stacks above other mods", async () => {
    await e.call("session.start");
    await e.settle();
    expect(
      await e.call("ui.render", {
        component: "AbovePrompt",
        props: { hasSurvey: true },
      }),
    ).toBe("BELOW");
    const tree = (await e.call("ui.render", {
      component: "AbovePrompt",
      props: { hasSurvey: false },
    })) as Tree;
    expect(tree.props).toEqual({ flexDirection: "column" });
  });

  it("runs no CLI in a headless session", async () => {
    await e.call("session.start", { isInteractive: false });
    await e.settle();
    expect(e.runs).toEqual([]);
    expect(e.statuses).toEqual([]);
  });

  it("swallows a failure in the background refresh", async () => {
    const broken = engine(
      LAUNCHED,
      () => FOLDER,
      {},
      async () => {
        throw new Error("engine unloaded");
      },
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await broken.call("session.start");
      await broken.settle();
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

describe("live switching", () => {
  const SESSION = "/home/.zzpersona/sessions/0123456789abcdef";
  const state = (persona: string) => ({
    persona,
    previous: "team/payments",
    launched: "team/payments",
    instructions: `## zzpersona persona: ${persona}\n\nBe ${persona}.\n`,
    held: ["mcp"],
    stricter: false,
    plugin: "x",
    appliedAt: "2026-10-21T00:00:00.000Z",
  });
  const reply = (shown: unknown) => (argv: readonly string[]) => {
    if (argv[1] === "live" && argv.includes("--show")) return json(shown);
    if (argv[1] === "live") return json(state(argv[2]!));
    if (argv[1] === "switch" && argv.length > 3)
      return json({
        scope: "project",
        persona: argv[2],
        project: "/r/.zzpersona",
      });
    return FOLDER;
  };
  const COMPOSED = {
    sections: [
      { id: "lean_body", scope: "shared", text: "body" },
      { id: "env_info_simple", scope: "session", text: "env" },
    ],
  };
  /** The text the engine would send for a section, after the mod's prompt.section hook. */
  const sectionText = async (e: ReturnType<typeof engine>, name: string) =>
    (
      (await e.call("prompt.section", { name }, { text: "core" })) as {
        text: string;
      }
    ).text;

  it("applies /persona use live and appends to the session's last section", async () => {
    const e = engine(
      { ...LAUNCHED, ZZPERSONA_SESSION: SESSION },
      reply({ launched: "team/payments" }),
    );
    await e.call("session.start");
    await e.settle();
    expect(await e.call("prompt.compose", {}, COMPOSED)).toBe(COMPOSED);
    expect(await sectionText(e, "env_info_simple")).toBe("core");
    const out = (await e.call("command.run", {
      command: "persona",
      args: "use team/platform",
    })) as { text: string };
    expect(e.runs).toContainEqual([
      "zzpersona",
      "live",
      "team/platform",
      "--session",
      SESSION,
      "--json",
    ]);
    expect(out.text).toContain("team/platform is now live in this session");
    expect(e.invalidated).toContain("prompt.section");
    const text = await sectionText(e, "env_info_simple");
    expect(
      text.startsWith(
        "core\n\nThe persona for this session is now team/platform.",
      ),
    ).toBe(true);
    expect(text).toContain("Be team/platform.");
    expect(await sectionText(e, "memory")).toBe("core");
  });

  it("switching back to the launched persona supersedes with its instructions", async () => {
    const e = engine(
      { ...LAUNCHED, ZZPERSONA_SESSION: SESSION },
      reply({ launched: "team/payments" }),
    );
    await e.call("session.start");
    await e.settle();
    await e.call("prompt.compose", {}, COMPOSED);
    await e.call("command.run", {
      command: "persona",
      args: "use team/platform",
    });
    await e.call("command.run", {
      command: "persona",
      args: "use team/payments",
    });
    const text = await sectionText(e, "env_info_simple");
    expect(
      text.startsWith(
        "core\n\nThe instructions for this session's persona team/payments were updated.",
      ),
    ).toBe(true);
    expect(text).toContain("Be team/payments.");
    const tree = (await e.call("ui.render", {
      component: "AbovePrompt",
    })) as Tree;
    expect(JSON.stringify(tree)).not.toContain("live");
  });

  it("saves and applies /persona switch", async () => {
    const e = engine(
      { ...LAUNCHED, ZZPERSONA_SESSION: SESSION },
      reply({ launched: "team/payments" }),
    );
    await e.call("session.start");
    await e.settle();
    const out = (await e.call("command.run", {
      command: "persona",
      args: "switch team/platform",
    })) as { text: string };
    const after = e.runs.slice(-3).map((argv) => argv[1]);
    expect(after).toEqual(["switch", "live", "switch"]);
    expect(out.text.split("\n")[0]).toBe("team/platform is now used for /r.");
    expect(out.text).toContain("is now live in this session");
  });

  it("explains /persona use without a session folder", async () => {
    const e = engine(LAUNCHED, () => FOLDER);
    await e.call("session.start");
    await e.settle();
    const out = (await e.call("command.run", {
      command: "persona",
      args: "use team/platform",
    })) as { text: string };
    expect(out.text).toBe(
      "live switching needs a session started by zzpersona claude",
    );
    expect(e.runs.filter((argv) => argv[1] === "live")).toEqual([]);
  });

  it("restores the live state after a reload", async () => {
    const e = engine(
      { ...LAUNCHED, ZZPERSONA_SESSION: SESSION },
      reply(state("team/platform")),
    );
    await e.call("session.start");
    await e.settle();
    expect(e.invalidated).toContain("prompt.section");
    await e.call("prompt.compose", {}, COMPOSED);
    expect(await sectionText(e, "env_info_simple")).toContain(
      "Be team/platform.",
    );
  });

  it("adopts a live state written by the daemon on the next prompt", async () => {
    const e = engine(
      { ...LAUNCHED, ZZPERSONA_SESSION: SESSION },
      reply({ launched: "team/payments" }),
    );
    await e.call("session.start");
    await e.settle();
    await e.call("prompt.compose", {}, COMPOSED);
    expect(await sectionText(e, "env_info_simple")).toBe("core");
    e.files.set(
      `${SESSION}/live.json`,
      JSON.stringify({
        ...state("team/payments"),
        instructions:
          "## zzpersona persona: team/payments\n\nBe the edited payments.\n",
        appliedAt: "2026-10-21T01:00:00.000Z",
      }),
    );
    const before = e.runs.length;
    e.invalidated.length = 0;
    const submitted = { text: "hi", wait: false, origin: { kind: "user" } };
    expect(await e.call("prompt.submit", submitted, "ENTERED")).toBe("ENTERED");
    expect(e.runs.length).toBe(before);
    expect(e.invalidated).toContain("prompt.section");
    expect(e.invalidated).toContain("ui.render");
    const text = await sectionText(e, "env_info_simple");
    expect(text).toContain("were updated");
    expect(text.endsWith("Be the edited payments.")).toBe(true);
  });

  it("ignores an unchanged or missing live.json", async () => {
    const e = engine(
      { ...LAUNCHED, ZZPERSONA_SESSION: SESSION },
      reply(state("team/platform")),
    );
    await e.call("session.start");
    await e.settle();
    const submitted = { text: "hi", wait: false, origin: { kind: "user" } };
    e.invalidated.length = 0;
    expect(await e.call("prompt.submit", submitted, "ENTERED")).toBe("ENTERED");
    expect(e.invalidated).toEqual([]);
    e.files.set(`${SESSION}/live.json`, JSON.stringify(state("team/platform")));
    expect(await e.call("prompt.submit", submitted, "ENTERED")).toBe("ENTERED");
    e.files.set(`${SESSION}/live.json`, "{not json");
    expect(await e.call("prompt.submit", submitted, "ENTERED")).toBe("ENTERED");
    expect(e.invalidated).toEqual([]);
  });

  it("reads no live.json without a session folder", async () => {
    const e = engine(LAUNCHED, () => FOLDER);
    await e.call("session.start");
    await e.settle();
    e.files.set(`${SESSION}/live.json`, JSON.stringify(state("team/platform")));
    e.invalidated.length = 0;
    expect(await e.call("prompt.submit", { text: "hi" }, "ENTERED")).toBe(
      "ENTERED",
    );
    expect(e.invalidated).toEqual([]);
  });

  it("anchors on a section the engine passes through prompt.section", async () => {
    // As Claude Code 2.1.306 does: sections go through prompt.section first, then compose,
    // and the last session section (total_tokens) never goes through prompt.section.
    const e = engine(
      { ...LAUNCHED, ZZPERSONA_SESSION: SESSION },
      reply({ launched: "team/payments" }),
    );
    await e.call("session.start");
    await e.settle();
    await sectionText(e, "env_info_simple");
    await sectionText(e, "memory");
    await e.call(
      "prompt.compose",
      {},
      {
        sections: [
          { id: "env_info_simple", scope: "session", text: "env" },
          { id: "memory", scope: "session", text: "mem" },
          { id: "total_tokens", scope: "session", text: "tokens" },
        ],
      },
    );
    await e.call("command.run", {
      command: "persona",
      args: "use team/platform",
    });
    expect(await sectionText(e, "memory")).toContain("Be team/platform.");
    expect(await sectionText(e, "env_info_simple")).toBe("core");
  });
});

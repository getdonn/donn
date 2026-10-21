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
      invalidate: () => {},
      resolve: () => ({ Box: "Box", Text: "Text" }),
    },
    command: { register: async () => undefined },
  } as unknown as Mod$;
  register(
    (event: string, matcherOrHook: object | Hook, hook?: Hook) =>
      hooks.set(event, (hook ?? matcherOrHook) as Hook),
    options,
  );
  const call = (event: string, e: unknown = {}) =>
    (
      hooks.get(event)! as (
        $: Mod$,
        e: unknown,
        next: (e: unknown) => Promise<unknown>,
      ) => Promise<unknown>
    )($, e, async () => "BELOW");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { call, settle, runs, statuses };
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

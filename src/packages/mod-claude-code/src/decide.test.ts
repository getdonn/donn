import { describe, expect, it } from "vitest";
import {
  bandText,
  commandText,
  launchedFrom,
  liveSection,
  liveText,
  nudgeText,
  personaCommand,
  USAGE,
  type Here,
  type Launched,
  type LiveState,
  type Source,
} from "./decide.js";

const A: Launched = { persona: "team/payments", source: "switch" };
const here = (persona: string, source: Source): Here => ({
  kind: "persona",
  persona,
  source,
});

describe("launchedFrom", () => {
  it("reads the launch variables, ignoring an unknown source", () => {
    expect(launchedFrom("team/x", "project", "/r")).toEqual({
      persona: "team/x",
      source: "project",
      project: "/r",
    });
    expect(launchedFrom(undefined, "project", undefined)).toBeUndefined();
    expect(launchedFrom("team/x", "bogus", undefined)).toBeUndefined();
  });
});

describe("band", () => {
  it("shows the launched persona and its source", () => {
    expect(bandText(A, here("team/payments", "switch"))).toBe(
      "persona team/payments · switch",
    );
  });

  it("in a plain session, shows what this folder uses", () => {
    expect(bandText(undefined, here("team/platform", "project"))).toBe(
      "persona none · this folder uses team/platform",
    );
    expect(bandText(undefined, here("team/platform", "switch"))).toBe(
      "persona none · this folder uses team/platform",
    );
  });

  it("says nothing for a plain session with only a default, or no persona", () => {
    expect(bandText(undefined, here("team/x", "default"))).toBeUndefined();
    expect(bandText(undefined, { kind: "none" })).toBeUndefined();
  });
});

describe("nudge", () => {
  it("tells a launched session that this folder uses another persona", () => {
    expect(nudgeText(A, here("team/platform", "switch"))).toBe(
      "this folder uses team/platform (switch); this session runs team/payments. /persona switch team/platform, then relaunch",
    );
  });

  it("no nudge when the folder selects the session's persona", () => {
    expect(
      nudgeText(
        { persona: "team/payments", source: "argument" },
        here("team/payments", "project"),
      ),
    ).toBeUndefined();
  });

  it("tells a plain session how to load this folder's persona", () => {
    expect(nudgeText(undefined, here("team/platform", "project"))).toBe(
      "this folder uses team/platform; start with zzpersona claude to load it",
    );
  });

  it("never nudges for a default alone", () => {
    expect(nudgeText(undefined, here("team/x", "default"))).toBeUndefined();
    expect(nudgeText(A, here("team/x", "default"))).toBeUndefined();
  });

  it("treats no-persona as nothing to say", () => {
    expect(nudgeText(undefined, { kind: "none" })).toBeUndefined();
    expect(nudgeText(A, { kind: "none" })).toBeUndefined();
    expect(bandText(undefined, { kind: "none" })).toBeUndefined();
  });

  it("reports an unreachable CLI", () => {
    expect(
      nudgeText(A, {
        kind: "unavailable",
        reason: "zzpersona not found on PATH",
      }),
    ).toBe("zzpersona unavailable: zzpersona not found on PATH");
  });
});

describe("/persona arguments", () => {
  it("parses /persona arguments loosely", () => {
    expect(personaCommand("")).toEqual({ form: "show", argv: ["switch"] });
    expect(personaCommand(" list ")).toEqual({ form: "list", argv: ["list"] });
    expect(personaCommand("  switch   team/x ")).toEqual({
      form: "switch",
      argv: ["switch", "team/x"],
    });
    expect(personaCommand("switch --default team/x")).toEqual({
      form: "switch",
      argv: ["switch", "team/x", "--default"],
    });
    expect(personaCommand("clear --default")).toEqual({
      form: "clear",
      argv: ["switch", "--clear", "--default"],
    });
    for (const bad of [
      "bogus",
      "switch",
      "switch a b",
      "clear x",
      "switch --clear",
      "switch --json",
    ]) {
      expect(personaCommand(bad)).toEqual({
        usage: USAGE,
      });
    }
  });
});

describe("/persona output", () => {
  it("shows this session's persona and what this folder uses", () => {
    expect(
      commandText(
        "show",
        {
          persona: "team/platform",
          source: "project",
          project: "/r/.zzpersona",
        },
        A,
        here("team/platform", "project"),
      ),
    ).toBe(
      "this session runs team/payments (switch)\nthis folder uses team/platform (project)",
    );
    expect(
      commandText(
        "show",
        { persona: "team/payments", source: "switch" },
        A,
        here("team/payments", "switch"),
      ),
    ).toBe("this session runs team/payments (switch), which this folder uses");
  });

  it("lists personas in layer order and marks this session's and this folder's", () => {
    expect(
      commandText(
        "list",
        {
          personas: [
            { ref: "org/base", layer: "org" },
            { ref: "project/persona", layer: "project" },
            { ref: "team/payments", layer: "team" },
            { ref: "team/platform", layer: "team" },
          ],
        },
        A,
        here("team/platform", "project"),
      ),
    ).toBe(
      [
        "org:",
        "  org/base",
        "team:",
        "  team/payments  (this session)",
        "  team/platform  (this folder)",
        "project:",
        "  project/persona",
      ].join("\n"),
    );
  });

  it("explains how to apply a switch", () => {
    expect(
      commandText(
        "switch",
        {
          scope: "project",
          persona: "team/platform",
          project: "/Users/you/repo/.zzpersona",
        },
        A,
        here("team/platform", "switch"),
      ),
    ).toBe(
      [
        "team/platform is now used for /Users/you/repo.",
        "This session still runs team/payments. To apply it, exit and run:",
        "  zzpersona claude",
        "(zzpersona claude -- --continue keeps this conversation, but not the new persona's instructions.)",
      ].join("\n"),
    );
    expect(
      commandText(
        "switch",
        { scope: "default", persona: "team/payments" },
        A,
        here("team/payments", "switch"),
      ),
    ).toBe("team/payments is now your default.");
  });

  it("reports a clear and what this folder uses now", () => {
    expect(
      commandText(
        "clear",
        { scope: "project", persona: "team/platform" },
        A,
        here("project/persona", "project"),
      ),
    ).toBe(
      "cleared this project's switch (team/platform)\nthis folder now uses project/persona (project)",
    );
    expect(
      commandText("clear", { scope: "default", persona: null }, A, {
        kind: "none",
      }),
    ).toBe("nothing to clear\nthis folder uses no persona");
  });
});

describe("live switching", () => {
  const live = (over: Partial<LiveState> = {}): LiveState => ({
    persona: "team/platform",
    previous: "team/payments",
    launched: "team/payments",
    instructions:
      "## zzpersona persona: team/platform\n\nYou are running the platform persona.\n",
    held: ["mcp", "permissions"],
    stricter: false,
    plugin: "zzp-team--platform",
    appliedAt: "2026-10-21T00:00:00.000Z",
    ...over,
  });

  it("adds a section that supersedes the launch instructions", () => {
    expect(liveSection(live())).toEqual({
      id: "zzpersona:live-persona",
      scope: "session",
      text: [
        "The persona for this session is now team/platform. Disregard the section headed",
        '"## zzpersona persona: team/payments"; the instructions below replace it.',
        "",
        "## zzpersona persona: team/platform",
        "",
        "You are running the platform persona.",
      ].join("\n"),
    });
    expect(liveSection(live({ persona: "team/payments" }))).toBeUndefined();
  });

  it("explains a live switch", () => {
    expect(liveText(live())).toBe(
      [
        "team/platform is now live in this session (skills, hooks, agents, instructions).",
        "Still from team/payments until you relaunch: MCP servers, permissions.",
        "To apply those too, exit and run: zzpersona claude team/platform",
      ].join("\n"),
    );
    expect(liveText(live({ held: ["settings"] }))).toContain(
      "Still from team/payments until you relaunch: Claude Code settings.",
    );
    expect(liveText(live({ held: ["mcp"] }))).toContain(
      "Still from team/payments until you relaunch: MCP servers.",
    );
    expect(liveText(live({ held: [] }))).toBe(
      "team/platform is now live in this session (skills, hooks, agents, instructions).",
    );
    expect(liveText(live({ held: ["permissions"], stricter: true }))).toContain(
      "team/platform denies more than team/payments; those rules apply after a relaunch.",
    );
    expect(
      liveText(live({ held: [] }), "team/platform is now used for /r."),
    ).toBe(
      "team/platform is now used for /r.\nteam/platform is now live in this session (skills, hooks, agents, instructions).",
    );
  });

  it("shows the live persona and what is held in the band", () => {
    const launched: Launched = { persona: "team/payments", source: "switch" };
    const folder = here("team/platform", "switch");
    expect(bandText(launched, folder, live())).toBe(
      "persona team/platform · live · MCP and permissions from team/payments",
    );
    expect(bandText(launched, folder, live({ held: ["mcp"] }))).toBe(
      "persona team/platform · live · MCP from team/payments",
    );
    expect(
      bandText(
        launched,
        folder,
        live({ held: ["mcp", "permissions", "settings"] }),
      ),
    ).toBe(
      "persona team/platform · live · MCP, permissions and settings from team/payments",
    );
    expect(bandText(launched, folder, live({ held: ["settings"] }))).toBe(
      "persona team/platform · live · settings from team/payments",
    );
    expect(bandText(launched, folder, live({ held: [] }))).toBe(
      "persona team/platform · live",
    );
    expect(bandText(launched, folder, live({ persona: "team/payments" }))).toBe(
      "persona team/payments · switch",
    );
  });

  it("nudges against the live persona", () => {
    const launched: Launched = { persona: "team/payments", source: "switch" };
    expect(
      nudgeText(launched, here("team/platform", "switch"), live()),
    ).toBeUndefined();
    expect(nudgeText(launched, here("team/other", "switch"), live())).toContain(
      "this session runs team/platform",
    );
  });

  it("parses /persona use", () => {
    expect(personaCommand("use team/x")).toEqual({
      form: "use",
      argv: ["live", "team/x"],
    });
    expect(personaCommand("use")).toEqual({ usage: USAGE });
    expect(personaCommand("use --default team/x")).toEqual({ usage: USAGE });
  });
});

describe("0.3.1 hints", () => {
  const launched: Launched = { persona: "team/payments", source: "switch" };

  it("suggests /persona use when the session can switch live", () => {
    expect(
      nudgeText(launched, here("team/platform", "switch"), undefined, true),
    ).toBe(
      "this folder uses team/platform (switch); this session runs team/payments. /persona use team/platform to switch now",
    );
    expect(
      nudgeText(launched, here("team/platform", "switch"), undefined, false),
    ).toContain("then relaunch");
  });

  it("gives a relaunch hint naming the persona after switch --default", () => {
    expect(
      commandText(
        "switch",
        { scope: "default", persona: "team/platform" },
        launched,
        here("team/platform", "default"),
      ),
    ).toBe(
      [
        "team/platform is now your default.",
        "This session still runs team/payments. To apply it, exit and run:",
        "  zzpersona claude team/platform",
      ].join("\n"),
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  bandText,
  commandText,
  launchedFrom,
  nudgeText,
  personaCommand,
  type Here,
  type Launched,
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
    for (const bad of ["bogus", "switch", "switch a b", "clear x"]) {
      expect(personaCommand(bad)).toEqual({
        usage:
          "usage: /persona [list | switch <persona> [--default] | clear [--default]]",
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

  it("lists personas by layer and marks this session's and this folder's", () => {
    expect(
      commandText(
        "list",
        {
          personas: [
            { ref: "org/base", layer: "org" },
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
        "  zzpersona claude -- --continue",
        "(--continue resumes this conversation with the new persona.)",
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

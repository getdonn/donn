import type { Probe } from "@zzpersona/adapter-sdk";
import { describe, expect, it } from "vitest";
import { shellHint, shellLookup } from "./shell.js";

function probe(
  exitCode: number,
  stdout: string,
  stderr = "",
  calls: string[][] = [],
): Probe {
  return {
    platform: "darwin",
    run: async (command, args) => {
      calls.push([command, ...args]);
      return { exitCode, stdout, stderr };
    },
    readFile: async () => undefined,
    listDir: async () => undefined,
  };
}

const env = { SHELL: "/bin/zsh" };

describe("shellLookup", () => {
  it("asks the user's interactive shell", async () => {
    const calls: string[][] = [];
    await shellLookup("claude", { env, probe: probe(0, "", "", calls) });
    expect(calls).toEqual([["/bin/zsh", "-ic", "type claude"]]);
  });

  it("reads zsh's and bash's answers", async () => {
    const cases: [string, string, unknown][] = [
      [
        "claude is an alias for /Users/me/.claude/local/claude",
        "",
        { kind: "alias", target: "/Users/me/.claude/local/claude" },
      ],
      [
        "claude is aliased to `/opt/claude/bin/claude --verbose'",
        "",
        { kind: "alias", target: "/opt/claude/bin/claude --verbose" },
      ],
      [
        "claude is /opt/bin/claude",
        "",
        { kind: "path", path: "/opt/bin/claude" },
      ],
      [
        "claude is hashed (/opt/bin/claude)",
        "",
        { kind: "path", path: "/opt/bin/claude" },
      ],
      ["claude not found", "", { kind: "missing" }],
      ["", "bash: type: claude: not found", { kind: "missing" }],
    ];
    for (const [stdout, stderr, expected] of cases) {
      expect(
        await shellLookup("claude", { env, probe: probe(0, stdout, stderr) }),
        stdout || stderr,
      ).toEqual(expected);
    }
  });

  it("skips lines an rc file prints", async () => {
    const out =
      "Welcome back!\nclaude-helper loaded\nclaude is /opt/bin/claude\n";
    expect(await shellLookup("claude", { env, probe: probe(0, out) })).toEqual({
      kind: "path",
      path: "/opt/bin/claude",
    });
  });

  it("does not know without a shell, on Windows, or when the shell times out", async () => {
    const calls: string[][] = [];
    expect(
      await shellLookup("claude", { env: {}, probe: probe(0, "", "", calls) }),
    ).toEqual({ kind: "unknown" });
    expect(
      await shellLookup("claude", {
        env,
        probe: { ...probe(0, "", "", calls), platform: "win32" },
      }),
    ).toEqual({ kind: "unknown" });
    expect(calls).toEqual([]);
    expect(
      await shellLookup("claude", {
        env,
        probe: probe(124, "", "/bin/zsh timed out after 10s"),
      }),
    ).toEqual({ kind: "unknown" });
    expect(
      await shellLookup("claude", {
        env,
        probe: probe(0, "claude is a shell function from /x"),
      }),
    ).toEqual({ kind: "unknown" });
  });
});

describe("shellHint", () => {
  it("explains an alias-only install with the PATH entry to add", () => {
    expect(
      shellHint(
        "claude",
        { kind: "alias", target: "/Users/me/.claude/local/claude" },
        undefined,
      ),
    ).toBe(
      `your shell has claude as an alias for /Users/me/.claude/local/claude; zzpersona runs the claude on PATH, which aliases don't change: export PATH="/Users/me/.claude/local:$PATH" in your shell's startup file`,
    );
    expect(
      shellHint("claude", { kind: "alias", target: "npx claude" }, undefined),
    ).toContain("add the folder that holds it to PATH");
  });

  it("explains a shell that predates a PATH change", () => {
    expect(
      shellHint(
        "claude",
        { kind: "path", path: "/opt/bin/claude" },
        undefined,
        "/bin/zsh",
      ),
    ).toBe(
      "a new shell finds claude at /opt/bin/claude, but this one predates a PATH change: run exec zsh or open a new terminal",
    );
  });

  it("names an alias that runs a different claude than PATH", () => {
    expect(
      shellHint(
        "claude",
        { kind: "alias", target: "'/a/claude' --x" },
        "/b/claude",
      ),
    ).toBe(
      "your shell's claude alias runs /a/claude, but zzpersona runs /b/claude (PATH)",
    );
    expect(
      shellHint("claude", { kind: "alias", target: "/b/claude" }, "/b/claude"),
    ).toBeUndefined();
  });

  it("has nothing to say otherwise", () => {
    expect(shellHint("claude", { kind: "missing" }, undefined)).toBeUndefined();
    expect(shellHint("claude", { kind: "unknown" }, undefined)).toBeUndefined();
    expect(
      shellHint("claude", { kind: "path", path: "/b/claude" }, "/b/claude"),
    ).toBeUndefined();
  });
});

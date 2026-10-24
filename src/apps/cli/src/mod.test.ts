import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Probe } from "@getdonn/adapter-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installedProbe, seed, zz, type Seeded } from "./test/seed.js";

let s: Seeded;
beforeEach(() => {
  s = seed();
});
afterEach(() => s.cleanup());

const MOD_VERSION = (
  createRequire(import.meta.url)("@getdonn/mod-claude-code/package.json") as {
    version: string;
  }
).version;

/** A probe whose `claude plugin …` calls are recorded and answered by `reply`. */
function recording(
  reply: (argv: string[]) => {
    exitCode: number;
    stdout?: string;
    stderr?: string;
  } = () => ({
    exitCode: 0,
  }),
) {
  const runs: string[][] = [];
  const probe: Probe = {
    ...installedProbe,
    run: async (command, args) => {
      if (command !== "claude" || args[0] !== "plugin")
        return installedProbe.run(command, args);
      runs.push([command, ...args]);
      return { stdout: "", stderr: "", ...reply([command, ...args]) };
    },
  };
  return { probe, runs };
}

describe("donn mod install", () => {
  it("copies the mod, writes its marketplace and registers it with claude", async () => {
    const { probe, runs } = recording();
    const r = await zz(["mod", "install", "--json"], {
      cwd: s.root,
      home: s.home,
      probe,
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const modDir = join(s.home, "mod");
    expect(
      JSON.parse(
        readFileSync(join(modDir, "plugin/.claude-plugin/plugin.json"), "utf8"),
      ),
    ).toMatchObject({ name: "donn", version: MOD_VERSION });
    expect(existsSync(join(modDir, "plugin/hooks/register.js"))).toBe(true);
    expect(
      JSON.parse(
        readFileSync(join(modDir, ".claude-plugin/marketplace.json"), "utf8"),
      ),
    ).toMatchObject({
      name: "donn",
      plugins: [{ name: "donn", source: "./plugin" }],
    });
    expect(runs).toEqual([
      ["claude", "plugin", "marketplace", "add", modDir],
      ["claude", "plugin", "install", "donn@donn", "--scope", "user"],
    ]);
    expect(JSON.parse(r.stdout)).toEqual({
      installed: join(modDir, "plugin"),
      ran: runs,
      warnings: expect.any(Array),
    });
  });

  it("re-runs cleanly when the marketplace and plugin already exist", async () => {
    const { probe } = recording(() => ({
      exitCode: 1,
      stderr: "Marketplace 'donn' is already installed\n",
    }));
    const r = await zz(["mod", "install"], {
      cwd: s.root,
      home: s.home,
      probe,
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
  });

  it("reports a claude command that fails", async () => {
    const { probe } = recording((argv) =>
      argv[2] === "install"
        ? { exitCode: 2, stderr: "Plugin not found\nmore\n" }
        : { exitCode: 0 },
    );
    const r = await zz(["mod", "install", "--json"], {
      cwd: s.root,
      home: s.home,
      probe,
    });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error).toMatchObject({
      code: "mod-install",
      message:
        "claude plugin install donn@donn --scope user exited 2: Plugin not found",
    });
  });
});

describe("donn mod uninstall", () => {
  it("unregisters the mod and removes its folder", async () => {
    const { probe, runs } = recording();
    await zz(["mod", "install"], { cwd: s.root, home: s.home, probe });
    runs.length = 0;
    const r = await zz(["mod", "uninstall"], {
      cwd: s.root,
      home: s.home,
      probe,
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(runs).toEqual([
      ["claude", "plugin", "uninstall", "donn@donn"],
      ["claude", "plugin", "marketplace", "remove", "donn"],
    ]);
    expect(existsSync(join(s.home, "mod"))).toBe(false);
  });
});

describe("donn mod uninstall, when things go wrong", () => {
  it("treats only claude's own not-found answers as done", async () => {
    await zz(["mod", "install"], {
      cwd: s.root,
      home: s.home,
      probe: recording().probe,
    });
    const notFound = recording((argv) =>
      argv[2] === "uninstall"
        ? {
            exitCode: 1,
            stderr: 'Plugin "donn@donn" is not installed\n',
          }
        : { exitCode: 1, stderr: "Marketplace 'donn' not found\n" },
    );
    const ok = await zz(["mod", "uninstall"], {
      cwd: s.root,
      home: s.home,
      probe: notFound.probe,
    });
    expect(ok.code, ok.stdout + ok.stderr).toBe(0);

    await zz(["mod", "install"], {
      cwd: s.root,
      home: s.home,
      probe: recording().probe,
    });
    const broken = recording(() => ({
      exitCode: 1,
      stderr: "error: unknown option '--scope'\n",
    }));
    const failed = await zz(["mod", "uninstall", "--json"], {
      cwd: s.root,
      home: s.home,
      probe: broken.probe,
    });
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout).error.code).toBe("mod-uninstall");
    expect(existsSync(join(s.home, "mod"))).toBe(true);
  });

  it("still removes its folder when claude is gone", async () => {
    await zz(["mod", "install"], {
      cwd: s.root,
      home: s.home,
      probe: recording().probe,
    });
    const gone = recording(() => ({
      exitCode: 127,
      stderr: "spawn claude ENOENT",
    }));
    const r = await zz(["mod", "uninstall"], {
      cwd: s.root,
      home: s.home,
      probe: gone.probe,
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("claude is not installed");
    expect(existsSync(join(s.home, "mod"))).toBe(false);
  });
});

describe("doctor's mod check", () => {
  const modCheck = async () => {
    const r = await zz(["doctor", "--json"], { cwd: s.repo, home: s.home });
    return (
      JSON.parse(r.stdout) as {
        checks: { id: string; status: string; message: string; fix?: string }[];
      }
    ).checks.find((c) => c.id === "mod")!;
  };

  it("warns when the mod is not installed, or is not this CLI's version", async () => {
    expect(await modCheck()).toMatchObject({
      status: "warn",
      message: "the mod is not installed",
      fix: "donn mod install",
    });
    await zz(["mod", "install"], {
      cwd: s.root,
      home: s.home,
      probe: recording().probe,
    });
    expect(await modCheck()).toMatchObject({
      status: "ok",
      message: `donn mod ${MOD_VERSION}`,
    });
    const manifest = join(s.home, "mod/plugin/.claude-plugin/plugin.json");
    writeFileSync(
      manifest,
      JSON.stringify({ name: "donn", version: "0.0.0-old" }),
    );
    expect(await modCheck()).toMatchObject({
      status: "warn",
      message: `mod 0.0.0-old does not match the mod this donn ships (${MOD_VERSION})`,
      fix: "donn mod install",
    });
  });
});

describe("donn mod install, without donn on PATH", () => {
  it("installs anyway and says how to put donn on PATH", async () => {
    const r = await zz(["mod", "install", "--json"], {
      cwd: s.root,
      home: s.home,
      env: { PATH: join(s.root, "nowhere") },
      probe: recording().probe,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).warnings).toEqual([
      expect.stringContaining("donn is not on PATH"),
    ]);
  });
});

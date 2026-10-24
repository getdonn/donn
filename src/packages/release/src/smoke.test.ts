import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Packed } from "./pack.js";
import { smoke } from "./smoke.js";
import { fakeRunner } from "./testing/fake-runner.js";

const ok = (stdout = "{}") => ({ code: 0, stdout, stderr: "" });

const tarballs = [
  { pkg: { name: "@getdonn/spec", version: "1.2.3" }, tarball: "/t/spec.tgz" },
  { pkg: { name: "@getdonn/cli", version: "1.2.3" }, tarball: "/t/cli.tgz" },
] as unknown as Packed[];

function handlers(opts: { version?: string; plugin?: boolean } = {}) {
  return [
    [(c: string) => c === "npm", ok("")],
    [
      (c: string, a: string[]) => c === "donn" && a[0] === "--version",
      ok(`${opts.version ?? "1.2.3"}\n`),
    ],
    [
      (c: string, a: string[]) => c === "donn" && a[0] === "mod",
      async (_c: string, _a: string[], o: { env?: NodeJS.ProcessEnv }) => {
        if (opts.plugin !== false) {
          const f = join(
            o.env?.["DONN_HOME"] ?? "",
            "mod/plugin/.claude-plugin/plugin.json",
          );
          await mkdir(dirname(f), { recursive: true });
          await writeFile(f, "{}");
        }
        return ok();
      },
    ],
    [(c: string) => c === "donn", ok()],
  ] as never;
}

describe("smoke", () => {
  it("runs the steps in order with the throwaway home", async () => {
    const run = fakeRunner(handlers());
    await smoke({ root: "/r", source: { tarballs }, run });
    expect(run.calls.map((c) => [c.cmd, ...c.args].slice(0, 3))).toEqual([
      ["npm", "install", "--prefix"],
      ["donn", "--version"],
      ["donn", "capabilities", "--json"],
      ["donn", "init", "--personas"],
      ["donn", "resolve", "org/base"],
      ["donn", "compile", "org/base"],
      ["donn", "doctor", "--json"],
      ["donn", "mod", "install"],
    ]);
    expect(run.calls[0]?.args.slice(3)).toEqual(["/t/spec.tgz", "/t/cli.tgz"]);
    for (const c of run.calls) {
      const env = c.opts?.env ?? {};
      expect(env["HOME"]).not.toBe(homedir());
      expect(env["DONN_HOME"]?.startsWith(dirname(env["HOME"] ?? "x"))).toBe(
        true,
      );
      expect(env["HOME"]?.startsWith(homedir())).toBe(false);
    }
  });

  it("a version mismatch fails with the step name", async () => {
    const run = fakeRunner(handlers({ version: "9.9.9" }));
    await expect(
      smoke({ root: "/r", source: { tarballs }, run }),
    ).rejects.toMatchObject({ code: "smoke", message: /^version: / });
  });

  it("registry mode installs @getdonn/cli from the registry", async () => {
    const run = fakeRunner(handlers());
    // No tarballs, so the expected version comes from the installed package.
    await expect(
      smoke({ root: "/r", source: { registry: "http://localhost:4873" }, run }),
    ).rejects.toMatchObject({ message: /^version: / });
    expect(run.calls[0]?.args).toEqual([
      "install",
      "--prefix",
      expect.any(String),
      "@getdonn/cli",
      "--registry",
      "http://localhost:4873",
    ]);
  });

  it("a missing plugin.json fails", async () => {
    const run = fakeRunner(handlers({ plugin: false }));
    await expect(
      smoke({ root: "/r", source: { tarballs }, run }),
    ).rejects.toMatchObject({ message: /^mod install: .*plugin\.json/ });
  });
});

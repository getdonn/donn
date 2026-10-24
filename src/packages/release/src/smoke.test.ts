import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Packed } from "./pack.js";
import { smoke } from "./smoke.js";
import { fakeRunner } from "./testing/fake-runner.js";

async function rootWith(version: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "smoke-test-root-"));
  await mkdir(join(root, "src/apps/cli"), { recursive: true });
  await writeFile(
    join(root, "src/apps/cli/package.json"),
    JSON.stringify({ name: "@getdonn/cli", version }),
  );
  return root;
}

const ok = (stdout = "{}") => ({ code: 0, stdout, stderr: "" });

const tarballs = [
  { pkg: { name: "@getdonn/spec", version: "1.2.3" }, tarball: "/t/spec.tgz" },
  { pkg: { name: "@getdonn/cli", version: "1.2.3" }, tarball: "/t/cli.tgz" },
] as unknown as Packed[];

function handlers(opts: { version?: string; plugin?: boolean } = {}) {
  return [
    [(c: string) => c === "npm", ok("")],
    [
      (c: string, a: string[]) =>
        c.endsWith("/node_modules/.bin/donn") && a[0] === "--version",
      ok(`${opts.version ?? "1.2.3"}\n`),
    ],
    [
      (c: string, a: string[]) =>
        c.endsWith("/node_modules/.bin/donn") && a[0] === "mod",
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
    [(c: string) => c.endsWith("/node_modules/.bin/donn"), ok()],
  ] as never;
}

describe("smoke", () => {
  it("runs the steps in order with the throwaway home", async () => {
    const run = fakeRunner(handlers());
    await smoke({ root: await rootWith("1.2.3"), source: { tarballs }, run });
    expect(
      run.calls.map((c) =>
        [
          c.cmd.endsWith("/node_modules/.bin/donn") ? "donn" : c.cmd,
          ...c.args,
        ].slice(0, 3),
      ),
    ).toEqual([
      ["npm", "install", "--prefix"],
      ["donn", "--version"],
      ["donn", "capabilities", "--json"],
      ["donn", "init", "--personas"],
      ["donn", "resolve", "org/base"],
      ["donn", "compile", "org/base"],
      ["donn", "doctor", "--json"],
      ["donn", "mod", "install"],
    ]);
    // donn runs by absolute path, never by PATH lookup.
    expect(run.calls[1]?.cmd.startsWith("/")).toBe(true);
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
      smoke({ root: await rootWith("1.2.3"), source: { tarballs }, run }),
    ).rejects.toMatchObject({ code: "smoke", message: /^version: / });
  });

  it("registry mode installs the workspace version of @getdonn/cli", async () => {
    const run = fakeRunner(handlers());
    await smoke({
      root: await rootWith("1.2.3"),
      source: { registry: "http://localhost:4873" },
      run,
    });
    expect(run.calls[0]?.args).toEqual([
      "install",
      "--prefix",
      expect.any(String),
      "@getdonn/cli@1.2.3",
      "--registry",
      "http://localhost:4873",
    ]);
  });

  it("registry mode fails when donn prints another version", async () => {
    const run = fakeRunner(handlers({ version: "1.2.2" }));
    await expect(
      smoke({
        root: await rootWith("1.2.3"),
        source: { registry: "http://localhost:4873" },
        run,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/^version: .*1\.2\.2.*1\.2\.3/),
    });
  });

  it("does not leak the caller's DONN_*, XDG_* or CLAUDE_CONFIG_DIR", async () => {
    const leaked = {
      DONN_PERSONA: "x",
      DONN_NO_DAEMON: "1",
      DONN_REGISTRY_TOKEN: "secret",
      CLAUDE_CONFIG_DIR: "/elsewhere",
      XDG_CONFIG_HOME: "/elsewhere",
      XDG_RUNTIME_DIR: "/elsewhere",
    };
    const saved = Object.fromEntries(
      Object.keys(leaked).map((k) => [k, process.env[k]]),
    );
    Object.assign(process.env, leaked);
    try {
      const run = fakeRunner(handlers());
      await smoke({ root: await rootWith("1.2.3"), source: { tarballs }, run });
      for (const c of run.calls) {
        for (const k of Object.keys(leaked)) {
          expect(c.opts?.env?.[k]).toBeUndefined();
        }
        expect(c.opts?.env?.["DONN_HOME"]).toBeDefined();
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("a missing plugin.json fails", async () => {
    const run = fakeRunner(handlers({ plugin: false }));
    await expect(
      smoke({ root: await rootWith("1.2.3"), source: { tarballs }, run }),
    ).rejects.toMatchObject({ message: /^mod install: .*plugin\.json/ });
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReleaseError } from "./errors.js";
import { publish } from "./publish.js";
import { fakeRunner } from "./testing/fake-runner.js";

const NPMJS = "https://registry.npmjs.org";
const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0))
    rmSync(d, { recursive: true, force: true });
});

type Pkg = { name: string; deps?: string[] };

/** A temp repo whose `pnpm ls` lists `pkgs` (all version 1.0.0). */
function repo(pkgs: Pkg[] = [{ name: "@getdonn/a" }, { name: "@getdonn/b" }]) {
  const root = mkdtempSync(join(tmpdir(), "release-publish-"));
  cleanup.push(root);
  writeFileSync(join(root, "LICENSE"), "license");
  writeFileSync(join(root, "NOTICE"), "notice");
  const entries = pkgs.map((p) => {
    const dir = join(root, p.name.split("/")[1] ?? p.name);
    mkdirSync(dir);
    const dependencies = Object.fromEntries(
      (p.deps ?? []).map((d) => [d, "workspace:*"]),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: p.name, version: "1.0.0", dependencies }),
    );
    return { name: p.name, version: "1.0.0", path: dir };
  });
  return { root, ls: JSON.stringify(entries) };
}

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const e404 = { code: 1, stdout: "", stderr: "npm error code E404\n" };

interface Script {
  ls: string;
  status?: string;
  npmVersion?: string;
  view?: (spec: string) => { code: number; stdout: string; stderr: string };
  publish?: (tarball: string) => {
    code: number;
    stdout: string;
    stderr: string;
  };
}

function runner(s: Script) {
  return fakeRunner([
    [(c, a) => c === "git" && a[0] === "status", ok(s.status ?? "")],
    [(c, a) => c === "pnpm" && a[0] === "ls", ok(s.ls)],
    [
      (c, a) => c === "pnpm" && a[0] === "pack",
      (_c, _a, opts) => ok(`${opts?.cwd}/out.tgz\n`),
    ],
    [
      (c, a) => c === "npm" && a[0] === "--version",
      ok(s.npmVersion ?? "11.5.1\n"),
    ],
    [
      (c, a) => c === "npm" && a[0] === "view",
      (_c, a) => (s.view ?? (() => e404))(a[1] ?? ""),
    ],
    [
      (c, a) => c === "npm" && a[0] === "publish",
      (_c, a) => (s.publish ?? (() => ok()))(a[1] ?? ""),
    ],
  ]);
}

const npmCalls = (run: ReturnType<typeof runner>, sub: string) =>
  run.calls.filter((c) => c.cmd === "npm" && c.args[0] === sub);

describe("publish", () => {
  it("publishes in dependency order", async () => {
    const { root, ls } = repo([
      { name: "@getdonn/cli", deps: ["@getdonn/lib"] },
      { name: "@getdonn/lib" },
    ]);
    const run = runner({ ls });
    const out = await publish({
      root,
      registry: NPMJS,
      dryRun: false,
      env: {},
      run,
    });
    expect(out).toEqual({
      registry: NPMJS,
      dryRun: false,
      published: ["@getdonn/lib@1.0.0", "@getdonn/cli@1.0.0"],
      skipped: [],
    });
    const calls = npmCalls(run, "publish");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual([
      "publish",
      expect.stringMatching(/lib\/out\.tgz$/),
      "--access",
      "public",
      "--registry",
      NPMJS,
    ]);
  });

  it("a re-run skips what the registry already has", async () => {
    const { root, ls } = repo();
    const run = runner({
      ls,
      view: (spec) => (spec.startsWith("@getdonn/a@") ? ok("1.0.0\n") : e404),
    });
    const out = await publish({
      root,
      registry: NPMJS,
      dryRun: false,
      env: {},
      run,
    });
    expect(out.skipped).toEqual(["@getdonn/a@1.0.0"]);
    expect(out.published).toEqual(["@getdonn/b@1.0.0"]);
    expect(npmCalls(run, "publish")).toHaveLength(1);
    expect(npmCalls(run, "view")[0]?.args).toEqual([
      "view",
      "@getdonn/a@1.0.0",
      "version",
      "--registry",
      NPMJS,
    ]);
  });

  it("publishes when the package exists but not this version (empty output)", async () => {
    const { root, ls } = repo([{ name: "@getdonn/a" }]);
    const run = runner({ ls, view: () => ok("") });
    const out = await publish({
      root,
      registry: NPMJS,
      dryRun: false,
      env: {},
      run,
    });
    expect(out.published).toEqual(["@getdonn/a@1.0.0"]);
  });

  it("stops at the first failure and reports it", async () => {
    const { root, ls } = repo();
    const run = runner({
      ls,
      publish: () => ({ code: 1, stdout: "", stderr: "E403 forbidden\n" }),
    });
    const out = await publish({
      root,
      registry: NPMJS,
      dryRun: false,
      env: {},
      run,
    });
    expect(out.published).toEqual([]);
    expect(out.failed?.name).toBe("@getdonn/a@1.0.0");
    expect(out.failed?.error).toContain("E403");
    expect(npmCalls(run, "publish")).toHaveLength(1);
  });

  it("a view error that is not E404 stops the run", async () => {
    const { root, ls } = repo();
    const run = runner({
      ls,
      view: () => ({ code: 1, stdout: "", stderr: "ECONNRESET\n" }),
    });
    const out = await publish({
      root,
      registry: NPMJS,
      dryRun: false,
      env: {},
      run,
    });
    expect(out.failed?.name).toBe("@getdonn/a@1.0.0");
    expect(npmCalls(run, "publish")).toHaveLength(0);
    expect(npmCalls(run, "view")).toHaveLength(1);
  });

  it("a view that prints a different version stops the run", async () => {
    const { root, ls } = repo();
    const run = runner({ ls, view: () => ok("2.0.0\n") });
    const out = await publish({
      root,
      registry: NPMJS,
      dryRun: false,
      env: {},
      run,
    });
    expect(out.failed?.name).toBe("@getdonn/a@1.0.0");
    expect(npmCalls(run, "publish")).toHaveLength(0);
  });

  it("--dry-run passes through to npm publish", async () => {
    const { root, ls } = repo([{ name: "@getdonn/a" }]);
    const run = runner({ ls });
    const out = await publish({
      root,
      registry: NPMJS,
      dryRun: true,
      env: {},
      run,
    });
    expect(out.dryRun).toBe(true);
    expect(npmCalls(run, "publish")[0]?.args.at(-1)).toBe("--dry-run");
  });

  it("passes the caller's env to npm", async () => {
    const { root, ls } = repo([{ name: "@getdonn/a" }]);
    const run = runner({ ls });
    const env = { NPM_CONFIG_USERCONFIG: "/x/npmrc" };
    await publish({ root, registry: NPMJS, dryRun: false, env, run });
    for (const c of run.calls.filter((c) => c.cmd === "npm")) {
      expect(c.opts?.env).toEqual(env);
    }
  });

  it("a dirty tree is refused before any npm call", async () => {
    const { root, ls } = repo();
    const run = runner({ ls, status: " M file.ts\n" });
    await expect(
      publish({ root, registry: NPMJS, dryRun: false, env: {}, run }),
    ).rejects.toMatchObject({ code: "dirty" });
    expect(run.calls.filter((c) => c.cmd === "npm")).toEqual([]);
    expect(run.calls.filter((c) => c.cmd === "pnpm")).toEqual([]);
  });

  it("npm 11.5.0 is refused under CI, 11.5.1 is accepted", async () => {
    const { root, ls } = repo([{ name: "@getdonn/a" }]);
    const env = { CI: "true" };
    const old = runner({ ls, npmVersion: "11.5.0\n" });
    const err = await publish({
      root,
      registry: NPMJS,
      dryRun: false,
      env,
      run: old,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReleaseError);
    expect((err as ReleaseError).code).toBe("npm-too-old");
    expect(npmCalls(old, "publish")).toHaveLength(0);

    const good = runner({ ls, npmVersion: "11.5.1\n" });
    const out = await publish({
      root,
      registry: NPMJS,
      dryRun: false,
      env,
      run: good,
    });
    expect(out.published).toHaveLength(1);
  });

  it("compares npm versions numerically", async () => {
    const { root, ls } = repo([{ name: "@getdonn/a" }]);
    const run = runner({ ls, npmVersion: "11.20.0\n" });
    const out = await publish({
      root,
      registry: NPMJS,
      dryRun: false,
      env: { CI: "1" },
      run,
    });
    expect(out.published).toHaveLength(1);
  });

  it("does not check the npm version outside CI", async () => {
    const { root, ls } = repo([{ name: "@getdonn/a" }]);
    const run = runner({ ls, npmVersion: "10.0.0\n" });
    await publish({ root, registry: NPMJS, dryRun: false, env: {}, run });
    expect(npmCalls(run, "--version")).toHaveLength(0);
  });

  it("an empty NODE_AUTH_TOKEN is refused", async () => {
    const { root, ls } = repo();
    for (const registry of [NPMJS, `${NPMJS}/`]) {
      const run = runner({ ls });
      await expect(
        publish({
          root,
          registry,
          dryRun: false,
          env: { CI: "true", NODE_AUTH_TOKEN: "" },
          run,
        }),
      ).rejects.toMatchObject({ code: "token-set" });
      expect(npmCalls(run, "publish")).toHaveLength(0);
      expect(npmCalls(run, "view")).toHaveLength(0);
    }
  });

  it("a token is allowed for a non-npmjs registry", async () => {
    const { root, ls } = repo([{ name: "@getdonn/a" }]);
    const run = runner({ ls });
    const out = await publish({
      root,
      registry: "http://localhost:4873",
      dryRun: false,
      env: { CI: "true", NODE_AUTH_TOKEN: "t" },
      run,
    });
    expect(out.published).toHaveLength(1);
  });
});

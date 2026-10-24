import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claim, type ClaimOptions } from "./claim.js";
import { ReleaseError } from "./errors.js";
import { fakeRunner } from "./testing/fake-runner.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0))
    rmSync(d, { recursive: true, force: true });
});

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const e404 = { code: 1, stdout: "", stderr: "npm error code E404\n" };
const boom = { code: 1, stdout: "", stderr: "npm error code ECONNRESET\n" };
const REPO = { type: "git", url: "git+https://github.com/getdonn/donn.git" };

function repo(names = ["@getdonn/a", "@getdonn/b"]) {
  const root = mkdtempSync(join(tmpdir(), "release-claim-"));
  cleanup.push(root);
  const entries = names.map((name) => {
    const dir = join(root, name.split("/")[1] ?? name);
    mkdirSync(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name,
        version: "1.2.3",
        description: `the ${name}`,
        license: "Apache-2.0",
        repository: REPO,
        dependencies: { "@getdonn/x": "workspace:*" },
        bin: { x: "x.js" },
      }),
    );
    return { name, version: "1.2.3", path: dir };
  });
  return { root, ls: JSON.stringify(entries) };
}

interface Script {
  ls: string;
  /** Answer for `npm config get registry`. */
  registry?: string;
  /** Answer for `npm view <spec> <field>`. */
  view?: (spec: string) => { code: number; stdout: string; stderr: string };
}

type Seen = { args: string[]; pkg: Record<string, unknown>; readme: string };

function setup(s: Script) {
  const published: Seen[] = [];
  const run = fakeRunner([
    [(c, a) => c === "pnpm" && a[0] === "ls", ok(s.ls)],
    [
      (c, a) => c === "npm" && a[0] === "config",
      ok(s.registry ?? "https://registry.npmjs.org/\n"),
    ],
    [
      (c, a) => c === "npm" && a[0] === "view",
      (_c, a) => (s.view ?? (() => e404))(a[1] ?? ""),
    ],
    [
      (c, a) => c === "npm" && a[0] === "publish",
      (_c, a) => {
        const dir = a[1] ?? "";
        published.push({
          args: a,
          pkg: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")),
          readme: readFileSync(join(dir, "README.md"), "utf8"),
        });
        return ok();
      },
    ],
    [(c, a) => c === "npm" && a[0] === "deprecate", ok()],
  ]);
  return { run, published };
}

const base = (
  root: string,
  run: ClaimOptions["run"],
  extra: Partial<ClaimOptions> = {},
): ClaimOptions => ({
  root,
  deprecate: false,
  yes: true,
  env: {},
  run,
  ...extra,
});

const calls = (run: ReturnType<typeof fakeRunner>, sub: string) =>
  run.calls.filter((c) => c.cmd === "npm" && c.args[0] === sub);

describe("claim", () => {
  it("only names missing from npm are claimed", async () => {
    const { root, ls } = repo();
    const { run, published } = setup({
      ls,
      view: (spec) => (spec === "@getdonn/a" ? ok("@getdonn/a\n") : e404),
    });
    const res = await claim(base(root, run));
    expect(res).toEqual({
      claimed: ["@getdonn/b"],
      existing: ["@getdonn/a"],
      deprecated: [],
    });
    expect(published.map((p) => p.pkg["name"])).toEqual(["@getdonn/b"]);
  });

  it("the placeholder carries the exact README and version 0.0.0", async () => {
    const { root, ls } = repo(["@getdonn/a"]);
    const { run, published } = setup({ ls });
    await claim(base(root, run));
    const [seen] = published;
    expect(seen?.readme).toBe(
      "Reserved. Releases come from https://github.com/getdonn/donn.\n",
    );
    expect(seen?.pkg).toEqual({
      name: "@getdonn/a",
      version: "0.0.0",
      description: "the @getdonn/a",
      license: "Apache-2.0",
      repository: REPO,
    });
    expect(seen?.args.slice(2)).toEqual(["--access", "public"]);
  });

  it("removes the temp folder afterwards", async () => {
    const { root, ls } = repo(["@getdonn/a"]);
    const { run, published } = setup({ ls });
    await claim(base(root, run));
    const dir = calls(run, "publish")[0]?.args[1] ?? "";
    expect(published).toHaveLength(1);
    expect(existsSync(dir)).toBe(false);
  });

  it("publish inherits stdio for the 2FA prompt", async () => {
    const { root, ls } = repo(["@getdonn/a"]);
    const { run } = setup({ ls });
    await claim(base(root, run));
    expect(calls(run, "publish")[0]?.opts?.stdio).toBe("inherit");
    expect(calls(run, "publish")[0]?.args).not.toContain("--registry");
  });

  it("without --yes it lists and publishes nothing", async () => {
    const { root, ls } = repo();
    const { run } = setup({
      ls,
      view: (spec) => (spec === "@getdonn/a" ? ok("@getdonn/a\n") : e404),
    });
    const res = await claim(base(root, run, { yes: false }));
    expect(res).toEqual({
      claimed: ["@getdonn/b"],
      existing: ["@getdonn/a"],
      deprecated: [],
    });
    expect(calls(run, "publish")).toHaveLength(0);
  });

  it("refuses a non-npmjs registry before any npm view", async () => {
    const { root, ls } = repo();
    for (const deprecate of [false, true]) {
      const { run } = setup({ ls, registry: "http://localhost:4873/\n" });
      await expect(
        claim(base(root, run, { deprecate, yes: false })),
      ).rejects.toMatchObject({ code: "registry" });
      expect(calls(run, "view")).toHaveLength(0);
      expect(calls(run, "publish")).toHaveLength(0);
    }
  });

  it("proceeds when npm's registry is npmjs", async () => {
    const { root, ls } = repo(["@getdonn/a"]);
    const { run } = setup({ ls, registry: "https://registry.npmjs.org/\n" });
    const res = await claim(base(root, run, { yes: false }));
    expect(res.claimed).toEqual(["@getdonn/a"]);
  });

  it("refuses when CI is set", async () => {
    const { root, ls } = repo();
    const { run } = setup({ ls });
    await expect(
      claim(base(root, run, { env: { CI: "true" } })),
    ).rejects.toMatchObject({ code: "ci" });
    expect(run.calls).toHaveLength(0);
  });

  it("an unknown npm view error stops without publishing", async () => {
    const { root, ls } = repo();
    const { run } = setup({ ls, view: () => boom });
    const err = await claim(base(root, run)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReleaseError);
    expect(err).toMatchObject({ code: "view" });
    expect(calls(run, "publish")).toHaveLength(0);
  });

  it("a failed publish stops with an error", async () => {
    const { root, ls } = repo();
    const run = fakeRunner([
      [(c) => c === "pnpm", ok(ls)],
      [(_c, a) => a[0] === "config", ok("https://registry.npmjs.org/\n")],
      [(_c, a) => a[0] === "view", e404],
      [(_c, a) => a[0] === "publish", boom],
    ]);
    await expect(claim(base(root, run))).rejects.toMatchObject({
      code: "publish",
    });
    expect(calls(run, "publish")).toHaveLength(1);
  });
});

describe("claim --deprecate", () => {
  const has = (spec: string) =>
    spec === "@getdonn/a@0.0.0" ? ok("0.0.0\n") : ok("");

  it("deprecates only 0.0.0 with the exact message", async () => {
    const { root, ls } = repo();
    const { run } = setup({ ls, view: has });
    const res = await claim(base(root, run, { deprecate: true }));
    expect(res).toEqual({
      claimed: [],
      existing: [],
      deprecated: ["@getdonn/a"],
    });
    const dep = calls(run, "deprecate");
    expect(dep.map((c) => c.args)).toEqual([
      ["deprecate", "@getdonn/a@0.0.0", "placeholder; use the latest version"],
    ]);
    expect(dep[0]?.opts?.stdio).toBe("inherit");
    expect(calls(run, "publish")).toHaveLength(0);
  });

  it("skips a package whose 0.0.0 is E404", async () => {
    const { root, ls } = repo(["@getdonn/a"]);
    const { run } = setup({ ls, view: () => e404 });
    const res = await claim(base(root, run, { deprecate: true }));
    expect(res.deprecated).toEqual([]);
    expect(calls(run, "deprecate")).toHaveLength(0);
  });

  it("an unknown view error stops", async () => {
    const { root, ls } = repo(["@getdonn/a"]);
    const { run } = setup({ ls, view: () => boom });
    await expect(
      claim(base(root, run, { deprecate: true })),
    ).rejects.toMatchObject({ code: "view" });
  });

  it("without --yes it only lists", async () => {
    const { root, ls } = repo();
    const { run } = setup({ ls, view: has });
    const res = await claim(base(root, run, { deprecate: true, yes: false }));
    expect(res.deprecated).toEqual(["@getdonn/a"]);
    expect(calls(run, "deprecate")).toHaveLength(0);
  });

  it("refuses when CI is set", async () => {
    const { root, ls } = repo();
    const { run } = setup({ ls });
    await expect(
      claim(base(root, run, { deprecate: true, env: { CI: "1" } })),
    ).rejects.toMatchObject({ code: "ci" });
  });
});

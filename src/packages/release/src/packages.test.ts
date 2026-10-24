import { describe, expect, it } from "vitest";
import { ReleaseError } from "./errors.js";
import { listWorkspaces, publicPackages, type Workspace } from "./packages.js";
import { fakeRunner } from "./testing/fake-runner.js";

function ws(
  name: string,
  deps: {
    dependencies?: string[];
    peerDependencies?: string[];
    optionalDependencies?: string[];
  } = {},
  isPrivate = false,
): Workspace {
  const field = (names?: string[]) =>
    Object.fromEntries((names ?? []).map((n) => [n, "workspace:*"]));
  return {
    name,
    version: "1.0.0",
    dir: `/repo/${name}`,
    private: isPrivate,
    manifest: {
      name,
      dependencies: field(deps.dependencies),
      peerDependencies: field(deps.peerDependencies),
      optionalDependencies: field(deps.optionalDependencies),
    },
  };
}

const names = (all: Workspace[]) =>
  publicPackages(all).map((p) => p.name.replace("@getdonn/", ""));

describe("publicPackages", () => {
  it("orders by @getdonn dependencies", () => {
    const all = [
      ws("@getdonn/cli", {
        dependencies: ["@getdonn/resolver", "@getdonn/spec"],
      }),
      ws("@getdonn/resolver", { dependencies: ["@getdonn/spec"] }),
      ws("@getdonn/spec"),
    ];
    expect(names(all)).toEqual(["spec", "resolver", "cli"]);
  });

  it("breaks ties by name", () => {
    const all = [ws("@getdonn/b"), ws("@getdonn/c"), ws("@getdonn/a")];
    expect(names(all)).toEqual(["a", "b", "c"]);
  });

  it("private workspaces are left out", () => {
    const all = [
      ws("@getdonn/spec"),
      ws("@getdonn/release", { dependencies: ["@getdonn/spec"] }, true),
      ws("donn-monorepo", {}, true),
    ];
    expect(names(all)).toEqual(["spec"]);
  });

  it("a cycle is an error", () => {
    const all = [
      ws("@getdonn/a", { dependencies: ["@getdonn/b"] }),
      ws("@getdonn/b", { dependencies: ["@getdonn/a"] }),
    ];
    const err = (() => {
      try {
        publicPackages(all);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ReleaseError);
    expect((err as ReleaseError).code).toBe("cycle");
    expect((err as ReleaseError).message).toContain("@getdonn/a");
    expect((err as ReleaseError).message).toContain("@getdonn/b");
  });

  it("peer and optional dependencies count", () => {
    const all = [
      ws("@getdonn/z", {
        peerDependencies: ["@getdonn/a"],
        optionalDependencies: ["@getdonn/b"],
      }),
      ws("@getdonn/b"),
      ws("@getdonn/a"),
    ];
    const pkgs = publicPackages(all);
    expect(pkgs.map((p) => p.name)).toEqual([
      "@getdonn/a",
      "@getdonn/b",
      "@getdonn/z",
    ]);
    expect(pkgs[2]?.deps).toEqual(["@getdonn/a", "@getdonn/b"]);
  });
});

describe("listWorkspaces", () => {
  it("reads pnpm ls output and each package.json", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "release-ws-"));
    mkdirSync(join(root, "spec"));
    writeFileSync(
      join(root, "spec", "package.json"),
      JSON.stringify({ name: "@getdonn/spec", version: "0.3.0" }),
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "donn-monorepo", private: true }),
    );
    const out = [
      { name: "donn-monorepo", path: root, private: true },
      {
        name: "@getdonn/spec",
        version: "0.3.0",
        path: join(root, "spec"),
        private: false,
      },
    ];
    const run2 = fakeRunner([
      [() => true, { code: 0, stdout: JSON.stringify(out), stderr: "" }],
    ]);
    const all = await listWorkspaces(root, run2);
    expect(all.map((w) => [w.name, w.version, w.private])).toEqual([
      ["donn-monorepo", "0.0.0", true],
      ["@getdonn/spec", "0.3.0", false],
    ]);
    expect(run2.calls[0]?.opts?.cwd).toBe(root);
  });

  it("names the package.json that cannot be read", async () => {
    const run = fakeRunner([
      [
        () => true,
        {
          code: 0,
          stdout: JSON.stringify([{ name: "x", path: "/nonexistent-ws" }]),
          stderr: "",
        },
      ],
    ]);
    await expect(listWorkspaces("/x", run)).rejects.toMatchObject({
      code: "workspaces",
      message: expect.stringContaining("/nonexistent-ws/package.json"),
    });
  });

  it("fails with a ReleaseError when pnpm fails", async () => {
    const run = fakeRunner([
      [() => true, { code: 1, stdout: "", stderr: "boom" }],
    ]);
    await expect(listWorkspaces("/x", run)).rejects.toMatchObject({
      code: "workspaces",
    });
  });
});

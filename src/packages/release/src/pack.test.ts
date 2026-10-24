import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packAll } from "./pack.js";
import type { PublicPackage } from "./packages.js";
import { fakeRunner } from "./testing/fake-runner.js";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "release-pack-"));
  writeFileSync(join(root, "LICENSE"), "license text");
  writeFileSync(join(root, "NOTICE"), "notice text");
  const dir = join(root, "pkg");
  mkdirSync(dir);
  const pkg: PublicPackage = {
    name: "@getdonn/pkg",
    version: "1.0.0",
    dir,
    private: false,
    manifest: {},
    deps: [],
  };
  return { root, dir, pkg };
}

describe("packAll", () => {
  it("copies LICENSE and NOTICE in for the pack", async () => {
    const { root, dir, pkg } = repo();
    const seen: boolean[] = [];
    const run = fakeRunner([
      [
        (cmd) => cmd === "pnpm",
        () => {
          seen.push(existsSync(join(dir, "LICENSE")));
          seen.push(existsSync(join(dir, "NOTICE")));
          return { code: 0, stdout: "x\n/out/a.tgz\n", stderr: "" };
        },
      ],
    ]);
    await packAll(root, [pkg], run, join(root, "out"));
    expect(seen).toEqual([true, true]);
    expect(existsSync(join(dir, "LICENSE"))).toBe(false);
    expect(existsSync(join(dir, "NOTICE"))).toBe(false);
  });

  it("removes the copies even when pack fails", async () => {
    const { root, dir, pkg } = repo();
    const run = fakeRunner([
      [() => true, { code: 1, stdout: "", stderr: "no" }],
    ]);
    await expect(
      packAll(root, [pkg], run, join(root, "out")),
    ).rejects.toMatchObject({ code: "pack" });
    expect(existsSync(join(dir, "LICENSE"))).toBe(false);
    expect(existsSync(join(dir, "NOTICE"))).toBe(false);
  });

  it("returns the tarball path pnpm printed", async () => {
    const { root, dir, pkg } = repo();
    const out = join(root, "out");
    const run = fakeRunner([
      [
        () => true,
        { code: 0, stdout: `Tarball\n${out}/p-1.0.0.tgz\n`, stderr: "" },
      ],
    ]);
    const packed = await packAll(root, [pkg], run, out);
    expect(packed).toEqual([{ pkg, tarball: `${out}/p-1.0.0.tgz` }]);
    expect(run.calls[0]).toMatchObject({
      cmd: "pnpm",
      args: ["pack", "--pack-destination", out],
      opts: { cwd: dir },
    });
  });
});

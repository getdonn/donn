import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nodeProbe } from "@getdonn/executor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { quietIo } from "../test/seed.js";
import {
  defaultTemplateName,
  parseVendorSource,
  redactUrl,
  stageVendor,
  vendorDigest,
} from "./vendor.js";

let root: string;
let home: string;
let stagingBase: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "donn-vendor-"));
  home = join(root, "home");
  stagingBase = join(root, "stage");
  mkdirSync(home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

/** An eve template's minimum: a package.json listing eve, and an agent folder. */
const putTemplate = (dir: string) => {
  put(`${dir}/package.json`, JSON.stringify({ dependencies: { eve: "1" } }));
  put(`${dir}/agent/a.ts`, "export {};\n");
};

const io = (env: NodeJS.ProcessEnv = {}) => ({
  ...quietIo({ cwd: root, home }),
  env: { HOME: home, ...env },
  probe: nodeProbe(),
});

/** Real git, independent of the user's own configuration. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  ).trim();

const stage = (
  source: Parameters<typeof stageVendor>[1],
  options: { name?: string } = {},
  withIo = io(),
) => stageVendor(withIo, source, { ...options, stagingBase });

const dirSource = (path: string) =>
  ({ kind: "dir", dir: join(root, path), given: path }) as const;

describe("parseVendorSource", () => {
  it("parses folders and git URLs", () => {
    expect(parseVendorSource("~/x", "/cwd", "/home/u")).toEqual({
      kind: "dir",
      dir: "/home/u/x",
      given: "~/x",
    });
    expect(parseVendorSource("../x", "/a/b", "/h")).toMatchObject({
      kind: "dir",
      dir: "/a/x",
    });
    expect(parseVendorSource("/abs/x", "/a/b", "/h")).toMatchObject({
      kind: "dir",
      dir: "/abs/x",
    });
    expect(parseVendorSource("https://h/o/r.git#v1", "/c", "/h")).toEqual({
      kind: "git",
      url: "https://h/o/r.git",
      ref: "v1",
      given: "https://h/o/r.git#v1",
    });
    expect(
      parseVendorSource("git@github.com:o/r.git", "/c", "/h"),
    ).toMatchObject({ kind: "git", url: "git@github.com:o/r.git" });
    for (const url of ["http://h/r", "ssh://h/r", "file:///r"])
      expect(parseVendorSource(url, "/c", "/h")).toMatchObject({ kind: "git" });
  });

  it("names a template after its source", () => {
    const name = (given: string) =>
      defaultTemplateName(parseVendorSource(given, "/c", "/h"));
    expect(name("/x/kody-eve-template")).toBe("kody-eve-template");
    expect(name("https://h/o/kody.git#main")).toBe("kody");
    expect(name("git@github.com:o/kody.git")).toBe("kody");
    expect(name("https://h/o/kody/")).toBe("kody");
  });

  it("removes credentials from a URL", () => {
    expect(redactUrl("https://user:secret@h/o/r.git")).toBe(
      "https://h/o/r.git",
    );
    expect(redactUrl("https://tok@h/r")).toBe("https://h/r");
    expect(redactUrl("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
  });
});

describe("stageVendor from a folder", () => {
  it("expands ~/", async () => {
    putTemplate("home/tpl");
    const withIo = io();
    const result = await stage(
      parseVendorSource("~/tpl", withIo.cwd, withIo.env.HOME!),
      {},
      withIo,
    );
    expect(result.name).toBe("tpl");
    expect(result.files).toEqual(["agent/a.ts", "package.json"]);
  });

  it("stages a folder template and digests it", async () => {
    putTemplate("tpl");
    const result = await stage(dirSource("tpl"));
    expect(result.files).toEqual(["agent/a.ts", "package.json"]);
    expect(result.digest).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(result.commit).toBeUndefined();
    expect(result.dirty).toBeUndefined();
    expect(result.source).toBe("tpl");
    expect(await vendorDigest(result.dir)).toBe(result.digest);
  });

  it("changes the digest with content and with the executable bit", async () => {
    putTemplate("tpl");
    const before = (await stage(dirSource("tpl"))).digest;
    put("tpl/agent/a.ts", "export const x = 1;\n");
    const edited = (await stage(dirSource("tpl"))).digest;
    expect(edited).not.toBe(before);
    execFileSync("chmod", ["+x", join(root, "tpl/agent/a.ts")]);
    expect((await stage(dirSource("tpl"))).digest).not.toBe(edited);
  });

  it("leaves out .env and node_modules", async () => {
    putTemplate("tpl");
    put("tpl/.env", "S=1");
    put("tpl/.env.local", "S=2");
    put("tpl/.env.example", "S=");
    put("tpl/node_modules/x", "x");
    put("tpl/.output/y", "y");
    const result = await stage(dirSource("tpl"));
    expect(result.files).toEqual([
      ".env.example",
      "agent/a.ts",
      "package.json",
    ]);
    expect(existsSync(join(result.dir, "node_modules"))).toBe(false);
  });

  it("drops what a checkout's .gitignore ignores and notes uncommitted changes", async () => {
    putTemplate("tpl");
    put("tpl/.gitignore", "dist/\n");
    put("tpl/dist/out.js", "x");
    git(join(root, "tpl"), "init");
    git(join(root, "tpl"), "add", "-A");
    git(join(root, "tpl"), "commit", "-m", "one");
    const head = git(join(root, "tpl"), "rev-parse", "HEAD");
    put("tpl/agent/a.ts", "export const changed = true;\n");
    put("tpl/agent/new.ts", "export {};\n");
    const result = await stage(dirSource("tpl"));
    expect(result.files).toEqual([
      ".gitignore",
      "agent/a.ts",
      "agent/new.ts",
      "package.json",
    ]);
    expect(result.commit).toBe(head);
    expect(result.dirty).toBe(true);
  });

  it("reports a clean checkout as not dirty", async () => {
    putTemplate("tpl");
    git(join(root, "tpl"), "init");
    git(join(root, "tpl"), "add", "-A");
    git(join(root, "tpl"), "commit", "-m", "one");
    expect((await stage(dirSource("tpl"))).dirty).toBe(false);
  });

  it("refuses a folder that is not an eve template", async () => {
    put("tpl/package.json", JSON.stringify({ dependencies: { react: "1" } }));
    put("tpl/agent/a.ts", "x");
    put("nopkg/agent/a.ts", "x");
    put(
      "noagent/package.json",
      JSON.stringify({ devDependencies: { eve: "1" } }),
    );
    for (const dir of ["tpl", "nopkg", "noagent"]) {
      await expect(stage(dirSource(dir))).rejects.toMatchObject({
        code: "vendor-not-eve-template",
      });
    }
    expect(existsSync(stagingBase) ? readdirSync(stagingBase) : []).toEqual([]);
  });

  it("accepts eve in devDependencies", async () => {
    put("tpl/package.json", JSON.stringify({ devDependencies: { eve: "1" } }));
    put("tpl/agent/a.ts", "x");
    expect((await stage(dirSource("tpl"))).files).toContain("agent/a.ts");
  });

  it("refuses a missing folder", async () => {
    await expect(stage(dirSource("nope"))).rejects.toMatchObject({
      code: "vendor-source-not-found",
    });
  });

  it("refuses a bad name", async () => {
    putTemplate("tpl");
    await expect(
      stage(dirSource("tpl"), { name: "Kody!" }),
    ).rejects.toMatchObject({ code: "invalid-template-name" });
    expect(existsSync(stagingBase) ? readdirSync(stagingBase) : []).toEqual([]);
  });
});

describe("stageVendor from git", () => {
  /** A bare repository with two commits on main, tag v1 on the first. */
  const bare = () => {
    putTemplate("work");
    const work = join(root, "work");
    git(work, "init");
    git(work, "add", "-A");
    git(work, "commit", "-m", "one");
    git(work, "tag", "v1");
    const first = git(work, "rev-parse", "HEAD");
    put("work/agent/b.ts", "export {};\n");
    git(work, "add", "-A");
    git(work, "commit", "-m", "two");
    const second = git(work, "rev-parse", "HEAD");
    git(root, "init", "--bare", "remote.git");
    git(work, "push", join(root, "remote.git"), "main", "v1");
    return { url: `file://${join(root, "remote.git")}`, first, second };
  };

  it("stages the default branch without a ref", async () => {
    const { url, second } = bare();
    const result = await stage({ kind: "git", url, given: url });
    expect(result.commit).toBe(second);
    expect(result.dirty).toBeUndefined();
    expect(result.name).toBe("remote");
    expect(result.files).toEqual(["agent/a.ts", "agent/b.ts", "package.json"]);
    expect(result.source).toBe(url);
  });

  it.each(["main", "v1", "sha"])("stages a git source at %s", async (ref) => {
    const { url, first, second } = bare();
    const at = ref === "sha" ? first : ref;
    const expected = ref === "main" ? second : first;
    const given = `${url}#${at}`;
    const result = await stage({ kind: "git", url, ref: at, given });
    expect(result.commit).toBe(expected);
    expect(result.ref).toBe(at);
    expect(result.source).toBe(given);
    expect(existsSync(join(result.dir, ".git"))).toBe(false);
  });

  it("reports a failed fetch", async () => {
    const url = `file://${join(root, "nope")}`;
    const error = await stage({ kind: "git", url, given: url }).catch((e) => e);
    expect(error).toMatchObject({ code: "vendor-fetch-failed" });
    expect(error.details.exitCode).toBeGreaterThan(0);
    expect(error.details.line).toContain("nope");
    expect(existsSync(stagingBase) ? readdirSync(stagingBase) : []).toEqual([]);
  });

  it("never prints a URL's credentials", async () => {
    const url = "https://user:secret@127.0.0.1:1/r.git";
    const error = await stage({ kind: "git", url, given: url }).catch((e) => e);
    expect(error).toMatchObject({ code: "vendor-fetch-failed" });
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(
      "secret",
    );
    expect(error.stack ?? "").not.toContain("secret");
  });

  it("records a source's credentials as removed", async () => {
    const { url } = bare();
    const given = url.replace("file://", "file://user:secret@");
    const withIo = io();
    const result = await stage({ kind: "git", url, given }, {}, withIo);
    expect(result.source).not.toContain("secret");
  });

  it("says when git is missing", async () => {
    const base = nodeProbe();
    const missing = {
      ...io(),
      probe: {
        ...base,
        run: async (command: string, args: string[]) =>
          command === "git"
            ? { exitCode: 127, stdout: "", stderr: "" }
            : base.run(command, args),
      },
    };
    const url = "file:///x";
    await expect(
      stage({ kind: "git", url, given: url }, {}, missing),
    ).rejects.toMatchObject({ code: "git-not-installed" });
    expect(existsSync(stagingBase) ? readdirSync(stagingBase) : []).toEqual([]);
  });
});

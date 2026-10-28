import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { nodeProbe } from "@getdonn/executor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { quietIo, seed, zz, type Seeded } from "../test/seed.js";
import { AgentVendorOutput } from "@getdonn/cli-schemas";
import {
  defaultTemplateName,
  parseVendorSource,
  commitVendor,
  readVendored,
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
  it("stages a plain folder without git", async () => {
    putTemplate("tpl");
    const noGit = {
      ...io(),
      probe: {
        ...nodeProbe(),
        run: async () => ({ exitCode: 127, stdout: "", stderr: "" }),
      },
    };
    const result = await stage(dirSource("tpl"), {}, noGit);
    expect(result.files).toEqual(["agent/a.ts", "package.json"]);
    expect(result).not.toHaveProperty("commit");
    expect(result).not.toHaveProperty("dirty");
    rmSync(result.dir, { recursive: true, force: true });
  });

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

  it("refuses a link that points outside the template", async () => {
    putTemplate("tpl");
    put("shared/x.ts", "export {};\n");
    symlinkSync("../../shared/x.ts", join(root, "tpl/agent/x.ts"));
    const error = await stage(dirSource("tpl")).catch((e) => e);
    expect(error).toMatchObject({ code: "vendor-link-outside" });
    expect(error.message).toContain("agent/x.ts");
    expect(existsSync(stagingBase) ? readdirSync(stagingBase) : []).toEqual([]);
    rmSync(join(root, "tpl/agent/x.ts"));
    symlinkSync(join(root, "shared/x.ts"), join(root, "tpl/agent/x.ts"));
    await expect(stage(dirSource("tpl"))).rejects.toMatchObject({
      code: "vendor-link-outside",
    });
  });

  it("keeps a link that points inside the template", async () => {
    putTemplate("tpl");
    put("tpl/lib/x.ts", "export {};\n");
    symlinkSync("../lib/x.ts", join(root, "tpl/agent/x.ts"));
    const result = await stage(dirSource("tpl"));
    expect(result.files).toContain("agent/x.ts");
    expect(lstatSync(join(result.dir, "agent/x.ts")).isSymbolicLink()).toBe(
      true,
    );
  });

  it("ignores .DS_Store in the source and in the digest", async () => {
    putTemplate("tpl");
    put("tpl/.DS_Store", "junk");
    put("tpl/agent/.DS_Store", "junk");
    const result = await stage(dirSource("tpl"));
    expect(result.files).toEqual(["agent/a.ts", "package.json"]);
    put(`${basename(result.dir)}/.DS_Store`, "x");
    writeFileSync(join(result.dir, ".DS_Store"), "junk");
    expect(await vendorDigest(result.dir)).toBe(result.digest);
  });

  it("checks for an eve template before reading the folder", async () => {
    put("broad/notes.txt", "n");
    put("broad/secret/key", "k");
    // Walking this would throw EACCES, so the refusal must come first.
    chmodSync(join(root, "broad/secret"), 0o000);
    try {
      await expect(stage(dirSource("broad"))).rejects.toMatchObject({
        code: "vendor-not-eve-template",
      });
    } finally {
      chmodSync(join(root, "broad/secret"), 0o755);
    }
    expect(existsSync(stagingBase) ? readdirSync(stagingBase) : []).toEqual([]);
  });

  it("records a folder under the home folder as ~/", async () => {
    putTemplate("home/tpl");
    const withIo = io();
    const result = await stage(
      { kind: "dir", dir: join(home, "tpl"), given: join(home, "tpl") },
      {},
      withIo,
    );
    expect(result.source).toBe("~/tpl");
    putTemplate("elsewhere");
    const other = await stage(dirSource("elsewhere"));
    expect(other.source).toBe("elsewhere");
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

describe("donn agent vendor", () => {
  let s: Seeded;
  beforeEach(() => {
    s = seed();
  });
  afterEach(() => s.cleanup());

  const tpl = (name = "tpl") => join(s.root, name);
  const writeTpl = (dir: string, files: Record<string, string> = {}) => {
    const all = {
      "package.json": JSON.stringify({ dependencies: { eve: "1" } }),
      "agent/a.ts": "export {};\n",
      ...files,
    };
    for (const [path, text] of Object.entries(all)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  };
  const vendor = (args: string[], json = true) =>
    zz(["agent", "vendor", ...args, ...(json ? ["--json"] : [])], {
      cwd: s.repo,
      home: s.home,
      probe: nodeProbe(),
      now: () => Date.UTC(2026, 9, 28),
    });
  const templates = () => join(s.repo, ".donn/templates");
  const sources = () =>
    JSON.parse(readFileSync(join(templates(), "sources.json"), "utf8"));

  it("vendors and records a template", async () => {
    writeTpl(tpl());
    const r = await vendor([tpl()]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const out = AgentVendorOutput.parse(JSON.parse(r.stdout));
    expect(out.template).toMatchObject({
      name: "tpl",
      path: ".donn/templates/tpl",
    });
    expect(out.added).toEqual(["agent/a.ts", "package.json"]);
    expect(existsSync(join(templates(), "tpl/package.json"))).toBe(true);
    const file = sources();
    expect(file.version).toBe(1);
    expect(file.templates.tpl).toMatchObject({
      digest: out.template.digest,
      vendoredAt: "2026-10-28T00:00:00.000Z",
    });
    expect(readdirSync(templates()).sort()).toEqual(["sources.json", "tpl"]);
    const text = await vendor([tpl("tpl")], false);
    expect(text.stdout).toContain(
      "refreshed tpl: 0 added, 0 changed, 0 removed",
    );
    expect(text.stdout).toContain("only agents created from now on");
  });

  it("refreshes a recorded template and reports the changes", async () => {
    writeTpl(tpl(), { "old.txt": "o" });
    await vendor([tpl()]);
    rmSync(join(tpl(), "old.txt"));
    writeFileSync(join(tpl(), "agent/a.ts"), "export const x = 1;\n");
    writeFileSync(join(tpl(), "new.txt"), "n");
    const r = await vendor([tpl()]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({
      added: ["new.txt"],
      changed: ["agent/a.ts"],
      removed: ["old.txt"],
    });
    expect(existsSync(join(templates(), "tpl/old.txt"))).toBe(false);
    expect(readdirSync(templates()).sort()).toEqual(["sources.json", "tpl"]);
  });

  it("refuses to refresh an edited copy, and --force refreshes it", async () => {
    writeTpl(tpl());
    await vendor([tpl()]);
    const edited = join(templates(), "tpl/agent/a.ts");
    writeFileSync(edited, "// mine\n");
    const r = await vendor([tpl()]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error).toMatchObject({
      code: "vendor-local-edits",
      fix: "--force",
    });
    expect(readFileSync(edited, "utf8")).toBe("// mine\n");
    const forced = await vendor([tpl(), "--force"]);
    expect(forced.code, forced.stdout + forced.stderr).toBe(0);
    expect(JSON.parse(forced.stdout).changed).toEqual(["agent/a.ts"]);
    expect(readFileSync(edited, "utf8")).toBe("export {};\n");
  });

  it("never replaces a folder it did not vendor", async () => {
    writeTpl(tpl("x"));
    mkdirSync(join(templates(), "x"), { recursive: true });
    writeFileSync(join(templates(), "x/mine.txt"), "m");
    const r = await vendor([tpl("x")]);
    expect(JSON.parse(r.stdout).error.code).toBe("vendor-name-taken");
    expect(readdirSync(join(templates(), "x"))).toEqual(["mine.txt"]);
  });

  it("refuses a source inside the project's templates", async () => {
    writeTpl(join(templates(), "mine"));
    const r = await vendor([join(templates(), "mine"), "--name", "copy"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("vendor-source-inside");
  });

  it("leaves .donn/templates as it was when staging fails", async () => {
    mkdirSync(tpl(), { recursive: true });
    writeFileSync(join(tpl(), "package.json"), "{}");
    const r = await vendor([tpl()]);
    expect(JSON.parse(r.stdout).error.code).toBe("vendor-not-eve-template");
    expect(existsSync(templates())).toBe(false);
  });

  it("names an unreadable record file", async () => {
    mkdirSync(templates(), { recursive: true });
    writeFileSync(join(templates(), "sources.json"), "{nope");
    await expect(readVendored(join(s.repo, ".donn"))).rejects.toMatchObject({
      code: "invalid-vendor-record",
    });
    writeFileSync(join(templates(), "sources.json"), '{"version":2}');
    await expect(readVendored(join(s.repo, ".donn"))).rejects.toThrow(
      /sources\.json/,
    );
  });

  it("keeps the old copy and record when the record cannot be written", async () => {
    writeTpl(tpl());
    await vendor([tpl()]);
    const record = readFileSync(join(templates(), "sources.json"), "utf8");
    writeFileSync(join(tpl(), "agent/a.ts"), "export const x = 1;\n");
    const staged = await stageVendor(
      io(),
      { kind: "dir", dir: tpl(), given: "tpl" },
      {
        name: "tpl",
        stagingBase,
      },
    );
    await expect(
      commitVendor(join(s.repo, ".donn"), staged, {
        now: () => 0,
        rename: async () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow("disk full");
    rmSync(staged.dir, { recursive: true, force: true });
    expect(readFileSync(join(templates(), "tpl/agent/a.ts"), "utf8")).toBe(
      "export {};\n",
    );
    expect(readFileSync(join(templates(), "sources.json"), "utf8")).toBe(
      record,
    );
    expect(readdirSync(templates()).sort()).toEqual(["sources.json", "tpl"]);
    const again = await vendor([tpl()]);
    expect(again.code, again.stdout + again.stderr).toBe(0);
  });

  it("a .DS_Store in the vendored copy is not a local edit", async () => {
    writeTpl(tpl());
    await vendor([tpl()]);
    writeFileSync(join(templates(), "tpl/.DS_Store"), "junk");
    mkdirSync(join(templates(), "tpl/agent"), { recursive: true });
    writeFileSync(join(templates(), "tpl/agent/.DS_Store"), "junk");
    const r = await vendor([tpl()]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
  });

  it.each([["lib/\n"], [".donn/templates\n"], ["lib/\n*.log\n.donn/\n"]])(
    "the project's ignore rules (%j) do not make a refresh a local edit",
    async (ignore) => {
      git(s.repo, "init", "-q");
      writeFileSync(join(s.repo, ".gitignore"), ignore);
      writeTpl(tpl(), { "agent/lib/x.ts": "export {};\n", "run.log": "l" });
      expect((await vendor([tpl()])).code).toBe(0);
      const r = await vendor([tpl()]);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({
        added: [],
        changed: [],
        removed: [],
      });
    },
  );

  it("does not take Object.prototype names for recorded templates", async () => {
    writeTpl(tpl());
    const r = await vendor([tpl(), "--name", "constructor"], false);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("vendored constructor into");
    expect(r.stdout).not.toContain("refreshed");
    expect(Object.hasOwn(sources().templates, "constructor")).toBe(true);
  });

  it("re-points a recorded template to a different source", async () => {
    writeTpl(tpl("a/x"));
    writeTpl(tpl("b/x"), { "agent/b.ts": "export {};\n" });
    await vendor([tpl("a/x")]);
    const r = await vendor([tpl("b/x")]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(sources().templates.x.source).toBe(tpl("b/x"));
  });
});

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ManagedManifest, ManagedOs } from "@getdonn/adapter-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { ManagedEnv } from "./managed/env.js";
import { parsePlutilJson, parseRegQuery } from "./managed/env.js";
import { zz } from "./test/seed.js";

// donn managed install, uninstall and check against temp roots: every system path, the
// MDM reader and the remote-settings file come through the `managed` seam, so no test reads or
// writes a real system folder, needs root, or runs plutil or reg.
// See docs/planning/21-managed-settings.md, section 3.

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const ORG = `apiVersion: donn/v0
kind: Persona
metadata: { name: acme }
instructions:
  - id: conduct
    file: ./instructions/conduct.md
permissions:
  deny: ["Bash(rm -rf:*)"]
hooks:
  pre-tool-use:
    - id: guard
      run: ./hooks/guard.sh
locks:
  - permissions.deny
  - instructions[conduct]
  - hooks.pre-tool-use[guard]
`;

const SETTINGS = "managed-settings.d/50-donn.json";
const MANIFEST = "donn/manifest.json";

interface Machine {
  root: string;
  home: string;
  personas: string;
  cwd: string;
  /** The fake system folder. */
  system: string;
  remote: string;
}

function machine(org: string = ORG): Machine {
  const root = mkdtempSync(join(tmpdir(), "donn-managed-install-"));
  roots.push(root);
  const home = join(root, "home");
  const personas = join(root, "personas");
  const cwd = join(root, "cwd");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  put(join(home, "config.yaml"), `personas: ${personas}\n`);
  put(join(personas, "org/acme.yaml"), org);
  put(join(personas, "org/instructions/conduct.md"), "Review kindly.");
  put(join(personas, "org/hooks/guard.sh"), "#!/bin/sh\nexit 2\n");
  return {
    root,
    home,
    personas,
    cwd,
    system: join(root, "system", "ClaudeCode"),
    remote: join(root, "claude", "remote-settings.json"),
  };
}

function seam(
  m: Machine,
  extra: Partial<ManagedEnv> = {},
): Partial<ManagedEnv> {
  return {
    os: "linux",
    root: m.system,
    isAdmin: () => true,
    strict: () => false,
    mdmPolicy: async () => undefined,
    remoteSettingsFile: m.remote,
    confirm: async () => {
      throw new Error("confirm must not be called");
    },
    ...extra,
  };
}

const cli = (m: Machine, argv: string[], managed: Partial<ManagedEnv> = {}) =>
  zz(argv, {
    cwd: m.cwd,
    home: m.home,
    managed: { ...seam(m), ...managed },
  });

async function build(m: Machine, os: ManagedOs = "linux", out = "bundle") {
  const r = await zz(["managed", "build", "--os", os, "--out", out], {
    cwd: m.cwd,
    home: m.home,
  });
  expect(r.code, r.stderr).toBe(0);
  return join(m.cwd, out);
}

const read = (path: string) => readFileSync(path, "utf8");
const PENDING = "donn/pending.json";

/** Install `bundle`, stopping as a crash would between its first and second file. */
const crash = (m: Machine, bundle: string) => {
  let writes = 0;
  return expect(
    cli(m, ["managed", "install", bundle, "--yes"], {
      onWrite: (path) => {
        if (++writes === 2) throw new Error(`simulated crash before ${path}`);
      },
    }),
  ).rejects.toThrow("simulated crash");
};

/** lstat with every owner reported as root, except `others` (path → uid). */
function rootOwned(others: Record<string, number> = {}): Partial<ManagedEnv> {
  return {
    strict: () => true,
    inspect: async (path) => {
      let info;
      try {
        info = lstatSync(path);
      } catch {
        return undefined;
      }
      return {
        kind: info.isSymbolicLink()
          ? "symlink"
          : info.isDirectory()
            ? "dir"
            : info.isFile()
              ? "file"
              : "other",
        uid: others[path] ?? 0,
        mode: info.mode & 0o7777,
      };
    },
  };
}
const manifestOf = (dir: string) =>
  JSON.parse(read(join(dir, MANIFEST))) as ManagedManifest;
/** Every file under `dir`, `/`-separated and sorted. */
function tree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((p) => p.split("\\").join("/"))
    .filter((p) => statSync(join(dir, p)).isFile())
    .sort();
}
const mode = (path: string) => statSync(path).mode & 0o777;
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** Push every file's mtime into the past, so a rewrite shows. */
function age(dir: string) {
  const past = new Date("2020-01-01T00:00:00Z");
  for (const p of tree(dir)) utimesSync(join(dir, p), past, past);
}
const mtimes = (dir: string) =>
  Object.fromEntries(tree(dir).map((p) => [p, statSync(join(dir, p)).mtimeMs]));

async function check(m: Machine, managed: Partial<ManagedEnv> = {}) {
  const r = await cli(m, ["managed", "check", "--json"], managed);
  return {
    r,
    out: JSON.parse(r.stdout) as {
      state: string;
      findings: { state: string; detail: string }[];
    },
  };
}

describe("donn managed install", () => {
  it("writes every file with its mode, the manifest included", async () => {
    const m = machine();
    const bundle = await build(m);
    const r = await cli(m, ["managed", "install", bundle, "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    const listed = [...Object.keys(manifestOf(bundle).files), MANIFEST].sort();
    expect(tree(m.system)).toEqual(listed);
    for (const p of listed) {
      expect(read(join(m.system, p))).toBe(read(join(bundle, p)));
      expect(mode(join(m.system, p))).toBe(
        p.startsWith("donn/hooks/") ? 0o755 : 0o644,
      );
    }
    for (const dir of ["managed-settings.d", "donn", "donn/hooks"]) {
      expect(mode(join(m.system, dir))).toBe(0o755);
    }
    expect(r.stdout).toContain(`write    ${SETTINGS}`);
  });

  it("refuses a blocked parent folder before any write", async () => {
    const m = machine();
    const bundle = await build(m);
    put(join(m.system, "donn/hooks"), "in the way");
    const r = await cli(m, ["managed", "install", bundle, "--yes"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      `${join(m.system, "donn/hooks")} is not a folder`,
    );
    expect(tree(m.system)).toEqual(["donn/hooks"]);
  });

  it("an interrupted install leaves pending.json; a re-run with a newer bundle finishes", async () => {
    const m = machine();
    const first = await build(m, "linux", "first");
    await crash(m, first);
    // One file was written, the rest and the manifest never were; pending.json claims all of them.
    const written = tree(m.system).filter((p) => p !== PENDING);
    expect(written).toHaveLength(1);
    expect(Object.keys(manifestOf(first).files)).toContain(written[0]);
    expect(tree(m.system)).toContain(PENDING);
    const pending = JSON.parse(read(join(m.system, PENDING))) as {
      paths: string[];
    };
    expect(pending.paths).toEqual(
      [...Object.keys(manifestOf(first).files), MANIFEST].sort(),
    );
    // A different bundle now (its settings differ): pending.json owns what the crash left.
    put(
      join(m.personas, "org/acme.yaml"),
      ORG.replace("Bash(rm -rf:*)", "Bash(sudo:*)"),
    );
    const second = await build(m, "linux", "second");
    const r = await cli(m, ["managed", "install", second, "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(tree(m.system)).toEqual(
      [...Object.keys(manifestOf(second).files), MANIFEST].sort(),
    );
    expect(read(join(m.system, SETTINGS))).toBe(read(join(second, SETTINGS)));
    expect((await check(m)).out.state).toBe("current");
  });

  it("an interrupted install can be uninstalled", async () => {
    const m = machine();
    const bundle = await build(m);
    await crash(m, bundle);
    put(join(m.system, "managed-settings.d/90-org.json"), "{}\n");
    const r = await cli(m, ["managed", "uninstall", "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(tree(m.system)).toEqual(["managed-settings.d/90-org.json"]);
  });

  it("adopts a file of donn's that already holds the bundle's bytes", async () => {
    const m = machine();
    const bundle = await build(m);
    put(join(m.system, SETTINGS), read(join(bundle, SETTINGS)));
    age(m.system);
    const before = statSync(join(m.system, SETTINGS)).mtimeMs;
    const r = await cli(m, ["managed", "install", bundle, "--yes", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).written).not.toContain(SETTINGS);
    expect(statSync(join(m.system, SETTINGS)).mtimeMs).toBe(before);
    expect(manifestOf(m.system).files[SETTINGS]).toBeDefined();
  });

  it("removal errors say could not remove", async () => {
    const m = machine();
    const bundle = await build(m);
    expect((await cli(m, ["managed", "install", bundle, "--yes"])).code).toBe(
      0,
    );
    const hook = tree(join(m.system, "donn/hooks"))[0]!;
    rmSync(join(m.system, "donn/hooks", hook));
    put(join(m.system, "donn/hooks", hook, "inside"), "x");
    const r = await cli(m, ["managed", "uninstall", "--yes"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      `could not remove ${join(m.system, "donn/hooks", hook)}`,
    );
  });

  it("prints the plan and asks unless --yes", async () => {
    const m = machine();
    const bundle = await build(m);
    const asked: string[] = [];
    const no = await cli(m, ["managed", "install", bundle], {
      confirm: async (q) => (asked.push(q), false),
    });
    expect(no.code).toBe(1);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(m.system);
    expect(no.stdout).toContain(`install into ${m.system}:`);
    expect(no.stdout).toContain(`write    ${SETTINGS}`);
    expect(no.stderr).toContain("nothing installed");
    expect(tree(m.system)).toEqual([]);

    const noTerminal = await cli(m, ["managed", "install", bundle], {
      confirm: async () => undefined,
    });
    expect(noTerminal.code).toBe(1);
    expect(noTerminal.stderr).toContain("--yes");
    expect(tree(m.system)).toEqual([]);

    const yes = await cli(m, ["managed", "install", bundle], {
      confirm: async () => true,
    });
    expect(yes.code, yes.stderr).toBe(0);
    expect(existsSync(join(m.system, MANIFEST))).toBe(true);
  });

  it("plans again after the question: a file that appeared meanwhile is refused", async () => {
    const m = machine();
    const bundle = await build(m);
    const r = await cli(m, ["managed", "install", bundle], {
      confirm: async () => {
        put(join(m.system, SETTINGS), "{}\n");
        return true;
      },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(join(m.system, SETTINGS));
    expect(tree(m.system)).toEqual([SETTINGS]);
    expect(read(join(m.system, SETTINGS))).toBe("{}\n");
  });

  it("a second identical install writes nothing", async () => {
    const m = machine();
    const bundle = await build(m);
    expect((await cli(m, ["managed", "install", bundle, "--yes"])).code).toBe(
      0,
    );
    age(m.system);
    const before = mtimes(m.system);
    // Nothing to change: no question either (confirm throws if called).
    const again = await cli(m, ["managed", "install", bundle]);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain("nothing to change");
    expect(mtimes(m.system)).toEqual(before);
    const json = await cli(m, ["managed", "install", bundle, "--json"]);
    expect(JSON.parse(json.stdout)).toEqual({
      root: m.system,
      written: [],
      replaced: [],
      removed: [],
      replaces: [],
      check: { state: "current", findings: [] },
    });
    const { r, out } = await check(m);
    expect(out.state).toBe("current");
    expect(r.code).toBe(0);
  });

  it("replacing a bundle removes only files the old manifest owned", async () => {
    const m = machine();
    const first = await build(m, "linux", "first");
    expect((await cli(m, ["managed", "install", first, "--yes"])).code).toBe(0);
    const hook = Object.keys(manifestOf(first).files).find((p) =>
      p.startsWith("donn/hooks/"),
    )!;
    // Someone else's file in our folder, and org files beside ours.
    put(join(m.system, "donn/hooks/org-audit.sh"), "#!/bin/sh\n");
    put(join(m.system, "managed-settings.d/10-org.json"), "{}\n");
    // The next bundle no longer locks the hook.
    put(
      join(m.personas, "org/acme.yaml"),
      ORG.replace("  - hooks.pre-tool-use[guard]\n", ""),
    );
    const second = await build(m, "linux", "second");
    const r = await cli(m, ["managed", "install", second, "--json", "--yes"]);
    expect(r.code, r.stdout).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      root: m.system,
      written: [],
      replaced: [SETTINGS, MANIFEST],
      removed: [hook],
      replaces: [],
      check: { state: "current", findings: [] },
    });
    expect(tree(m.system)).toEqual([
      "donn/hooks/org-audit.sh",
      MANIFEST,
      "managed-settings.d/10-org.json",
      SETTINGS,
    ]);
    expect(read(join(m.system, SETTINGS))).toBe(read(join(second, SETTINGS)));
  });

  it("never touches managed-settings.json or other drop-ins", async () => {
    const m = machine();
    const org = {
      "managed-settings.json": '{ "model": "x" }\n',
      "managed-settings.d/10-org.json": '{ "a": 1 }\n',
      "managed-settings.d/90-org.json": '{ "b": 2 }\n',
    };
    for (const [p, text] of Object.entries(org)) put(join(m.system, p), text);
    age(m.system);
    const before = mtimes(m.system);
    const bundle = await build(m);
    expect((await cli(m, ["managed", "install", bundle, "--yes"])).code).toBe(
      0,
    );
    expect((await cli(m, ["managed", "uninstall", "--yes"])).code).toBe(0);
    expect(tree(m.system)).toEqual(Object.keys(org).sort());
    for (const [p, text] of Object.entries(org)) {
      expect(read(join(m.system, p))).toBe(text);
    }
    expect(mtimes(m.system)).toEqual(before);
  });

  it("refuses when an org-owned managed-mcp.json exists", async () => {
    const m = machine(`${ORG}policy:\n  mcp: exclusive\n`);
    const bundle = await build(m);
    expect(Object.keys(manifestOf(bundle).files)).toContain("managed-mcp.json");
    put(join(m.system, "managed-mcp.json"), '{ "mcpServers": {} }\n');
    const r = await cli(m, ["managed", "install", bundle, "--yes"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(join(m.system, "managed-mcp.json"));
    expect(tree(m.system)).toEqual(["managed-mcp.json"]);
  });

  it("refuses a 50-donn.json it did not install", async () => {
    const m = machine();
    const bundle = await build(m);
    put(join(m.system, SETTINGS), "{}\n");
    const r = await cli(m, ["managed", "install", bundle, "--yes"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(join(m.system, SETTINGS));
    expect(tree(m.system)).toEqual([SETTINGS]);
    expect(read(join(m.system, SETTINGS))).toBe("{}\n");
  });

  it("install refuses a bundle for another OS", async () => {
    const m = machine();
    const bundle = await build(m, "windows");
    const r = await cli(m, ["managed", "install", bundle, "--yes"], {
      os: "macos",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("windows");
    expect(r.stderr).toContain("macos");
    expect(existsSync(m.system)).toBe(false);
  });

  it("refuses a bundle whose hashes do not match", async () => {
    const m = machine();
    const bundle = await build(m);
    writeFileSync(join(bundle, SETTINGS), "{}\n");
    const r = await cli(m, ["managed", "install", bundle, "--yes"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(SETTINGS);
    expect(existsSync(m.system)).toBe(false);
  });

  it("installs only the files the manifest lists", async () => {
    const m = machine();
    const bundle = await build(m);
    put(join(bundle, "managed-settings.d/99-extra.json"), "{}\n");
    put(join(bundle, "managed-settings.json"), "{}\n");
    expect((await cli(m, ["managed", "install", bundle, "--yes"])).code).toBe(
      0,
    );
    expect(tree(m.system)).toEqual(
      [...Object.keys(manifestOf(bundle).files), MANIFEST].sort(),
    );
  });

  it("refuses a manifest that lists a file outside donn's own", async () => {
    const m = machine();
    const bundle = await build(m);
    const text = '{ "model": "x" }\n';
    put(join(bundle, "managed-settings.json"), text);
    const manifest = manifestOf(bundle);
    manifest.files["managed-settings.json"] = sha256(text);
    writeFileSync(join(bundle, MANIFEST), JSON.stringify(manifest));
    const r = await cli(m, ["managed", "install", bundle, "--yes"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("managed-settings.json");
    expect(existsSync(m.system)).toBe(false);
  });

  it("without administrator rights prints the exact command, exit 1", async () => {
    const m = machine();
    const bundle = await build(m);
    const notAdmin = { isAdmin: () => false };
    const r = await cli(m, ["managed", "install", "bundle", "--yes"], notAdmin);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      "error: managed install needs administrator rights; run: sudo donn managed install bundle\n",
    );
    const win = await cli(m, ["managed", "install", bundle, "--yes"], {
      ...notAdmin,
      os: "windows",
    });
    expect(win.code).toBe(1);
    expect(win.stderr).toContain(
      "managed install needs administrator rights; run it in an elevated PowerShell: donn managed install",
    );
    const un = await cli(m, ["managed", "uninstall", "--yes"], notAdmin);
    expect(un.code).toBe(1);
    expect(un.stderr).toBe(
      "error: managed uninstall needs administrator rights; run: sudo donn managed uninstall\n",
    );
    expect(existsSync(m.system)).toBe(false);
  });

  it("a newer manifest format stops check and install", async () => {
    const m = machine();
    const bundle = await build(m);
    const newer = `${JSON.stringify({ format: 2, donn: "9.0.0", files: {} })}\n`;
    put(join(m.system, MANIFEST), newer);
    age(m.system);
    const before = mtimes(m.system);
    const message = "installed by a newer donn (9.0.0); upgrade donn";
    for (const argv of [
      ["managed", "install", bundle, "--yes"],
      ["managed", "uninstall", "--yes"],
      ["managed", "check"],
    ]) {
      const r = await cli(m, argv);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.stderr).toContain(message);
    }
    expect(mtimes(m.system)).toEqual(before);
    expect(read(join(m.system, MANIFEST))).toBe(newer);
  });
});

describe("install: earlier values and the follow-up check", () => {
  it("lists the earlier single values our drop-in replaces, and installs anyway", async () => {
    const m = machine();
    const bundle = await build(m);
    put(
      join(m.system, "managed-settings.json"),
      JSON.stringify({ claudeMd: "org text", model: "opus" }),
    );
    put(
      join(m.system, "managed-settings.d/10-org.json"),
      JSON.stringify({
        claudeMd: "earlier",
        permissions: { deny: ["Read(.env)"] },
      }),
    );
    put(
      join(m.system, "managed-settings.d/90-org.json"),
      JSON.stringify({ deniedModels: [] }),
    );
    const r = await cli(m, ["managed", "install", bundle, "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      "  replaces claudeMd from managed-settings.json\n",
    );
    expect(r.stdout).toContain(
      "  replaces claudeMd from managed-settings.d/10-org.json\n",
    );
    expect(r.stdout).not.toContain("replaces permissions");
    expect(r.stdout).not.toContain("from managed-settings.d/90-org.json");
    const again = await cli(m, ["managed", "install", bundle, "--json"]);
    expect(JSON.parse(again.stdout).replaces).toEqual([
      { key: "claudeMd", file: "managed-settings.json" },
      { key: "claudeMd", file: "managed-settings.d/10-org.json" },
    ]);
  });

  it("says when the installed policy is not current, and still exits 0", async () => {
    const m = machine();
    const bundle = await build(m);
    put(
      join(m.system, "managed-settings.d/90-org.json"),
      JSON.stringify({ claudeMd: "theirs" }),
    );
    const r = await cli(m, ["managed", "install", bundle, "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      "managed: overridden\noverridden: managed-settings.d/90-org.json replaces claudeMd\n",
    );
    const json = await cli(m, ["managed", "install", bundle, "--json"], {
      remoteSettingsFile: m.remote,
    });
    expect(JSON.parse(json.stdout).check.state).toBe("overridden");

    const ignored = machine();
    put(ignored.remote, JSON.stringify({ permissions: { deny: ["Read"] } }));
    const i = await cli(ignored, [
      "managed",
      "install",
      await build(ignored),
      "--yes",
    ]);
    expect(i.code, i.stderr).toBe(0);
    expect(i.stdout).toContain("managed: ignored\nignored: ");
    expect(i.stdout).toContain(ignored.remote);
  });

  it("prints nothing more when the installed policy is current", async () => {
    const m = machine();
    const r = await cli(m, ["managed", "install", await build(m), "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).not.toContain("managed:");
  });
});

describe("unsafe policy folders", () => {
  async function installed() {
    const m = machine();
    const bundle = await build(m);
    const r = await cli(m, ["managed", "install", bundle, "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    return { m, bundle };
  }

  it("passes when every folder is root's and not group or other writable", async () => {
    const { m, bundle } = await installed();
    for (const dir of ["", "managed-settings.d", "donn", "donn/hooks"])
      chmodSync(join(m.system, dir), 0o755);
    const r = await cli(
      m,
      ["managed", "install", bundle, "--yes"],
      rootOwned(),
    );
    expect(r.code, r.stderr).toBe(0);
  });

  it("refuses a symlinked donn/hooks, for install and uninstall", async () => {
    const { m, bundle } = await installed();
    const elsewhere = join(m.root, "elsewhere");
    put(join(elsewhere, "keep.sh"), "#!/bin/sh\n");
    rmSync(join(m.system, "donn/hooks"), { recursive: true });
    symlinkSync(elsewhere, join(m.system, "donn/hooks"));
    const path = join(m.system, "donn/hooks");
    for (const argv of [
      ["managed", "install", bundle, "--yes"],
      ["managed", "uninstall", "--yes"],
    ]) {
      const r = await cli(m, argv, rootOwned());
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.stderr).toContain(`${path} is a symbolic link`);
      // Not root either: a symlinked folder is never written through.
      const plain = await cli(m, argv);
      expect(plain.code, argv.join(" ")).toBe(1);
    }
    expect(tree(elsewhere)).toEqual(["keep.sh"]);
    expect(existsSync(join(m.system, MANIFEST))).toBe(true);
  });

  it("refuses a folder not owned by root", async () => {
    const { m, bundle } = await installed();
    const path = join(m.system, "donn");
    const r = await cli(
      m,
      ["managed", "install", bundle, "--yes"],
      rootOwned({ [path]: 501 }),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${path} is owned by uid 501, not root`);
  });

  it("refuses a group-writable folder, and a manifest that is", async () => {
    const { m } = await installed();
    for (const dir of ["", "donn", "donn/hooks"])
      chmodSync(join(m.system, dir), 0o755);
    chmodSync(join(m.system, "managed-settings.d"), 0o775);
    const r = await cli(m, ["managed", "uninstall", "--yes"], rootOwned());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      `${join(m.system, "managed-settings.d")} is writable by group or others`,
    );
    chmodSync(join(m.system, "managed-settings.d"), 0o755);
    chmodSync(join(m.system, MANIFEST), 0o666);
    const again = await cli(m, ["managed", "uninstall", "--yes"], rootOwned());
    expect(again.code).toBe(1);
    expect(again.stderr).toContain(join(m.system, MANIFEST));
    expect(existsSync(join(m.system, SETTINGS))).toBe(true);
  });
});

describe("donn managed uninstall", () => {
  it("removes exactly the manifest's files and the manifest", async () => {
    const m = machine();
    const bundle = await build(m);
    put(join(m.system, "managed-mcp.json"), "{}\n");
    put(join(m.system, "managed-settings.d/90-org.json"), "{}\n");
    expect((await cli(m, ["managed", "install", bundle, "--yes"])).code).toBe(
      0,
    );
    const r = await cli(m, ["managed", "uninstall", "--yes", "--json"]);
    expect(r.code, r.stdout).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      root: m.system,
      removed: [...Object.keys(manifestOf(bundle).files), MANIFEST],
    });
    expect(tree(m.system)).toEqual([
      "managed-mcp.json",
      "managed-settings.d/90-org.json",
    ]);
    // Our own folders go when empty; managed-settings.d is shared and stays.
    expect(existsSync(join(m.system, "donn"))).toBe(false);
    expect(existsSync(join(m.system, "managed-settings.d"))).toBe(true);
  });

  it("removes the folders it emptied, the root included", async () => {
    const m = machine();
    const bundle = await build(m);
    expect(existsSync(m.system)).toBe(false);
    expect((await cli(m, ["managed", "install", bundle, "--yes"])).code).toBe(
      0,
    );
    expect((await cli(m, ["managed", "uninstall", "--yes"])).code).toBe(0);
    expect(existsSync(m.system)).toBe(false);
    expect(existsSync(dirname(m.system))).toBe(true);
  });

  it("asks unless --yes, and says when nothing is installed", async () => {
    const m = machine();
    const bundle = await build(m);
    const none = await cli(m, ["managed", "uninstall"]);
    expect(none.code).toBe(0);
    expect(none.stdout).toContain("nothing installed");
    expect((await cli(m, ["managed", "install", bundle, "--yes"])).code).toBe(
      0,
    );
    const no = await cli(m, ["managed", "uninstall"], {
      confirm: async () => false,
    });
    expect(no.code).toBe(1);
    expect(no.stdout).toContain(`remove   ${SETTINGS}`);
    expect(existsSync(join(m.system, MANIFEST))).toBe(true);
  });
});

describe("donn managed check", () => {
  async function installed(org: string = ORG) {
    const m = machine(org);
    const bundle = await build(m);
    const r = await cli(m, ["managed", "install", bundle, "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    return m;
  }

  it("current", async () => {
    const m = await installed();
    const { r, out } = await check(m);
    expect(out).toEqual({ state: "current", findings: [] });
    expect(r.code).toBe(0);
    const text = await cli(m, ["managed", "check"]);
    expect(text.stdout).toBe(`managed: current (${m.system})\n`);
  });

  it("missing", async () => {
    const m = machine();
    const { r, out } = await check(m);
    expect(out.state).toBe("missing");
    expect(out.findings).toEqual([
      { state: "missing", detail: `nothing installed in ${m.system}` },
    ]);
    expect(r.code).toBe(1);
  });

  it("stale: the layer changed since the bundle was built", async () => {
    const m = await installed();
    put(
      join(m.personas, "org/acme.yaml"),
      ORG.replace("Bash(rm -rf:*)", "Bash(sudo:*)"),
    );
    const { r, out } = await check(m);
    expect(out.state).toBe("stale");
    expect(out.findings[0]!.detail).toContain("org/acme");
    expect(out.findings[0]!.detail).toContain(SETTINGS);
    expect(r.code).toBe(1);
  });

  it("a layer that is not in the store skips the freshness comparison", async () => {
    const m = await installed();
    rmSync(join(m.personas, "org/acme.yaml"));
    const { r, out } = await check(m);
    expect(out).toEqual({
      state: "current",
      findings: [
        {
          state: "current",
          detail: "cannot check for newer layers: org/acme is not in the store",
        },
      ],
    });
    expect(r.code).toBe(0);
  });

  it("stale: a layer that no longer compiles, or is refused, says why", async () => {
    const m = await installed();
    rmSync(join(m.personas, "org/hooks/guard.sh"));
    const missing = await check(m);
    expect(missing.out.state).toBe("stale");
    expect(missing.out.findings[0]!.detail).toContain(
      "cannot compile org/acme",
    );
    expect(missing.r.code).toBe(1);
    put(join(m.personas, "org/hooks/guard.sh"), "#!/bin/sh\nexit 2\n");
    put(
      join(m.personas, "org/acme.yaml"),
      `${ORG}targets:\n  claude-code:\n    managed:\n      notARealKey: 1\n`,
    );
    const refused = await check(m);
    expect(refused.out.state).toBe("stale");
    expect(refused.out.findings[0]!.detail).toContain(
      "org/acme no longer compiles",
    );
    expect(refused.out.findings[0]!.detail).toContain("notARealKey");
  });

  it("edited while an install is pending", async () => {
    const m = machine();
    const bundle = await build(m);
    await crash(m, bundle);
    const { r, out } = await check(m);
    expect(out.state).toBe("edited");
    expect(out.findings).toContainEqual({
      state: "edited",
      detail:
        "an interrupted install; re-run donn managed install or uninstall",
    });
    expect(r.code).toBe(1);
  });

  it("ignored: an MDM profile that is present but unreadable wins", async () => {
    const m = await installed();
    const { out } = await check(m, {
      mdmPolicy: async () => {
        throw new Error("plutil: malformed");
      },
    });
    expect(out.state).toBe("ignored");
    expect(out.findings[0]!.detail).toContain(
      "MDM profile present but unreadable",
    );
  });

  it("edited: a byte changed, or a file is gone", async () => {
    const m = await installed();
    const path = join(m.system, SETTINGS);
    writeFileSync(path, read(path).replace("rm -rf", "rm -rF"));
    const { out } = await check(m);
    expect(out.state).toBe("edited");
    expect(out.findings).toContainEqual({
      state: "edited",
      detail: `${SETTINGS} was changed since it was installed`,
    });
    rmSync(path);
    expect((await check(m)).out.findings).toContainEqual({
      state: "edited",
      detail: `${SETTINGS} is missing`,
    });
  });

  it("ignored: an MDM policy without managedSourcesBehavior merge", async () => {
    const m = await installed();
    const mdm = (policy: Record<string, unknown> | undefined) => ({
      mdmPolicy: async () => policy,
    });
    const ignored = await check(m, mdm({ model: "x" }));
    expect(ignored.out.state).toBe("ignored");
    expect(ignored.out.findings[0]!.detail).toContain("MDM");
    expect(ignored.r.code).toBe(1);
    const merged = await check(
      m,
      mdm({ model: "x", managedSourcesBehavior: "merge" }),
    );
    expect(merged.out.state).toBe("current");
    // Only control keys: the profile delivers no policy, so it is not a source.
    const control = await check(
      m,
      mdm({ managedSourcesBehavior: "first-wins" }),
    );
    expect(control.out.state).toBe("current");
  });

  it("ignored: a remote-settings file likewise; the highest source decides", async () => {
    const m = await installed();
    put(m.remote, JSON.stringify({ permissions: { deny: ["Read(.env)"] } }));
    const ignored = await check(m);
    expect(ignored.out.state).toBe("ignored");
    expect(ignored.out.findings[0]!.detail).toContain(m.remote);
    put(
      m.remote,
      JSON.stringify({ model: "x", managedSourcesBehavior: "merge" }),
    );
    expect((await check(m)).out.state).toBe("current");
    // Merge in the remote source applies every source, even an MDM profile that says nothing.
    expect(
      (await check(m, { mdmPolicy: async () => ({ model: "y" }) })).out.state,
    ).toBe("current");
  });

  it("overridden: a later drop-in replaces one of our single values", async () => {
    const m = await installed();
    put(
      join(m.system, "managed-settings.d/10-org.json"),
      JSON.stringify({ claudeMd: "earlier: ours wins" }),
    );
    expect((await check(m)).out.state).toBe("current");
    put(
      join(m.system, "managed-settings.d/90-org.json"),
      JSON.stringify({
        claudeMd: "theirs",
        permissions: { deny: ["Read(.env)"] },
      }),
    );
    const { out } = await check(m);
    expect(out.state).toBe("overridden");
    expect(out.findings).toEqual([
      {
        state: "overridden",
        detail: "managed-settings.d/90-org.json replaces claudeMd",
      },
      {
        state: "current",
        detail: `${SETTINGS} replaces claudeMd from managed-settings.d/10-org.json`,
      },
    ]);
  });

  it("several at once: the most severe is the state, all are listed", async () => {
    const m = await installed();
    put(
      join(m.system, "managed-settings.d/90-org.json"),
      JSON.stringify({ claudeMd: "theirs" }),
    );
    const hook = tree(join(m.system, "donn/hooks"))[0]!;
    writeFileSync(join(m.system, "donn/hooks", hook), "#!/bin/sh\n");
    const { out } = await check(m, {
      mdmPolicy: async () => ({ model: "y" }),
    });
    expect(out.state).toBe("ignored");
    expect(out.findings.map((f) => f.state)).toEqual([
      "ignored",
      "edited",
      "overridden",
    ]);
  });

  it("notes each earlier value our drop-in replaces; the state stays current", async () => {
    const m = await installed();
    put(
      join(m.system, "managed-settings.json"),
      JSON.stringify({ claudeMd: "org text", model: "opus" }),
    );
    const { r, out } = await check(m);
    expect(out).toEqual({
      state: "current",
      findings: [
        {
          state: "current",
          detail: `${SETTINGS} replaces claudeMd from managed-settings.json`,
        },
      ],
    });
    expect(r.code).toBe(0);
  });

  it("with a registry configured, says the comparison used the pulled layers", async () => {
    const m = await installed();
    put(
      join(m.home, "config.yaml"),
      `personas: ${m.personas}\nregistry:\n  url: http://127.0.0.1:9\n`,
    );
    const note =
      "compared with the layers pulled locally; run donn pull for the latest";
    const current = await check(m);
    expect(current.out).toEqual({
      state: "current",
      findings: [{ state: "current", detail: note }],
    });
    put(
      join(m.personas, "org/acme.yaml"),
      ORG.replace("Bash(rm -rf:*)", "Bash(sudo:*)"),
    );
    const stale = await check(m);
    expect(stale.out.state).toBe("stale");
    expect(stale.out.findings[0]!.detail).toContain(`; ${note}`);
  });

  it("prints notes when current, too", async () => {
    const m = await installed();
    rmSync(join(m.personas, "org/acme.yaml"));
    const r = await cli(m, ["managed", "check"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      `managed: current (${m.system})\nnote: cannot check for newer layers: org/acme is not in the store\n`,
    );
  });

  describe("remote-settings.json counts only recognised settings", () => {
    const remote = async (body: unknown) => {
      const m = await installed();
      put(m.remote, JSON.stringify(body));
      return (await check(m)).out.state;
    };

    it("a top-level settings object", async () => {
      expect(await remote({ permissions: { deny: ["Read"] } })).toBe("ignored");
      expect(await remote({ somethingNew: 1, fetchedAt: "x" })).toBe("current");
    });

    it("a settings wrapper", async () => {
      expect(
        await remote({
          checksum: "abc",
          settings: { permissions: { deny: ["Read"] } },
        }),
      ).toBe("ignored");
      expect(
        await remote({
          checksum: "abc",
          settings: { model: "x", managedSourcesBehavior: "merge" },
        }),
      ).toBe("current");
    });

    it("a wrapper with metadata only is not a policy", async () => {
      expect(await remote({ checksum: "abc", settings: {} })).toBe("current");
      expect(await remote({ checksum: "abc" })).toBe("current");
    });
  });

  it("prints one line per finding", async () => {
    const m = await installed();
    rmSync(join(m.system, SETTINGS));
    const r = await cli(m, ["managed", "check"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe(`managed: edited\nedited: ${SETTINGS} is missing\n`);
  });
});

describe("MDM readers", () => {
  it("parses plutil's JSON", () => {
    expect(parsePlutilJson('{"model":"x"}\n')).toEqual({ model: "x" });
    expect(parsePlutilJson("[]")).toBeUndefined();
    expect(parsePlutilJson("not json")).toBeUndefined();
  });

  it("parses reg query output", () => {
    const out =
      '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\ClaudeCode\r\n    Settings    REG_SZ    {"model": "x", "permissions": {"deny": ["Bash(a b)"]}}\r\n\r\n';
    expect(parseRegQuery(out)).toEqual({
      model: "x",
      permissions: { deny: ["Bash(a b)"] },
    });
    expect(
      parseRegQuery(
        '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\ClaudeCode\r\n    Settings    REG_EXPAND_SZ    {"a":1}\r\n',
      ),
    ).toEqual({ a: 1 });
    expect(parseRegQuery("")).toBeUndefined();
    expect(
      parseRegQuery("    Settings    REG_DWORD    0x1\r\n"),
    ).toBeUndefined();
  });
});

describe("doctor and status", () => {
  const doctorManaged = async (
    m: Machine,
    managed: Partial<ManagedEnv> = {},
  ) => {
    const r = await cli(m, ["doctor", "--json"], managed);
    const checks = JSON.parse(r.stdout).checks as {
      id: string;
      status: string;
      message: string;
      fix?: string;
    }[];
    return checks.find((c) => c.id === "managed")!;
  };

  it("doctor: skipped when nothing is installed, ok when current, warn otherwise", async () => {
    const m = machine();
    expect((await doctorManaged(m)).status).toBe("skipped");
    const bundle = await build(m);
    expect((await cli(m, ["managed", "install", bundle, "--yes"])).code).toBe(
      0,
    );
    expect(await doctorManaged(m)).toMatchObject({ status: "ok" });
    rmSync(join(m.system, SETTINGS));
    const warn = await doctorManaged(m);
    expect(warn.status).toBe("warn");
    expect(warn.message).toContain(`${SETTINGS} is missing`);
    expect(warn.fix).toContain("donn managed install");
  });

  it("doctor: an unreadable installed manifest names the file to remove", async () => {
    const m = machine();
    put(join(m.system, MANIFEST), "not json");
    const c = await doctorManaged(m);
    expect(c.status).toBe("warn");
    expect(c.fix).toContain(`remove ${join(m.system, MANIFEST)} by hand`);
  });

  it("doctor: warns while an install is pending", async () => {
    const m = machine();
    await crash(m, await build(m));
    const c = await doctorManaged(m);
    expect(c.status).toBe("warn");
    expect(c.message).toContain("an interrupted install");
  });

  it("doctor: a newer manifest format is a warning", async () => {
    const m = machine();
    put(
      join(m.system, MANIFEST),
      JSON.stringify({ format: 2, donn: "9.0.0", files: {} }),
    );
    const c = await doctorManaged(m);
    expect(c.status).toBe("warn");
    expect(c.message).toContain("installed by a newer donn (9.0.0)");
  });

  it("status: a managed line when something is installed", async () => {
    const m = machine();
    const none = await cli(m, ["status"]);
    expect(none.stdout).not.toContain("managed:");
    expect(
      JSON.parse((await cli(m, ["status", "--json"])).stdout).managed,
    ).toEqual({
      state: "missing",
      findings: [
        { state: "missing", detail: `nothing installed in ${m.system}` },
      ],
    });
    const bundle = await build(m);
    expect((await cli(m, ["managed", "install", bundle, "--yes"])).code).toBe(
      0,
    );
    expect((await cli(m, ["status"])).stdout).toContain("\nmanaged: current\n");
    rmSync(join(m.system, SETTINGS));
    expect((await cli(m, ["status"])).stdout).toContain(
      `\nmanaged: edited (${SETTINGS} is missing)\n`,
    );
  });
});

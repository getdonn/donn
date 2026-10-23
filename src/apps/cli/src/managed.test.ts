import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ManagedManifest } from "@zzpersona/adapter-sdk";
import { bundleDigest } from "@zzpersona/registry-api";
import { startMockRegistry } from "@zzpersona/registry-api/mock";
import { bundleLayer } from "@zzpersona/store-remote";
import { createLocalStore } from "@zzpersona/store-local";
import { afterEach, describe, expect, it } from "vitest";
import { cliVersion } from "./commands/daemon.js";
import { readBundle, writeBundle } from "./managed/bundle-io.js";
import { zz } from "./test/seed.js";

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const ORG = `apiVersion: zzpersona/v0
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
const AREA = `apiVersion: zzpersona/v0
kind: Persona
metadata: { name: fintech }
extends: [org/acme]
permissions:
  ask: ["Bash(git push:*)"]
locks:
  - permissions.ask
`;
const TEAM = `apiVersion: zzpersona/v0
kind: Persona
metadata: { name: payments }
extends: [area/fintech]
permissions:
  allow: ["Bash(pnpm test)"]
locks:
  - permissions.allow
`;

interface Machine {
  root: string;
  home: string;
  personas: string;
  cwd: string;
}

function machine(extra: Record<string, string> = {}, registry?: string) {
  const root = mkdtempSync(join(tmpdir(), "zzp-managed-"));
  roots.push(root);
  const home = join(root, "home");
  const personas = join(root, "personas");
  const cwd = join(root, "cwd");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  put(
    join(home, "config.yaml"),
    `personas: ${personas}\n${registry ? `registry:\n  url: ${registry}\n` : ""}`,
  );
  const files: Record<string, string> = {
    "org/acme.yaml": ORG,
    "org/instructions/conduct.md": "Review kindly.",
    "org/hooks/guard.sh": "#!/bin/sh\nexit 2\n",
    "area/fintech.yaml": AREA,
    "team/payments.yaml": TEAM,
    ...extra,
  };
  for (const [path, text] of Object.entries(files)) {
    if (text !== "") put(join(personas, path), text);
  }
  const m: Machine = { root, home, personas, cwd };
  return m;
}

const run = (m: Machine, argv: string[], env: NodeJS.ProcessEnv = {}) =>
  zz(["managed", "build", ...argv], { cwd: m.cwd, home: m.home, env });

const manifestOf = (dir: string) =>
  JSON.parse(
    readFileSync(join(dir, "zzpersona/manifest.json"), "utf8"),
  ) as ManagedManifest;
const settingsOf = (dir: string) =>
  JSON.parse(
    readFileSync(join(dir, "managed-settings.d/50-zzpersona.json"), "utf8"),
  ) as Record<string, any>;

describe("zzpersona managed build", () => {
  it("builds the org layer by default", async () => {
    const m = machine();
    const r = await run(m, ["--os", "linux"]);
    expect(r.code).toBe(0);
    const out = join(m.cwd, "zzpersona-managed");
    expect(r.stdout).toContain(`bundle: ${out}`);
    const manifest = manifestOf(out);
    expect(manifest.layers.map((l) => l.ref)).toEqual(["org/acme"]);
    expect(manifest.zzpersona).toBe(cliVersion());
    expect(manifest.os).toBe("linux");
    expect(settingsOf(out).permissions.deny).toEqual(["Bash(rm -rf:*)"]);
    expect(readdirSync(join(out, "zzpersona/hooks"))).toHaveLength(1);
    // Only the org's locks: nothing from the area or the team.
    expect(settingsOf(out).permissions.ask).toBeUndefined();
  });

  it("needs --layer when there are several org layers", async () => {
    const m = machine({ "org/other.yaml": ORG.replace("acme", "other") });
    const r = await run(m, []);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("org/acme");
    expect(r.stderr).toContain("org/other");
    expect(r.stderr).toContain("--layer");
    expect((await run(m, ["--layer", "org/other"])).code).toBe(0);
  });

  it("rejects a layer that is not org, area or team", async () => {
    const m = machine();
    const r = await run(m, ["--layer", "project/x"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("project/x");
  });

  it("builds a team chain", async () => {
    const m = machine();
    const r = await run(m, [
      "--layer",
      "team/payments",
      "--os",
      "macos",
      "--out",
      "b",
    ]);
    expect(r.code).toBe(0);
    const out = join(m.cwd, "b");
    const manifest = manifestOf(out);
    expect(manifest.layers.map((l) => l.ref)).toEqual([
      "org/acme",
      "area/fintech",
      "team/payments",
    ]);
    const settings = settingsOf(out);
    expect(settings.permissions.deny).toEqual(["Bash(rm -rf:*)"]);
    expect(settings.permissions.ask).toEqual(["Bash(git push:*)"]);
    expect(settings.permissions.allow).toEqual(["Bash(pnpm test)"]);
  });

  it("nothing locked builds an empty policy", async () => {
    const m = machine({
      "org/acme.yaml": `apiVersion: zzpersona/v0
kind: Persona
metadata: { name: acme }
permissions:
  deny: ["Bash(rm -rf:*)"]
`,
    });
    const r = await run(m, []);
    expect(r.code).toBe(0);
    const out = join(m.cwd, "zzpersona-managed");
    expect(settingsOf(out)).toEqual({});
    expect(existsSync(join(out, "managed-mcp.json"))).toBe(false);
    const notice =
      "nothing in org/acme and its ancestors is locked; the bundle enforces nothing";
    expect(r.stdout).toContain(`${notice}\n`);
    const json = JSON.parse((await run(m, ["--json"])).stdout);
    expect(json.notice).toBe(notice);
  });

  it("prints no empty-policy notice when something is enforced", async () => {
    const m = machine();
    const r = await run(m, ["--json"]);
    expect(JSON.parse(r.stdout).notice).toBeUndefined();
    expect((await run(m, [])).stdout).not.toContain("enforces nothing");
  });

  it("refusals exit 1 and name the layer and path", async () => {
    const m = machine({
      "team/payments.yaml": `${TEAM}targets:
  claude-code:
    managed:
      notARealKey: true
`,
    });
    const r = await run(m, ["--layer", "team/payments"]);
    expect(r.code).toBe(1);
    const line = r.stderr.split("\n").find((l) => l.startsWith("refused:"))!;
    expect(line).toMatch(
      /^refused: targets\.claude-code\.managed\.notARealKey \(team\/payments\) managed-unknown-key: .+$/,
    );
    expect(line).toContain("notARealKey");
    expect(existsSync(join(m.cwd, "zzpersona-managed"))).toBe(false);
    const json = await run(m, ["--layer", "team/payments", "--json"]);
    expect(json.code).toBe(1);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.out).toBeNull();
    expect(
      parsed.report.entries.some(
        (e: any) => e.outcome === "refused" && e.layer === "team/payments",
      ),
    ).toBe(true);
  });

  it("reports a key set by the team with the team layer", async () => {
    const m = machine({
      "team/payments.yaml": `${TEAM}policy:
  permissions: exclusive
targets:
  claude-code:
    managed:
      strictKnownMarketplaces: []
`,
    });
    const r = await run(m, ["--layer", "team/payments", "--json"]);
    expect(r.code).toBe(0);
    const { report } = JSON.parse(r.stdout);
    const entries = report.entries.filter(
      (e: any) =>
        e.path.startsWith("policy") ||
        e.path.includes("strictKnownMarketplaces"),
    );
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const e of entries) expect(e.layer).toBe("team/payments");
  });

  it("--json prints the report and the output path", async () => {
    const m = machine();
    const r = await run(m, ["--json", "--out", "elsewhere"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.out).toBe(join(m.cwd, "elsewhere"));
    expect(parsed.report.entries.length).toBeGreaterThan(0);
  });

  it("defaults --os to the current OS and rejects unknown ones", async () => {
    const m = machine();
    expect((await run(m, [])).code).toBe(0);
    const expected =
      process.platform === "darwin"
        ? "macos"
        : process.platform === "win32"
          ? "windows"
          : "linux";
    expect(manifestOf(join(m.cwd, "zzpersona-managed")).os).toBe(expected);
    const bad = await run(m, ["--os", "beos"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("--os");
  });

  it("builds the same bytes twice", async () => {
    const m = machine();
    await run(m, ["--os", "linux", "--out", "a"]);
    await run(m, ["--os", "linux", "--out", "b"]);
    const a = readFileSync(join(m.cwd, "a/zzpersona/manifest.json"));
    const b = readFileSync(join(m.cwd, "b/zzpersona/manifest.json"));
    expect(a.equals(b)).toBe(true);
  });

  it("refuses a missing hook script by name", async () => {
    const m = machine({ "org/hooks/guard.sh": "" });
    const r = await run(m, []);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("hooks/guard.sh");
  });

  it("refuses to overwrite a folder that is not a bundle, and replaces one that is", async () => {
    const m = machine();
    const out = join(m.cwd, "zzpersona-managed");
    put(join(out, "mine.txt"), "keep me");
    const refused = await run(m, []);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("not a zzpersona bundle");
    expect(readFileSync(join(out, "mine.txt"), "utf8")).toBe("keep me");
    rmSync(out, { recursive: true });

    expect((await run(m, [])).code).toBe(0);
    put(join(m.personas, "org/instructions/conduct.md"), "Changed.");
    expect((await run(m, [])).code).toBe(0);
    expect(settingsOf(out).claudeMd).toContain("Changed.");
    expect(readdirSync(m.cwd).filter((f) => f.startsWith("."))).toEqual([]);
  });

  it("layer digests use bundleDigest for local layers", async () => {
    const m = machine();
    await run(m, []);
    const local = createLocalStore({ user: m.home, personas: m.personas });
    const { source, files } = await bundleLayer(local, "org/acme");
    const layer = manifestOf(join(m.cwd, "zzpersona-managed")).layers[0]!;
    expect(layer.digest).toBe(bundleDigest(source, files));
    expect(layer.version).toBeUndefined();
  });

  it("uses published versions and digests when the layer came from the registry", async () => {
    const registry = await startMockRegistry({ token: "t" });
    try {
      const m = machine({}, registry.url);
      const env = { ZZPERSONA_REGISTRY_TOKEN: "t" };
      const opts = { cwd: m.cwd, home: m.home, env };
      expect((await zz(["publish", "org/acme"], opts)).code).toBe(0);
      expect((await zz(["pull"], opts)).code).toBe(0);
      const r = await run(m, [], env);
      expect(r.code).toBe(0);
      const layer = manifestOf(join(m.cwd, "zzpersona-managed")).layers[0]!;
      expect(layer.version).toBe(1);
      const index = JSON.parse(
        readFileSync(join(m.home, "cache/registry/index.json"), "utf8"),
      );
      expect(layer.digest).toBe(index.layers["org/acme"].digest);
    } finally {
      await registry.stop();
    }
  });

  it("refuses a cached layer whose files no longer match the index", async () => {
    const registry = await startMockRegistry({ token: "t" });
    try {
      const m = machine({}, registry.url);
      const env = { ZZPERSONA_REGISTRY_TOKEN: "t" };
      const opts = { cwd: m.cwd, home: m.home, env };
      await zz(["publish", "org/acme"], opts);
      await zz(["pull"], opts);
      expect((await run(m, [], env)).code).toBe(0);
      const cacheRoot = join(m.home, "cache/registry/org/acme");
      const folder = join(cacheRoot, readdirSync(cacheRoot)[0]!);
      writeFileSync(join(folder, "instructions/conduct.md"), "tampered");
      const r = await run(m, ["--out", "second"], env);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("org/acme");
      expect(r.stderr).toContain("zzpersona pull");
      expect(existsSync(join(m.cwd, "second"))).toBe(false);
    } finally {
      await registry.stop();
    }
  });

  // Task 5 adds the registry route and replaces this with: the downloaded files equal a local build.
  it.skip("--from-registry downloads the bundle", () => {});

  it("--from-registry exits 1 until the registry route exists", async () => {
    const m = machine();
    const r = await run(m, ["--from-registry"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not supported by this registry");
  });
});

describe("bundle io", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("round-trips and verifies every hash", async () => {
    const m = machine();
    await run(m, ["--os", "linux"]);
    const dir = join(m.cwd, "zzpersona-managed");
    const { files, manifest } = await readBundle(dir);
    expect(Object.keys(files)).toContain("zzpersona/manifest.json");
    expect(Object.keys(manifest.files).every((p) => p in files)).toBe(true);
    const copy = join(m.cwd, "copy");
    await writeBundle(copy, files);
    expect((await readBundle(copy)).manifest).toEqual(manifest);
  });

  it("names the first file whose hash differs", async () => {
    const m = machine();
    await run(m, ["--os", "linux"]);
    const dir = join(m.cwd, "zzpersona-managed");
    const target = "managed-settings.d/50-zzpersona.json";
    writeFileSync(join(dir, target), "{}");
    await expect(readBundle(dir)).rejects.toThrow(target);
  });

  it("names a listed file that is missing, and a folder without a manifest", async () => {
    const m = machine();
    await run(m, ["--os", "linux"]);
    const dir = join(m.cwd, "zzpersona-managed");
    rmSync(join(dir, "managed-settings.d/50-zzpersona.json"));
    await expect(readBundle(dir)).rejects.toThrow("50-zzpersona.json");
    await expect(readBundle(m.cwd)).rejects.toThrow("not a zzpersona bundle");
  });

  it("refuses Windows drive paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "zzp-bundle-"));
    roots.push(root);
    for (const path of ["C:/evil", "c:evil", "z:\\x"]) {
      await expect(
        writeBundle(join(root, "b"), { [path]: enc("x") }),
      ).rejects.toThrow("not a path inside the bundle");
    }
  });

  it("refuses paths that leave the folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "zzp-bundle-"));
    roots.push(root);
    await expect(
      writeBundle(join(root, "b"), { "../evil": enc("x") }),
    ).rejects.toThrow("not a path inside the bundle");
    expect(existsSync(join(root, "evil"))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
});

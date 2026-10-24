import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import claudeCode from "@getdonn/adapter-claude-code";
import type { ManagedManifest } from "@getdonn/adapter-sdk";
import { bundleDigest } from "@getdonn/registry-api";
import { startMockRegistry } from "@getdonn/registry-api/mock";
import { bundleLayer } from "@getdonn/store-remote";
import { createLocalStore } from "@getdonn/store-local";
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
const AREA = `apiVersion: donn/v0
kind: Persona
metadata: { name: fintech }
extends: [org/acme]
permissions:
  ask: ["Bash(git push:*)"]
locks:
  - permissions.ask
`;
const TEAM = `apiVersion: donn/v0
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
  const root = mkdtempSync(join(tmpdir(), "donn-managed-"));
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

/** Every file under `dir` with its text, `/`-separated. */
function filesIn(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const path = join(e.parentPath, e.name);
    out[
      path
        .slice(dir.length + 1)
        .split("\\")
        .join("/")
    ] = readFileSync(path, "utf8");
  }
  return out;
}

const run = (m: Machine, argv: string[], env: NodeJS.ProcessEnv = {}) =>
  zz(["managed", "build", ...argv], { cwd: m.cwd, home: m.home, env });

const manifestOf = (dir: string) =>
  JSON.parse(
    readFileSync(join(dir, "donn/manifest.json"), "utf8"),
  ) as ManagedManifest;
const settingsOf = (dir: string) =>
  JSON.parse(
    readFileSync(join(dir, "managed-settings.d/50-donn.json"), "utf8"),
  ) as Record<string, any>;

describe("donn managed build", () => {
  it("builds the org layer by default", async () => {
    const m = machine();
    const r = await run(m, ["--os", "linux"]);
    expect(r.code).toBe(0);
    const out = join(m.cwd, "donn-managed");
    expect(r.stdout).toContain(`bundle: ${out}`);
    const manifest = manifestOf(out);
    expect(manifest.layers.map((l) => l.ref)).toEqual(["org/acme"]);
    expect(manifest.donn).toBe(cliVersion());
    expect(manifest.os).toBe("linux");
    expect(settingsOf(out).permissions.deny).toEqual(["Bash(rm -rf:*)"]);
    expect(readdirSync(join(out, "donn/hooks"))).toHaveLength(1);
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
      "org/acme.yaml": `apiVersion: donn/v0
kind: Persona
metadata: { name: acme }
permissions:
  deny: ["Bash(rm -rf:*)"]
`,
    });
    const r = await run(m, []);
    expect(r.code).toBe(0);
    const out = join(m.cwd, "donn-managed");
    expect(settingsOf(out)).toEqual({});
    expect(existsSync(join(out, "managed-mcp.json"))).toBe(false);
    const notice =
      "nothing in org/acme and its ancestors is locked; the bundle enforces nothing";
    expect(r.stdout).toContain(`${notice}\n`);
    const json = JSON.parse((await run(m, ["--json"])).stdout);
    expect(json.notice).toBe(notice);
  });

  it("says so when locks exist but Claude Code enforces none of them", async () => {
    const m = machine({
      "org/acme.yaml": `apiVersion: donn/v0
kind: Persona
metadata: { name: acme }
locks:
  - knowledge
  - targets.codex
`,
    });
    const notice =
      "nothing in org/acme and its ancestors is enforced by Claude Code; the bundle enforces nothing";
    const r = await run(m, []);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`${notice}\n`);
    expect(JSON.parse((await run(m, ["--json"])).stdout).notice).toBe(notice);
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
    expect(existsSync(join(m.cwd, "donn-managed"))).toBe(false);
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
    expect(manifestOf(join(m.cwd, "donn-managed")).os).toBe(expected);
    const bad = await run(m, ["--os", "beos"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("--os");
  });

  it("builds the same bytes twice", async () => {
    const m = machine();
    await run(m, ["--os", "linux", "--out", "a"]);
    await run(m, ["--os", "linux", "--out", "b"]);
    const a = readFileSync(join(m.cwd, "a/donn/manifest.json"));
    const b = readFileSync(join(m.cwd, "b/donn/manifest.json"));
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
    const out = join(m.cwd, "donn-managed");
    put(join(out, "mine.txt"), "keep me");
    const refused = await run(m, []);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("not a donn bundle");
    expect(readFileSync(join(out, "mine.txt"), "utf8")).toBe("keep me");
    rmSync(out, { recursive: true });

    expect((await run(m, [])).code).toBe(0);
    put(join(m.personas, "org/instructions/conduct.md"), "Changed.");
    expect((await run(m, [])).code).toBe(0);
    expect(settingsOf(out).claudeMd).toContain("Changed.");
    expect(readdirSync(m.cwd).filter((f) => f.startsWith("."))).toEqual([]);
  });

  it("refuses a policy folder that holds more than its manifest lists, touching nothing", async () => {
    const m = machine();
    expect((await run(m, ["--os", "linux", "--out", "policy"])).code).toBe(0);
    const out = join(m.cwd, "policy");
    put(join(out, "managed-settings.json"), '{"claudeMd":"org"}');
    put(join(out, "managed-settings.d/10-org.json"), '{"deniedModels":[]}');
    const before = filesIn(out);
    const r = await run(m, ["--os", "linux", "--out", "policy"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not a donn bundle");
    expect(filesIn(out)).toEqual(before);
    // A manifest that cannot be read is not a bundle either.
    rmSync(join(out, "managed-settings.json"));
    rmSync(join(out, "managed-settings.d/10-org.json"));
    writeFileSync(join(out, "donn/manifest.json"), "{");
    expect((await run(m, ["--os", "linux", "--out", "policy"])).code).toBe(1);
    expect(readFileSync(join(out, "donn/manifest.json"), "utf8")).toBe("{");
  });

  it("refuses an --out in or under a managed policy folder", async () => {
    const m = machine();
    const system = join(m.root, "system", "ClaudeCode");
    mkdirSync(system, { recursive: true });
    const link = join(m.root, "link");
    symlinkSync(system, link);
    for (const out of [system, join(system, "sub"), link, join(link, "x")]) {
      const r = await zz(["managed", "build", "--out", out], {
        cwd: m.cwd,
        home: m.home,
        managed: { root: system },
      });
      expect(r.code, out).toBe(1);
      expect(r.stderr).toContain(system);
      expect(r.stderr).toContain("donn managed install");
    }
    expect(readdirSync(system)).toEqual([]);
  });

  it("layer digests use bundleDigest for local layers", async () => {
    const m = machine();
    await run(m, []);
    const local = createLocalStore({ user: m.home, personas: m.personas });
    const { source, files } = await bundleLayer(local, "org/acme");
    const layer = manifestOf(join(m.cwd, "donn-managed")).layers[0]!;
    expect(layer.digest).toBe(bundleDigest(source, files));
    expect(layer.version).toBeUndefined();
  });

  it("uses published versions and digests when the layer came from the registry", async () => {
    const registry = await startMockRegistry({ token: "t" });
    try {
      const m = machine({}, registry.url);
      const env = { DONN_REGISTRY_TOKEN: "t" };
      const opts = { cwd: m.cwd, home: m.home, env };
      expect((await zz(["publish", "org/acme"], opts)).code).toBe(0);
      expect((await zz(["pull"], opts)).code).toBe(0);
      const r = await run(m, [], env);
      expect(r.code).toBe(0);
      const layer = manifestOf(join(m.cwd, "donn-managed")).layers[0]!;
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
      const env = { DONN_REGISTRY_TOKEN: "t" };
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
      expect(r.stderr).toContain("donn pull");
      expect(existsSync(join(m.cwd, "second"))).toBe(false);
    } finally {
      await registry.stop();
    }
  });

  describe("--from-registry", () => {
    const TOKEN = "registry-token-1";
    const env = { DONN_REGISTRY_TOKEN: TOKEN };

    /** A machine whose three layers are published to a mock registry that builds bundles. */
    async function published(managed: boolean) {
      const registry = await startMockRegistry({
        token: TOKEN,
        ...(managed && { managed: claudeCode.managed! }),
      });
      const m = machine({}, registry.url);
      const opts = { cwd: m.cwd, home: m.home, env };
      for (const ref of ["org/acme", "area/fintech", "team/payments"]) {
        expect((await zz(["publish", ref], opts)).code).toBe(0);
      }
      expect((await zz(["pull"], opts)).code).toBe(0);
      return { registry, m };
    }

    const filesOf = (dir: string): Record<string, string> => {
      const out: Record<string, string> = {};
      const walk = (folder: string) => {
        for (const entry of readdirSync(folder, { withFileTypes: true })) {
          const path = join(folder, entry.name);
          if (entry.isDirectory()) walk(path);
          else out[path.slice(dir.length + 1)] = readFileSync(path, "utf8");
        }
      };
      walk(dir);
      return out;
    };

    it("downloads the bundle a local build of the pulled layers also makes", async () => {
      const { registry, m } = await published(true);
      try {
        const remote = await run(
          m,
          [
            "--layer",
            "team/payments",
            "--os",
            "linux",
            "--from-registry",
            "--out",
            "remote",
          ],
          env,
        );
        expect(remote.code).toBe(0);
        expect(remote.stdout).toContain("enforced: permissions.deny");
        const local = await run(
          m,
          ["--layer", "team/payments", "--os", "linux", "--out", "local"],
          env,
        );
        expect(local.code).toBe(0);
        const a = filesOf(join(m.cwd, "remote"));
        const b = filesOf(join(m.cwd, "local"));
        const strip = (files: Record<string, string>) => {
          const { "donn/manifest.json": manifest, ...rest } = files;
          const { donn: _version, ...fields } = JSON.parse(manifest!);
          return { ...rest, manifest: fields };
        };
        expect(strip(a)).toEqual(strip(b));
        expect(Object.keys(a)).toContain("managed-settings.d/50-donn.json");
        // The result is a bundle install can use.
        expect(
          (await readBundle(join(m.cwd, "remote"))).manifest.layers,
        ).toHaveLength(3);
      } finally {
        await registry.stop();
      }
    });

    it("prints the registry's refusal and writes nothing", async () => {
      const registry = await startMockRegistry({
        token: TOKEN,
        managed: claudeCode.managed!,
      });
      try {
        const m = machine(
          {
            "org/acme.yaml": ORG.replace(
              "locks:",
              "mcp:\n  servers:\n    vault:\n      url: https://x.example/mcp\n      headers:\n        Authorization: secret://vault/token\nlocks:\n  - mcp.servers.vault",
            ),
          },
          registry.url,
        );
        const opts = { cwd: m.cwd, home: m.home, env };
        expect((await zz(["publish", "org/acme"], opts)).code).toBe(0);
        const r = await run(m, ["--os", "linux", "--from-registry"], env);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("refused: mcp.servers.vault (org/acme)");
        expect(r.stderr).toContain("managed-secret");
        expect(existsSync(join(m.cwd, "donn-managed"))).toBe(false);
      } finally {
        await registry.stop();
      }
    });

    it("says so when the registry does not build bundles", async () => {
      const { registry, m } = await published(false);
      try {
        const r = await run(
          m,
          ["--layer", "org/acme", "--os", "linux", "--from-registry"],
          env,
        );
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("not supported by this registry");
      } finally {
        await registry.stop();
      }
    });

    it("needs a registry", async () => {
      const m = machine();
      const r = await run(m, ["--from-registry"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("no registry configured");
    });

    /** A registry that answers `body` for the bundle route and nothing else. */
    async function liar(body: unknown, status = 200) {
      const server = createServer((_req, res) => {
        res.writeHead(status, {
          "content-type":
            status === 200 ? "application/json" : "application/problem+json",
        });
        res.end(JSON.stringify(body));
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      return {
        url,
        stop: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      };
    }

    const manifestFor = (files: Record<string, string>) => ({
      format: 1,
      donn: "x",
      os: "linux",
      layers: [{ ref: "org/acme", digest: `sha256:${"a".repeat(64)}` }],
      files,
      report: { entries: [], warnings: [] },
    });
    const b64 = (text: string) => Buffer.from(text).toString("base64");
    const hash = (text: string) =>
      createHash("sha256").update(text).digest("hex");

    it("refuses a file path that escapes the bundle folder, writing nothing", async () => {
      const evil = await liar({
        manifest: manifestFor({ "../evil.txt": hash("x") }),
        files: {
          "../evil.txt": b64("x"),
          "donn/manifest.json": b64("{}"),
        },
      });
      try {
        const m = machine({}, evil.url);
        const r = await run(
          m,
          ["--layer", "org/acme", "--os", "linux", "--from-registry"],
          env,
        );
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("../evil.txt");
        expect(existsSync(join(m.cwd, "donn-managed"))).toBe(false);
        expect(existsSync(join(m.cwd, "..", "evil.txt"))).toBe(false);
      } finally {
        await evil.stop();
      }
    });

    it("refuses files that do not match the manifest's digests", async () => {
      const path = "managed-settings.d/50-donn.json";
      const bad = await liar({
        manifest: manifestFor({ [path]: hash("one") }),
        files: { [path]: b64("two"), "donn/manifest.json": b64("{}") },
      });
      try {
        const m = machine({}, bad.url);
        const r = await run(
          m,
          ["--layer", "org/acme", "--os", "linux", "--from-registry"],
          env,
        );
        expect(r.code).toBe(1);
        expect(r.stderr).toContain(path);
        expect(existsSync(join(m.cwd, "donn-managed"))).toBe(false);
      } finally {
        await bad.stop();
      }
    });

    const fromRegistry = [
      "--layer",
      "org/acme",
      "--os",
      "linux",
      "--from-registry",
    ];
    const problem = (ref?: string) => ({
      type: "about:blank",
      title: "Not found",
      status: 404,
      detail: "nothing here",
      problems: [
        { code: "not-found", message: "nothing here", ...(ref && { ref }) },
      ],
    });

    it("reads a 404 without a ref as a registry that lacks the route", async () => {
      const old = await liar(problem(), 404);
      try {
        const m = machine({}, old.url);
        const r = await run(m, fromRegistry, env);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("not supported by this registry");
      } finally {
        await old.stop();
      }
    });

    it("keeps the layer-not-found message when the 404 names a ref", async () => {
      const reg = await liar(problem("org/acme"), 404);
      try {
        const m = machine({}, reg.url);
        const r = await run(m, fromRegistry, env);
        expect(r.code).toBe(1);
        expect(r.stderr).not.toContain("not supported");
        expect(r.stderr).toContain("nothing here");
      } finally {
        await reg.stop();
      }
    });

    it("refuses manifest.json bytes that differ from the manifest it sent", async () => {
      const path = "managed-settings.d/50-donn.json";
      const manifest = manifestFor({ [path]: hash("one") });
      const bad = await liar({
        manifest,
        files: {
          [path]: b64("one"),
          "donn/manifest.json": b64(JSON.stringify({ ...manifest, files: {} })),
        },
      });
      try {
        const m = machine({}, bad.url);
        const r = await run(m, fromRegistry, env);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("manifest.json");
        expect(existsSync(join(m.cwd, "donn-managed"))).toBe(false);
      } finally {
        await bad.stop();
      }
    });

    /** A well-formed bundle answer whose manifest is `manifest` plus `extra`. */
    const answer = (extra: Record<string, unknown> = {}) => {
      const path = "managed-settings.d/50-donn.json";
      const manifest = { ...manifestFor({ [path]: hash("{}\n") }), ...extra };
      return {
        manifest,
        files: {
          [path]: b64("{}\n"),
          "donn/manifest.json": b64(JSON.stringify(manifest)),
        },
      };
    };

    it("refuses a bundle for another OS or another layer than asked", async () => {
      const reg = await liar(answer());
      try {
        const m = machine({}, reg.url);
        const os = await run(
          m,
          ["--layer", "org/acme", "--os", "macos", "--from-registry"],
          env,
        );
        expect(os.code).toBe(1);
        expect(os.stderr).toContain("linux");
        expect(os.stderr).toContain("macos");
        const layer = await run(
          m,
          ["--layer", "area/fintech", "--os", "linux", "--from-registry"],
          env,
        );
        expect(layer.code).toBe(1);
        expect(layer.stderr).toContain("org/acme");
        expect(layer.stderr).toContain("area/fintech");
        expect(existsSync(join(m.cwd, "donn-managed"))).toBe(false);
      } finally {
        await reg.stop();
      }
    });

    it("accepts a manifest field this client does not know, byte for byte", async () => {
      const reg = await liar(answer({ signedBy: { key: "k1" } }));
      try {
        const m = machine({}, reg.url);
        const r = await run(m, fromRegistry, env);
        expect(r.code, r.stderr).toBe(0);
        expect(
          manifestOf(join(m.cwd, "donn-managed")) as unknown,
        ).toMatchObject({ signedBy: { key: "k1" } });
      } finally {
        await reg.stop();
      }
    });

    it("refuses file keys that differ only in case", async () => {
      const a = "managed-settings.d/50-donn.json";
      const b = "managed-settings.d/50-DONN.json";
      const manifest = manifestFor({ [a]: hash("x"), [b]: hash("x") });
      const bad = await liar({
        manifest,
        files: {
          [a]: b64("x"),
          [b]: b64("x"),
          "donn/manifest.json": b64(JSON.stringify(manifest)),
        },
      });
      try {
        const m = machine({}, bad.url);
        const r = await run(m, fromRegistry, env);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("differ only in case");
        expect(existsSync(join(m.cwd, "donn-managed"))).toBe(false);
      } finally {
        await bad.stop();
      }
    });
  });
});

describe("bundle io", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("round-trips and verifies every hash", async () => {
    const m = machine();
    await run(m, ["--os", "linux"]);
    const dir = join(m.cwd, "donn-managed");
    const { files, manifest } = await readBundle(dir);
    expect(Object.keys(files)).toContain("donn/manifest.json");
    expect(Object.keys(manifest.files).every((p) => p in files)).toBe(true);
    const copy = join(m.cwd, "copy");
    await writeBundle(copy, files);
    expect((await readBundle(copy)).manifest).toEqual(manifest);
  });

  it("names the first file whose hash differs", async () => {
    const m = machine();
    await run(m, ["--os", "linux"]);
    const dir = join(m.cwd, "donn-managed");
    const target = "managed-settings.d/50-donn.json";
    writeFileSync(join(dir, target), "{}");
    await expect(readBundle(dir)).rejects.toThrow(target);
  });

  it("names a listed file that is missing, and a folder without a manifest", async () => {
    const m = machine();
    await run(m, ["--os", "linux"]);
    const dir = join(m.cwd, "donn-managed");
    rmSync(join(dir, "managed-settings.d/50-donn.json"));
    await expect(readBundle(dir)).rejects.toThrow("50-donn.json");
    await expect(readBundle(m.cwd)).rejects.toThrow("not a donn bundle");
  });

  it("refuses Windows drive paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "donn-bundle-"));
    roots.push(root);
    for (const path of ["C:/evil", "c:evil", "z:\\x"]) {
      await expect(
        writeBundle(join(root, "b"), { [path]: enc("x") }),
      ).rejects.toThrow("not a path inside the bundle");
    }
  });

  it("refuses paths that leave the folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "donn-bundle-"));
    roots.push(root);
    await expect(
      writeBundle(join(root, "b"), { "../evil": enc("x") }),
    ).rejects.toThrow("not a path inside the bundle");
    expect(existsSync(join(root, "evil"))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
});

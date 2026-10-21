import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ActivationPlan } from "@zzpersona/adapter-sdk";
import { runConformance } from "@zzpersona/adapter-sdk/conformance";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContext } from "./context.js";
import { CliError } from "./errors.js";
import { findAdapter, loadAdapters, loadSecretProviders } from "./plugins.js";
import { quietIo, seed, zz, type Seeded } from "./test/seed.js";

const FIXTURES = join(import.meta.dirname, "test/plugins");

let s: Seeded;
beforeEach(() => {
  s = seed();
});
afterEach(() => s.cleanup());

function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Add lines to the seeded config.yaml. */
const configure = (lines: string) =>
  put(join(s.home, "config.yaml"), `personas: ${s.personas}\n${lines}\n`);

const context = (cwd = s.root) => createContext(quietIo({ cwd, home: s.home }));

const loadError = async (promise: Promise<unknown>) => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("plugin-load");
  return error as CliError;
};

/** An adapter package with only an "import" export condition, under <home>/adapters. */
function installEsmOnly(name: string) {
  const dir = join(s.home, "adapters/node_modules", name);
  put(
    join(dir, "package.json"),
    JSON.stringify({
      name,
      version: "1.2.3",
      type: "module",
      exports: { ".": { import: "./index.js" } },
    }),
  );
  put(
    join(dir, "index.js"),
    `export default {
  apiVersion: 1,
  id: "esm-only",
  irVersions: [0],
  capabilities: () => ({ fields: {} }),
  detect: async () => ({ installed: false, facts: {} }),
  compile: () => ({ files: {}, secretEnv: {}, report: { adapter: "esm-only", irVersion: 0, entries: [] } }),
  activate: () => ({ steps: [] }),
};
`,
  );
  return join(dir, "index.js");
}

describe("third-party adapters", () => {
  it("loads a class-based adapter from a path and it passes conformance", async () => {
    configure(`adapters: [${join(FIXTURES, "class-adapter")}]`);
    const ctx = await context();
    const adapter = await findAdapter(ctx, {}, "fake");
    expect(adapter.id).toBe("fake");
    const failed = (await runConformance(adapter)).filter((r) => !r.passed);
    expect(failed).toEqual([]);
  });

  it("loads an ESM-only package by name", async () => {
    const entry = installEsmOnly("acme-zzp-fake");
    configure("adapters: [acme-zzp-fake]");
    const [loaded] = await loadAdapters(await context(), {});
    expect(loaded).toMatchObject({
      entry: "acme-zzp-fake",
      resolved: entry,
      version: "1.2.3",
    });
    expect(loaded!.plugin.id).toBe("esm-only");
  });

  it("resolves a relative entry against the home, not cwd", async () => {
    put(
      join(s.home, "local-adapter/index.js"),
      readFileSync(join(FIXTURES, "class-adapter/index.js"), "utf8"),
    );
    configure("adapters: [./local-adapter]");
    const [loaded] = await loadAdapters(await context(s.repo), {});
    expect(loaded!.resolved).toBe(join(s.home, "local-adapter/index.js"));
  });

  it("names the install command for a missing package", async () => {
    configure("adapters: [acme-missing]");
    const error = await loadError(loadAdapters(await context(), {}));
    expect(error.message).toContain(
      `npm install --prefix ${join(s.home, "adapters")} acme-missing`,
    );
  });

  it("refuses entries that are not usable adapters", async () => {
    const reasons = new Set<unknown>();
    for (const entries of [
      ["./nope"],
      [join(FIXTURES, "not-a-plugin")],
      [join(FIXTURES, "provider")],
      [join(FIXTURES, "bad-version")],
      [join(FIXTURES, "class-adapter"), join(FIXTURES, "class-adapter")],
    ]) {
      configure(`adapters: [${entries.join(", ")}]`);
      const error = await loadError(loadAdapters(await context(), {}));
      reasons.add(error.details.reason);
    }
    expect(reasons.size).toBe(5);
  });

  it("refuses an adapter that claims a built-in id", async () => {
    put(
      join(s.home, "imposter/index.js"),
      readFileSync(join(FIXTURES, "class-adapter/index.js"), "utf8").replace(
        'id = "fake"',
        'id = "claude-code"',
      ),
    );
    configure("adapters: [./imposter]");
    const error = await loadError(loadAdapters(await context(), {}));
    expect(error.message).toContain("claude-code");
  });

  it("a broken adapter does not affect zzpersona claude", async () => {
    configure("adapters: [./missing]");
    const r = await zz(["claude", "--dry-run"], { cwd: s.repo, home: s.home });
    expect(r.code, r.stderr).toBe(0);
  });

  it("compiles with a third-party harness", async () => {
    configure(`adapters: [${join(FIXTURES, "class-adapter")}]`);
    const ok = await zz(["compile", "--harness", "fake", "--json"], {
      cwd: s.repo,
      home: s.home,
    });
    expect(ok.code, ok.stderr).toBe(0);
    const bad = await zz(["compile", "--harness", "nope", "--json"], {
      cwd: s.repo,
      home: s.home,
    });
    expect(JSON.parse(bad.stdout).error).toMatchObject({
      code: "unknown-harness",
      available: ["claude-code", "agents-md", "codex", "fake"],
    });
  });
});

describe("secret provider packages", () => {
  it("refuses a provider that claims a built-in type", async () => {
    put(
      join(s.home, "env-provider/index.js"),
      'export default { apiVersion: 1, type: "env", resolve: async () => "x" };\n',
    );
    configure("secretProviders: [./env-provider]");
    await loadError(loadSecretProviders(await context(), {}));
  });

  it("resolves a secret through a provider package", async () => {
    const base = join(s.personas, "org/base.yaml");
    writeFileSync(
      base,
      readFileSync(base, "utf8").replace(
        "vault: { type: hashicorp-vault, address: https://vault.corp }",
        "vault: { type: fake-vault }",
      ),
    );
    configure(`secretProviders: [${join(FIXTURES, "provider")}]`);
    const calls: Record<string, string>[] = [];
    const r = await zz(["claude"], {
      cwd: s.repo,
      home: s.home,
      runPlan: async (
        _plan: ActivationPlan,
        options: { secretEnv: Record<string, string> },
      ) => {
        calls.push(options.secretEnv);
        return 0;
      },
    });
    expect(r.code, r.stderr).toBe(0);
    expect(Object.values(calls[0]!)).toEqual(["v-payments/schema-token"]);
  });
});

describe("package entry resolution", () => {
  /** A provider package under <home>/adapters with the given package.json fields and files. */
  function installProvider(
    name: string,
    pkg: Record<string, unknown>,
    files: Record<string, string>,
  ) {
    const dir = join(s.home, "adapters/node_modules", name);
    put(join(dir, "package.json"), JSON.stringify({ name, ...pkg }));
    for (const [file, content] of Object.entries(files))
      put(join(dir, file), content);
    return dir;
  }
  const ESM =
    'export default { apiVersion: 1, type: "esm-vault", resolve: async () => "x" };\n';
  const CJS = "module.exports = { nope: true };\n";

  it("follows nested and top-level export conditions, never the CJS build", async () => {
    const shapes: Record<string, unknown>[] = [
      {
        type: "module",
        main: "./lib/index.cjs",
        exports: {
          ".": {
            import: { types: "./lib/index.d.ts", default: "./lib/index.js" },
            require: "./lib/index.cjs",
          },
        },
      },
      {
        type: "module",
        main: "./lib/index.cjs",
        exports: { import: "./lib/index.js", require: "./lib/index.cjs" },
      },
      {
        type: "module",
        exports: {
          ".": {
            node: { import: "./lib/index.js" },
            default: "./lib/index.cjs",
          },
        },
      },
      { type: "module", main: "lib/index" },
    ];
    for (const [i, pkg] of shapes.entries()) {
      const name = i === 2 ? "@acme/zzp-shape-2" : `zzp-shape-${i}`;
      const dir = installProvider(name, pkg, {
        "lib/index.js": ESM,
        "lib/index.cjs": CJS,
      });
      configure(`secretProviders: ["${name}"]`);
      const [loaded] = await loadSecretProviders(await context(), {});
      expect(loaded!.resolved, name).toBe(join(dir, "lib/index.js"));
    }
  });

  it("reports a malformed package.json as a plugin-load error", async () => {
    const dir = join(s.home, "adapters/node_modules/zzp-broken");
    put(join(dir, "package.json"), "{ not json");
    configure("secretProviders: [zzp-broken]");
    const error = await loadError(loadSecretProviders(await context(), {}));
    expect(error.details.reason).toBe("invalid-package-json");
  });
});

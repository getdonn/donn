import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { capabilityFields, type Probe } from "@zzpersona/adapter-sdk";
import { HOOK_EVENTS } from "@zzpersona/spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  capabilitiesDoc,
  firstPartyColumns,
  renderGrid,
  type Column,
} from "./capabilities/render.js";
import { installedProbe, seed, zz, type Seeded } from "./test/seed.js";

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
const configure = (lines: string) =>
  put(join(s.home, "config.yaml"), `personas: ${s.personas}\n${lines}\n`);

const run = (argv: string[], probe?: Probe) =>
  zz(["capabilities", ...argv], {
    cwd: s.repo,
    home: s.home,
    ...(probe && { probe }),
  });

/** The grid's table lines: from the header to the first blank line. */
const gridLines = (out: string) => out.split("\n\n")[0]!.split("\n");
const rowLabels = (out: string) =>
  gridLines(out)
    .slice(1)
    .map((line) => line.split(/\s+/)[0]);

describe("zzpersona capabilities", () => {
  it("prints the first-party grid within 80 columns", async () => {
    const r = await run([]);
    expect(r.code, r.stderr).toBe(0);
    const lines = gridLines(r.stdout);
    expect(lines[0]).toMatch(/claude-code\s+agents-md\s+codex/);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    expect(rowLabels(r.stdout)).toEqual([
      "instructions",
      "skills",
      "mcp.servers",
      "secrets",
      "knowledge",
      "permissions.allow",
      "permissions.deny",
      "permissions.ask",
      "hooks",
      "policy",
      "targets",
    ]);
    expect(r.stdout).toContain("Codex has no per-launch skill root");
  });

  it("declares a policy row for every built-in adapter", () => {
    for (const column of firstPartyColumns()) {
      expect(column.matrix.fields.policy?.support, column.id).toBe(
        column.id === "claude-code" ? "native" : "advisory",
      );
    }
  });

  it("collapses permissions when every column agrees", () => {
    const columns = firstPartyColumns().filter((c) => c.id !== "codex");
    expect(rowLabels(renderGrid(columns))).toContain("permissions");
  });

  it("expands hook rows when events differ", () => {
    const [claude] = firstPartyColumns();
    const odd: Column = {
      ...claude!,
      matrix: {
        fields: {
          ...claude!.matrix.fields,
          "hooks.stop": { support: "none", note: "no stop hook" },
        },
      },
    };
    const labels = rowLabels(renderGrid([odd]));
    expect(labels).not.toContain("hooks");
    for (const event of HOOK_EVENTS) expect(labels).toContain(`hooks.${event}`);
  });

  it("numbers a shared note once", () => {
    const out = renderGrid(firstPartyColumns());
    const notes = out.split("\n\n").slice(1).join("\n\n");
    const once = (text: string) =>
      expect(notes.split(text).length - 1, text).toBe(1);
    once("AGENTS.md is plain text; use a harness adapter for hooks");
    once("rendered as guidance; not enforced");
    // The hooks row cites the same number in its agents-md cell and nowhere else new.
    const hooks = gridLines(out).find((l) => l.startsWith("hooks"))!;
    expect(hooks).toMatch(/✕ \d+/);
  });

  it("lists one harness with --harness", async () => {
    const r = await run(["--harness", "codex"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(
      /^skills\s+✕ none\s+Codex has no per-launch skill root$/m,
    );
    expect(r.stdout).toMatch(
      /^mcp\.servers\s+● native\s+\* gateway refs, URL-server headers, and servers whose secret/m,
    );
  });

  it("rejects an unknown harness", async () => {
    const r = await run(["--harness", "nope", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("unknown-harness");
  });

  it("prints every field per harness with --json", async () => {
    const r = await run(["--json"]);
    expect(r.code, r.stderr).toBe(0);
    const json = JSON.parse(r.stdout) as {
      harnesses: { id: string; fields: Record<string, { support: string }> }[];
    };
    expect(json.harnesses.map((h) => h.id)).toEqual([
      "claude-code",
      "agents-md",
      "codex",
    ]);
    for (const h of json.harnesses) {
      expect(Object.keys(h.fields)).toEqual(capabilityFields(h.id));
    }
    expect(json.harnesses[2]!.fields.skills).toEqual({
      support: "none",
      note: "Codex has no per-launch skill root",
    });
  });

  it("marks a harness that is not installed", async () => {
    const missing: Probe = {
      ...installedProbe,
      run: async (command) =>
        command === "codex"
          ? { exitCode: 127, stdout: "", stderr: "" }
          : installedProbe.run(command, []),
    };
    const r = await run(["--detect"], missing);
    expect(r.code, r.stderr).toBe(0);
    expect(gridLines(r.stdout)[0]).toContain("codex (not installed)");
    expect(gridLines(r.stdout)[0]).toContain("claude-code 2.1.306");
  });

  it("keeps the listing when one adapter's detect throws", async () => {
    const broken: Probe = {
      ...installedProbe,
      run: async (command) => {
        if (command === "codex") throw new Error("probe exploded");
        return installedProbe.run(command, []);
      },
    };
    const r = await run(["--detect"], broken);
    expect(r.code, r.stderr).toBe(0);
    expect(gridLines(r.stdout)[0]).toContain("codex (detection failed)");
    expect(gridLines(r.stdout)[0]).toContain("claude-code 2.1.306");
    const json = await run(["--detect", "--json"], broken);
    const codex = (
      JSON.parse(json.stdout) as {
        harnesses: { id: string; detected?: unknown }[];
      }
    ).harnesses.find((h) => h.id === "codex")!;
    expect(codex.detected).toEqual({
      installed: false,
      error: "probe exploded",
    });
  });

  it("shows Claude Code partial with --detect", async () => {
    const blocked: Probe = {
      ...installedProbe,
      readFile: async (path) =>
        path.endsWith("managed-settings.json")
          ? '{"disableSideloadFlags": true}'
          : undefined,
    };
    const r = await run(["--harness", "claude-code", "--detect"], blocked);
    expect(r.stdout).toMatch(
      /^skills\s+✕ none\s+disableSideloadFlags blocks --plugin-dir/m,
    );
    const full = await run(["--harness", "claude-code"]);
    expect(full.stdout).toMatch(/^skills\s+● native/m);
  });

  it("shows an incomplete third-party matrix", async () => {
    configure(`adapters: [${join(FIXTURES, "whole-file-adapter")}]`);
    const r = await run([]);
    expect(r.code, r.stderr).toBe(0);
    expect(gridLines(r.stdout)[0]).toMatch(/codex\s+whole-file/);
    expect(r.stdout).toContain("not declared by the adapter");
  });

  it("fails on a broken adapter plugin", async () => {
    configure(`adapters: [${join(FIXTURES, "bad-version")}]`);
    const r = await run(["--json"]);
    const compile = await zz(["compile", "--harness", "x", "--json"], {
      cwd: s.repo,
      home: s.home,
    });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe(
      JSON.parse(compile.stdout).error.code,
    );
  });

  it("prints the published form with --markdown", async () => {
    const r = await run(["--markdown"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^# Capability matrix\n/);
    expect(r.stdout).toContain("| Field | claude-code | agents-md | codex |");
    expect(r.stdout).toContain(
      "Harnesses without an adapter yet: Copilot CLI, Cursor, Gemini CLI, Antigravity.",
    );
  });
});

describe("docs/capabilities.md", () => {
  it("keeps docs/capabilities.md current", () => {
    const file = join(import.meta.dirname, "../../../../docs/capabilities.md");
    const committed = existsSync(file) ? readFileSync(file, "utf8") : "";
    expect(
      committed,
      "docs/capabilities.md is stale; run pnpm docs:capabilities",
    ).toBe(capabilitiesDoc(firstPartyColumns()));
  });
});

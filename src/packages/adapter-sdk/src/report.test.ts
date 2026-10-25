import type { ResolvedPersona } from "@getdonn/spec";
import { describe, expect, it } from "vitest";
import {
  annotateLocks,
  capabilityFields,
  requiredEntries,
  UNDECLARED,
  type CompileReport,
} from "./index.js";
import { HOOK_EVENTS } from "@getdonn/spec";

const pathsAndOutcomes = (entries: { path: string; outcome: string }[]) =>
  entries.map(({ path, outcome }) => ({ path, outcome }));

const emptyIr = (): ResolvedPersona => ({
  irVersion: 0,
  layers: ["team/t"],
  metadata: { name: "t", labels: {} },
  instructions: [],
  skills: [],
  mcp: { servers: {} },
  permissions: { allow: [], deny: [], ask: [] },
  hooks: {},
  knowledge: [],
  secrets: { providers: {} },
  locks: [],
  targets: {},
  policy: {},
  models: {},
  agents: {},
});

const ir: ResolvedPersona = {
  ...emptyIr(),
  permissions: { allow: ["Read(./**)"], deny: ["Bash(rm -rf:*)"], ask: [] },
  hooks: { notification: [{ id: "ping", run: "org/hooks/ping.sh" }] },
  knowledge: [
    { id: "a", source: "https://a" },
    { id: "b", source: "https://b" },
  ],
  targets: { codex: { model: "x" } },
  locks: [{ path: "permissions.deny", layer: "org/base" }],
};

describe("capabilityFields", () => {
  it("lists the fixed fields, every hook event, then the adapter's own targets", () => {
    const fields = capabilityFields("x");
    expect(fields[0]).toBe("instructions");
    expect(fields.at(-1)).toBe("targets.x");
    for (const event of HOOK_EVENTS) expect(fields).toContain(`hooks.${event}`);
  });
});

describe("requiredEntries", () => {
  it("gives each entry its field's note as the reason", () => {
    const required = requiredEntries(
      "toy",
      {
        fields: {
          "permissions.deny": { support: "advisory", note: "as text" },
        },
      },
      ir,
    );
    expect(required).toContainEqual({
      path: "permissions.deny[Bash(rm -rf:*)]",
      outcome: "advisory",
      reason: "as text",
    });
    expect(required).toContainEqual({
      path: "knowledge[a]",
      outcome: "dropped",
      reason: UNDECLARED,
    });
  });

  it("lists every value under a field the adapter cannot express natively", () => {
    const required = requiredEntries(
      "toy",
      {
        fields: {
          "permissions.allow": { support: "native" },
          "permissions.deny": { support: "advisory" },
          knowledge: { support: "none" },
        },
      },
      ir,
    );
    expect(pathsAndOutcomes(required)).toEqual(
      expect.arrayContaining([
        { path: "permissions.deny[Bash(rm -rf:*)]", outcome: "advisory" },
        { path: "knowledge[a]", outcome: "dropped" },
        { path: "knowledge[b]", outcome: "dropped" },
        { path: "hooks.notification[ping]", outcome: "dropped" },
      ]),
    );
    expect(required).toHaveLength(4);
  });

  it("ignores other harnesses' targets but reports the adapter's own", () => {
    const own = { ...ir, targets: { codex: { a: 1 }, toy: { b: 2 } } };
    const paths = requiredEntries("toy", { fields: {} }, own).map(
      (e) => e.path,
    );
    expect(paths).toContain("targets.toy");
    expect(paths).not.toContain("targets.codex");
  });

  it("names each secret-bearing env var when secrets are not native", () => {
    const withSecrets: ResolvedPersona = {
      ...emptyIr(),
      mcp: {
        servers: {
          db: {
            command: "npx",
            env: { TOKEN: "secret://vault/db", LEVEL: "debug" },
          },
        },
      },
    };
    const required = requiredEntries(
      "toy",
      { fields: { "mcp.servers": { support: "native" } } },
      withSecrets,
    );
    expect(pathsAndOutcomes(required)).toEqual([
      { path: "mcp.servers.db.env.TOKEN", outcome: "dropped" },
    ]);
  });

  it("lists nothing for a fully native adapter", () => {
    expect(
      requiredEntries(
        "toy",
        {
          fields: {
            "permissions.allow": { support: "native" },
            "permissions.deny": { support: "native" },
            knowledge: { support: "native" },
            "hooks.notification": { support: "native" },
          },
        },
        { ...ir, targets: {} },
      ),
    ).toEqual([]);
  });
});

describe("annotateLocks", () => {
  it("marks entries a lock covers and leaves the rest alone", () => {
    const report: CompileReport = {
      adapter: "toy",
      irVersion: 0,
      entries: [
        {
          path: "permissions.deny[Bash(rm -rf:*)]",
          outcome: "advisory",
          reason: "r",
        },
        { path: "knowledge[a]", outcome: "dropped", reason: "r" },
      ],
    };
    const annotated = annotateLocks(report, ir);
    expect(annotated.entries[0]!.lock).toEqual({
      path: "permissions.deny",
      layer: "org/base",
    });
    expect(annotated.entries[1]).not.toHaveProperty("lock");
    expect(report.entries[0]).not.toHaveProperty("lock");
  });
});

describe("requiredEntries secret locations (I4)", () => {
  it("finds secret refs in args, url and headers, not only env", () => {
    const ir: ResolvedPersona = {
      ...emptyIr(),
      mcp: {
        servers: {
          db: { command: "npx", args: ["--token", "secret://vault/t"] },
          remote: {
            url: "https://mcp.corp/sse",
            headers: { Authorization: "secret://vault/key" },
          },
        },
      },
    };
    const paths = requiredEntries(
      "toy",
      { fields: { "mcp.servers": { support: "native" } } },
      ir,
    ).map((e) => e.path);
    expect(paths.sort()).toEqual([
      "mcp.servers.db.args.1",
      "mcp.servers.remote.headers.Authorization",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { diff, resolve, valueAt, type PersonaSource } from "./index.js";

// diff() compares two resolve results over their provenance paths. See spec 08 §3.

const persona = (name: string, extra: object = {}) => ({
  apiVersion: "zzpersona/v0",
  kind: "Persona",
  metadata: { name, description: `the ${name} persona` },
  ...extra,
});

const source: PersonaSource = {
  load: async (ref) =>
    ({
      "org/base": persona("base", {
        permissions: { deny: ["Bash(rm -rf:*)"] },
        targets: { "claude-code": { model: "sonnet" } },
        instructions: [{ id: "conduct", inline: "Be kind." }],
      }),
      "team/a": persona("a", {
        extends: ["org/base"],
        mcp: {
          servers: {
            db: { command: "db-mcp", env: { TOKEN: "secret://env/A" } },
          },
        },
      }),
      "team/b": persona("b", {
        extends: ["org/base"],
        permissions: { deny: ["Bash(kubectl delete:*)"] },
        targets: { "claude-code": { model: "opus" } },
        locks: ["permissions.deny"],
      }),
      "team/c": persona("c", {
        extends: ["org/base"],
        instructions: [
          { id: "conduct", inline: "Be terse.", position: "replace(conduct)" },
        ],
        mcp: {
          servers: {
            db: { command: "db-mcp", env: { TOKEN: "secret://env/B" } },
          },
        },
      }),
    })[ref],
};

const resolved = (ref: string) => resolve(ref, { source });

describe("valueAt", () => {
  it("walks keys and selects keyed entries", async () => {
    const { ir } = await resolved("team/b");
    expect(valueAt(ir, "targets.claude-code.model")).toBe("opus");
    expect(valueAt(ir, "permissions.deny[Bash(rm -rf:*)]")).toBe(
      "Bash(rm -rf:*)",
    );
    expect(valueAt(ir, "instructions[conduct]")).toMatchObject({
      id: "conduct",
    });
    expect(valueAt(ir, "permissions.deny[nope]")).toBeUndefined();
  });
});

describe("diff", () => {
  it("lists added, removed and changed values with their layers", async () => {
    const changes = diff(await resolved("team/a"), await resolved("team/b"));
    expect(changes).toEqual([
      {
        path: "locks[permissions.deny]",
        change: "added",
        to: "team/b",
        toLayer: "team/b",
      },
      {
        path: "mcp.servers.db",
        change: "removed",
        from: { command: "db-mcp", env: { TOKEN: "secret://env/A" } },
        fromLayer: "team/a",
      },
      {
        path: "permissions.deny[Bash(kubectl delete:*)]",
        change: "added",
        to: "Bash(kubectl delete:*)",
        toLayer: "team/b",
      },
      {
        path: "targets.claude-code.model",
        change: "changed",
        from: "sonnet",
        to: "opus",
        fromLayer: "org/base",
        toLayer: "team/b",
      },
    ]);
  });

  it("skips metadata and finds nothing between identical personas", async () => {
    expect(diff(await resolved("team/a"), await resolved("team/a"))).toEqual(
      [],
    );
    const paths = diff(await resolved("team/a"), await resolved("team/b")).map(
      (c) => c.path,
    );
    expect(paths.some((p) => p.startsWith("metadata."))).toBe(false);
  });

  it("a changed instruction is one row and secret refs stay refs", async () => {
    const changes = diff(await resolved("team/a"), await resolved("team/c"));
    expect(changes.map((c) => [c.path, c.change])).toEqual([
      ["instructions[conduct]", "changed"],
      ["mcp.servers.db", "changed"],
    ]);
    expect(JSON.stringify(changes)).toContain("secret://env/B");
  });
});

import type { ManagedCompiler, ManagedInput } from "@zzpersona/adapter-sdk";
import { describe, expect, it } from "vitest";
import { compileFromSource } from "./managed.js";

const docs: Record<string, unknown> = {
  "org/acme": {
    apiVersion: "zzpersona/v0",
    kind: "Persona",
    metadata: { name: "acme" },
    instructions: [{ id: "conduct", file: "./instructions/conduct.md" }],
    hooks: { "pre-tool-use": [{ id: "guard", run: "./hooks/guard.sh" }] },
    locks: ["instructions[conduct]", "hooks.pre-tool-use[guard]"],
  },
  "team/payments": {
    apiVersion: "zzpersona/v0",
    kind: "Persona",
    metadata: { name: "payments" },
    extends: ["org/acme"],
    policy: { mcp: "exclusive" },
    targets: { "claude-code": { managed: { deniedModels: ["x"] } } },
  },
};

const source = {
  load: async (ref: string) => docs[ref],
};

function fake() {
  const seen: { input?: ManagedInput; wanted?: unknown } = {};
  const compiler: ManagedCompiler = {
    roots: { macos: "/m", linux: "/l", windows: "C:\\w" },
    inputs: (ir) => {
      seen.wanted = ir.layers;
      return {
        texts: ["org/instructions/conduct.md"],
        scripts: ["org/hooks/guard.sh"],
      };
    },
    compile: (input) => {
      seen.input = input;
      return { report: { entries: [], warnings: [] } };
    },
  };
  return { compiler, seen };
}

const read = async (path: string): Promise<Uint8Array> =>
  new TextEncoder().encode(`bytes of ${path}`);

describe("compileFromSource", () => {
  it("resolves the ref, reads the compiler's inputs and compiles", async () => {
    const { compiler, seen } = fake();
    const layers = [
      { ref: "org/acme", digest: "sha256:a" },
      { ref: "team/payments", version: 3, digest: "sha256:b" },
    ];
    await compileFromSource(compiler, {
      source,
      ref: "team/payments",
      os: "linux",
      layers,
      zzpersona: "1.2.3",
      readFile: read,
    });
    expect(seen.wanted).toEqual(["org/acme", "team/payments"]);
    expect(seen.input).toMatchObject({
      os: "linux",
      zzpersona: "1.2.3",
      layers,
      texts: {
        "org/instructions/conduct.md": "bytes of org/instructions/conduct.md",
      },
    });
    expect(
      new TextDecoder().decode(seen.input!.scripts["org/hooks/guard.sh"]),
    ).toBe("bytes of org/hooks/guard.sh");
  });

  it("passes the resolver's provenance, so a team-set key names the team", async () => {
    const { compiler, seen } = fake();
    await compileFromSource(compiler, {
      source,
      ref: "team/payments",
      os: "macos",
      layers: [],
      zzpersona: "0",
      readFile: read,
    });
    const provenance = seen.input!.provenance!;
    const policyKey = Object.keys(provenance).find((k) =>
      k.startsWith("policy"),
    );
    expect(policyKey).toBeDefined();
    expect(provenance[policyKey!]).toBe("team/payments");
    const managedKey = Object.keys(provenance).find((k) =>
      k.includes("managed"),
    );
    expect(managedKey).toBeDefined();
    expect(provenance[managedKey!]).toBe("team/payments");
  });

  it("fails when a file cannot be read", async () => {
    const { compiler } = fake();
    await expect(
      compileFromSource(compiler, {
        source,
        ref: "org/acme",
        os: "linux",
        layers: [],
        zzpersona: "0",
        readFile: async (path) => {
          throw new Error(`cannot read ${path}`);
        },
      }),
    ).rejects.toThrow("cannot read org/instructions/conduct.md");
  });
});

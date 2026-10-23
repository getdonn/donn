import { describe, expect, it } from "vitest";
import {
  InstructionFragment,
  Persona,
  PersonaDocument,
  PersonaOverlay,
} from "./persona.js";

const base = {
  apiVersion: "zzpersona/v0",
  kind: "Persona",
  metadata: { name: "base" },
};

describe("Persona", () => {
  it("accepts a minimal persona", () => {
    expect(Persona.safeParse(base).success).toBe(true);
  });

  it("rejects unknown keys at every level", () => {
    expect(Persona.safeParse({ ...base, instructoins: [] }).success).toBe(
      false,
    );
    expect(
      Persona.safeParse({ ...base, permissions: { alow: [] } }).success,
    ).toBe(false);
    expect(
      Persona.safeParse({ ...base, hooks: { "pre-tool-uze": [] } }).success,
    ).toBe(false);
  });

  it("rejects a wrong apiVersion", () => {
    expect(
      Persona.safeParse({ ...base, apiVersion: "zzpersona/v1" }).success,
    ).toBe(false);
  });

  it("requires extends refs to start with a known layer", () => {
    expect(
      Persona.safeParse({ ...base, extends: ["org/base", "team/pay-ments"] })
        .success,
    ).toBe(true);
    expect(
      Persona.safeParse({ ...base, extends: ["division/base"] }).success,
    ).toBe(false);
    expect(Persona.safeParse({ ...base, extends: ["org"] }).success).toBe(
      false,
    );
  });

  it("accepts each MCP server form and rejects mixed ones", () => {
    const servers = {
      jira: { ref: "gateway://jira" },
      db: {
        command: "npx",
        args: ["-y", "@corp/db"],
        env: { TOKEN: "secret://vault/db" },
      },
      remote: { url: "https://mcp.corp/sse", transport: "sse" },
    };
    expect(Persona.safeParse({ ...base, mcp: { servers } }).success).toBe(true);
    const mixed = { ref: "gateway://jira", command: "npx" };
    expect(
      Persona.safeParse({ ...base, mcp: { servers: { x: mixed } } }).success,
    ).toBe(false);
  });

  it("checks hook removals are <event>[<id>]", () => {
    const ok = { remove: ["pre-tool-use[audit-log]"] };
    expect(Persona.safeParse({ ...base, hooks: ok }).success).toBe(true);
    const bad = { remove: ["audit-log"] };
    expect(Persona.safeParse({ ...base, hooks: bad }).success).toBe(false);
  });

  it("leaves lock path validity to the resolver", () => {
    // 079-invalid-lock-path must reach the resolver to be reported with its layer.
    expect(
      Persona.safeParse({ ...base, locks: ["permissions.denny"] }).success,
    ).toBe(true);
  });
});

describe("InstructionFragment", () => {
  it("takes exactly one of file or inline", () => {
    expect(
      InstructionFragment.safeParse({ id: "a", file: "./a.md" }).success,
    ).toBe(true);
    expect(
      InstructionFragment.safeParse({ id: "a", inline: "text" }).success,
    ).toBe(true);
    expect(InstructionFragment.safeParse({ id: "a" }).success).toBe(false);
    expect(
      InstructionFragment.safeParse({ id: "a", file: "./a.md", inline: "text" })
        .success,
    ).toBe(false);
  });

  it("accepts append, prepend and replace(<id>) positions only", () => {
    for (const position of [
      "append",
      "prepend",
      "replace(payments-overview)",
    ]) {
      expect(
        InstructionFragment.safeParse({ id: "a", inline: "x", position })
          .success,
      ).toBe(true);
    }
    for (const position of ["after", "replace()", "replace(Bad_Id)"]) {
      expect(
        InstructionFragment.safeParse({ id: "a", inline: "x", position })
          .success,
      ).toBe(false);
    }
  });
});

describe("policy", () => {
  it("accepts a policy block", () => {
    const policy = {
      permissions: "exclusive",
      hooks: "exclusive",
      mcp: "exclusive",
      bypassPermissions: "disabled",
    };
    expect(Persona.parse({ ...base, policy }).policy).toEqual(policy);
    expect(Persona.safeParse({ ...base, policy: {} }).success).toBe(true);
  });

  it("rejects unknown policy keys and values", () => {
    expect(
      Persona.safeParse({ ...base, policy: { permissions: "shared" } }).success,
    ).toBe(false);
    expect(
      Persona.safeParse({ ...base, policy: { network: "exclusive" } }).success,
    ).toBe(false);
  });

  it("an overlay cannot carry policy", () => {
    const overlay = { apiVersion: "zzpersona/v0", kind: "PersonaOverlay" };
    expect(
      PersonaOverlay.safeParse({ ...overlay, policy: { mcp: "exclusive" } })
        .success,
    ).toBe(false);
  });
});

describe("PersonaOverlay", () => {
  it("cannot carry metadata, extends or locks", () => {
    const overlay = { apiVersion: "zzpersona/v0", kind: "PersonaOverlay" };
    expect(PersonaOverlay.safeParse(overlay).success).toBe(true);
    for (const key of ["metadata", "extends", "locks"]) {
      expect(PersonaOverlay.safeParse({ ...overlay, [key]: [] }).success).toBe(
        false,
      );
    }
  });

  it("is selected by kind in PersonaDocument", () => {
    const doc = PersonaDocument.parse({
      apiVersion: "zzpersona/v0",
      kind: "PersonaOverlay",
    });
    expect(doc.kind).toBe("PersonaOverlay");
  });
});

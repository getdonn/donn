import { AdapterInputError } from "@getdonn/adapter-sdk";
import { ResolveError } from "@getdonn/resolver";
import { SecretResolutionError } from "@getdonn/secrets";
import { describe, expect, it } from "vitest";
import type { CliIo } from "./cli.js";
import { report } from "./errors.js";
import { installedProbe, safeManaged, zz } from "./test/seed.js";

function io() {
  const out = { stdout: "", stderr: "" };
  const cliIo: CliIo = {
    env: {},
    cwd: "/",
    stdout: { write: (s: string) => (out.stdout += s) },
    stderr: { write: (s: string) => (out.stderr += s) },
    probe: installedProbe,
    managed: safeManaged(),
  };
  return { cliIo, out };
}

describe("report", () => {
  it("prints adapter input errors as one line and an adapter envelope (I1)", () => {
    const text = io();
    expect(
      report(
        text.cliIo,
        false,
        new AdapterInputError("skill x: ../x is outside"),
      ),
    ).toBe(1);
    expect(text.out.stderr).toBe("error: skill x: ../x is outside\n");
    const json = io();
    report(json.cliIo, true, new AdapterInputError("skill x: ../x is outside"));
    expect(JSON.parse(json.out.stdout).error).toEqual({
      code: "adapter",
      message: "skill x: ../x is outside",
    });
  });
});

describe("every --json envelope carries a message", () => {
  it("a resolver error: its text form, naming the ref and the layer", () => {
    const json = io();
    report(
      json.cliIo,
      true,
      new ResolveError("missing-ref", { ref: "org/nope", from: "team/t" }),
    );
    expect(JSON.parse(json.out.stdout).error).toEqual({
      code: "missing-ref",
      message: "missing-ref: ref=org/nope, from=team/t",
      ref: "org/nope",
      from: "team/t",
    });
  });

  it("a secrets error: its text form, with the failures", () => {
    const json = io();
    const failures = [{ ref: "secret://env/X", reason: "X is not set" }];
    report(json.cliIo, true, new SecretResolutionError(failures));
    expect(JSON.parse(json.out.stdout).error).toEqual({
      code: "secrets",
      message: "could not resolve 1 secret(s):\n  secret://env/X: X is not set",
      failures,
    });
  });
});

describe("CliError envelopes", () => {
  it("always carry a message", async () => {
    const r = await zz(["init", "--json"], { cwd: "/" });
    expect(JSON.parse(r.stdout).error).toMatchObject({
      code: "init-needs-flags",
      message: expect.stringContaining("--personas"),
    });
  });
});

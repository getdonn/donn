import { AdapterInputError } from "@zzpersona/adapter-sdk";
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

describe("CliError envelopes", () => {
  it("always carry a message", async () => {
    const r = await zz(["init", "--json"], { cwd: "/" });
    expect(JSON.parse(r.stdout).error).toMatchObject({
      code: "init-needs-flags",
      message: expect.stringContaining("--personas"),
    });
  });
});

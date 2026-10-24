import { describe, expect, it } from "vitest";
import type { Mod$, ProcessRunResult } from "./api.js";
import { runCli } from "./cli.js";

function fake(reply: ProcessRunResult | Error) {
  const calls: { argv: readonly string[]; init?: object }[] = [];
  const $ = {
    process: {
      run: async (argv: readonly string[], init?: object) => {
        calls.push({ argv, ...(init && { init }) });
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  } as unknown as Mod$;
  return { $, calls };
}

describe("runCli", () => {
  it("runs donn with --json in the folder, with a 5 s timeout", async () => {
    const { $, calls } = fake({ exitCode: 0, stdout: '{"a":1}', stderr: "" });
    expect(await runCli($, ["switch"], "/r")).toEqual({
      ok: true,
      json: { a: 1 },
    });
    expect(calls).toEqual([
      {
        argv: ["donn", "switch", "--json"],
        init: { cwd: "/r", timeoutMs: 5000 },
      },
    ]);
  });

  it("ignores stderr when stdout is JSON", async () => {
    const { $ } = fake({
      exitCode: 0,
      stdout: '{"persona":"x"}',
      stderr: "warning: something\n",
    });
    expect(await runCli($, ["switch"], "/r")).toMatchObject({ ok: true });
  });

  it("returns the CLI's error envelope", async () => {
    const { $ } = fake({
      exitCode: 1,
      stdout: '{"error":{"code":"no-persona","message":"no persona here"}}',
      stderr: "",
    });
    expect(await runCli($, ["switch"], "/r")).toEqual({
      ok: false,
      code: "no-persona",
      reason: "no persona here",
    });
  });

  it("explains a command that could not run", async () => {
    const reason = async (error: Error) =>
      ((await runCli(fake(error).$, ["switch"], "/r")) as { reason: string })
        .reason;
    expect(await reason(new Error("spawn donn ENOENT"))).toBe(
      "the donn command was not found on PATH",
    );
    expect(await reason(new Error("the command timed out after 5000 ms"))).toBe(
      "timed out",
    );
    // No daemon here either: the refusal says what fixes it (spec 15 §2).
    expect(await reason(new Error("Acme policy: no process.run"))).toBe(
      "start the daemon (donn daemon start), or allow the mod to run donn",
    );
  });

  it("reports output that is not JSON", async () => {
    const { $ } = fake({ exitCode: 0, stdout: "not json", stderr: "" });
    expect(await runCli($, ["switch"], "/r")).toEqual({
      ok: false,
      reason: "the donn command printed something that is not JSON",
    });
  });

  it("never throws on a JSON reply that is not an object", async () => {
    const { $ } = fake({ exitCode: 1, stdout: "null", stderr: "" });
    expect(await runCli($, ["switch"], "/r")).toEqual({
      ok: false,
      reason: "the donn command exited 1",
    });
  });
});

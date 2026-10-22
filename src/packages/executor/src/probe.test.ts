import { describe, expect, it } from "vitest";
import { nodeProbe } from "./index.js";

describe("nodeProbe", () => {
  const probe = nodeProbe();

  it("returns 127 for a missing command instead of throwing", async () => {
    expect(await probe.run("zz-no-such-command", [])).toMatchObject({
      exitCode: 127,
    });
  });

  it("returns stdout and the exit code", async () => {
    expect(
      await probe.run("node", ["-e", "process.stdout.write('ok')"]),
    ).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
    expect(await probe.run("node", ["-e", "process.exit(4)"])).toMatchObject({
      exitCode: 4,
    });
  });

  it("returns undefined for absent paths", async () => {
    expect(await probe.readFile("/zz/no/such/file")).toBeUndefined();
    expect(await probe.listDir("/zz/no/such/dir")).toBeUndefined();
  });

  it("reports this platform", () => {
    expect(probe.platform).toBe(process.platform);
  });
});

describe("nodeProbe timeouts", () => {
  it("reports a command killed by its timeout as exit 124", async () => {
    const result = await nodeProbe({ timeoutMs: 100 }).run("sleep", ["5"]);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out");
  });

  it("gives a command no stdin, so a read sees end of input", async () => {
    const result = await nodeProbe({ timeoutMs: 2000 }).run("sh", [
      "-c",
      "read x; echo done",
    ]);
    expect(result).toMatchObject({ exitCode: 0, stdout: "done\n" });
  });

  it.skipIf(process.platform === "win32")(
    "kills a command that ignores SIGTERM, and what it started",
    async () => {
      const started = Date.now();
      const result = await nodeProbe({ timeoutMs: 200 }).run("sh", [
        "-c",
        "trap '' TERM; sleep 30 & sleep 30",
      ]);
      expect(result.exitCode).toBe(124);
      expect(Date.now() - started).toBeLessThan(3000);
    },
  );
});

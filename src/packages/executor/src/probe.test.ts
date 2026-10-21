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

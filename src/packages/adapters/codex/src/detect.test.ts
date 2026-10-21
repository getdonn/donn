import type { Probe } from "@zzpersona/adapter-sdk";
import { describe, expect, it } from "vitest";
import adapter from "./index.js";

const probe = (exitCode: number, stdout = ""): Probe => ({
  platform: "darwin",
  run: async () => ({ exitCode, stdout, stderr: "" }),
  readFile: async () => undefined,
  listDir: async () => undefined,
});

describe("detect", () => {
  it("reads the version, or reports Codex missing", async () => {
    expect(await adapter.detect(probe(0, "codex-cli 0.163.0\n"))).toEqual({
      installed: true,
      version: "0.163.0",
      facts: {},
    });
    expect((await adapter.detect(probe(127))).installed).toBe(false);
  });
});

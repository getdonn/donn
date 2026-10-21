import { describe, expect, it } from "vitest";
import {
  keychainParts,
  resolveSecrets,
  SecretResolutionError,
  type SecretContext,
} from "./index.js";

type Reply = { exitCode: number; stdout?: string; stderr?: string };

/** A context whose run records each call and answers with `reply`. */
function fake(platform: string, reply: Reply) {
  const calls: string[][] = [];
  const ctx: SecretContext = {
    env: {},
    platform,
    run: async (command, args) => {
      calls.push([command, ...args]);
      return { stdout: "", stderr: "", ...reply };
    },
  };
  return { ctx, calls };
}

const failureFor = async (ref: string, ctx: SecretContext) => {
  const error = await resolveSecrets([ref], {}, ctx).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SecretResolutionError);
  return (error as SecretResolutionError).failures[0]!.reason;
};

describe("keychain", () => {
  it("splits service and account at the last segment", () => {
    expect(keychainParts("acme/github/token")).toEqual({
      service: "acme/github",
      account: "token",
    });
    expect(keychainParts("only-one")).toBeUndefined();
  });

  it("reads from the macOS keychain", async () => {
    const { ctx, calls } = fake("darwin", { exitCode: 0, stdout: "s3cret\n" });
    expect(
      await resolveSecrets(["secret://keychain/acme/github/token"], {}, ctx),
    ).toEqual({ "secret://keychain/acme/github/token": "s3cret" });
    expect(calls).toEqual([
      [
        "security",
        "find-generic-password",
        "-s",
        "acme/github",
        "-a",
        "token",
        "-w",
      ],
    ]);
  });

  it("strips exactly one trailing newline", async () => {
    const { ctx } = fake("darwin", { exitCode: 0, stdout: "a  \n\n" });
    expect(await resolveSecrets(["secret://keychain/s/a"], {}, ctx)).toEqual({
      "secret://keychain/s/a": "a  \n",
    });
  });

  it("reads from the Linux keyring with secret-tool", async () => {
    const { ctx, calls } = fake("linux", { exitCode: 0, stdout: "v\n" });
    await resolveSecrets(["secret://keychain/acme/github/token"], {}, ctx);
    expect(calls).toEqual([
      ["secret-tool", "lookup", "service", "acme/github", "account", "token"],
    ]);
  });

  it("reports a missing item without running anything else", async () => {
    expect(
      await failureFor(
        "secret://keychain/s/a",
        fake("darwin", { exitCode: 44 }).ctx,
      ),
    ).toBe("not found in the keychain");
    expect(
      await failureFor(
        "secret://keychain/s/a",
        fake("linux", { exitCode: 1 }).ctx,
      ),
    ).toBe("not found in the keychain");
    expect(
      await failureFor(
        "secret://keychain/s/a",
        fake("darwin", { exitCode: 0, stdout: "" }).ctx,
      ),
    ).toBe("not found in the keychain");
  });

  it("explains a missing secret-tool, other exit codes and other platforms", async () => {
    expect(
      await failureFor(
        "secret://keychain/s/a",
        fake("linux", { exitCode: 127 }).ctx,
      ),
    ).toBe("secret-tool is not installed (install libsecret-tools)");
    expect(
      await failureFor(
        "secret://keychain/s/a",
        fake("darwin", {
          exitCode: 51,
          stderr: "security: SecKeychainSearch failed\nmore detail\n",
        }).ctx,
      ),
    ).toBe("security exited 51: security: SecKeychainSearch failed");
    expect(
      await failureFor(
        "secret://keychain/s/a",
        fake("win32", { exitCode: 0 }).ctx,
      ),
    ).toBe("keychain is not supported on win32");
  });

  it("rejects a ref without service and account", async () => {
    expect(
      await failureFor(
        "secret://keychain/only-one",
        fake("darwin", { exitCode: 0, stdout: "x" }).ctx,
      ),
    ).toBe("keychain refs are secret://<provider>/<service>/<account>");
  });

  it("works undeclared, or declared under another name", async () => {
    const { ctx } = fake("darwin", { exitCode: 0, stdout: "x\n" });
    expect(
      await resolveSecrets(
        ["secret://mine/a/b"],
        { mine: { type: "keychain" } },
        ctx,
      ),
    ).toEqual({ "secret://mine/a/b": "x" });
  });
});

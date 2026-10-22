import { describe, expect, it } from "vitest";
import {
  deleteKeychainItem,
  keychainParts,
  keychainSupported,
  setKeychainItem,
  resolveSecrets,
  SecretResolutionError,
  type KeychainContext,
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

describe("keychain failures that are not a missing item", () => {
  it("reports a secret-tool error on stderr, not a missing item", async () => {
    expect(
      await failureFor(
        "secret://keychain/s/a",
        fake("linux", {
          exitCode: 1,
          stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY\n",
        }).ctx,
      ),
    ).toBe(
      "secret-tool exited 1: Cannot autolaunch D-Bus without X11 $DISPLAY",
    );
  });

  it("explains a timed-out lookup", async () => {
    expect(
      await failureFor(
        "secret://keychain/s/a",
        fake("darwin", { exitCode: 124, stderr: "timed out after 10s" }).ctx,
      ),
    ).toBe("timed out waiting for security (was a keychain prompt left open?)");
  });
});

describe("keychain writes", () => {
  const recorder = (platform: string, exitCode = 0, stderr = "") => {
    const calls: { command: string; args: string[]; input?: string }[] = [];
    const ctx: KeychainContext = {
      platform,
      run: async (command: string, args: string[], input?: string) => {
        calls.push({ command, args, input });
        return { exitCode, stdout: "", stderr };
      },
    };
    return { ctx, calls };
  };

  it("macOS writes the secret through security -i stdin, never argv", async () => {
    const { ctx, calls } = recorder("darwin");
    await setKeychainItem(
      ctx,
      "zzpersona-registry",
      "https://r.example",
      "tok",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("security");
    expect(calls[0]!.args).toEqual(["-i"]);
    expect(calls[0]!.input).toBe(
      'add-generic-password -U -s "zzpersona-registry" -a "https://r.example" -w "tok"\n',
    );
    expect(calls[0]!.args.join(" ")).not.toContain("tok");
  });

  it("Linux writes through secret-tool store stdin", async () => {
    const { ctx, calls } = recorder("linux");
    await setKeychainItem(ctx, "s", "a", "tok");
    expect(calls[0]).toEqual({
      command: "secret-tool",
      args: [
        "store",
        "--label=zzpersona registry",
        "service",
        "s",
        "account",
        "a",
      ],
      input: "tok",
    });
  });

  it("refuses a value with a quote, backslash or newline", async () => {
    const { ctx, calls } = recorder("darwin");
    for (const bad of ['a"b', "a\\b", "a\nb"]) {
      await expect(setKeychainItem(ctx, "s", "a", bad)).rejects.toThrow(
        /value/,
      );
      await expect(setKeychainItem(ctx, bad, "a", "v")).rejects.toThrow(
        /service/,
      );
      await expect(setKeychainItem(ctx, "s", bad, "v")).rejects.toThrow(
        /account/,
      );
    }
    expect(calls).toHaveLength(0);
  });

  it("delete reports a missing item as false", async () => {
    expect(await deleteKeychainItem(recorder("darwin", 44).ctx, "s", "a")).toBe(
      false,
    );
    expect(await deleteKeychainItem(recorder("linux", 1).ctx, "s", "a")).toBe(
      false,
    );
    const ok = recorder("darwin");
    expect(await deleteKeychainItem(ok.ctx, "s", "a")).toBe(true);
    expect(ok.calls[0]!.args).toEqual([
      "delete-generic-password",
      "-s",
      "s",
      "-a",
      "a",
    ]);
    const linux = recorder("linux");
    await deleteKeychainItem(linux.ctx, "s", "a");
    expect(linux.calls[0]!.args).toEqual([
      "clear",
      "service",
      "s",
      "account",
      "a",
    ]);
  });

  it("reports unsupported platforms and a missing command", async () => {
    expect(keychainSupported("darwin")).toBe(true);
    expect(keychainSupported("linux")).toBe(true);
    expect(keychainSupported("win32")).toBe(false);
    await expect(
      setKeychainItem(recorder("win32").ctx, "s", "a", "v"),
    ).rejects.toThrow("not supported on win32");
    await expect(
      setKeychainItem(recorder("linux", 127).ctx, "s", "a", "v"),
    ).rejects.toThrow("secret-tool is not installed");
  });

  it("the existing secret:// resolve still works", async () => {
    const { ctx, calls } = fake("darwin", { exitCode: 0, stdout: "val\n" });
    const out = await resolveSecrets(["secret://keychain/s/a"], {}, ctx);
    expect(JSON.stringify(out)).toContain("val");
    expect(calls[0]).toEqual([
      "security",
      "find-generic-password",
      "-s",
      "s",
      "-a",
      "a",
      "-w",
    ]);
  });
});

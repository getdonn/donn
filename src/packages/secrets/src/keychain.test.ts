import { describe, expect, it } from "vitest";
import {
  deleteKeychainItem,
  getKeychainItem,
  hasKeychainItem,
  keychainParts,
  keychainSupported,
  setKeychainItem,
  resolveSecrets,
  SecretResolutionError,
  type KeychainContext,
  type SecretContext,
} from "./index.js";

const REAL44 =
  "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.";

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

/** A `security find-generic-password -g` answer: the password line goes to stderr. */
const found = (value: string): Reply => ({
  exitCode: 0,
  stdout: 'keychain: "login.keychain-db"\nclass: "genp"\n',
  stderr: `password: ${value}\n`,
});

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
    const { ctx, calls } = fake("darwin", found('"s3cret"'));
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
        "-g",
      ],
    ]);
  });

  // `security -g` output captured from a real keychain (macOS 27): anything but printable ASCII
  // without a quote or backslash comes as 0x<hex>, which `-w` would have printed as bare hex.
  it.each([
    [
      "a newline",
      '0x4C494E45310A4C494E4532  "LINE1\\012LINE2"',
      "LINE1\nLINE2",
    ],
    ["non-ASCII text", '0x636166C3A9  "caf\\303\\251"', "café"],
    ["a quote and a backslash", '0x6122625C63  "a"b\\134c"', 'a"b\\c'],
    ["a value that is itself hex", '"4c494e4531"', "4c494e4531"],
    ["spaces around it", '" x "', " x "],
  ])("reads a macOS value with %s", async (_, line, value) => {
    const { ctx } = fake("darwin", found(line));
    expect(await resolveSecrets(["secret://keychain/s/a"], {}, ctx)).toEqual({
      "secret://keychain/s/a": value,
    });
  });

  it("reads a multi-line PEM from the macOS keychain whole", async () => {
    const pem = "-----BEGIN KEY-----\nAbC=\n-----END KEY-----\n";
    const hex = Buffer.from(pem).toString("hex").toUpperCase();
    const { ctx } = fake("darwin", found(`0x${hex}  "ignored"`));
    expect(await getKeychainItem(ctx, "s", "a")).toBe(pem);
  });

  it("reads an empty macOS value as empty", async () => {
    expect(await getKeychainItem(fake("darwin", found("")).ctx, "s", "a")).toBe(
      "",
    );
  });

  it("refuses a macOS value that is not text, or output it cannot read", async () => {
    await expect(
      getKeychainItem(fake("darwin", found("0xFF00FE")).ctx, "s", "a"),
    ).rejects.toThrow("the keychain value is not UTF-8 text");
    await expect(
      getKeychainItem(fake("darwin", { exitCode: 0 }).ctx, "s", "a"),
    ).rejects.toThrow("security printed no password line");
  });

  it("strips exactly one trailing newline from secret-tool", async () => {
    const { ctx } = fake("linux", { exitCode: 0, stdout: "a  \n\n" });
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
        fake("darwin", { exitCode: 44, stderr: REAL44 }).ctx,
      ),
    ).toBe("not found in the keychain");
    expect(
      await failureFor(
        "secret://keychain/s/a",
        fake("linux", { exitCode: 1, stderr: "no D-Bus" }).ctx,
      ),
    ).toBe("secret-tool exited 1: no D-Bus");
    expect(
      await failureFor(
        "secret://keychain/s/a",
        fake("linux", { exitCode: 1 }).ctx,
      ),
    ).toBe("not found in the keychain");
    expect(
      await failureFor("secret://keychain/s/a", fake("darwin", found("")).ctx),
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
        fake("darwin", found('"x"')).ctx,
      ),
    ).toBe("keychain refs are secret://<provider>/<service>/<account>");
  });

  it("works undeclared, or declared under another name", async () => {
    const { ctx } = fake("darwin", found('"x"'));
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
  const recorder = (
    platform: string,
    exitCode = 0,
    stderr = "",
    stdout = "",
  ) => {
    const calls: { command: string; args: string[]; input?: string }[] = [];
    const ctx: KeychainContext = {
      platform,
      run: async (command: string, args: string[], input?: string) => {
        calls.push({ command, args, input });
        return { exitCode, stdout, stderr };
      },
    };
    return { ctx, calls };
  };

  it("macOS writes the secret through security -i stdin, never argv", async () => {
    const { ctx, calls } = recorder("darwin");
    await setKeychainItem(ctx, "donn-registry", "https://r.example", "tok");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("security");
    expect(calls[0]!.args).toEqual(["-i"]);
    expect(calls[0]!.input).toBe(
      'add-generic-password -U -s "donn-registry" -a "https://r.example" -w "tok"\n',
    );
    expect(calls[0]!.args.join(" ")).not.toContain("tok");
  });

  it("Linux writes through secret-tool store stdin", async () => {
    const { ctx, calls } = recorder("linux");
    await setKeychainItem(ctx, "s", "a", "tok");
    expect(calls[0]).toEqual({
      command: "secret-tool",
      args: ["store", "--label=donn registry", "service", "s", "account", "a"],
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
    expect(
      await deleteKeychainItem(recorder("darwin", 44, REAL44).ctx, "s", "a"),
    ).toBe(false);
    expect(await deleteKeychainItem(recorder("linux", 1).ctx, "s", "a")).toBe(
      false,
    );
    expect(
      await deleteKeychainItem(
        recorder("linux", 1, "no D-Bus").ctx,
        "s",
        "a",
      ).catch((e: unknown) => (e as Error).message),
    ).toBe("secret-tool exited 1: no D-Bus");
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

  it("tells whether an item exists without reading its secret on macOS", async () => {
    const found = recorder("darwin", 0, "", 'keychain: "login"\n');
    expect(await hasKeychainItem(found.ctx, "s", "a")).toBe(true);
    // No -w: security prints the attributes only, so no access prompt and no secret.
    expect(found.calls[0]!.args).toEqual([
      "find-generic-password",
      "-s",
      "s",
      "-a",
      "a",
    ]);
    expect(
      await hasKeychainItem(recorder("darwin", 44, REAL44).ctx, "s", "a"),
    ).toBe(false);
    await expect(
      hasKeychainItem(
        recorder("darwin", 51, "User interaction is not allowed.").ctx,
        "s",
        "a",
      ),
    ).rejects.toThrow("security exited 51: User interaction is not allowed.");
    expect(
      await hasKeychainItem(recorder("linux", 0, "", "v").ctx, "s", "a"),
    ).toBe(true);
    expect(await hasKeychainItem(recorder("linux", 1).ctx, "s", "a")).toBe(
      false,
    );
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
    const { ctx, calls } = fake("darwin", found('"val"'));
    const out = await resolveSecrets(["secret://keychain/s/a"], {}, ctx);
    expect(JSON.stringify(out)).toContain("val");
    expect(calls[0]).toEqual([
      "security",
      "find-generic-password",
      "-s",
      "s",
      "-a",
      "a",
      "-g",
    ]);
  });
});

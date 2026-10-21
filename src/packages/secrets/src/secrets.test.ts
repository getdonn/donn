import { describe, expect, it } from "vitest";
import {
  parseSecretRef,
  resolveSecrets,
  SecretResolutionError,
} from "./index.js";

const VALUE = "SUPER-SECRET-VALUE";

describe("parseSecretRef", () => {
  it("splits provider and path", () => {
    expect(parseSecretRef("secret://vault/payments/token")).toEqual({
      provider: "vault",
      path: "payments/token",
    });
    expect(parseSecretRef("secret://vault")).toBeUndefined();
    expect(parseSecretRef("https://x/y")).toBeUndefined();
  });
});

describe("resolveSecrets", () => {
  it("resolves a declared env provider", async () => {
    expect(
      await resolveSecrets(
        ["secret://local/TOKEN"],
        { local: { type: "env" } },
        { env: { TOKEN: "v" } },
      ),
    ).toEqual({ "secret://local/TOKEN": "v" });
  });

  it("resolves the undeclared env provider", async () => {
    expect(
      await resolveSecrets(["secret://env/X"], {}, { env: { X: "x" } }),
    ).toEqual({ "secret://env/X": "x" });
  });

  it("collects every failure into one error with exact reasons", async () => {
    const error = await resolveSecrets(
      [
        "secret://bad",
        "secret://nowhere/A",
        "secret://vault/b/c",
        "secret://local/MISSING",
      ],
      {
        vault: { type: "hashicorp-vault", address: "https://vault.corp" },
        local: { type: "env" },
      },
      { env: { OTHER: VALUE } },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretResolutionError);
    expect((error as SecretResolutionError).failures).toEqual([
      {
        ref: "secret://bad",
        reason: "not a secret://<provider>/<path> ref",
      },
      {
        ref: "secret://nowhere/A",
        reason: 'provider "nowhere" is not declared in secrets.providers',
      },
      {
        ref: "secret://vault/b/c",
        reason: 'provider type "hashicorp-vault" is not supported yet',
      },
      {
        ref: "secret://local/MISSING",
        reason: "environment variable MISSING is not set",
      },
    ]);
    expect((error as Error).message).toBe(
      [
        "could not resolve 4 secret(s):",
        "  secret://bad: not a secret://<provider>/<path> ref",
        '  secret://nowhere/A: provider "nowhere" is not declared in secrets.providers',
        '  secret://vault/b/c: provider type "hashicorp-vault" is not supported yet',
        "  secret://local/MISSING: environment variable MISSING is not set",
      ].join("\n"),
    );
  });

  it("treats an empty variable as unset", async () => {
    const error = await resolveSecrets(
      ["secret://env/TOKEN"],
      {},
      { env: { TOKEN: "" } },
    ).catch((e: unknown) => e);
    expect((error as SecretResolutionError).failures).toEqual([
      {
        ref: "secret://env/TOKEN",
        reason: "environment variable TOKEN is not set",
      },
    ]);
  });

  it("never puts a value in an error", async () => {
    const error = await resolveSecrets(
      ["secret://env/SET", "secret://env/UNSET"],
      {},
      { env: { SET: VALUE } },
    ).catch((e: unknown) => e);
    expect(JSON.stringify(error)).not.toContain(VALUE);
    expect((error as Error).message).not.toContain(VALUE);
  });
});

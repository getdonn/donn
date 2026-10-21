import { describe, expect, it } from "vitest";
import {
  defineSecretProvider,
  SECRET_PROVIDER_API_VERSION,
  SecretProviderDeclarationError,
  type SecretBackend,
} from "./index.js";

const resolve: SecretBackend["resolve"] = async (path) => `v-${path}`;

describe("defineSecretProvider", () => {
  it("stamps the contract version", () => {
    expect(SECRET_PROVIDER_API_VERSION).toBe(1);
    expect(
      defineSecretProvider({ type: "fake-vault", resolve }).apiVersion,
    ).toBe(1);
  });

  it("rejects a bad or built-in type and a missing resolve", () => {
    for (const type of ["", "Bad_Type", "env", "keychain"]) {
      expect(() => defineSecretProvider({ type, resolve })).toThrow(
        SecretProviderDeclarationError,
      );
    }
    expect(() =>
      defineSecretProvider({ type: "x" } as unknown as SecretBackend),
    ).toThrow(SecretProviderDeclarationError);
  });

  it("keeps a class instance's resolve bound", async () => {
    class Provider {
      readonly type = "class-vault";
      readonly prefix = "c-";
      async resolve(path: string) {
        return `${this.prefix}${path}`;
      }
    }
    const provider = defineSecretProvider(new Provider());
    expect(await provider.resolve("x", {}, {} as never)).toBe("c-x");
  });
});

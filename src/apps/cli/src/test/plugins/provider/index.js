import { defineSecretProvider } from "@zzpersona/secrets";

// Test-only: a secret provider package. Never do this with real values.

export default defineSecretProvider({
  type: "fake-vault",
  resolve: async (path) => `v-${path}`,
});

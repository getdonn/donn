import { describe, expect, it } from "vitest";
import { registryConformance } from "./conformance.js";
import { startMockRegistry } from "./mock.js";

registryConformance(() => startMockRegistry());

describe("startMockRegistry", () => {
  it("uses the token it is given", async () => {
    const mock = await startMockRegistry({ token: "custom", subject: "ann" });
    try {
      expect(mock.token).toBe("custom");
      const response = await fetch(`${mock.url}/v1/whoami`, {
        headers: { authorization: "Bearer custom" },
      });
      expect(await response.json()).toEqual({ subject: "ann", org: "acme" });
    } finally {
      await mock.stop();
    }
  });
});

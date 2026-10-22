import { describe, expect, it } from "vitest";
import { RegistryError } from "./client.js";
import { normaliseUrl, routeUrl } from "./url.js";

describe("normaliseUrl", () => {
  it("URLs are normalised", () => {
    expect(normaliseUrl("https://Reg.corp/zz")).toBe("https://reg.corp/zz/");
    expect(normaliseUrl("https://reg.corp/zz/")).toBe(
      normaliseUrl("https://Reg.corp/zz"),
    );
    expect(normaliseUrl("HTTPS://reg.corp")).toBe("https://reg.corp/");
    const base = normaliseUrl("https://reg.corp/zz");
    expect(routeUrl(base, "/v1/whoami", {}).href).toBe(
      "https://reg.corp/zz/v1/whoami",
    );
    expect(
      routeUrl(base, "/v1/layers/{ref}/versions/{version}", {
        ref: "team/web",
        version: "latest",
      }).href,
    ).toBe("https://reg.corp/zz/v1/layers/team%2Fweb/versions/latest");
  });

  it("http is refused except loopback", () => {
    for (const ok of [
      "http://127.0.0.1:8080",
      "http://localhost:3000/x",
      "http://[::1]:9000",
    ]) {
      expect(() => normaliseUrl(ok)).not.toThrow();
    }
    for (const bad of ["http://reg.corp", "http://10.0.0.1", "ftp://x.test"]) {
      expect(() => normaliseUrl(bad)).toThrow(RegistryError);
      try {
        normaliseUrl(bad);
      } catch (error) {
        expect((error as RegistryError).code).toBe("insecure-url");
      }
    }
  });
});

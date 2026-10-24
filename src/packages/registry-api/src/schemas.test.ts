import { describe, expect, it } from "vitest";
import {
  ConformanceSchemas,
  LayerVersion,
  LoginToken,
  ManagedBundleResponse,
  Problem,
  PublishResult,
  Whoami,
  grantCovers,
} from "./schemas.js";

describe("tolerant schemas", () => {
  it("tolerant schemas read older and newer answers", () => {
    expect(Whoami.parse({ subject: "ann", org: "acme" })).toEqual({
      subject: "ann",
      org: "acme",
    });
    expect(
      Whoami.parse({
        subject: "ann",
        org: "acme",
        teapot: true,
        kind: "session",
      }),
    ).toEqual({ subject: "ann", org: "acme", kind: "session" });
    expect(
      Whoami.parse({
        subject: "ann",
        org: "acme",
        kind: "robot",
        roles: [{ role: "admin", path: "*" }],
        expiresAt: "2030-01-01T00:00:00+00:00",
      }),
    ).toEqual({
      subject: "ann",
      org: "acme",
      kind: "robot",
      roles: [{ role: "admin", path: "*" }],
      expiresAt: "2030-01-01T00:00:00+00:00",
    });
    expect(
      ConformanceSchemas.Whoami.safeParse({
        subject: "a",
        org: "b",
        kind: "robot",
      }).success,
    ).toBe(false);
    expect(
      ConformanceSchemas.Whoami.safeParse({
        subject: "a",
        org: "b",
        roles: [{ role: "admin", path: "*" }],
      }).success,
    ).toBe(false);
    const token = {
      token: "t",
      subject: "s",
      expiresAt: "2030-01-01T00:00:00+00:00",
    };
    expect(LoginToken.safeParse(token).success).toBe(true);
    expect(ConformanceSchemas.LoginToken.safeParse(token).success).toBe(false);
    expect(
      ConformanceSchemas.Whoami.safeParse({
        subject: "a",
        org: "b",
        expiresAt: "2030-01-01T00:00:00+00:00",
      }).success,
    ).toBe(false);
    const problem = Problem.parse({
      type: "urn:x",
      title: "t",
      status: 418,
      detail: "d",
      problems: [{ code: "teapot", message: "m", extra: 1 }],
    });
    expect(problem.problems?.[0]?.code).toBe("teapot");
  });

  it("the strict copies refuse unknown fields", () => {
    expect(
      ConformanceSchemas.Whoami.safeParse({
        subject: "ann",
        org: "acme",
        teapot: true,
      }).success,
    ).toBe(false);
    expect(
      ConformanceSchemas.Problem.safeParse({
        type: "urn:x",
        title: "t",
        status: 418,
        detail: "d",
        problems: [{ code: "teapot", message: "m" }],
      }).success,
    ).toBe(false);
  });
});

describe("grantCovers", () => {
  it("matches whole segments", () => {
    expect(grantCovers("team/pay", "team/payments")).toBe(false);
    expect(grantCovers("team", "team/payments")).toBe(true);
    expect(grantCovers("*", "org/x")).toBe(true);
    expect(grantCovers("team/payments", "team/payments")).toBe(true);
  });
});

const digest = `sha256:${"a".repeat(64)}`;

describe("tolerant results", () => {
  it("a dry run or unchanged result is never read as a publish", () => {
    const dry = PublishResult.parse({
      dryRun: true,
      diff: [],
      broken: [],
      version: 1,
      digest,
    });
    expect(dry).toMatchObject({ dryRun: true });
    const unchanged = PublishResult.parse({
      unchanged: true,
      version: 1,
      digest,
      broken: [],
    });
    expect(unchanged).toMatchObject({ unchanged: true });
  });

  it("a layer version whose file has an extra field parses", () => {
    const version = {
      ref: "org/base",
      version: 1,
      digest,
      source: "x",
      files: [{ path: "a.md", content: "YQ==", size: 1 }],
      publishedAt: "2026-10-22T00:00:00.000Z",
      publishedBy: "ann",
    };
    expect(LayerVersion.parse(version).files).toEqual([
      { path: "a.md", content: "YQ==" },
    ]);
    expect(ConformanceSchemas.LayerVersion.safeParse(version).success).toBe(
      false,
    );
  });

  it("strict problem items refuse unknown fields", () => {
    expect(
      ConformanceSchemas.Problem.safeParse({
        type: "urn:x",
        title: "t",
        status: 404,
        detail: "d",
        problems: [{ code: "not-found", message: "m", extra: 1 }],
      }).success,
    ).toBe(false);
  });
});

describe("managed bundle response", () => {
  const manifest = {
    format: 1,
    donn: "0.1.0",
    os: "linux",
    layers: [
      { ref: "org/acme", version: 1, digest: `sha256:${"a".repeat(64)}` },
    ],
    files: { "managed-settings.d/50-donn.json": "b".repeat(64) },
    report: { entries: [], warnings: [] },
  };
  const answer = {
    manifest,
    files: { "managed-settings.d/50-donn.json": "e30=" },
  };

  it("the client schema strips unknown keys; the kit's copy refuses them", () => {
    const extra = { ...answer, teapot: true };
    expect(ManagedBundleResponse.parse(extra)).toEqual(answer);
    expect(
      ConformanceSchemas.ManagedBundleResponse.safeParse(answer).error,
    ).toBeUndefined();
    expect(
      ConformanceSchemas.ManagedBundleResponse.safeParse(extra).success,
    ).toBe(false);
    expect(
      ManagedBundleResponse.parse({
        ...answer,
        manifest: { ...manifest, future: 1 },
      }).manifest,
    ).toEqual(manifest);
  });

  it("files must be base64 and the manifest a format 1 manifest", () => {
    expect(
      ManagedBundleResponse.safeParse({
        ...answer,
        files: { a: "not base64!" },
      }).success,
    ).toBe(false);
    expect(
      ManagedBundleResponse.safeParse({
        ...answer,
        manifest: { ...manifest, format: 2 },
      }).success,
    ).toBe(false);
  });
});

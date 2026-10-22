import { describe, expect, it } from "vitest";
import { ConformanceSchemas, Problem, Whoami, grantCovers } from "./schemas.js";

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

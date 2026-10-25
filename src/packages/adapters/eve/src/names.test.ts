import { describe, expect, it } from "vitest";
import { connectionName, skillName } from "./names.js";

describe("connectionName", () => {
  it("lowercases, maps _ to - and adds the donn- prefix", () => {
    expect(connectionName("my_db")).toBe("donn-my-db");
    expect(connectionName("My-DB")).toBe("donn-my-db");
    expect(connectionName("github")).toBe("donn-github");
  });

  it("refuses a character eve's rule does not allow", () => {
    expect(connectionName("Café")).toBeUndefined();
    expect(connectionName("a.b")).toBeUndefined();
  });

  it("allows 64 characters with the prefix and refuses 65", () => {
    expect(connectionName("a".repeat(59))).toHaveLength(64);
    expect(connectionName("a".repeat(60))).toBeUndefined();
    expect(connectionName("a".repeat(65))).toBeUndefined();
  });
});

describe("skillName", () => {
  it("keeps the name after the prefix", () => {
    expect(skillName("review-conventions")).toBe("donn-review-conventions");
    expect(skillName("Review_Conventions")).toBe("donn-Review_Conventions");
  });

  it("refuses a name eve rejects or that is too long", () => {
    expect(skillName("café")).toBeUndefined();
    expect(skillName("a b")).toBeUndefined();
    expect(skillName("a".repeat(59))).toHaveLength(64);
    expect(skillName("a".repeat(60))).toBeUndefined();
  });
});

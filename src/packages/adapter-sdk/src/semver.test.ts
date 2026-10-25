import { describe, expect, it } from "vitest";
import { satisfiesRange } from "./semver.js";

describe("satisfiesRange", () => {
  it("matches a version inside a range", () => {
    expect(satisfiesRange("0.83.5", ">=0.83.2 <0.84.0")).toBe(true);
    expect(satisfiesRange("0.83.2", ">=0.83.2 <0.84.0")).toBe(true);
  });

  it("refuses a version outside it", () => {
    expect(satisfiesRange("0.84.0", ">=0.83.2 <0.84.0")).toBe(false);
    expect(satisfiesRange("0.83.1", ">=0.83.2 <0.84.0")).toBe(false);
  });

  it("reads caret, tilde and exact comparators", () => {
    expect(satisfiesRange("0.83.9", "^0.83.2")).toBe(true);
    expect(satisfiesRange("0.84.0", "^0.83.2")).toBe(false);
    expect(satisfiesRange("1.4.0", "^1.2.0")).toBe(true);
    expect(satisfiesRange("1.2.9", "~1.2.0")).toBe(true);
    expect(satisfiesRange("1.3.0", "~1.2.0")).toBe(false);
    expect(satisfiesRange("1.2.3", "1.2.3")).toBe(true);
  });

  it("refuses anything that is not a plain version", () => {
    expect(satisfiesRange("x", ">=0.0.0")).toBe(false);
    expect(satisfiesRange("1.0.0-rc.1", ">=0.0.0")).toBe(false);
  });
});

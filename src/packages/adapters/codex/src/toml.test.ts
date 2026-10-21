import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { tomlKey, tomlString, tomlValue } from "./toml.js";

describe("toml", () => {
  it("encodes instructions as a TOML string Codex reads back", () => {
    const text = 'Line "one"\n\tC:\\path """ end ✨ \u0001\r\nlast';
    expect(parse(`v = ${tomlString(text)}`).v).toBe(text);
  });

  it("refuses keys that are not bare, since Codex splits -c keys on every dot", () => {
    expect(tomlKey("payments-schema")).toBe("payments-schema");
    expect(() => tomlKey("my.server")).toThrow(/not a bare key/);
    expect(() => tomlKey("with space")).toThrow(/not a bare key/);
  });

  it("encodes arrays and inline tables with sorted keys", () => {
    expect(tomlValue(["a", 'b"'])).toBe('["a", "b\\""]');
    const table = tomlValue({ Z: "1", A: 'x"y' });
    expect(table).toBe('{ A = "x\\"y", Z = "1" }');
    expect(parse(`t = ${table}`).t).toEqual({ A: 'x"y', Z: "1" });
  });
});

import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { tomlKey, tomlString, tomlValue } from "./toml.js";

describe("toml", () => {
  it("encodes instructions as a TOML string Codex reads back", () => {
    const text = 'Line "one"\n\tC:\\path """ end ✨ \u0001\r\nlast';
    expect(parse(`v = ${tomlString(text)}`).v).toBe(text);
  });

  it("quotes server names that are not bare keys", () => {
    expect(tomlKey("payments-schema")).toBe("payments-schema");
    expect(tomlKey("my.server")).toBe('"my.server"');
    expect(tomlKey("with space")).toBe('"with space"');
    expect(parse(`${tomlKey("my.server")} = 1`)).toEqual({ "my.server": 1 });
  });

  it("encodes arrays and inline tables with sorted keys", () => {
    expect(tomlValue(["a", 'b"'])).toBe('["a", "b\\""]');
    const table = tomlValue({ Z: "1", A: 'x"y' });
    expect(table).toBe('{ A = "x\\"y", Z = "1" }');
    expect(parse(`t = ${table}`).t).toEqual({ A: 'x"y', Z: "1" });
  });
});

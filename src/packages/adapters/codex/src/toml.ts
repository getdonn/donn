// TOML for Codex's `-c key=value` overrides: Codex parses each value as TOML, so every string is a
// basic string with its escapes, and keys that are not bare are quoted.

export function tomlString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === "\\") out += "\\\\";
    else if (char === '"') out += '\\"';
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f)
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += char;
  }
  return `${out}"`;
}

const BARE = /^[A-Za-z0-9_-]+$/;

/** A key in a `-c` path. Codex splits those on every dot, quotes or not, so only bare keys work. */
export function tomlKey(key: string): string {
  if (!BARE.test(key))
    throw new Error(`${JSON.stringify(key)} is not a bare key`);
  return key;
}

/** A key inside a value, which Codex does parse as TOML. */
const tableKey = (key: string) => (BARE.test(key) ? key : tomlString(key));

export type TomlInput = string | string[] | { [key: string]: TomlInput };

export function tomlValue(value: TomlInput): string {
  if (typeof value === "string") return tomlString(value);
  if (Array.isArray(value)) return `[${value.map(tomlString).join(", ")}]`;
  const keys = Object.keys(value).sort();
  return keys.length === 0
    ? "{}"
    : `{ ${keys.map((k) => `${tableKey(k)} = ${tomlValue(value[k]!)}`).join(", ")} }`;
}

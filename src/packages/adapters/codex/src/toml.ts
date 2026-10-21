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

export function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

export type TomlInput = string | string[] | { [key: string]: TomlInput };

export function tomlValue(value: TomlInput): string {
  if (typeof value === "string") return tomlString(value);
  if (Array.isArray(value)) return `[${value.map(tomlString).join(", ")}]`;
  const keys = Object.keys(value).sort();
  return keys.length === 0
    ? "{}"
    : `{ ${keys.map((k) => `${tomlKey(k)} = ${tomlValue(value[k]!)}`).join(", ")} }`;
}

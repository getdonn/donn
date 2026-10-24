import type { ResolvedPersona } from "@getdonn/spec";

/**
 * Whether a relative path stays inside its root: not empty, not absolute (POSIX, drive letter,
 * UNC or root-relative Windows), and no `..` segment. Adapters check copyFrom sources with it;
 * the CLI must still re-check real paths, symlinks included, when it copies.
 */
export function isContainedPath(path: string): boolean {
  if (path === "" || /^[\\/]/.test(path) || /^[A-Za-z]:/.test(path))
    return false;
  return !path.split(/[\\/]/).includes("..");
}

/** Every secret ref inside `value`, with its path below `prefix` (dotted keys, array indexes). */
export function secretRefsIn(
  value: unknown,
  prefix: string,
): { path: string; ref: string }[] {
  if (typeof value === "string") {
    return value.startsWith("secret://") ? [{ path: prefix, ref: value }] : [];
  }
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    secretRefsIn(child, `${prefix}.${key}`),
  );
}

/** Secret refs in MCP server definitions: env, headers, args, url. */
export const serverSecretRefs = (ir: ResolvedPersona) =>
  Object.entries(ir.mcp.servers).flatMap(([name, server]) =>
    secretRefsIn(server, `mcp.servers.${name}`),
  );

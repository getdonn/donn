import type { ManagedOs } from "@zzpersona/adapter-sdk";

// Where Claude Code reads managed policy files on each OS (code.claude.com/docs/en/managed-mcp,
// "Deploy managed-mcp.json"; read 2026-10-23).

export const MANAGED_ROOTS: Record<ManagedOs, string> = {
  macos: "/Library/Application Support/ClaudeCode",
  linux: "/etc/claude-code",
  windows: "C:\\Program Files\\ClaudeCode",
};

/** A bundle file's absolute path once installed on `os`; `relative` is `/`-separated. */
export function installedPath(os: ManagedOs, relative: string): string {
  return os === "windows"
    ? `${MANAGED_ROOTS[os]}\\${relative.replaceAll("/", "\\")}`
    : `${MANAGED_ROOTS[os]}/${relative}`;
}

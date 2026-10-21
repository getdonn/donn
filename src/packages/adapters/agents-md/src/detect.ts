import type { Detection } from "@zzpersona/adapter-sdk";

// AGENTS.md is a file format, not a program: there is nothing to look for.

export async function detect(): Promise<Detection> {
  return { installed: true, version: "n/a", facts: {} };
}

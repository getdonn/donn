import type { CapabilityMatrix } from "@zzpersona/adapter-sdk";
import { HOOK_EVENTS } from "@zzpersona/spec";

// AGENTS.md is plain text that tools read as instructions: instructions are native, knowledge is
// a list of pointers, permissions become guidance, and everything else has no place in it.

const native = { support: "native" } as const;
const none = { support: "none" } as const;
const guidance = {
  support: "approximated",
  note: "rendered as guidance; not enforced",
} as const;

export function capabilities(): CapabilityMatrix {
  return {
    fields: {
      instructions: native,
      knowledge: {
        support: "advisory",
        note: "listed as pointers in AGENTS.md",
      },
      "permissions.allow": guidance,
      "permissions.deny": guidance,
      "permissions.ask": guidance,
      skills: none,
      "mcp.servers": none,
      secrets: none,
      "targets.agents-md": none,
      ...Object.fromEntries(
        HOOK_EVENTS.map((event) => [`hooks.${event}`, none]),
      ),
    },
  };
}

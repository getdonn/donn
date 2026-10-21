import type { CapabilityMatrix } from "@zzpersona/adapter-sdk";
import { HOOK_EVENTS } from "@zzpersona/spec";

// What a Codex launch can carry per invocation (spikes/codex/FINDINGS.md).

const native = { support: "native" } as const;
const none = { support: "none" } as const;
const guidance = {
  support: "approximated",
  note: "sandbox and approval policy, rules as guidance; MCP tool allow rules are exact",
} as const;

export function capabilities(): CapabilityMatrix {
  return {
    fields: {
      instructions: native,
      "mcp.servers": native,
      secrets: native,
      knowledge: {
        support: "advisory",
        note: "listed as pointers in the instructions",
      },
      "permissions.allow": guidance,
      "permissions.deny": guidance,
      "permissions.ask": guidance,
      skills: none,
      "targets.codex": native,
      ...Object.fromEntries(
        HOOK_EVENTS.map((event) => [`hooks.${event}`, none]),
      ),
    },
  };
}

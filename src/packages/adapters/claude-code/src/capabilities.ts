import type { CapabilityMatrix } from "@zzpersona/adapter-sdk";
import { HOOK_EVENTS } from "@zzpersona/spec";

// What the relaunch path can express. Degraded modes (managed settings) drop more, per compile,
// and say so in the report; this matrix is the full-capability declaration.

const native = { support: "native" } as const;

export function capabilities(): CapabilityMatrix {
  return {
    fields: {
      instructions: native,
      skills: native,
      "mcp.servers": native,
      secrets: native,
      "permissions.allow": native,
      "permissions.deny": native,
      "permissions.ask": native,
      knowledge: {
        support: "advisory",
        note: "listed as pointers in the system prompt",
      },
      "targets.claude-code": native,
      ...Object.fromEntries(
        HOOK_EVENTS.map((event) => [`hooks.${event}`, native]),
      ),
    },
  };
}

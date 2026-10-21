import type { CapabilityMatrix, Detection } from "@zzpersona/adapter-sdk";
import { HOOK_EVENTS } from "@zzpersona/spec";
import { modeFor } from "./compile.js";

// What the relaunch path can express, and, given a detection, what its degraded mode can: managed
// settings that block sideload flags lose the plugin and MCP flags; managed-mcp.json loses MCP.

const native = { support: "native" } as const;
const none = { support: "none" } as const;

export function capabilities(detection?: Detection): CapabilityMatrix {
  const mode = detection ? modeFor(detection) : "relaunch";
  const plugin = mode === "partial" ? none : native;
  const mcp = mode === "relaunch" ? native : none;
  return {
    fields: {
      instructions: native,
      skills: plugin,
      "mcp.servers": mcp,
      secrets: mcp,
      "permissions.allow": native,
      "permissions.deny": native,
      "permissions.ask": native,
      knowledge: {
        support: "advisory",
        note: "listed as pointers in the system prompt",
      },
      "targets.claude-code": native,
      ...Object.fromEntries(
        HOOK_EVENTS.map((event) => [`hooks.${event}`, plugin]),
      ),
    },
  };
}

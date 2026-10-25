import type { CapabilityMatrix, Detection } from "@getdonn/adapter-sdk";
import { HOOK_EVENTS } from "@getdonn/spec";
import { modeFor } from "./compile.js";

// What the relaunch path can express, and, given a detection, what its degraded mode can: managed
// settings that block sideload flags lose the plugin and MCP flags; managed-mcp.json loses MCP.

const native = { support: "native" } as const;
const SIDELOAD_BLOCKED = {
  support: "none",
  note: "disableSideloadFlags blocks --plugin-dir and --mcp-config",
} as const;
const MANAGED_MCP = {
  support: "none",
  note: "managed-mcp.json makes --mcp-config exit",
} as const;

export function capabilities(detection?: Detection): CapabilityMatrix {
  const mode = detection ? modeFor(detection) : "relaunch";
  const plugin = mode === "partial" ? SIDELOAD_BLOCKED : native;
  const mcp =
    mode === "relaunch"
      ? native
      : mode === "partial"
        ? SIDELOAD_BLOCKED
        : MANAGED_MCP;
  return {
    fields: {
      instructions: native,
      skills:
        plugin === native
          ? { ...native, caveat: "registry skills (:// sources) are dropped" }
          : plugin,
      "mcp.servers":
        mcp === native
          ? {
              ...native,
              caveat:
                "gateway:// refs are dropped until gateway resolution exists",
            }
          : mcp,
      secrets: mcp,
      "permissions.allow": native,
      "permissions.deny": native,
      "permissions.ask": native,
      knowledge: {
        support: "advisory",
        note: "rendered as text in the system prompt",
      },
      "targets.claude-code": {
        ...native,
        caveat: "secret refs and permission lists in targets are dropped",
      },
      ...Object.fromEntries(
        HOOK_EVENTS.map((event) => [`hooks.${event}`, plugin]),
      ),
      // Enforced by the managed policy bundle, which a launch's mode does not change.
      policy: { ...native, note: "managed policy bundle" },
      models: {
        support: "none",
        note: "Not yet: Claude Code reads a gateway from ANTHROPIC_BASE_URL; a later spec",
      },
    },
  };
}

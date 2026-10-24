import type { CapabilityMatrix } from "@getdonn/adapter-sdk";
import { HOOK_EVENTS } from "@getdonn/spec";

// What a Codex launch can carry per invocation (spikes/codex/FINDINGS.md). The notes are the
// report's reasons.

const native = { support: "native" } as const;
const guidance = {
  support: "approximated",
  note: "rendered as guidance; Codex enforces only its sandbox and approval policy",
} as const;
const hooks = {
  support: "none",
  note: "untrusted hooks do not run, and donn never bypasses Codex's hook trust",
} as const;

const POLICY = {
  support: "none",
  note: "not rendered; enforced only by managed bundles for Claude Code",
} as const;

export function capabilities(): CapabilityMatrix {
  return {
    fields: {
      instructions: native,
      "mcp.servers": {
        ...native,
        caveat:
          "gateway refs, URL-server headers, and servers whose secret cannot be forwarded by name are dropped; see the report",
      },
      secrets: native,
      knowledge: {
        support: "advisory",
        note: "listed as pointers in the instructions",
      },
      "permissions.allow": {
        ...guidance,
        caveat: "MCP tool allow rules with bare tool names become approvals",
      },
      "permissions.deny": guidance,
      "permissions.ask": guidance,
      skills: { support: "none", note: "Codex has no per-launch skill root" },
      "targets.codex": {
        ...native,
        caveat: "only sandbox, approval and model are read",
      },
      policy: POLICY,
      ...Object.fromEntries(
        HOOK_EVENTS.map((event) => [`hooks.${event}`, hooks]),
      ),
    },
  };
}

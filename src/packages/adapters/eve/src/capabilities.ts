import type { CapabilityMatrix } from "@getdonn/adapter-sdk";
import { HOOK_EVENTS } from "@getdonn/spec";

// What an eve agent takes from a persona. See docs/planning/24-adapter-eve.md, section 3.
// The note on each field that is not native is the reason the report gives for its items.

const native = { support: "native" } as const;
const none = (note: string) => ({ support: "none", note }) as const;

export function capabilities(): CapabilityMatrix {
  return {
    fields: {
      instructions: native,
      skills: {
        ...native,
        caveat:
          "supporting scripts/ run only where the agent has a sandbox, which is eve's rule; eve names the skill from its directory and requires description frontmatter in SKILL.md, so a skill without one is dropped",
      },
      "mcp.servers": {
        ...native,
        caveat:
          "stdio servers and gateway:// refs are dropped: eve connects to HTTP MCP and OpenAPI only",
      },
      knowledge: {
        support: "advisory",
        note: "listed as pointers in instructions/donn.md",
      },
      secrets: native,
      "permissions.allow": none(
        "Harness permission rules do not map to eve; eve's tool allow-lists per connection are a later mapping",
      ),
      "permissions.deny": none(
        "Harness permission rules do not map to eve; eve's tool allow-lists per connection are a later mapping",
      ),
      "permissions.ask": none(
        "Harness permission rules do not map to eve; eve's tool allow-lists per connection are a later mapping",
      ),
      policy: none(
        "Managed policy is harness enforcement; eve has no managed surface",
      ),
      models: native,
      "targets.eve": {
        ...native,
        caveat:
          "contextWindow sets modelContextWindowTokens; unknown keys are reported",
      },
      ...Object.fromEntries(
        HOOK_EVENTS.map((event) => [
          `hooks.${event}`,
          none(
            "eve hooks are TypeScript modules; author them in the agent's hooks/",
          ),
        ]),
      ),
    },
  };
}

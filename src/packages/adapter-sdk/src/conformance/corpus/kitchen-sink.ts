import { HOOK_EVENTS, type Hook, type HookEvent } from "@zzpersona/spec";
import type { CorpusEntry } from "./index.js";

/**
 * Everything at once: every hook event, every MCP server form, a repeated secret ref, a local and
 * a registry skill, a lock on several fields, a 20 000-character instruction, and target blocks
 * for two harnesses.
 */
export const kitchenSink: CorpusEntry = {
  name: "kitchen-sink",
  personaId: "team/kitchen",
  texts: { "org/instructions/rules.md": "Follow the org rules." },
  ir: {
    irVersion: 0,
    layers: ["org/base", "team/kitchen"],
    metadata: { name: "kitchen-sink", labels: { team: "kitchen" } },
    instructions: [
      { id: "rules", file: "org/instructions/rules.md" },
      { id: "long", inline: "Keep going. ".repeat(1667).slice(0, 20000) },
    ],
    skills: [
      { name: "local-skill", source: "team/skills/local-skill" },
      { name: "remote-skill", source: "registry://org/skills/remote-skill@^1" },
    ],
    mcp: {
      gateway: "bifrost://corp",
      servers: {
        db: {
          command: "npx",
          args: ["-y", "@corp/db-mcp"],
          env: {
            TOKEN: "secret://vault/db/token",
            TOKEN_AGAIN: "secret://vault/db/token",
            URL: "secret://vault/db/url",
            LOG_LEVEL: "debug",
          },
        },
        jira: { ref: "gateway://jira" },
        remote: {
          url: "https://mcp.corp/sse",
          transport: "sse",
          headers: { "X-Team": "kitchen" },
        },
      },
    },
    permissions: {
      allow: ["Read(./**)"],
      deny: ["Bash(rm -rf:*)"],
      ask: ["Bash(git push:*)"],
    },
    hooks: Object.fromEntries(
      HOOK_EVENTS.map((event): [HookEvent, Hook[]] => [
        event,
        [
          {
            id: `${event}-hook`,
            run: `org/hooks/${event}.sh`,
            ...(event === "pre-tool-use" && { matcher: "Bash" }),
          },
        ],
      ]),
    ),
    knowledge: [{ id: "wiki", source: "mcp://confluence?space=ENG" }],
    secrets: { providers: { vault: { type: "hashicorp-vault" } } },
    locks: [
      { path: "permissions.deny", layer: "org/base" },
      { path: "mcp.servers", layer: "org/base" },
      { path: "hooks.notification", layer: "org/base" },
    ],
    targets: {
      "claude-code": { model: "opus", strictMcp: false },
      codex: { approvalPolicy: "on-request" },
    },
  },
};

import { posix } from "node:path";
import {
  AdapterInputError,
  annotateLocks,
  assertIrVersion,
  type CompileInput,
  type CompileOutput,
  type Detection,
  type FileEntry,
  type HarnessAdapter,
  type ReportEntry,
  type SecretRef,
} from "@zzpersona/adapter-sdk";
import type { HookEvent, McpServer, ResolvedPersona } from "@zzpersona/spec";

// A resolved persona as a Claude Code build for the relaunch path: a plugin (skills, hooks), a
// settings fragment (permissions, targets), an MCP config, and a system prompt. See
// docs/planning/05-adapter-sdk.md, section 5, and spikes/claude-code/FINDINGS.md.

const NATIVE_EVENTS: Record<HookEvent, string> = {
  "session-start": "SessionStart",
  "session-end": "SessionEnd",
  "user-prompt-submit": "UserPromptSubmit",
  "pre-tool-use": "PreToolUse",
  "post-tool-use": "PostToolUse",
  stop: "Stop",
  "subagent-stop": "SubagentStop",
  "pre-compact": "PreCompact",
  notification: "Notification",
};

/** Keys in targets.claude-code the adapter consumes instead of writing to settings. */
const ADAPTER_KEYS = new Set(["strictMcp"]);

const asJson = (value: unknown): FileEntry => ({
  content: `${JSON.stringify(value, null, 2)}\n`,
});

export const pluginName = (personaId: string) =>
  `zzp-${personaId.replaceAll("/", "-")}`;

function systemPrompt(
  ir: ResolvedPersona,
  texts: Record<string, string>,
): string | undefined {
  const parts = ir.instructions.map((fragment) => {
    if ("inline" in fragment) return fragment.inline.trimEnd();
    const text = texts[fragment.file];
    if (text === undefined) {
      throw new AdapterInputError(
        `no text supplied for instruction file ${fragment.file}`,
      );
    }
    return text.trimEnd();
  });
  if (ir.knowledge.length > 0) {
    parts.push(
      `## Knowledge sources\n${ir.knowledge.map((k) => `- ${k.id}: ${k.source}`).join("\n")}`,
    );
  }
  return parts.length === 0 ? undefined : `${parts.join("\n\n")}\n`;
}

/** Servers in Claude Code's .mcp.json shape, with secret refs swapped for env placeholders. */
function mcpConfig(ir: ResolvedPersona, dropped: ReportEntry[]) {
  const secretEnv: Record<string, SecretRef> = {};
  const placeholder = new Map<string, string>();
  const hide = (value: string) => {
    if (!value.startsWith("secret://")) return value;
    let name = placeholder.get(value);
    if (name === undefined) {
      name = `ZZP_SECRET_${placeholder.size + 1}`;
      placeholder.set(value, name);
      secretEnv[name] = value as SecretRef;
    }
    return `\${${name}}`;
  };
  const sortedHidden = (record: Record<string, string>) =>
    Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, hide(record[key]!)]),
    );

  const servers: Record<string, unknown> = {};
  for (const name of Object.keys(ir.mcp.servers).sort()) {
    const server: McpServer = ir.mcp.servers[name]!;
    if ("ref" in server) {
      dropped.push({
        path: `mcp.servers.${name}`,
        outcome: "dropped",
        reason:
          "gateway:// refs need gateway resolution, which is not available yet",
      });
    } else if ("command" in server) {
      servers[name] = {
        command: server.command,
        ...(server.args && { args: server.args }),
        ...(server.env && { env: sortedHidden(server.env) }),
      };
    } else {
      servers[name] = {
        type: server.transport ?? "http",
        url: server.url,
        ...(server.headers && { headers: sortedHidden(server.headers) }),
      };
    }
  }
  return { servers, secretEnv };
}

export type Mode = "relaunch" | "partial" | "relaunch-no-mcp";

const SIDELOAD_BLOCKED =
  "disableSideloadFlags blocks --plugin-dir and --mcp-config";
const MANAGED_MCP = "managed-mcp.json makes --mcp-config exit";

/** Managed settings decide what the launch may carry; sideload blocking wins. */
export function modeFor(detection: Detection): Mode {
  if (detection.facts.sideloadBlocked === true) return "partial";
  if (detection.facts.managedMcp === true) return "relaunch-no-mcp";
  return "relaunch";
}

const skillPaths = (ir: ResolvedPersona) =>
  ir.skills.map((s) => `skills[${s.name}]`);
const serverPaths = (ir: ResolvedPersona) =>
  Object.keys(ir.mcp.servers)
    .sort()
    .map((name) => `mcp.servers.${name}`);
const hookPaths = (ir: ResolvedPersona) =>
  Object.entries(ir.hooks).flatMap(([event, list]) =>
    (list ?? []).map((hook) => `hooks.${event}[${hook.id}]`),
  );

function dropAll(entries: ReportEntry[], paths: string[], reason: string) {
  for (const path of paths) entries.push({ path, outcome: "dropped", reason });
}

/** The plugin: manifest, skills and hooks. */
function pluginFiles(
  ir: ResolvedPersona,
  personaId: string,
  files: Record<string, FileEntry>,
  entries: ReportEntry[],
) {
  files["plugin/.claude-plugin/plugin.json"] = asJson({
    name: pluginName(personaId),
    version: "0.0.0",
    description: `Persona ${ir.metadata.name}`,
  });

  for (const skill of ir.skills) {
    if (skill.source.includes("://")) {
      entries.push({
        path: `skills[${skill.name}]`,
        outcome: "dropped",
        reason: "skill registries are not supported in v0",
      });
    } else {
      files[`plugin/skills/${skill.name}`] = { copyFrom: skill.source };
    }
  }

  const hooks: Record<string, unknown[]> = {};
  for (const [event, list] of Object.entries(ir.hooks) as [
    HookEvent,
    typeof ir.hooks.stop,
  ][]) {
    for (const hook of list ?? []) {
      const script = `${hook.id}-${posix.basename(hook.run)}`;
      files[`plugin/hooks/scripts/${script}`] = {
        copyFrom: hook.run,
        mode: 0o755,
      };
      (hooks[NATIVE_EVENTS[event]] ??= []).push({
        ...(hook.matcher !== undefined && { matcher: hook.matcher }),
        hooks: [
          {
            type: "command",
            command: `\${CLAUDE_PLUGIN_ROOT}/hooks/scripts/${script}`,
          },
        ],
      });
    }
  }
  if (Object.keys(hooks).length > 0)
    files["plugin/hooks/hooks.json"] = asJson({ hooks });
}

export function compile(
  input: CompileInput,
  self: HarnessAdapter,
): CompileOutput {
  const { ir, personaId, texts } = input;
  assertIrVersion(self, ir);
  const entries: ReportEntry[] = [];
  const files: Record<string, FileEntry> = {};

  const prompt = systemPrompt(ir, texts);
  if (prompt !== undefined) files["system-prompt.md"] = { content: prompt };
  for (const k of ir.knowledge) {
    entries.push({
      path: `knowledge[${k.id}]`,
      outcome: "advisory",
      reason: "rendered as text in the system prompt",
    });
  }

  const mode = modeFor(input.detection);
  let secretEnv: Record<string, SecretRef> = {};
  if (mode === "partial") {
    dropAll(
      entries,
      [...skillPaths(ir), ...hookPaths(ir), ...serverPaths(ir)],
      SIDELOAD_BLOCKED,
    );
  } else {
    pluginFiles(ir, personaId, files, entries);
  }
  if (mode === "relaunch") {
    const mcp = mcpConfig(ir, entries);
    secretEnv = mcp.secretEnv;
    files["mcp.json"] = asJson({ mcpServers: mcp.servers });
  } else if (mode === "relaunch-no-mcp") {
    dropAll(entries, serverPaths(ir), MANAGED_MCP);
  }

  const targets = Object.fromEntries(
    Object.entries(ir.targets["claude-code"] ?? {}).filter(
      ([key]) => !ADAPTER_KEYS.has(key),
    ),
  );
  files["settings.json"] = asJson({ permissions: ir.permissions, ...targets });

  return {
    files,
    secretEnv,
    report: annotateLocks(
      { adapter: self.id, irVersion: ir.irVersion, mode, entries },
      ir,
    ),
  };
}

import {
  AdapterInputError,
  annotateLocks,
  assertIrVersion,
  requiredEntries,
  type CompileInput,
  type CompileOutput,
  type HarnessAdapter,
  type ReportEntry,
  type SecretRef,
} from "@zzpersona/adapter-sdk";
import type { McpServer, ResolvedPersona } from "@zzpersona/spec";
import { capabilities } from "./capabilities.js";
import type { TomlInput } from "./toml.js";

// A persona as a Codex launch: instructions for `developer_instructions`, MCP servers as `-c`
// tables with secrets forwarded by name, MCP tool approvals, and sandbox settings. activate turns
// launch.json into arguments. See docs/planning/12-codex.md, section 1.

export const INSTRUCTIONS = "instructions.md";
export const LAUNCH = "launch.json";

export interface LaunchSpec {
  servers: Record<string, { [key: string]: TomlInput }>;
  approvals: [server: string, tool: string][];
  sandbox: string;
  approval: string;
  model?: string;
}

const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];
const APPROVALS = ["on-request", "never"];
const LOOSER = "looser than zzpersona's default";

// Secrets reach Codex's own environment under their names: these would change how it runs.
const RESERVED =
  /^(PATH|HOME|SHELL|USER|TMPDIR|NODE_OPTIONS|(HTTPS?|ALL|NO)_PROXY|(CODEX|OPENAI|ZZPERSONA|ZZP)_.*)$/i;

const isSecret = (value: string) => value.startsWith("secret://");

function instructions(
  personaId: string,
  ir: ResolvedPersona,
  texts: Record<string, string>,
) {
  const parts = ir.instructions.map((fragment) => {
    if ("inline" in fragment) return fragment.inline.trimEnd();
    const text = texts[fragment.file];
    if (text === undefined)
      throw new AdapterInputError(
        `no text supplied for instruction file ${fragment.file}`,
      );
    return text.trimEnd();
  });
  if (ir.knowledge.length > 0) {
    parts.push(
      `## Knowledge sources\n${ir.knowledge.map((k) => `- ${k.id}: ${k.source}`).join("\n")}`,
    );
  }
  const rules = (title: string, list: readonly string[]) =>
    list.length === 0
      ? []
      : [`${title}\n${list.map((r) => `- ${r}`).join("\n")}`];
  const toolRules = [
    ...rules("Never run:", ir.permissions.deny),
    ...rules("Ask before:", ir.permissions.ask),
    ...rules("Allowed:", ir.permissions.allow),
  ];
  if (toolRules.length > 0)
    parts.push(["## Tool rules", ...toolRules].join("\n\n"));
  return `${[`## zzpersona persona: ${personaId}`, ...parts].join("\n\n")}\n`;
}

function servers(ir: ResolvedPersona, entries: ReportEntry[]) {
  const specs: LaunchSpec["servers"] = {};
  const secretEnv: Record<string, SecretRef> = {};
  const drop = (name: string, reason: string) =>
    entries.push({ path: `mcp.servers.${name}`, outcome: "dropped", reason });
  for (const name of Object.keys(ir.mcp.servers).sort()) {
    const server: McpServer = ir.mcp.servers[name]!;
    if ("ref" in server) {
      drop(
        name,
        "gateway:// refs need gateway resolution, which is not available yet",
      );
      continue;
    }
    if ("url" in server) {
      if (isSecret(server.url)) {
        drop(name, "a secret URL cannot be forwarded by name");
        continue;
      }
      if (Object.values(server.headers ?? {}).some(isSecret)) {
        drop(name, "secret headers on URL servers are not passed to Codex yet");
        continue;
      }
      specs[name] = { url: server.url };
      for (const header of Object.keys(server.headers ?? {}).sort()) {
        entries.push({
          path: `mcp.servers.${name}.headers.${header}`,
          outcome: "dropped",
          reason: "headers on URL servers are not passed to Codex yet",
        });
      }
      continue;
    }
    if ((server.args ?? []).some(isSecret)) {
      drop(name, "a secret in args cannot be forwarded by name; put it in env");
      continue;
    }
    const env = server.env ?? {};
    const secretVars = Object.keys(env)
      .filter((k) => isSecret(env[k]!))
      .sort();
    const clash = secretVars.find(
      (v) => secretEnv[v] !== undefined && secretEnv[v] !== env[v],
    );
    const reserved = secretVars.find((v) => RESERVED.test(v));
    if (reserved) {
      drop(
        name,
        `${reserved} is a variable Codex or zzpersona reads itself; Codex forwards secrets by name, so it would override it`,
      );
      continue;
    }
    if (clash) {
      drop(
        name,
        `another MCP server already uses ${clash} for a different secret; Codex forwards variables by name`,
      );
      continue;
    }
    for (const v of secretVars) secretEnv[v] = env[v] as SecretRef;
    const plain = Object.fromEntries(
      Object.keys(env)
        .filter((k) => !isSecret(env[k]!))
        .sort()
        .map((k) => [k, env[k]!]),
    );
    specs[name] = {
      command: server.command,
      ...(server.args && { args: server.args }),
      ...(Object.keys(plain).length > 0 && { env: plain }),
      ...(secretVars.length > 0 && { env_vars: secretVars }),
    };
  }
  return { specs, secretEnv };
}

export function compile(
  input: CompileInput,
  self: HarnessAdapter,
): CompileOutput {
  const { ir, personaId, texts } = input;
  assertIrVersion(self, ir);
  const text = instructions(personaId, ir, texts);
  const entries: ReportEntry[] = [];
  const { specs, secretEnv } = servers(ir, entries);

  // MCP tool allow rules are exact: per-tool approval on a server that is launched, or the
  // whole server for `*`. Codex splits `-c` keys on dots, so other tool names stay guidance.
  const approvals: LaunchSpec["approvals"] = [];
  const exact = new Set<string>();
  for (const rule of ir.permissions.allow) {
    const match = /^mcp__(.+?)__([A-Za-z0-9_-]+|\*)$/.exec(rule);
    if (match && specs[match[1]!] && !("url" in specs[match[1]!]!)) {
      approvals.push([match[1]!, match[2]!]);
      exact.add(`permissions.allow[${rule}]`);
    }
  }
  const reasons: Record<string, string> = {
    skills: "Codex has no per-launch skill root",
    hooks:
      "untrusted hooks do not run, and zzpersona never bypasses Codex's hook trust",
    permissions:
      "rendered as guidance; Codex enforces only its sandbox and approval policy",
    knowledge: "listed as pointers in the instructions",
  };
  for (const required of requiredEntries(self.id, capabilities(), ir)) {
    if (exact.has(required.path)) continue;
    entries.push({
      ...required,
      reason: reasons[required.path.split(/[.[]/)[0]!] ?? "not carried",
    });
  }
  if (ir.mcp.gateway !== undefined) {
    entries.push({
      path: "mcp.gateway",
      outcome: "dropped",
      reason: "gateway resolution is not available yet",
    });
  }

  const targets = (ir.targets.codex ?? {}) as Record<string, unknown>;
  const pick = (key: string, allowed: string[], fallback: string) => {
    const value = targets[key];
    if (value === undefined) return fallback;
    if (typeof value === "string" && allowed.includes(value)) return value;
    throw new AdapterInputError(
      `targets.codex.${key} must be one of ${allowed.join(", ")}, not ${JSON.stringify(value)}`,
    );
  };
  const sandbox = pick("sandbox", SANDBOXES, "workspace-write");
  const approval = pick("approval", APPROVALS, "on-request");
  if (sandbox === "danger-full-access")
    entries.push({
      path: "targets.codex.sandbox",
      outcome: "advisory",
      reason: LOOSER,
    });
  if (approval === "never")
    entries.push({
      path: "targets.codex.approval",
      outcome: "advisory",
      reason: LOOSER,
    });
  for (const key of Object.keys(targets).sort()) {
    if (!["sandbox", "approval", "model"].includes(key)) {
      entries.push({
        path: `targets.codex.${key}`,
        outcome: "dropped",
        reason:
          "not a Codex setting zzpersona knows (sandbox, approval, model)",
      });
    }
  }
  const model = typeof targets.model === "string" ? targets.model : undefined;
  const launch: LaunchSpec = {
    servers: specs,
    approvals,
    sandbox,
    approval,
    ...(model !== undefined && { model }),
  };
  return {
    files: {
      [INSTRUCTIONS]: { content: text },
      [LAUNCH]: { content: `${JSON.stringify(launch, null, 2)}\n` },
    },
    secretEnv,
    report: annotateLocks(
      { adapter: self.id, irVersion: ir.irVersion, entries },
      ir,
    ),
  };
}

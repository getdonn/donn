import {
  AdapterInputError,
  annotateLocks,
  isContainedPath,
  requiredEntries,
  satisfiesRange,
  UnsupportedIrVersionError,
  type AgentAdapter,
  type AgentCompileInput,
  type AgentCompileOutput,
  type FileEntry,
  type ReportEntry,
  type SecretRef,
} from "@getdonn/adapter-sdk";
import type { ResolvedPersona } from "@getdonn/spec";
import { capabilities } from "./capabilities.js";
import {
  CHANNEL_FILE,
  CHANNEL_TS,
  ROUTE_AUTH_FILE,
  ROUTE_AUTH_TS,
  ROUTE_TOKEN_ENV,
} from "./channel.js";
import { assertNoSlotCollisions } from "./collisions.js";
import {
  configFile,
  CONFIG_FILE,
  modelId,
  modelPath,
  SANDBOX_FILE,
  SANDBOX_TS,
} from "./config.js";
import { connectionFiles, unknownTargetEntries } from "./connections.js";
import { ENV_FILE, envFile, isWholeRef, SecretNames } from "./env.js";
import { EveCompileError } from "./errors.js";
import {
  isKnownTemplate,
  portability,
  templateModelEntries,
  unknownTemplateEntry,
} from "./portability.js";
import { connectionName, skillName } from "./names.js";
import { subagentPlan } from "./subagents.js";

// A persona as the files of an eve agent's own slots. See docs/planning/24-adapter-eve.md,
// sections 2 and 3. Secrets are numbered in one fixed walk (see SecretNames in env.ts): the
// gateway first, then the connections, so `config.ts` is built before the connection files.

export const INSTRUCTIONS_FILE = "agent/instructions/donn.md";

type Server = ResolvedPersona["mcp"]["servers"][string];
const isUrlServer = (
  server: Server,
): server is Extract<Server, { url: string }> => "url" in server;

/**
 * The connection each url server becomes, by persona server name. Two servers that map to one
 * name are an error, since dropping either would be arbitrary; a name eve cannot take is dropped.
 */
export function connectionPlan(ir: ResolvedPersona): {
  names: Map<string, string>;
  dropped: ReportEntry[];
} {
  const names = new Map<string, string>();
  const owner = new Map<string, string>();
  const dropped: ReportEntry[] = [];
  for (const [server, definition] of Object.entries(ir.mcp.servers)) {
    if (!isUrlServer(definition)) continue;
    const name = connectionName(server);
    if (name === undefined) {
      dropped.push({
        path: `mcp.servers.${server}`,
        outcome: "dropped",
        reason: `name-unmappable: eve connection names are lowercase letters, digits and dashes, starting with a letter, at most 64 with the donn- prefix; "${server}" cannot become one`,
      });
      continue;
    }
    const other = owner.get(name);
    if (other !== undefined) {
      throw new EveCompileError(
        "name-collision",
        `MCP servers "${other}" and "${server}" both become connection ${name}; rename one in the persona`,
      );
    }
    owner.set(name, server);
    names.set(server, name);
  }
  return { names, dropped };
}

/** Whether a `SKILL.md` has a non-empty `description` in its frontmatter (eve requires one). */
export function hasDescription(skillMd: string): boolean {
  const lines = skillMd.replaceAll("\r\n", "\n").split("\n");
  if (lines[0]?.trimEnd() !== "---") return false;
  const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === "---");
  const front = lines.slice(1, end === -1 ? undefined : end);
  const at = front.findIndex((line) => /^description\s*:/.test(line));
  if (at === -1) return false;
  const value = front[at]!.replace(/^description\s*:/, "").trim();
  // A block scalar (`>`, `|-`, …) holds its text on the indented lines below.
  if (/^[>|][+-]?$/.test(value)) return /^\s+\S/.test(front[at + 1] ?? "");
  return value.replace(/^(["'])(.*)\1$/, "$2").trim() !== "";
}

/** `instructions/donn.md`: the fragments in resolved order, then the knowledge pointers. */
function instructionsText(
  input: AgentCompileInput,
  names: Map<string, string>,
  entries: ReportEntry[],
): string | undefined {
  const { ir, personaId, texts } = input;
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
    const lines = ir.knowledge.map(({ id, source }) => {
      // An `mcp://<server>` pointer names the connection that serves it.
      const server = /^mcp:\/\/([^/?#]+)/.exec(source)?.[1];
      const connection = server === undefined ? undefined : names.get(server);
      let note = "";
      if (server !== undefined) {
        if (connection) note = ` (connection \`${connection}\`)`;
        else {
          note = " (not available to this agent)";
          entries.push({
            path: `knowledge[${id}]`,
            outcome: "advisory",
            reason: `server "${server}" has no connection in this agent (stdio, gateway ref, unmappable name or not in the persona), so the pointer cannot be followed`,
          });
        }
      }
      return `- ${id}: ${source}${note}`;
    });
    parts.push(`## Knowledge sources\n${lines.join("\n")}`);
  }
  if (parts.length === 0) return undefined;
  const header = `<!-- Generated by donn from ${personaId}; edit the persona, not this file. -->`;
  return `${[header, ...parts].join("\n\n")}\n`;
}

/** The skills: each directory copied whole to `skills/donn-<name>/`. */
function skillFiles(
  input: AgentCompileInput,
  files: Record<string, FileEntry>,
  entries: ReportEntry[],
): string[] {
  const { ir, texts, agent, project } = input;
  const written: string[] = [];
  // Where the agent has no sandbox, a skill's scripts have nowhere to run.
  const noSandbox = ir.agents[agent]!.target === "local" && !project.hasSandbox;
  for (const skill of ir.skills) {
    const path = `skills[${skill.name}]`;
    const dir = skillName(skill.name);
    if (skill.source.includes("://")) {
      entries.push({
        path,
        outcome: "dropped",
        reason: "skill registries are not supported in v0",
      });
      continue;
    }
    if (dir === undefined) {
      entries.push({
        path,
        outcome: "dropped",
        reason: `name-unmappable: eve skill names are ASCII letters, digits, _ and -, at most 64 with the donn- prefix; "${skill.name}" cannot become one`,
      });
      continue;
    }
    if (!isContainedPath(skill.source)) {
      throw new AdapterInputError(
        `skill ${skill.name}: path ${skill.source} escapes the personas root`,
      );
    }
    const source = skill.source.replace(/\/+$/, "");
    // The CLI supplies the text of every file of a local skill (see AgentCompileInput.texts).
    const skillMd = texts[`${source}/SKILL.md`];
    if (skillMd === undefined) {
      throw new AdapterInputError(
        `no text supplied for skill file ${source}/SKILL.md`,
      );
    }
    if (!hasDescription(skillMd)) {
      entries.push({
        path,
        outcome: "dropped",
        reason: `eve requires a description in the frontmatter of SKILL.md; add one to ${source}/SKILL.md`,
      });
      continue;
    }
    files[`agent/skills/${dir}`] = { copyFrom: skill.source };
    written.push(dir);
    if (
      noSandbox &&
      Object.keys(texts).some((file) => file.startsWith(`${source}/scripts/`))
    ) {
      entries.push({
        path,
        outcome: "advisory",
        reason:
          "the skill's scripts/ run only in a sandbox; locally that needs Docker running when eve builds",
      });
    }
  }
  return written;
}

export function compile(
  input: AgentCompileInput,
  self: AgentAdapter,
): AgentCompileOutput {
  const { ir } = input;
  if (!self.irVersions.includes(ir.irVersion)) {
    throw new UnsupportedIrVersionError(self.id, ir.irVersion);
  }
  if (!satisfiesRange(input.frameworkVersion, self.frameworkRange)) {
    throw new EveCompileError(
      "framework-version",
      `${self.id} ${input.frameworkVersion} is outside the range this adapter compiles for (${self.frameworkRange})`,
    );
  }
  if (ir.agents[input.agent] === undefined) {
    throw new AdapterInputError(
      `persona ${input.personaId} has no agent "${input.agent}"`,
    );
  }
  const files: Record<string, FileEntry> = {};
  const entries: ReportEntry[] = requiredEntries(self.id, capabilities(), ir);

  const connections = connectionPlan(ir);
  entries.push(...connections.dropped);

  const secrets = new SecretNames();
  const agent = ir.agents[input.agent]!;
  const subagents = subagentPlan(
    ir,
    { id: modelId(ir, input.agent), path: modelPath(ir, input.agent) },
    input.project.texts ?? {},
  );
  const config = configFile(ir, input.agent, secrets, subagents.subagents);
  entries.push(
    ...config.entries,
    ...subagents.entries,
    ...unknownTargetEntries(ir, connections.names),
  );
  files[CONFIG_FILE] = { content: config.content };
  const mcp = connectionFiles(ir, input.personaId, connections.names, secrets);
  entries.push(...mcp.entries);
  Object.assign(files, mcp.files);
  const secretEnv: Record<string, SecretRef> = {
    ...secrets.toSecretEnv(),
    ...config.secretEnv,
  };
  // A value that is exactly a secret ref is a secret under its own name; `env` holds plain values.
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(agent.env)) {
    const other = secretEnv[name];
    if (isWholeRef(value)) {
      if (other !== undefined && other !== value) {
        throw new EveCompileError(
          "env-collision",
          `agents.${input.agent}.env.${name} is ${value}, but ${name} is also set from ${other}`,
        );
      }
      secretEnv[name] = value as SecretRef;
    } else if (other !== undefined) {
      throw new EveCompileError(
        "env-collision",
        `agents.${input.agent}.env.${name} is a plain value, but ${name} is also set from ${other}`,
      );
    } else env[name] = value;
  }
  files[ENV_FILE] = {
    content: envFile(
      [
        ...config.envNames,
        ...Object.keys(secrets.toSecretEnv()),
        ...Object.keys(agent.env),
      ],
      config.envAnyOf,
    ),
  };
  const writesSandbox =
    agent.target === "self-host" && !input.project.hasSandbox;
  if (writesSandbox) files[SANDBOX_FILE] = { content: SANDBOX_TS };

  const donnRoutes = agent.target !== "vercel";
  const writesChannel = donnRoutes && !input.project.hasRouteAuth;
  if (donnRoutes) {
    files[ROUTE_AUTH_FILE] = { content: ROUTE_AUTH_TS };
    if (writesChannel) files[CHANNEL_FILE] = { content: CHANNEL_TS };
    // The runner fills the value per run; a token the agent sets itself is kept.
    if (!(ROUTE_TOKEN_ENV in env) && !(ROUTE_TOKEN_ENV in secretEnv))
      env[ROUTE_TOKEN_ENV] = "";
  }

  const template = agent.template;
  if (!isKnownTemplate(template))
    entries.push(unknownTemplateEntry(input.agent, template));
  entries.push(...templateModelEntries(input.agent, template, ir));

  const text = instructionsText(input, connections.names, entries);
  if (text !== undefined) files[INSTRUCTIONS_FILE] = { content: text };
  const skills = skillFiles(input, files, entries);

  assertNoSlotCollisions(input.project.existing, {
    skills,
    connections: [...connections.names.values()],
    instructions: text !== undefined,
    sandbox: writesSandbox,
    channel: writesChannel,
  });

  return {
    files,
    secretEnv,
    env,
    report: annotateLocks(
      { adapter: self.id, irVersion: ir.irVersion, entries },
      ir,
    ),
    portability: portability(
      template,
      agent.target,
      input.project.hasRouteAuth,
      ir.models.gateway !== undefined,
    ),
  };
}

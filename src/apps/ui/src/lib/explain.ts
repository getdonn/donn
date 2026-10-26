import type { ResolveOutput } from "@getdonn/cli-schemas";
import { lockCovers, parsePath } from "@getdonn/spec";

// Presentation lookups over a `resolve --json` answer (docs/planning/26-gui.md §3, item 1): the
// resolved persona grouped by field, and for any value which layer set it, what it displaced and
// which lock covers it. All of it is read from the answer; nothing is computed or merged here.

type Ir = ResolveOutput["ir"];
type Lock = Ir["locks"][number];

export interface Explained {
  /** The layer that set the value (its provenance), when one did. */
  layer: string | undefined;
  /** What the value displaced, in merge order. */
  overrides: ResolveOutput["history"];
  /** Removals this value stands in for (`replace(<id>)` under a new id). */
  replaced: ResolveOutput["history"];
  /** The locks whose path covers the value. */
  locks: Lock[];
  warnings: ResolveOutput["warnings"];
}

/** An agent's lock is written against its definition: `agents.define.<name>`. */
const lockPathOf = (path: string) =>
  path.startsWith("agents.") && !path.startsWith("agents.define.")
    ? `agents.define.${path.slice("agents.".length)}`
    : path;

/** Which layer set `path`, what it displaced and which locks protect it. */
export function explainValue(
  result: Pick<ResolveOutput, "provenance" | "history" | "warnings"> & {
    ir: Pick<Ir, "locks">;
  },
  path: string,
): Explained {
  const target = parsePath(lockPathOf(path));
  return {
    layer: result.provenance[path],
    overrides: result.history.filter((entry) => entry.path === path),
    replaced: result.history.filter((entry) => entry.replacedBy === path),
    locks:
      target === undefined
        ? []
        : result.ir.locks.filter((lock) => {
            const locked = parsePath(lock.path);
            return locked !== undefined && lockCovers(locked, target);
          }),
    warnings: result.warnings.filter((warning) => warning.path === path),
  };
}

/** The layer a ref belongs to: `org`, `area`, `team`, `project` or `user`. */
export const layerKind = (ref: string) => ref.split("/")[0] ?? ref;

/**
 * The file behind a layer, when the app can know it. Only the project's own is derivable: no
 * command reports where the personas folder or the user layer live.
 */
export function layerFile(
  ref: string,
  project: string | undefined,
): string | undefined {
  return layerKind(ref) === "project" && project !== undefined
    ? `${project.replace(/\/+$/, "")}/.donn/persona.yaml`
    : undefined;
}

export interface FieldItem {
  /** The value's path, which `provenance`, `history` and the locks are keyed by. */
  path: string;
  label: string;
  detail?: string;
}

export interface FieldGroup {
  id:
    | "instructions"
    | "skills"
    | "mcp"
    | "permissions"
    | "hooks"
    | "models"
    | "agents"
    | "secrets";
  title: string;
  items: FieldItem[];
}

const SECRET_REF = /secret:\/\/[^\s"',;)]+/g;

/** The `secret://` refs inside a value; the persona holds refs, never values. */
function secretRefs(value: unknown): string[] {
  if (typeof value === "string") return value.match(SECRET_REF) ?? [];
  if (Array.isArray(value)) return value.flatMap(secretRefs);
  if (typeof value === "object" && value !== null)
    return Object.values(value).flatMap(secretRefs);
  return [];
}

function describeServer(server: Ir["mcp"]["servers"][string]): string {
  if ("ref" in server) return server.ref;
  if ("command" in server)
    return [server.command, ...(server.args ?? [])].join(" ");
  return server.url;
}

/** The resolved persona by field group, each value with the path explain is keyed by. */
export function fieldGroups(ir: Ir): FieldGroup[] {
  const instructions = ir.instructions.map((entry) => ({
    path: `instructions[${entry.id}]`,
    label: entry.id,
    detail: "file" in entry ? entry.file : "inline",
  }));
  const skills = ir.skills.map((skill) => ({
    path: `skills[${skill.name}]`,
    label: skill.name,
    detail: skill.source,
  }));
  const servers = Object.entries(ir.mcp.servers);
  const mcp = [
    ...(ir.mcp.gateway === undefined
      ? []
      : [{ path: "mcp.gateway", label: "gateway", detail: ir.mcp.gateway }]),
    ...servers.map(([name, server]) => ({
      path: `mcp.servers.${name}`,
      label: name,
      detail: describeServer(server),
    })),
  ];
  const permissions = (["deny", "ask", "allow"] as const).flatMap((list) =>
    ir.permissions[list].map((rule) => ({
      path: `permissions.${list}[${rule}]`,
      label: rule,
      detail: list,
    })),
  );
  const hooks = Object.entries(ir.hooks).flatMap(([event, list]) =>
    (list ?? []).map((hook) => ({
      path: `hooks.${event}[${hook.id}]`,
      label: hook.id,
      detail: `${event}${hook.matcher === undefined ? "" : ` ${hook.matcher}`}: ${hook.run}`,
    })),
  );
  const models = [
    ...(ir.models.gateway === undefined
      ? []
      : [
          {
            path: "models.gateway",
            label: "gateway",
            detail: `${ir.models.gateway.type}${ir.models.gateway.baseURL === undefined ? "" : ` ${ir.models.gateway.baseURL}`}`,
          },
        ]),
    ...(ir.models.default === undefined
      ? []
      : [
          {
            path: "models.default",
            label: "default",
            detail: ir.models.default,
          },
        ]),
  ];
  const agents = Object.entries(ir.agents).map(([name, agent]) => ({
    path: `agents.${name}`,
    label: name,
    detail: `${agent.template} on ${agent.target}`,
  }));
  const providers = Object.entries(ir.secrets.providers).map(
    ([name, provider]) => ({
      path: `secrets.providers.${name}`,
      label: name,
      detail: provider.type,
    }),
  );
  const refs = [
    ...servers.map(([name, server]) => ({
      path: `mcp.servers.${name}`,
      refs: secretRefs(server),
    })),
    { path: "models.gateway", refs: secretRefs(ir.models.gateway) },
  ].flatMap(({ path, refs: found }) =>
    found.map((ref) => ({ path, label: ref, detail: path })),
  );
  return [
    { id: "instructions", title: "Instructions", items: instructions },
    { id: "skills", title: "Skills", items: skills },
    { id: "mcp", title: "MCP servers", items: mcp },
    { id: "permissions", title: "Permissions", items: permissions },
    { id: "hooks", title: "Hooks", items: hooks },
    { id: "models", title: "Models", items: models },
    { id: "agents", title: "Agents", items: agents },
    {
      id: "secrets",
      title: "Secrets (refs only)",
      items: [...providers, ...refs],
    },
  ];
}

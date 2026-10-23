import { createHash } from "node:crypto";
import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  AdapterInputError,
  isContainedPath,
  UnsupportedIrVersionError,
  type ManagedCode,
  type ManagedEntry,
  type ManagedInput,
  type ManagedManifest,
  type ManagedReport,
  type ManagedResult,
} from "@zzpersona/adapter-sdk";
import {
  HOOK_EVENTS,
  IR_VERSION,
  lockCovers,
  parsePath,
  type McpServer,
  type PersonaPath,
  type Policy,
  type Ref,
  type ResolvedPersona,
} from "@zzpersona/spec";
import { NATIVE_EVENTS } from "../compile.js";
import { KNOWN_MANAGED_KEYS, minClaudeCode } from "./keys.js";
import { installedPath } from "./roots.js";

// A chain's locks as a Claude Code managed policy bundle: a settings drop-in, managed-mcp.json
// under policy.mcp: exclusive, the locked hook scripts and a manifest. Only locked values enter
// the bundle; everything else stays a persona default. See docs/planning/21-managed-settings.md,
// section 2, for the mapping this implements row by row.

const SETTINGS = "managed-settings.d/50-zzpersona.json";
const MANAGED_MCP = "managed-mcp.json";
const MANIFEST = "zzpersona/manifest.json";
const HOOKS = "zzpersona/hooks";
const MANAGED = ["targets", "claude-code", "managed"];

const ADVISORY = "enforced at publish and resolve, not by Claude Code";
const REASON = {
  instructions:
    "delivered as claudeMd: guidance after the system prompt that users cannot exclude, not part of the system prompt",
  permission: "lower scopes may add rules, never remove this one",
  hook: "runs from the policy folder; lower scopes cannot remove it",
  remote: "provided to every user through managedMcpServers",
  exclusive:
    "loaded from managed-mcp.json, which only the policy's servers pass",
  gatewayRef: `gateway:// refs need gateway resolution, which is not available yet; ${ADVISORY}`,
  gatewayRefExclusive: `gateway:// refs need gateway resolution, which is not available yet, and sessions will not load it while policy.mcp is exclusive; ${ADVISORY}`,
  secret:
    "is a secret reference, and managed files are readable by every user; pass secrets through each user's environment",
  unknownKey:
    "is not a managed setting zzpersona knows; check the spelling against the Claude Code settings reference",
  passthrough: "applied last, as written",
  sourcesBehavior:
    "written, but Claude Code reads it from the highest managed source, so from the policy files it cannot make a console or MDM policy merge with them; set it there",
  lockOnly: ADVISORY,
  coversNothing: `covers nothing this chain sets; ${ADVISORY}`,
} as const;

const POLICY: {
  [K in keyof Policy]-?: {
    /** The settings path the key compiles to. */
    key: string;
    apply(settings: Settings): void;
    reason: string;
  };
} = {
  permissions: {
    key: "allowManagedPermissionRulesOnly",
    apply: (s) => (s.allowManagedPermissionRulesOnly = true),
    reason: "allowManagedPermissionRulesOnly: only the policy's rules count",
  },
  hooks: {
    key: "allowManagedHooksOnly",
    apply: (s) => (s.allowManagedHooksOnly = true),
    reason: "allowManagedHooksOnly: only the policy's hooks run",
  },
  mcp: {
    key: "allowManagedMcpServersOnly",
    apply: (s) => (s.allowManagedMcpServersOnly = true),
    reason:
      "allowManagedMcpServersOnly and managed-mcp.json: only the policy's servers load",
  },
  bypassPermissions: {
    key: "permissions.disableBypassPermissionsMode",
    apply: (s) => (permissionsOf(s).disableBypassPermissionsMode = "disable"),
    reason:
      "permissions.disableBypassPermissionsMode: the bypass mode cannot be entered",
  },
};

type Settings = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const permissionsOf = (settings: Settings) =>
  (settings.permissions ??= {}) as Record<string, unknown>;

const at = (keys: string[], entry?: string): PersonaPath =>
  entry === undefined ? { keys } : { keys, entry };

/** The chain's declared locks; remembers which ones covered a value. */
class Locks {
  private readonly locks: { path: string; layer: Ref; parsed?: PersonaPath }[];
  private readonly touched = new Set<string>();
  private readonly layers: Ref[];

  constructor(ir: ResolvedPersona) {
    this.layers = ir.layers;
    this.locks = ir.locks.map((lock) => ({
      ...lock,
      parsed: parsePath(lock.path),
    }));
  }

  /** Whether `upper` comes before `lower` in the chain (root first). */
  above(upper: Ref, lower: Ref): boolean {
    const [u, l] = [this.layers.indexOf(upper), this.layers.indexOf(lower)];
    return u !== -1 && l !== -1 && u < l;
  }

  /** The first lock a layer above `layer` declared that `match` accepts; touches nothing. */
  declaredAbove(
    layer: Ref,
    match: (lock: PersonaPath) => boolean,
  ): { path: string; layer: Ref } | undefined {
    return this.locks.find(
      (lock) =>
        lock.parsed !== undefined &&
        this.above(lock.layer, layer) &&
        match(lock.parsed),
    );
  }

  /** The first declared lock covering `path` (root first, as declared). */
  covering(path: PersonaPath): { path: string; layer: Ref } | undefined {
    const covers = this.locks.filter(
      (lock) => lock.parsed && lockCovers(lock.parsed, path),
    );
    for (const lock of covers) this.touched.add(lock.path);
    return covers[0];
  }

  /** Locks no value matched, in declaration order. */
  untouched() {
    return this.locks.filter((lock) => !this.touched.has(lock.path));
  }
}

const hookFile = (event: string, id: string, run: string) =>
  `${HOOKS}/${event}-${id}-${posix.basename(run)}`;

/** The personas-root-relative files a compile reads: locked instruction files and hook scripts. */
export function managedInputs(ir: ResolvedPersona): {
  texts: string[];
  scripts: string[];
} {
  const locks = new Locks(ir);
  const texts = ir.instructions.flatMap((fragment) =>
    "file" in fragment &&
    locks.covering(at(["instructions"], fragment.id)) !== undefined
      ? [fragment.file]
      : [],
  );
  const scripts = HOOK_EVENTS.flatMap((event) =>
    (ir.hooks[event] ?? []).flatMap((hook) =>
      // An uncontained run is never read; compile refuses it.
      isContainedPath(hook.run) && locks.covering(at(["hooks", event], hook.id))
        ? [hook.run]
        : [],
    ),
  );
  return { texts: [...new Set(texts)], scripts: [...new Set(scripts)] };
}

/** The path of the first string inside `value` that holds a secret ref. */
function secretIn(value: unknown, prefix: string): string | undefined {
  if (typeof value === "string")
    return value.includes("secret://") ? prefix : undefined;
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const found = secretIn(item, `${prefix}.${i}`);
      if (found) return found;
    }
  } else if (isObject(value)) {
    for (const key of Object.keys(value).sort()) {
      const found = secretIn(value[key], `${prefix}.${key}`);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * `over` laid on `base` the way Claude Code merges drop-ins: objects per key, lists combined
 * without duplicates. A value `base` already holds is never replaced: an unequal one is a
 * conflict, named by its dotted path (with a leading dot). At or below a `sealed` path nothing
 * may be added either: a locked server is taken whole, even one compiled into managed-mcp.json.
 */
function overlay(
  base: unknown,
  over: unknown,
  path: string,
  sealed: (path: string) => boolean,
): { value: unknown; conflict?: string } {
  if (isDeepStrictEqual(base, over)) return { value: base };
  if (base === undefined) {
    if (sealed(path)) return { value: base, conflict: path };
    // A new object may still reach a sealed path below it (a server only in managed-mcp.json).
    return isObject(over) ? overlay({}, over, path, sealed) : { value: over };
  }
  if (sealed(path) && !(isObject(base) && isObject(over))) {
    return { value: base, conflict: path };
  }
  if (Array.isArray(base) && Array.isArray(over)) {
    const seen = new Set(base.map((item) => JSON.stringify(item)));
    return {
      value: [
        ...base,
        ...over.filter((item) => !seen.has(JSON.stringify(item))),
      ],
    };
  }
  if (isObject(base) && isObject(over)) {
    const merged: [string, unknown][] = Object.entries(base).filter(
      ([key]) => !Object.hasOwn(over, key),
    );
    for (const [key, value] of Object.entries(over)) {
      const child = overlay(
        Object.hasOwn(base, key) ? base[key] : undefined,
        value,
        `${path}.${key}`,
        sealed,
      );
      if (child.conflict !== undefined) return child;
      merged.push([key, child.value]);
    }
    // fromEntries defines own properties, so a "__proto__" key stays a key.
    return { value: Object.fromEntries(merged) };
  }
  return { value: base, conflict: path };
}

/** What a passthrough key reaches past the compile: IR sections and the policy key over them. */
interface Guard {
  /** A lock at or above one of these binds the key; with `inside`, a lock within one too. */
  sections: string[][];
  inside?: boolean;
  policy?: keyof Policy;
}

const MCP_GUARD: Guard = { sections: [["mcp", "servers"]], policy: "mcp" };
const INSTRUCTIONS_GUARD: Guard = { sections: [["instructions"]] };

/**
 * The passthrough keys that could widen what a higher layer locked (spec 21, amendment 15).
 * `permissions` widens only through `allow`: deny and ask rules only tighten.
 */
const GUARDS: Record<string, (value: unknown) => Guard | undefined> = {
  permissions: (value) =>
    isObject(value) && Object.hasOwn(value, "allow")
      ? { sections: [["permissions", "allow"]], policy: "permissions" }
      : undefined,
  managedMcpServers: () => MCP_GUARD,
  allowedMcpServers: () => MCP_GUARD,
  deniedMcpServers: () => MCP_GUARD,
  allowManagedMcpServersOnly: () => MCP_GUARD,
  hooks: () => ({ sections: [["hooks"]], inside: true, policy: "hooks" }),
  claudeMd: () => INSTRUCTIONS_GUARD,
  claudeMdExcludes: () => INSTRUCTIONS_GUARD,
};

/** A Claude Code allowlist/denylist URL pattern (`*` matches anything) as a test. */
const urlPattern = (pattern: string) => {
  const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${pattern.split("*").map(escape).join(".*")}$`);
};

/** Whether a deniedMcpServers entry names `name` (or matches its URL or command). */
function deniesServer(entry: unknown, name: string, server?: McpServer) {
  if (!isObject(entry)) return false;
  if (entry.serverName === name) return true;
  if (server === undefined) return false;
  if ("url" in server && typeof entry.serverUrl === "string")
    return urlPattern(entry.serverUrl).test(server.url);
  if ("command" in server && Array.isArray(entry.serverCommand))
    return isDeepStrictEqual(entry.serverCommand, [
      server.command,
      ...(server.args ?? []),
    ]);
  return false;
}

/**
 * Why passthrough `key`, set by `layer`, would widen a lock or policy key that a layer above
 * declared; undefined when it does not. The same layer, or a layer above, may set it freely.
 */
function widens(
  key: string,
  value: unknown,
  layer: Ref,
  ir: ResolvedPersona,
  locks: Locks,
  setBy: (path: string) => Ref,
): string | undefined {
  const reason = (what: string, lock: string, at: Ref) =>
    `would widen ${what}, locked by ${lock} (${at}); this key is set by ${layer}, a layer below`;
  const own = [...MANAGED, key];
  const harness = locks.declaredAbove(layer, (lock) =>
    lockCovers(lock, { keys: own }),
  );
  if (harness) return reason(own.join("."), harness.path, harness.layer);
  const guard = Object.hasOwn(GUARDS, key) ? GUARDS[key]!(value) : undefined;
  if (guard === undefined) return undefined;
  const what = guard.sections.map((section) => section.join(".")).join(", ");
  const policy = guard.policy && ir.policy[guard.policy];
  if (guard.policy && policy !== undefined) {
    const at = setBy(`policy.${guard.policy}`);
    if (locks.above(at, layer))
      return reason(what, `policy.${guard.policy}: ${policy}`, at);
  }
  const section = locks.declaredAbove(layer, (lock) =>
    guard.sections.some(
      (keys) =>
        lockCovers(lock, { keys }) ||
        (guard.inside === true && lockCovers({ keys }, lock)),
    ),
  );
  if (section) return reason(what, section.path, section.layer);
  if (key === "deniedMcpServers" && Array.isArray(value)) {
    const server = locks.declaredAbove(layer, (lock) => {
      const [mcp, servers, name] = lock.keys;
      if (mcp !== "mcp" || servers !== "servers" || name === undefined)
        return false;
      const known = Object.hasOwn(ir.mcp.servers, name)
        ? ir.mcp.servers[name]
        : undefined;
      return value.some((entry) => deniesServer(entry, name, known));
    });
    if (server)
      return `would deny ${server.path}, locked by ${server.path} (${server.layer}); this key is set by ${layer}, a layer below`;
  }
  return undefined;
}

/** The settings paths the compile wrote, with the IR values each came from. */
class Sources {
  private readonly map = new Map<string, { path: string; layer: Ref }[]>();

  private readonly whole = new Set<string>();

  /** Like add(), and nothing may be added at or below `setting` either. */
  seal(setting: string, path: string, layer: Ref): void {
    this.whole.add(setting);
    this.add(setting, path, layer);
  }

  /** Whether `setting` (a dotted path with a leading dot) is at or below a sealed one. */
  readonly sealed = (setting: string): boolean => {
    for (const whole of this.whole) {
      if (setting === `.${whole}` || setting.startsWith(`.${whole}.`))
        return true;
    }
    return false;
  };

  add(setting: string, path: string, layer: Ref): void {
    const list = this.map.get(setting) ?? [];
    list.push({ path, layer });
    this.map.set(setting, list);
  }

  /** The sources of `setting` or of its nearest ancestor, as "path (layer)". */
  /**
   * The sources of `setting` or of its nearest ancestor, as "path (layer)"; for a container the
   * compile filled below its own level, the sources of everything under it.
   */
  describe(setting: string): string {
    const format = (list: { path: string; layer: Ref }[]) =>
      [...new Set(list.map((s) => `${s.path} (${s.layer})`))].join(", ");
    let prefix = setting;
    while (prefix !== "") {
      const list = this.map.get(prefix);
      if (list) return format(list);
      prefix = prefix.slice(0, Math.max(0, prefix.lastIndexOf(".")));
    }
    const below = [...this.map]
      .filter(([key]) => key.startsWith(`${setting}.`))
      .flatMap(([, list]) => list);
    return below.length > 0 ? format(below) : "the compiled policy";
  }
}

const sortKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : isObject(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sortKeys(value[key])]),
        )
      : value;

/** Sorted keys, two-space indent, trailing newline: the same value always gives the same bytes. */
const jsonBytes = (value: unknown) =>
  new TextEncoder().encode(`${JSON.stringify(sortKeys(value), null, 2)}\n`);

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function textOf(
  fragment: ResolvedPersona["instructions"][number],
  texts: Record<string, string>,
): string {
  if ("inline" in fragment) return fragment.inline;
  const text = texts[fragment.file];
  if (text === undefined) {
    throw new AdapterInputError(
      `no text supplied for instruction file ${fragment.file}`,
    );
  }
  return text;
}

/** Why a server cannot go to managedMcpServers, or undefined when it can. */
function notRemote(server: Exclude<McpServer, { ref: string }>) {
  if ("command" in server) return "a stdio server";
  if (!server.url.startsWith("https://")) return "a server not on https://";
  if (Object.keys(server.headers ?? {}).length > 0)
    return "a server with headers";
  if (server.url.includes("${")) return "a server with ${VAR} in its URL";
  return undefined;
}

/** A server in the .mcp.json shape managed-mcp.json takes. */
const mcpJsonServer = (server: Exclude<McpServer, { ref: string }>) =>
  "command" in server
    ? {
        type: "stdio",
        command: server.command,
        ...(server.args && { args: server.args }),
        ...(server.env && { env: server.env }),
      }
    : {
        type: server.transport ?? "http",
        url: server.url,
        ...(server.headers && { headers: server.headers }),
      };

/**
 * An installed hook path as a shell word. POSIX: single quotes, so `$`, backticks and spaces stay
 * literal. Windows: double quotes, which cannot hold a `"` and leave `$`, backticks (PowerShell)
 * and `%` (cmd) live, so a name with any of them is refused.
 */
function shellPath(os: ManagedInput["os"], file: string, what: string) {
  const path = installedPath(os, file);
  if (os !== "windows") return `'${path.replaceAll("'", "'\\''")}'`;
  const name = posix.basename(file);
  const bad = /["$`%]/.exec(name);
  if (bad) {
    throw new AdapterInputError(
      `hook ${what}: ${name} has ${bad[0]} in its name, which a Windows shell would expand or cannot quote`,
    );
  }
  return `"${path}"`;
}

export function compileManaged(input: ManagedInput): ManagedResult {
  const { ir, os } = input;
  if (ir.irVersion !== IR_VERSION) {
    throw new UnsupportedIrVersionError("claude-code", ir.irVersion);
  }
  const locks = new Locks(ir);
  const sources = new Sources();
  const entries: ManagedEntry[] = [];
  const settings: Settings = {};
  const files: Record<string, Uint8Array> = {};
  const exclusive = ir.policy.mcp === "exclusive";
  const exclusiveServers: Record<string, unknown> = {};
  const setBy = (path: string): Ref =>
    input.provenance?.[path] ?? ir.layers[0]!;

  const add = (
    path: string,
    layer: Ref,
    outcome: ManagedEntry["outcome"],
    reason: string,
    code?: ManagedCode,
  ) => entries.push({ path, layer, outcome, ...(code && { code }), reason });

  // instructions → claudeMd, in contract order.
  const fragments: string[] = [];
  for (const fragment of ir.instructions) {
    const lock = locks.covering(at(["instructions"], fragment.id));
    if (!lock) continue;
    const text = textOf(fragment, input.texts);
    if (text.trim() !== "") fragments.push(text.trim());
    sources.add("claudeMd", `instructions[${fragment.id}]`, lock.layer);
    add(
      `instructions[${fragment.id}]`,
      lock.layer,
      "enforced",
      REASON.instructions,
    );
  }
  if (fragments.length > 0) settings.claudeMd = fragments.join("\n\n");

  for (const skill of ir.skills) {
    const lock = locks.covering(at(["skills"], skill.name));
    if (lock) add(`skills[${skill.name}]`, lock.layer, "advisory", ADVISORY);
  }

  if (ir.mcp.gateway !== undefined) {
    const lock = locks.covering(at(["mcp", "gateway"]));
    if (lock) add("mcp.gateway", lock.layer, "advisory", ADVISORY);
  }

  const remote: Record<string, unknown> = {};
  for (const name of Object.keys(ir.mcp.servers).sort()) {
    const path = `mcp.servers.${name}`;
    const lock = locks.covering(at(["mcp", "servers", name]));
    if (!lock) continue;
    const server = ir.mcp.servers[name]!;
    if ("ref" in server) {
      add(
        path,
        lock.layer,
        "advisory",
        exclusive ? REASON.gatewayRefExclusive : REASON.gatewayRef,
      );
      continue;
    }
    const secret = secretIn(server, path);
    if (secret) {
      add(
        path,
        lock.layer,
        "refused",
        `${secret} ${REASON.secret}`,
        "managed-secret",
      );
      continue;
    }
    const why = notRemote(server);
    if (why === undefined && "url" in server) {
      remote[name] = { type: server.transport ?? "http", url: server.url };
      sources.seal(`managedMcpServers.${name}`, path, lock.layer);
      add(path, lock.layer, "enforced", REASON.remote);
    } else if (exclusive) {
      exclusiveServers[name] = mcpJsonServer(server);
      // Its name is taken in managedMcpServers too: the passthrough must not shadow it there.
      sources.seal(`managedMcpServers.${name}`, path, lock.layer);
      add(path, lock.layer, "enforced", REASON.exclusive);
    } else {
      add(
        path,
        lock.layer,
        "refused",
        `${why} needs managed-mcp.json, which only policy.mcp: exclusive writes; managedMcpServers takes only https:// servers without headers`,
        "managed-mcp-needs-exclusive",
      );
    }
  }
  if (Object.keys(remote).length > 0) settings.managedMcpServers = remote;

  for (const list of ["allow", "deny", "ask"] as const) {
    const rules = ir.permissions[list].filter((rule) => {
      const lock = locks.covering(at(["permissions", list], rule));
      if (lock) {
        const path = `permissions.${list}[${rule}]`;
        sources.add(`permissions.${list}`, path, lock.layer);
        add(path, lock.layer, "enforced", REASON.permission);
      }
      return lock !== undefined;
    });
    if (rules.length > 0) permissionsOf(settings)[list] = rules;
  }

  const hooks: Record<string, unknown[]> = {};
  for (const event of HOOK_EVENTS) {
    for (const hook of ir.hooks[event] ?? []) {
      const lock = locks.covering(at(["hooks", event], hook.id));
      if (!lock) continue;
      if (!isContainedPath(hook.run)) {
        throw new AdapterInputError(
          `hook ${event}[${hook.id}]: ${hook.run} is outside the personas root`,
        );
      }
      const script = input.scripts[hook.run];
      if (script === undefined) {
        throw new AdapterInputError(
          `no script supplied for hook file ${hook.run}`,
        );
      }
      const file = hookFile(event, hook.id, hook.run);
      const path = `hooks.${event}[${hook.id}]`;
      files[file] = script;
      (hooks[NATIVE_EVENTS[event]] ??= []).push({
        ...(hook.matcher !== undefined && { matcher: hook.matcher }),
        hooks: [{ type: "command", command: shellPath(os, file, path) }],
      });
      sources.add(`hooks.${NATIVE_EVENTS[event]}`, path, lock.layer);
      add(path, lock.layer, "enforced", REASON.hook);
    }
  }
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;

  for (const k of ir.knowledge) {
    const lock = locks.covering(at(["knowledge"], k.id));
    if (lock) add(`knowledge[${k.id}]`, lock.layer, "advisory", ADVISORY);
  }

  for (const name of Object.keys(ir.secrets.providers).sort()) {
    const lock = locks.covering(at(["secrets", "providers", name]));
    if (lock)
      add(`secrets.providers.${name}`, lock.layer, "advisory", ADVISORY);
  }

  // policy: locked by being set, so the layer is whoever set it.
  for (const key of Object.keys(ir.policy).sort() as (keyof Policy)[]) {
    if (ir.policy[key] === undefined) continue;
    const path = `policy.${key}`;
    POLICY[key].apply(settings);
    sources.add(POLICY[key].key, path, setBy(path));
    add(path, setBy(path), "enforced", POLICY[key].reason);
  }

  // targets.claude-code.managed: known keys applied last. They add to the compiled policy and
  // never replace any of it: a layer below the lock's must not undo it from here.
  const managed = ir.targets["claude-code"]?.managed;
  let policy: Settings = settings;
  if (isObject(managed)) {
    for (const key of Object.keys(managed).sort()) {
      const path = `${MANAGED.join(".")}.${key}`;
      const layer = setBy(path);
      const secret = secretIn(managed[key], path);
      if (!KNOWN_MANAGED_KEYS.has(key)) {
        add(
          path,
          layer,
          "refused",
          `${key} ${REASON.unknownKey}`,
          "managed-unknown-key",
        );
      } else if (secret) {
        add(
          path,
          layer,
          "refused",
          `${secret} ${REASON.secret}`,
          "managed-secret",
        );
      } else {
        const merged = overlay(
          policy,
          { [key]: managed[key] },
          "",
          sources.sealed,
        );
        // A replacement is named first; then a lower layer reaching past a higher one's lock.
        const widened =
          merged.conflict === undefined
            ? widens(key, managed[key], layer, ir, locks, setBy)
            : undefined;
        if (merged.conflict !== undefined) {
          const setting = merged.conflict.slice(1);
          add(
            path,
            layer,
            "refused",
            `would replace ${setting}, compiled from ${sources.describe(setting)}; this key is set by ${layer}`,
            "managed-passthrough-conflict",
          );
        } else if (widened !== undefined) {
          add(path, layer, "refused", widened, "managed-passthrough-conflict");
        } else {
          policy = merged.value as Settings;
          if (key === "managedSourcesBehavior")
            add(path, layer, "advisory", REASON.sourcesBehavior);
          else add(path, layer, "enforced", REASON.passthrough);
        }
      }
    }
  }

  for (const lock of locks.untouched()) {
    const keys = lock.parsed?.keys ?? [];
    if (MANAGED.every((key, i) => keys[i] === key)) continue;
    const harnessOrLabels = keys[0] === "targets" || keys[0] === "metadata";
    add(
      lock.path,
      lock.layer,
      "advisory",
      harnessOrLabels ? REASON.lockOnly : REASON.coversNothing,
    );
  }

  const report: ManagedReport = {
    entries,
    warnings: warnings(policy, exclusive),
  };
  if (entries.some((entry) => entry.outcome === "refused")) return { report };

  files[SETTINGS] = jsonBytes(policy);
  if (exclusive)
    files[MANAGED_MCP] = jsonBytes({ mcpServers: exclusiveServers });

  const hashes = Object.fromEntries(
    Object.keys(files)
      .sort()
      .map((path) => [path, sha256(files[path]!)]),
  );
  const floor = minClaudeCode(Object.keys(policy));
  const manifest: ManagedManifest = {
    format: 1,
    zzpersona: input.zzpersona,
    os,
    layers: input.layers,
    files: hashes,
    ...(floor !== undefined && { minClaudeCode: floor }),
    report,
  };
  const ordered: Record<string, Uint8Array> = {};
  for (const path of Object.keys(files).sort()) ordered[path] = files[path]!;
  ordered[MANIFEST] = jsonBytes(manifest);
  return { report, bundle: { files: ordered, manifest } };
}

/** Where the policy weakens zzpersona's own launches (docs/planning/09 and 10). */
function warnings(
  policy: Settings,
  exclusive: boolean,
): ManagedReport["warnings"] {
  const found: ManagedReport["warnings"] = [];
  if (policy.disableSideloadFlags === true) {
    found.push({
      code: "partial-mode",
      message:
        "disableSideloadFlags rejects --plugin-dir and --mcp-config: zzpersona claude runs in partial mode, without the persona's plugin and MCP servers",
    });
  }
  if (exclusive) {
    found.push({
      code: "partial-mode",
      message:
        "managed-mcp.json makes --mcp-config exit: zzpersona claude launches without the persona's MCP servers",
    });
  }
  if (policy.allowManagedHooksOnly === true) {
    found.push({
      code: "plugin-hooks-dropped",
      message:
        "allowManagedHooksOnly blocks plugin hooks: persona hooks do not run, only the policy's",
    });
  }
  if (isObject(policy.hooks) && Object.keys(policy.hooks).length > 0) {
    found.push({
      code: "console-hooks-approval",
      message:
        "delivered from the claude.ai console instead of these files, the policy's hooks need each developer's approval",
    });
  }
  return found;
}

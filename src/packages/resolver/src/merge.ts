import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  formatPath,
  IR_VERSION,
  isValidLockPath,
  lockCovers,
  parsePath,
  ResolvedPersona,
  type Hook,
  type HistoryEntry,
  type HookEvent,
  type KnowledgePointer,
  type McpServer,
  type Persona,
  type PersonaOverlay,
  type PersonaPath,
  type Policy,
  type Ref,
  type ResolveResult,
  type ResolveWarning,
  type SecretProvider,
  type WarningCode,
} from "@zzpersona/spec";
import { ResolveError } from "./errors.js";

// Merges layers in order into one accumulator. Every individual change goes through guard(),
// which checks it against the locks declared by earlier layers. Checking per change (rather than
// diffing whole fields afterwards) is what lets the user overlay drop just the offending entry.
// The rules are specified by fixtures/README.md; the fixtures are the tests.

type Change = "add" | "set" | "remove";
type InstructionSource = { file: string } | { inline: string };
type RuleList = "allow" | "deny" | "ask";

interface Lock {
  path: string;
  parsed: PersonaPath;
  layer: Ref;
}

const RULE_LISTS: RuleList[] = ["allow", "deny", "ask"];

const at = (keys: string[], entry?: string): PersonaPath =>
  entry === undefined ? { keys } : { keys, entry };

/** Adding to deny or ask only tightens policy, so a lock there still allows additions. */
const isRestrictiveAdd = ({ keys }: PersonaPath, change: Change): boolean =>
  change === "add" &&
  keys.length === 2 &&
  keys[0] === "permissions" &&
  keys[1] !== "allow";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The last path segment without a version: registry://org/skills/pr-review@^2 → pr-review. */
const skillName = (source: string): string =>
  source.split("/").at(-1)!.split("@")[0]!;

export class Merge {
  private layer!: Ref;
  private dir = "";
  private isOverlay = false;

  private readonly provenance = new Map<string, Ref>();
  private readonly warnings: ResolveWarning[] = [];
  private readonly history: HistoryEntry[] = [];
  private readonly locks: Lock[] = [];

  private readonly labels = new Map<string, string>();
  private readonly instructions: { id: string; source: InstructionSource }[] =
    [];
  private readonly skills = new Map<string, string>();
  private gateway: string | undefined;
  private readonly servers = new Map<string, McpServer>();
  private readonly rules: Record<RuleList, Map<string, true>> = {
    allow: new Map(),
    deny: new Map(),
    ask: new Map(),
  };
  private readonly hooks = new Map<HookEvent, Hook[]>();
  private readonly knowledge: KnowledgePointer[] = [];
  private readonly providers = new Map<string, SecretProvider>();
  private readonly targets: Record<string, unknown> = {};
  private readonly policy: Policy = {};

  apply(layer: Ref, doc: Persona | PersonaOverlay, dir?: string): void {
    this.layer = layer;
    this.dir = dir ?? posix.dirname(layer);
    this.isOverlay = doc.kind === "PersonaOverlay";
    const declared = doc.kind === "Persona" ? (doc.locks ?? []) : [];
    if (declared.length > 0 && layer.startsWith("user/")) {
      throw new ResolveError("user-layer-lock", { layer });
    }
    for (const path of declared) {
      if (!isValidLockPath(path))
        throw new ResolveError("invalid-lock-path", { path, layer });
    }

    if (doc.kind === "Persona") {
      for (const [key, value] of Object.entries(doc.metadata.labels ?? {})) {
        this.setKeyed(this.labels, value, at(["metadata", "labels", key]), key);
      }
    }
    this.mergeInstructions(doc.instructions ?? []);
    this.mergeSkills(doc.skills ?? {});
    this.mergeMcp(doc.mcp ?? {});
    this.mergePermissions(doc.permissions ?? {});
    this.mergeHooks(doc.hooks ?? {});
    for (const item of doc.knowledge ?? []) {
      this.upsertById(this.knowledge, { ...item }, at(["knowledge"], item.id));
    }
    for (const [name, provider] of Object.entries(
      doc.secrets?.providers ?? {},
    )) {
      this.setKeyed(
        this.providers,
        provider,
        at(["secrets", "providers", name]),
        name,
      );
    }
    const managed = this.takeManaged(doc.targets);
    this.mergePolicy(doc.kind === "Persona" ? doc.policy : undefined, managed);
    this.mergeTargets(doc.targets ?? {}, ["targets"]);

    // A lock applies to every layer after the one that declared it.
    for (const path of declared)
      this.locks.push({ path, parsed: parsePath(path)!, layer });
  }

  finish(
    layers: Ref[],
    target: Ref,
    metadata: Persona["metadata"],
  ): ResolveResult {
    this.shadow("ask", "deny", "ask-shadowed-by-deny");
    this.shadow("allow", "deny", "allow-shadowed-by-deny");
    this.shadow("allow", "ask", "allow-shadowed-by-ask");

    for (const key of ["name", "version", "description"] as const) {
      if (metadata[key] !== undefined)
        this.provenance.set(`metadata.${key}`, target);
    }
    const sorted = (list: RuleList) => [...this.rules[list].keys()].sort();

    const ir = ResolvedPersona.parse({
      irVersion: IR_VERSION,
      layers,
      metadata: {
        name: metadata.name,
        ...(metadata.version !== undefined && { version: metadata.version }),
        ...(metadata.description !== undefined && {
          description: metadata.description,
        }),
        labels: Object.fromEntries(this.labels),
      },
      instructions: this.instructions.map(({ id, source }) => ({
        id,
        ...source,
      })),
      skills: [...this.skills]
        .map(([name, source]) => ({ name, source }))
        .sort((a, b) => (a.name < b.name ? -1 : 1)),
      mcp: {
        ...(this.gateway !== undefined && { gateway: this.gateway }),
        servers: Object.fromEntries(this.servers),
      },
      permissions: {
        allow: sorted("allow"),
        deny: sorted("deny"),
        ask: sorted("ask"),
      },
      hooks: Object.fromEntries(this.hooks),
      knowledge: this.knowledge,
      secrets: { providers: Object.fromEntries(this.providers) },
      locks: this.locks.map(({ path, layer }) => ({ path, layer })),
      targets: this.targets,
      policy: this.policy,
    });
    return {
      ir,
      provenance: Object.fromEntries(this.provenance),
      warnings: this.warnings,
      history: this.history,
    };
  }

  // ---- fields -----------------------------------------------------------------------------

  private mergeInstructions(
    fragments: NonNullable<Persona["instructions"]>,
  ): void {
    let prependAt = 0;
    for (const fragment of fragments) {
      const { id, position = "append" } = fragment;
      const source: InstructionSource =
        "file" in fragment
          ? { file: this.local(fragment.file) }
          : { inline: fragment.inline };
      const replaces = /^replace\((.+)\)$/.exec(position)?.[1];
      const target = replaces ?? id;
      const index = this.instructions.findIndex((i) => i.id === target);

      if (replaces !== undefined && index === -1) {
        throw new ResolveError("replace-target-missing", {
          id: replaces,
          layer: this.layer,
        });
      }
      if (index !== -1) {
        // Same id or replace(<id>): swap in place.
        if (
          target === id &&
          isDeepStrictEqual(this.instructions[index]!.source, source)
        )
          continue;
        if (
          target !== id &&
          !this.guard(at(["instructions"], target), "remove")
        )
          continue;
        if (!this.guard(at(["instructions"], id), "set")) continue;
        this.instructions[index] = { id, source };
        if (target !== id) {
          this.forget(`instructions[${target}]`, `instructions[${id}]`);
        }
        this.record(`instructions[${id}]`);
        continue;
      }
      if (!this.guard(at(["instructions"], id), "add")) continue;
      if (position === "prepend")
        this.instructions.splice(prependAt++, 0, { id, source });
      else this.instructions.push({ id, source });
      this.record(`instructions[${id}]`);
    }
  }

  private mergeSkills({
    include = [],
    exclude = [],
  }: NonNullable<Persona["skills"]>): void {
    for (const raw of include) {
      const source = raw.includes("://") ? raw : this.local(raw);
      const name = skillName(source);
      this.setKeyed(this.skills, source, at(["skills"], name), name);
    }
    for (const name of exclude)
      this.removeKeyed(this.skills, at(["skills"], name), name);
  }

  private mergeMcp({
    gateway,
    servers = {},
    remove = [],
  }: NonNullable<Persona["mcp"]>): void {
    if (gateway !== undefined && gateway !== this.gateway) {
      if (
        this.guard(
          at(["mcp", "gateway"]),
          this.gateway === undefined ? "add" : "set",
        )
      ) {
        this.gateway = gateway;
        this.record("mcp.gateway");
      }
    }
    for (const [name, server] of Object.entries(servers)) {
      this.setKeyed(this.servers, server, at(["mcp", "servers", name]), name);
    }
    for (const name of remove)
      this.removeKeyed(this.servers, at(["mcp", "servers", name]), name);
  }

  private mergePermissions(
    permissions: NonNullable<Persona["permissions"]>,
  ): void {
    for (const list of RULE_LISTS) {
      for (const rule of permissions[list] ?? []) {
        this.setKeyed(
          this.rules[list],
          true,
          at(["permissions", list], rule),
          rule,
        );
      }
    }
    for (const list of RULE_LISTS) {
      for (const rule of permissions.remove?.[list] ?? []) {
        this.removeKeyed(
          this.rules[list],
          at(["permissions", list], rule),
          rule,
          list !== "allow",
        );
      }
    }
  }

  private mergeHooks(hooks: NonNullable<Persona["hooks"]>): void {
    const { remove = [], ...events } = hooks;
    for (const [event, list] of Object.entries(events) as [
      HookEvent,
      Hook[] | undefined,
    ][]) {
      for (const hook of list ?? []) {
        const merged = this.hooks.get(event) ?? [];
        const normalized: Hook = { id: hook.id, run: this.local(hook.run) };
        if (hook.matcher !== undefined) normalized.matcher = hook.matcher;
        this.upsertById(merged, normalized, at(["hooks", event], hook.id));
        if (merged.length > 0) this.hooks.set(event, merged);
      }
    }
    for (const removal of remove) {
      const { keys, entry } = parsePath(removal)!;
      const event = keys[0] as HookEvent;
      const path = at(["hooks", event], entry);
      const list = this.hooks.get(event) ?? [];
      const index = list.findIndex((h) => h.id === entry);
      if (index === -1) {
        this.warn("remove-unmatched", path);
        continue;
      }
      if (!this.guard(path, "remove")) continue;
      list.splice(index, 1);
      if (list.length === 0) this.hooks.delete(event);
      this.forget(formatPath(path));
      this.warn("security-removal", path);
    }
  }

  /** Pulls `targets.claude-code.managed` out of the targets to merge, leaving the rest. */
  private takeManaged(
    targets: Persona["targets"],
  ): Record<string, unknown> | undefined {
    const claude = targets?.["claude-code"];
    if (claude === undefined || !("managed" in claude)) return undefined;
    const { managed, ...rest } = claude;
    targets!["claude-code"] = rest;
    return isPlainObject(managed) ? managed : {};
  }

  /**
   * `policy` and `targets.claude-code.managed` belong to org, area and team layers. Each key is
   * implicitly locked by the layer that first sets it: no later layer may set it again.
   */
  private mergePolicy(
    policy: Policy | undefined,
    managed: Record<string, unknown> | undefined,
  ): void {
    if (policy === undefined && managed === undefined) return;
    if (!["org", "area", "team"].includes(this.layer.split("/")[0]!)) {
      throw new ResolveError("policy-in-lower-layer", { layer: this.layer });
    }
    for (const [key, value] of Object.entries(policy ?? {})) {
      this.setOnce(`policy.${key}`, () => {
        (this.policy as Record<string, unknown>)[key] = value;
      });
    }
    if (managed === undefined) return;
    const claude = (this.targets["claude-code"] ??= {}) as Record<
      string,
      unknown
    >;
    const store = (claude["managed"] ??= {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(managed)) {
      this.setOnce(`targets.claude-code.managed.${key}`, () => {
        store[key] = value;
      });
    }
  }

  private setOnce(path: string, set: () => void): void {
    const lockedBy = this.provenance.get(path);
    if (lockedBy !== undefined) {
      throw new ResolveError("lock-violation", {
        path,
        lock: path,
        lockedBy,
        layer: this.layer,
      });
    }
    set();
    this.record(path);
  }

  /** Deep merge; arrays and scalars are leaves, replaced whole. */
  private mergeTargets(value: unknown, keys: string[]): void {
    if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value))
        this.mergeTargets(child, [...keys, key]);
      return;
    }
    let node = this.targets;
    for (let i = 1; i < keys.length - 1; i++) {
      const key = keys[i]!;
      if (!isPlainObject(node[key])) {
        node[key] = {};
        this.forget(keys.slice(0, i + 1).join("."));
      }
      node = node[key] as Record<string, unknown>;
    }
    const leaf = keys.at(-1)!;
    if (isDeepStrictEqual(node[leaf], value)) return;
    if (!this.guard(at(keys), node[leaf] === undefined ? "add" : "set")) return;
    node[leaf] = value;
    const path = keys.join(".");
    for (const key of this.provenance.keys()) {
      if (key.startsWith(`${path}.`)) this.forget(key);
    }
    this.record(path);
  }

  // ---- primitives -------------------------------------------------------------------------

  private setKeyed<V>(
    map: Map<string, V>,
    value: V,
    path: PersonaPath,
    key: string,
  ): void {
    const current = map.get(key);
    if (current !== undefined && isDeepStrictEqual(current, value)) return;
    if (!this.guard(path, current === undefined ? "add" : "set")) return;
    map.set(key, value);
    this.record(formatPath(path));
  }

  private removeKeyed<V>(
    map: Map<string, V>,
    path: PersonaPath,
    key: string,
    security = false,
  ) {
    if (!map.has(key)) {
      this.warn("remove-unmatched", path);
      return;
    }
    if (!this.guard(path, "remove")) return;
    map.delete(key);
    this.forget(formatPath(path));
    if (security) this.warn("security-removal", path);
  }

  private upsertById<T extends { id: string }>(
    list: T[],
    item: T,
    path: PersonaPath,
  ): void {
    const index = list.findIndex((existing) => existing.id === item.id);
    if (index !== -1 && isDeepStrictEqual(list[index], item)) return;
    if (!this.guard(path, index === -1 ? "add" : "set")) return;
    if (index === -1) list.push(item);
    else list[index] = item;
    this.record(formatPath(path));
  }

  /** May this layer make this change? Throws on a lock violation; the overlay skips and warns. */
  private guard(path: PersonaPath, change: Change): boolean {
    for (const lock of this.locks) {
      if (!lockCovers(lock.parsed, path) || isRestrictiveAdd(path, change))
        continue;
      if (this.isOverlay) {
        this.warn("overlay-lock-ignored", path);
        return false;
      }
      throw new ResolveError("lock-violation", {
        path: formatPath(path),
        lock: lock.path,
        lockedBy: lock.layer,
        layer: this.layer,
      });
    }
    return true;
  }

  /** Exact rules in a stronger list are dropped from the weaker one (deny > ask > allow). */
  private shadow(weak: RuleList, strong: RuleList, code: WarningCode): void {
    for (const rule of [...this.rules[weak].keys()]) {
      if (!this.rules[strong].has(rule)) continue;
      const path = `permissions.${weak}[${rule}]`;
      this.warnings.push({ code, path, layer: this.provenance.get(path)! });
      this.rules[weak].delete(rule);
      this.provenance.delete(path);
    }
  }

  /** A path in this layer's file, made relative to the personas root. */
  private local(path: string): string {
    return posix.join(this.dir, path);
  }

  /** This layer set the value at `path`; if another layer had set it, that is an override. */
  private record(path: string): void {
    const from = this.provenance.get(path);
    if (from !== undefined && from !== this.layer) {
      this.history.push({ path, layer: this.layer, kind: "override", from });
    }
    this.provenance.set(path, this.layer);
  }

  /**
   * This layer deleted the value at `path`, or swapped it for the value at `replacedBy`. Not used
   * for shadowed rules: those are warnings.
   */
  private forget(path: string, replacedBy?: string): void {
    const from = this.provenance.get(path);
    if (from === undefined) return;
    this.history.push({
      path,
      layer: this.layer,
      kind: "remove",
      from,
      ...(replacedBy !== undefined && { replacedBy }),
    });
    this.provenance.delete(path);
  }

  private warn(code: WarningCode, path: PersonaPath): void {
    this.warnings.push({ code, path: formatPath(path), layer: this.layer });
  }
}

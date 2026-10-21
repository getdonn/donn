import {
  HOOK_EVENTS,
  lockCovers,
  parsePath,
  type ResolvedPersona,
} from "@zzpersona/spec";
import {
  FIXED_CAPABILITY_FIELDS,
  type CapabilityField,
  type CapabilityMatrix,
  type CompileReport,
  type ReportEntry,
  type Support,
} from "./types.js";
import { serverSecretRefs } from "./paths.js";

// "No silent loss", derived rather than trusted: from an adapter's matrix and an IR, the report
// entries a compile must contain. See docs/planning/05-adapter-sdk.md, section 2.

type Required = Omit<ReportEntry, "lock">;

/** The reason for items under a field the adapter's matrix leaves out. */
export const UNDECLARED = "not declared by the adapter";

/** Every field an adapter's matrix declares: the fixed ones, each hook event, its own targets. */
export function capabilityFields(adapterId: string): CapabilityField[] {
  return [
    ...FIXED_CAPABILITY_FIELDS,
    ...HOOK_EVENTS.map((event): CapabilityField => `hooks.${event}`),
    `targets.${adapterId}`,
  ];
}

const OUTCOME: Record<Exclude<Support, "native">, ReportEntry["outcome"]> = {
  none: "dropped",
  advisory: "advisory",
  approximated: "approximated",
};

/** Every IR value under each capability field, as report paths. */
function valuesByField(
  adapterId: string,
  ir: ResolvedPersona,
): [CapabilityField, string[]][] {
  const servers = Object.entries(ir.mcp.servers);
  return [
    ["instructions", ir.instructions.map((i) => `instructions[${i.id}]`)],
    ["skills", ir.skills.map((s) => `skills[${s.name}]`)],
    ["mcp.servers", servers.map(([name]) => `mcp.servers.${name}`)],
    ["knowledge", ir.knowledge.map((k) => `knowledge[${k.id}]`)],
    ["secrets", serverSecretRefs(ir).map((r) => r.path)],
    ...(["allow", "deny", "ask"] as const).map(
      (list): [CapabilityField, string[]] => [
        `permissions.${list}`,
        ir.permissions[list].map((rule) => `permissions.${list}[${rule}]`),
      ],
    ),
    ...Object.entries(ir.hooks).map(
      ([event, hooks]): [CapabilityField, string[]] => [
        `hooks.${event}` as CapabilityField,
        (hooks ?? []).map((hook) => `hooks.${event}[${hook.id}]`),
      ],
    ),
    // Other harnesses' blocks are not this adapter's loss.
    [
      `targets.${adapterId}`,
      adapterId in ir.targets ? [`targets.${adapterId}`] : [],
    ],
  ];
}

export function requiredEntries(
  adapterId: string,
  matrix: CapabilityMatrix,
  ir: ResolvedPersona,
): Required[] {
  return valuesByField(adapterId, ir).flatMap(([field, paths]) => {
    const entry = matrix.fields[field];
    const support = entry?.support ?? "none";
    if (support === "native") return [];
    const reason = entry
      ? (entry.note ?? "the adapter gives no reason")
      : UNDECLARED;
    return paths.map((path) => ({ path, outcome: OUTCOME[support], reason }));
  });
}

/** A copy of `report` with each entry a lock covers marked, so weakened policy is visible. */
export function annotateLocks(
  report: CompileReport,
  ir: ResolvedPersona,
): CompileReport {
  const locks = ir.locks.map((lock) => ({
    ...lock,
    parsed: parsePath(lock.path),
  }));
  return {
    ...report,
    entries: report.entries.map(({ lock: _ignored, ...entry }) => {
      const path = parsePath(entry.path);
      const lock =
        path && locks.find((l) => l.parsed && lockCovers(l.parsed, path));
      return lock
        ? { ...entry, lock: { path: lock.path, layer: lock.layer } }
        : entry;
    }),
  };
}

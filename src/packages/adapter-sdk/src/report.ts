import { lockCovers, parsePath, type ResolvedPersona } from "@zzpersona/spec";
import type {
  CapabilityField,
  CapabilityMatrix,
  CompileReport,
  ReportEntry,
  Support,
} from "./types.js";

// "No silent loss", derived rather than trusted: from an adapter's matrix and an IR, the report
// entries a compile must contain. See docs/planning/05-adapter-sdk.md, section 2.

type Required = { path: string; outcome: ReportEntry["outcome"] };

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
    [
      "secrets",
      servers.flatMap(([name, server]) =>
        Object.entries("env" in server ? (server.env ?? {}) : {})
          .filter(([, value]) => value.startsWith("secret://"))
          .map(([key]) => `mcp.servers.${name}.env.${key}`),
      ),
    ],
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
    const support = matrix.fields[field]?.support ?? "none";
    if (support === "native") return [];
    return paths.map((path) => ({ path, outcome: OUTCOME[support] }));
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

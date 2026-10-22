import { diff, type Change } from "@zzpersona/resolver";
import type { CliIo } from "../cli.js";
import { createContext, resolvePersona } from "../context.js";
import { selectPersona } from "../select.js";

// zzpersona diff [a] <b>: what changes from a to b, or from the persona used here to b.
// See docs/planning/08-cli-reach.md, section 3.

export interface DiffOptions {
  json?: boolean;
  overlay: boolean;
  local?: boolean;
}

const MARKS = { added: "+", removed: "-", changed: "~" } as const;

/** Scalars inline; objects and multi-line text as "(changed)". */
const show = (value: unknown) =>
  (typeof value === "string" && !value.includes("\n")) ||
  typeof value === "number" ||
  typeof value === "boolean"
    ? String(value)
    : "(changed)";

function row(change: Change): [string, string, string] {
  const label = `${MARKS[change.change]} ${change.path}`;
  if (change.change === "added") return [label, "", change.toLayer ?? ""];
  if (change.change === "removed") return [label, "", change.fromLayer ?? ""];
  const from = show(change.from);
  const to = show(change.to);
  return [
    label,
    from === "(changed)" || to === "(changed)"
      ? "(changed)"
      : `${from} → ${to}`,
    change.fromLayer === change.toLayer
      ? (change.toLayer ?? "")
      : `${change.fromLayer} → ${change.toLayer}`,
  ];
}

function render(from: string, to: string, changes: Change[]): string {
  if (changes.length === 0) return "no differences\n";
  const rows = changes.map(row);
  const width = (i: number) => Math.max(...rows.map((r) => r[i]!.length));
  const lines = rows.map(([label, values, layers]) =>
    [
      label.padEnd(width(0)),
      ...(values ? [values.padEnd(width(1))] : []),
      layers,
    ]
      .join("  ")
      .trimEnd(),
  );
  const count = `${changes.length} difference${changes.length === 1 ? "" : "s"}`;
  return [`${from} → ${to}   (${count})`, ...lines, ""].join("\n");
}

export async function diffCommand(
  io: CliIo,
  first: string,
  second: string | undefined,
  options: DiffOptions,
): Promise<number> {
  const ctx = await createContext(io, { local: options.local === true });
  const fromSelection = await selectPersona(
    second === undefined ? undefined : first,
    ctx,
  );
  const toSelection = await selectPersona(second ?? first, ctx);
  const changes = diff(
    await resolvePersona(ctx, fromSelection, options.overlay),
    await resolvePersona(ctx, toSelection, options.overlay),
  );
  io.stdout.write(
    options.json
      ? `${JSON.stringify({ from: fromSelection.ref, to: toSelection.ref, changes }, null, 2)}\n`
      : render(fromSelection.ref, toSelection.ref, changes),
  );
  return 0;
}

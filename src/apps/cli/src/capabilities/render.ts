import {
  capabilityFields,
  UNDECLARED,
  type CapabilityEntry,
  type CapabilityField,
  type CapabilityMatrix,
  type Support,
} from "@getdonn/adapter-sdk";
import { HOOK_EVENTS } from "@getdonn/spec";
import { HARNESSES } from "../harness.js";

// The capability matrix as a terminal grid, one harness's list, the published Markdown, or JSON.
// See docs/planning/13-capability-matrix.md, section 2.

export interface Column {
  id: string;
  detected?: { installed: boolean; version?: string; error?: string };
  matrix: CapabilityMatrix;
}

const SYMBOL: Record<Support, string> = {
  native: "●",
  approximated: "◐",
  advisory: "○",
  none: "✕",
};

/** The first-party adapters' full matrices, without detection: the published doc. */
export function firstPartyColumns(): Column[] {
  return Object.values(HARNESSES).map((adapter) => ({
    id: adapter.id,
    matrix: adapter.capabilities(),
  }));
}

function entryOf(column: Column, field: CapabilityField): CapabilityEntry {
  return column.matrix.fields[field] ?? { support: "none", note: UNDECLARED };
}

/** A row: a label, and the field it shows in each column. */
interface Row {
  label: string;
  field: (column: Column) => CapabilityField;
}

const single = (field: CapabilityField): Row => ({
  label: field,
  field: () => field,
});

/** A group shows as one row when, in every column, all its fields say the same. */
function group(
  label: string,
  fields: CapabilityField[],
  columns: Column[],
): Row[] {
  const same = columns.every((column) => {
    const [first, ...rest] = fields.map((f) =>
      JSON.stringify(entryOf(column, f)),
    );
    return rest.every((entry) => entry === first);
  });
  return same ? [{ label, field: () => fields[0]! }] : fields.map(single);
}

function rows(columns: Column[]): Row[] {
  return [
    single("instructions"),
    single("skills"),
    single("mcp.servers"),
    single("secrets"),
    single("knowledge"),
    ...group(
      "permissions",
      ["permissions.allow", "permissions.deny", "permissions.ask"],
      columns,
    ),
    ...group(
      "hooks",
      HOOK_EVENTS.map((event): CapabilityField => `hooks.${event}`),
      columns,
    ),
    single("policy"),
    single("models"),
    { label: "targets", field: (column) => `targets.${column.id}` },
  ];
}

const header = (column: Column) =>
  column.detected === undefined
    ? column.id
    : column.detected.error !== undefined
      ? `${column.id} (detection failed)`
      : column.detected.installed
        ? `${column.id} ${column.detected.version ?? ""}`.trimEnd()
        : `${column.id} (not installed)`;

/** Cells with their note numbers; notes and caveats share one numbering, equal text one number. */
function table(columns: Column[]) {
  const numbers = new Map<string, number>();
  const number = (text: string) => {
    if (!numbers.has(text)) numbers.set(text, numbers.size + 1);
    return numbers.get(text)!;
  };
  const body = rows(columns).map((row) => ({
    label: row.label,
    cells: columns.map((column) => {
      const entry = entryOf(column, row.field(column));
      const refs = [entry.note, entry.caveat]
        .filter((text): text is string => text !== undefined)
        .map(number);
      return {
        symbol: SYMBOL[entry.support],
        caveat: entry.caveat !== undefined,
        refs,
      };
    }),
  }));
  return { body, notes: [...numbers.keys()] };
}

const LEGEND = "● native  ◐ approximated  ○ advisory  ✕ none  * caveat";

export function renderGrid(columns: Column[]): string {
  const { body, notes } = table(columns);
  const cellText = (c: (typeof body)[number]["cells"][number]) =>
    `${c.symbol}${c.caveat ? "*" : ""}${c.refs.length > 0 ? ` ${c.refs.join(",")}` : ""}`;
  const labelWidth = Math.max(...body.map((r) => r.label.length)) + 2;
  const widths = columns.map(
    (column, i) =>
      Math.max(
        header(column).length,
        ...body.map((r) => cellText(r.cells[i]!).length),
      ) + 2,
  );
  const line = (label: string, cells: string[]) =>
    (
      label.padEnd(labelWidth) +
      cells.map((cell, i) => cell.padEnd(widths[i]!)).join("")
    ).trimEnd();
  const grid = [
    line("", columns.map(header)),
    ...body.map((r) => line(r.label, r.cells.map(cellText))),
  ];
  const width = String(notes.length).length;
  return `${[
    grid.join("\n"),
    LEGEND,
    notes.map((n, i) => `${String(i + 1).padStart(width)}  ${n}`).join("\n"),
  ].join("\n\n")}\n`;
}

/** One harness: a line per field with its support, note and caveat. */
export function renderHarness(column: Column): string {
  const fields = capabilityFields(column.id);
  const width = Math.max(...fields.map((f) => f.length)) + 2;
  const supportWidth =
    Math.max(...Object.keys(SYMBOL).map((s) => s.length)) + 4;
  const lines = fields.map((field) => {
    const entry = entryOf(column, field);
    const text = [entry.note, entry.caveat && `* ${entry.caveat}`]
      .filter(Boolean)
      .join("  ");
    return (
      field.padEnd(width) +
      `${SYMBOL[entry.support]} ${entry.support}`.padEnd(supportWidth) +
      text
    ).trimEnd();
  });
  return `${header(column)}\n\n${lines.join("\n")}\n`;
}

const DOC_HEADER = [
  "# Capability matrix",
  "",
  "Generated by `donn capabilities --markdown`; regenerate with `pnpm docs:capabilities`. Do not edit by hand.",
  "",
  "- ● native — carried and enforced as the persona says",
  "- ◐ approximated — carried, but weaker or as guidance",
  "- ○ advisory — shown to the model, not enforced",
  "- ✕ none — not carried; the compile report lists each item",
  "- \\* — a caveat applies; see its note",
  "",
  "Each compile's report names the exact items affected.",
  "",
  "Harnesses without an adapter yet: Copilot CLI, Cursor, Gemini CLI, Antigravity.",
];

/** The published Markdown form: the header, the table, then the numbered notes. */
export function capabilitiesDoc(columns: Column[]): string {
  const { body, notes } = table(columns);
  const cell = (c: (typeof body)[number]["cells"][number]) =>
    `${c.symbol}${c.caveat ? "\\*" : ""}${c.refs.length > 0 ? ` ${c.refs.join(", ")}` : ""}`;
  const tableLines = [
    `| Field | ${columns.map(header).join(" | ")} |`,
    `|---|${columns.map(() => "---|").join("")}`,
    ...body.map((r) => `| ${r.label} | ${r.cells.map(cell).join(" | ")} |`),
  ];
  return `${[
    DOC_HEADER.join("\n"),
    tableLines.join("\n"),
    `Notes:\n\n${notes.map((n, i) => `${i + 1}. ${n}`).join("\n")}`,
  ].join("\n\n")}\n`;
}

export function capabilitiesJson(columns: Column[]) {
  return {
    harnesses: columns.map((column) => ({
      id: column.id,
      ...(column.detected && { detected: column.detected }),
      fields: Object.fromEntries(
        capabilityFields(column.id).map((field) => [
          field,
          entryOf(column, field),
        ]),
      ),
    })),
  };
}

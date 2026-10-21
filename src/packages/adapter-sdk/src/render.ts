import { HOOK_EVENTS } from "@zzpersona/spec";
import {
  FIXED_CAPABILITY_FIELDS,
  type ActivationPlan,
  type CompileOutput,
  type HarnessAdapter,
} from "./types.js";

// Stable text renderings: one compile result for golden files, and every adapter's matrix as
// the published capability table. See docs/planning/05-adapter-sdk.md, sections 2–3.

const section = (title: string, lines: string[]) =>
  lines.length === 0 ? [] : [title, ...lines];

const byKey = <T>(record: Record<string, T>) =>
  Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

export function renderBuild(
  output: CompileOutput,
  plan: ActivationPlan,
): string {
  const files = byKey(output.files);
  const secrets = byKey(output.secretEnv);
  const { entries } = output.report;
  const lines = [
    `mode: ${output.report.mode ?? "default"}`,
    ...section(
      `files (${files.length})`,
      files.flatMap(([path, file]) =>
        "copyFrom" in file
          ? [`  ${path} <- copy ${file.copyFrom}`]
          : [
              `  ${path} (${(file.mode ?? 0o644).toString(8).padStart(4, "0")})`,
              ...file.content.split("\n").map((line) => `    ${line}`),
            ],
      ),
    ),
    ...section(
      `secretEnv (${secrets.length})`,
      secrets.map(([name, ref]) => `  ${name} = ${ref}`),
    ),
    ...section(
      `report (${entries.length})`,
      entries.map((e) =>
        [
          `  ${e.outcome}  ${e.path}  ${e.reason}`,
          e.lock ? `  locked: ${e.lock.path} by ${e.lock.layer}` : "",
        ].join(""),
      ),
    ),
    ...section(
      `plan (${plan.steps.length})`,
      plan.steps.flatMap((step) => {
        if (step.kind === "overlay") {
          return [`  overlay ${step.path} (${step.content.length} chars)`];
        }
        const env = Object.keys(step.env).sort();
        return [
          `  launch ${[step.command, ...step.args].join(" ")}`,
          ...(env.length > 0 ? [`    env: ${env.join(", ")}`] : []),
        ];
      }),
    ),
  ];
  return `${lines.join("\n")}\n`;
}

/** Markdown table of what each adapter can express, in contract field order. */
export function renderCapabilities(adapters: HarnessAdapter[]): string {
  const matrices = adapters.map((adapter) => adapter.capabilities().fields);
  const declared = new Set(matrices.flatMap((fields) => Object.keys(fields)));
  const order = [
    ...FIXED_CAPABILITY_FIELDS,
    ...HOOK_EVENTS.map((event) => `hooks.${event}`),
    ...[...declared].filter((field) => field.startsWith("targets.")).sort(),
  ];
  const rows = order
    .filter((field) => declared.has(field))
    .map((field) => {
      const cells = matrices.map((fields) => {
        const support = fields[field as keyof typeof fields]?.support ?? "none";
        return support === "none" ? "—" : support;
      });
      return `| ${field} | ${cells.join(" | ")} |`;
    });
  return [
    `| field | ${adapters.map((a) => a.id).join(" | ")} |`,
    `|---|${adapters.map(() => "---|").join("")}`,
    ...rows,
    "",
  ].join("\n");
}

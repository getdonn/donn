import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parsePath, type ResolvedPersona } from "@zzpersona/spec";
import { defineAdapter } from "../define.js";
import { isContainedPath, secretRefsIn, serverSecretRefs } from "../paths.js";
import { annotateLocks, requiredEntries } from "../report.js";
import type {
  ActivateInput,
  ActivationPlan,
  CompileOutput,
  Detection,
  HarnessAdapter,
  Probe,
} from "../types.js";
import { corpus, type CorpusEntry } from "./corpus/index.js";

// The conformance kit: framework-neutral checks every adapter must pass, ours and third
// parties'. See docs/planning/05-adapter-sdk.md, section 3.

export const CHECK_NAMES = [
  "declaration",
  "rejects-unsupported-ir",
  "deterministic",
  "well-formed-output",
  "no-secret-leaks",
  "no-silent-loss",
  "detect-not-installed",
  "no-writes",
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

/** Checks that run once per corpus entry; the others run once per adapter. */
export const PER_ENTRY_CHECKS: readonly CheckName[] = [
  "deterministic",
  "well-formed-output",
  "no-secret-leaks",
  "no-silent-loss",
];

export interface CheckResult {
  name: CheckName;
  corpusEntry?: string;
  passed: boolean;
  reason?: string;
}

export interface ConformanceOptions {
  /** The detection compile and activate receive. Defaults to an installed harness, no facts. */
  detection?: Detection;
  /**
   * The adapter targets a file format, not a program (agents-md): detect must report installed
   * without running anything, instead of reporting a missing program as not installed.
   */
  noBinary?: boolean;
}

const DEFAULT_DETECTION: Detection = {
  installed: true,
  version: "0.0.0",
  facts: {},
};
const MODES = new Set([0o600, 0o644, 0o755]);

const isContained = isContainedPath;

/** Problems found, empty when the check passes. */
type Check = () => string[];

function outcome(
  name: CheckName,
  check: Check,
  corpusEntry?: string,
): CheckResult {
  let problems: string[];
  try {
    problems = check();
  } catch (error) {
    problems = [`threw: ${(error as Error).message}`];
  }
  return {
    name,
    ...(corpusEntry !== undefined && { corpusEntry }),
    passed: problems.length === 0,
    ...(problems.length > 0 && { reason: problems.join("; ") }),
  };
}

/** Secret refs an adapter might write: in MCP servers, and in its own targets block. */
const secretRefs = (ir: ResolvedPersona, adapterId: string) => [
  ...serverSecretRefs(ir),
  ...secretRefsIn(ir.targets[adapterId], `targets.${adapterId}`),
];

const RANK: Record<string, number> = {
  approximated: 1,
  advisory: 2,
  dropped: 3,
};

/** An entry at `entry` speaks for `path`: the same value, or a parent of it. */
const covers = (entry: string, path: string) =>
  entry === path ||
  path.startsWith(`${entry}.`) ||
  path.startsWith(`${entry}[`);

/** Whether a report path names a value present in the IR. */
function pathExists(ir: ResolvedPersona, path: string): boolean {
  const parsed = parsePath(path);
  if (!parsed) return false;
  let node: unknown = ir;
  for (const key of parsed.keys) {
    if (typeof node !== "object" || node === null || !(key in node))
      return false;
    node = (node as Record<string, unknown>)[key];
  }
  if (parsed.entry === undefined) return true;
  return (
    Array.isArray(node) &&
    node.some((item) =>
      typeof item === "string"
        ? item === parsed.entry
        : item?.id === parsed.entry || item?.name === parsed.entry,
    )
  );
}

function wellFormed(output: CompileOutput, plan: ActivationPlan): string[] {
  const problems: string[] = [];
  for (const [path, file] of Object.entries(output.files)) {
    if (!isContained(path))
      problems.push(`file path escapes the build dir: ${path}`);
    if (file.mode !== undefined && !MODES.has(file.mode)) {
      problems.push(`invalid mode ${file.mode.toString(8)} for ${path}`);
    }
    if ("copyFrom" in file && !isContained(file.copyFrom)) {
      problems.push(`copyFrom escapes the personas root: ${file.copyFrom}`);
    }
  }
  for (const step of plan.steps) {
    if (step.kind === "overlay" && !isContained(step.path)) {
      problems.push(`overlay escapes the project: ${step.path}`);
    }
    if (step.kind === "overlay" && step.block !== undefined) {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(step.block)) {
        problems.push(`overlay block name is not kebab-case: ${step.block}`);
      } else if (
        step.content.includes(`<!-- ${step.block}:begin`) ||
        step.content.includes(`<!-- ${step.block}:end -->`)
      ) {
        problems.push(`overlay content holds its own ${step.block} markers`);
      }
    }
    if (step.kind === "launch" && step.command.trim() === "") {
      problems.push("launch step has no command");
    }
  }
  return problems;
}

function noSecretLeaks(
  adapterId: string,
  ir: ResolvedPersona,
  output: CompileOutput,
  plan: ActivationPlan,
): string[] {
  const problems: string[] = [];
  const leaks = (text: string) => text.includes("secret://");
  for (const [path, file] of Object.entries(output.files)) {
    if ("content" in file && leaks(file.content))
      problems.push(`secret ref in ${path}`);
  }
  for (const step of plan.steps) {
    if (step.kind === "launch" && step.args.some(leaks)) {
      problems.push("secret ref in launch args");
    }
    if (step.kind === "overlay" && leaks(step.content)) {
      problems.push(`secret ref in overlay ${step.path}`);
    }
  }
  const placed = new Set(Object.values(output.secretEnv));
  const dropped = output.report.entries.filter((e) => e.outcome === "dropped");
  for (const { path, ref } of secretRefs(ir, adapterId)) {
    const reported = dropped.some((e) => covers(e.path, path));
    if (!placed.has(ref as never) && !reported) {
      problems.push(`${path} is neither in secretEnv nor reported dropped`);
    }
  }
  return problems;
}

function noSilentLoss(
  adapter: HarnessAdapter,
  detection: Detection,
  ir: ResolvedPersona,
  output: CompileOutput,
): string[] {
  const { entries } = output.report;
  // The matrix for this detection's mode, so a degraded mode's losses are required too. An
  // entry satisfies a requirement if it covers the same value or a parent, at least as lossy.
  const problems = requiredEntries(
    adapter.id,
    adapter.capabilities(detection),
    ir,
  )
    .filter(
      (r) =>
        !entries.some(
          (e) => covers(e.path, r.path) && RANK[e.outcome]! >= RANK[r.outcome]!,
        ),
    )
    .map((r) => `missing report entry: ${r.outcome} ${r.path}`);
  for (const entry of entries) {
    if (!pathExists(ir, entry.path)) {
      problems.push(`report names a value not in the IR: ${entry.path}`);
    }
  }
  const expected = annotateLocks(output.report, ir).entries.map((e) => e.lock);
  if (
    !isDeepStrictEqual(
      entries.map((e) => e.lock),
      expected,
    )
  ) {
    problems.push("lock annotations differ from annotateLocks()");
  }
  return problems;
}

const notInstalled: Probe = {
  run: async () => ({ exitCode: 127, stdout: "", stderr: "not found" }),
  readFile: async () => undefined,
  listDir: async () => undefined,
  platform: process.platform,
};

/**
 * Run every check against `adapter`. All compile and activate calls run inside a fresh, empty
 * working directory, which must still be empty afterwards; the original working directory is
 * restored before returning. Needs a test runner that allows process.chdir (vitest's forks pool).
 */
export async function runConformance(
  adapter: HarnessAdapter,
  options: ConformanceOptions = {},
): Promise<CheckResult[]> {
  const detection = options.detection ?? DEFAULT_DETECTION;
  const results: CheckResult[] = [];

  results.push(
    outcome("declaration", () => {
      defineAdapter(adapter);
      return adapter.apiVersion === 1
        ? []
        : [`apiVersion ${String(adapter.apiVersion)} is not 1`];
    }),
  );

  const before = process.cwd();
  const sandbox = mkdtempSync(join(tmpdir(), "zzp-conformance-"));
  let chdirError: Error | undefined;
  try {
    process.chdir(sandbox);
  } catch (error) {
    // vitest's threads pool (worker threads) has no process.chdir.
    chdirError = error as Error;
  }
  try {
    const [first] = corpus as [CorpusEntry];
    results.push(
      outcome("rejects-unsupported-ir", () => {
        const input = {
          ...inputFor(first, detection),
          ir: { ...first.ir, irVersion: 9999 },
        };
        try {
          adapter.compile(input as never);
        } catch (error) {
          return (error as Error).name === "UnsupportedIrVersionError"
            ? []
            : [`threw ${(error as Error).name}, not UnsupportedIrVersionError`];
        }
        return ["compiled an IR version it does not accept"];
      }),
    );
    for (const entry of corpus)
      results.push(...checkEntry(adapter, entry, detection));
    if (chdirError === undefined) process.chdir(before);
    const written = readdirSync(sandbox);
    results.push(
      outcome("no-writes", () => {
        if (chdirError !== undefined) {
          return [
            `cannot change directory (${chdirError.message}); run conformance under vitest's forks pool`,
          ];
        }
        return written.length === 0
          ? []
          : [`wrote to the working directory: ${written.join(", ")}`];
      }),
    );
  } finally {
    if (chdirError === undefined) process.chdir(before);
    rmSync(sandbox, { recursive: true, force: true });
  }

  let detected: Detection | undefined;
  let detectError: unknown;
  let probed = false;
  const watched: Probe = {
    ...notInstalled,
    run: (command, args) => {
      probed = true;
      return notInstalled.run(command, args);
    },
  };
  try {
    detected = await adapter.detect(watched);
  } catch (error) {
    detectError = error;
  }
  results.push(
    outcome("detect-not-installed", () => {
      if (detectError) return [`threw: ${(detectError as Error).message}`];
      if (options.noBinary) {
        return [
          ...(detected?.installed === true
            ? []
            : ["did not report installed: true"]),
          ...(probed ? ["ran a command, but declares no binary"] : []),
        ];
      }
      return detected?.installed === false
        ? []
        : ["did not report installed: false"];
    }),
  );
  return results;
}

function inputFor(entry: CorpusEntry, detection: Detection) {
  return {
    personaId: entry.personaId,
    ir: entry.ir,
    detection,
    texts: entry.texts,
  };
}

function checkEntry(
  adapter: HarnessAdapter,
  entry: CorpusEntry,
  detection: Detection,
): CheckResult[] {
  const activateInput = (output: CompileOutput): ActivateInput => ({
    ir: entry.ir,
    output,
    buildDir: "/BUILD",
    detection,
    cwd: "/PROJECT",
    passthrough: [],
  });
  let output: CompileOutput;
  let plan: ActivationPlan;
  try {
    output = adapter.compile(inputFor(entry, detection));
    plan = adapter.activate(activateInput(output));
  } catch (error) {
    return PER_ENTRY_CHECKS.map((name) =>
      outcome(name, () => [`threw: ${(error as Error).message}`], entry.name),
    );
  }
  return [
    outcome(
      "deterministic",
      () => {
        const again = adapter.compile(inputFor(entry, detection));
        const problems: string[] = [];
        if (!isDeepStrictEqual(output, again))
          problems.push("compile output differs between runs");
        if (!isDeepStrictEqual(plan, adapter.activate(activateInput(output)))) {
          problems.push("activation plan differs between runs");
        }
        return problems;
      },
      entry.name,
    ),
    outcome("well-formed-output", () => wellFormed(output, plan), entry.name),
    outcome(
      "no-secret-leaks",
      () => noSecretLeaks(adapter.id, entry.ir, output, plan),
      entry.name,
    ),
    outcome(
      "no-silent-loss",
      () => noSilentLoss(adapter, detection, entry.ir, output),
      entry.name,
    ),
  ];
}

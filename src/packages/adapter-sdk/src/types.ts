import type { HookEvent, Ref, ResolvedPersona } from "@zzpersona/spec";

// The harness adapter contract. See docs/planning/05-adapter-sdk.md, sections 1–2.
// Adapters are pure: compile() and activate() return data, and the CLI carries out the side
// effects. Only detect() observes the machine, through the Probe the CLI passes in.

export interface HarnessAdapter {
  apiVersion: 1;
  /** Kebab-case, e.g. "claude-code". */
  id: string;
  /** IR versions this adapter accepts. */
  irVersions: readonly number[];
  /** With a detection, the matrix for the mode that detection puts the adapter in. */
  capabilities(detection?: Detection): CapabilityMatrix;
  detect(probe: Probe): Promise<Detection>;
  compile(input: CompileInput): CompileOutput;
  activate(input: ActivateInput): ActivationPlan;
}

export interface Probe {
  /** Runs a command. Never throws for a missing command: returns exit code 127. */
  run(
    command: string,
    args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** File contents, or undefined when absent. */
  readFile(path: string): Promise<string | undefined>;
  /** Entry names in a directory, or undefined when absent. */
  listDir(path: string): Promise<string[] | undefined>;
  platform: NodeJS.Platform;
}

export interface Detection {
  installed: boolean;
  version?: string;
  /** Adapter-specific facts that change compile or activate. */
  facts: Record<string, string | number | boolean>;
}

export interface CompileInput {
  personaId: Ref;
  ir: ResolvedPersona;
  detection: Detection;
  /** Text of every file the IR references by path, keyed by personas-root-relative path. */
  texts: Record<string, string>;
}

export type FileMode = 0o600 | 0o644 | 0o755;

export type FileEntry =
  | { content: string; mode?: FileMode }
  /** Copied by the CLI from a personas-root-relative path (a file or a directory). */
  | { copyFrom: string; mode?: FileMode };

export type SecretRef = `secret://${string}`;

export interface CompileOutput {
  /** Build-dir-relative paths. */
  files: Record<string, FileEntry>;
  /** Placeholder env var → secret ref. Files contain `${NAME}`, never values. */
  secretEnv: Record<string, SecretRef>;
  report: CompileReport;
}

export interface ActivateInput {
  ir: ResolvedPersona;
  output: CompileOutput;
  /** Absolute; the CLI wrote `output.files` here. */
  buildDir: string;
  detection: Detection;
  /** The project directory. */
  cwd: string;
  /** Extra args the user gave after `--`. */
  passthrough: string[];
}

export type Step =
  | {
      kind: "launch";
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
    }
  /** A project-relative file; the CLI adds the ownership marker. */
  | { kind: "overlay"; path: string; content: string };

export interface ActivationPlan {
  steps: Step[];
}

/**
 * native        same meaning, enforced by the harness
 * approximated  expressed with different semantics
 * advisory      rendered as instruction text the model may ignore
 * none          dropped
 */
export type Support = "native" | "approximated" | "advisory" | "none";

export const FIXED_CAPABILITY_FIELDS = [
  "instructions",
  "skills",
  "mcp.servers",
  "knowledge",
  "secrets",
  "permissions.allow",
  "permissions.deny",
  "permissions.ask",
] as const;

export type CapabilityField =
  | (typeof FIXED_CAPABILITY_FIELDS)[number]
  | `hooks.${HookEvent}`
  | `targets.${string}`;

export interface CapabilityMatrix {
  /** A field left out counts as "none". */
  fields: Partial<Record<CapabilityField, { support: Support; note?: string }>>;
}

export interface ReportEntry {
  /** IR path grammar from @zzpersona/spec. */
  path: string;
  outcome: "approximated" | "advisory" | "dropped";
  reason: string;
  /** Added by the SDK (annotateLocks), never by the adapter. */
  lock?: { path: string; layer: Ref };
}

export interface CompileReport {
  adapter: string;
  irVersion: number;
  /** Set when detection changed the strategy. */
  mode?: string;
  /** Lossy items only. */
  entries: ReportEntry[];
}

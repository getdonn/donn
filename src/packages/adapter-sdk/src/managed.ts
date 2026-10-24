import type { Ref, ResolvedPersona } from "@getdonn/spec";

// The managed policy bundle: an org/area/team chain's locks compiled to the files a harness's
// administrator-owned policy folder holds. See docs/planning/21-managed-settings.md, section 2.
// Optional on the adapter contract: only harnesses with machine-wide policy implement it.

export type ManagedOs = "macos" | "linux" | "windows";

/** A layer the bundle was compiled from: its ref, published version and content digest. */
export interface ManagedLayer {
  ref: Ref;
  version?: number;
  digest: string;
}

export interface ManagedInput {
  /** The resolved chain: the deepest layer's IR, with every lock its ancestors declared. */
  ir: ResolvedPersona;
  /** The chain, root first; copied into the manifest. */
  layers: ManagedLayer[];
  os: ManagedOs;
  /** The CLI version that compiles, recorded in the manifest. */
  donn: string;
  /** Instruction file texts, keyed as in the IR (personas-root-relative). */
  texts: Record<string, string>;
  /** Hook run files, keyed as in the IR (personas-root-relative). */
  scripts: Record<string, Uint8Array>;
  /**
   * Which layer set each value, keyed by path (the resolver's provenance). Names the layer of
   * `policy` and `targets.<harness>.managed` entries, which are locked by being set rather than
   * by a declared lock. Without it those entries name the chain's root layer.
   */
  provenance?: Record<string, Ref>;
}

export type ManagedCode =
  | "managed-secret"
  | "managed-mcp-needs-exclusive"
  | "managed-unknown-key"
  /** A `targets.<harness>.managed` key would replace a value the compile produced. */
  | "managed-passthrough-conflict";

export interface ManagedEntry {
  /** IR path grammar from @getdonn/spec. */
  path: string;
  /** The layer whose lock (or policy) put the value in the bundle. */
  layer: Ref;
  /** `refused` fails the build. */
  outcome: "enforced" | "advisory" | "refused";
  /** Set on refusals. */
  code?: ManagedCode;
  reason: string;
}

export type ManagedWarningCode =
  "partial-mode" | "plugin-hooks-dropped" | "console-hooks-approval";

export interface ManagedReport {
  /** One per locked value, and one per lock that covers nothing the bundle carries. */
  entries: ManagedEntry[];
  /** Where the policy weakens donn's own launches. */
  warnings: { code: ManagedWarningCode; message: string }[];
}

export interface ManagedManifest {
  format: 1;
  donn: string;
  os: ManagedOs;
  layers: ManagedLayer[];
  /** Root-relative path → sha256 hex, for every bundle file but the manifest itself. */
  files: Record<string, string>;
  /** The highest Claude Code version any key in the bundle needs. */
  minClaudeCode?: string;
  report: ManagedReport;
}

export interface ManagedResult {
  report: ManagedReport;
  /** Absent when any entry is refused. Includes donn/manifest.json. */
  bundle?: {
    /** Paths relative to the policy root, `/`-separated on every OS. */
    files: Record<string, Uint8Array>;
    manifest: ManagedManifest;
  };
}

export interface ManagedCompiler {
  /** The personas-root-relative files compile() needs read: locked instruction files and hooks. */
  inputs(ir: ResolvedPersona): { texts: string[]; scripts: string[] };
  /** Pure: the same input gives the same bytes. */
  compile(input: ManagedInput): ManagedResult;
  /** The policy folder on each OS. */
  roots: Record<ManagedOs, string>;
}

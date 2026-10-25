import type { Ref, ResolvedPersona } from "@getdonn/spec";
import { AdapterDeclarationError, isCapabilityField } from "./define.js";
import { capabilityFields } from "./report.js";
import type {
  CapabilityMatrix,
  CompileReport,
  FileEntry,
  SecretRef,
} from "./types.js";

// The agent adapter contract. See docs/planning/24-adapter-eve.md, section 1. Like a harness
// adapter, an agent adapter is pure: compile() returns data and the CLI writes the files.

export interface AgentAdapter {
  apiVersion: 1;
  /** Kebab-case; also the template prefix: "eve" for `eve:<slug>`. */
  id: string;
  irVersions: readonly number[];
  /** The framework versions this adapter compiles for, as a semver range. */
  frameworkRange: string;
  /**
   * Env names the generated files may read although the agent does not set them: provider keys
   * (`ANTHROPIC_API_KEY`) and a world's connection variable (`DATABASE_URL`). The `env-declared`
   * conformance check allows exactly these, besides the keys of `env` and `secretEnv`.
   */
  providerEnv?: readonly string[];
  /** Every fixed capability field declared, as for harnesses (spec 13). */
  capabilities(): CapabilityMatrix;
  /** Known templates and what each needs at each target. */
  templates(): TemplateInfo[];
  compile(input: AgentCompileInput): AgentCompileOutput; // pure, synchronous
}

export interface AgentCompileInput {
  personaId: Ref;
  ir: ResolvedPersona;
  /** A key of `ir.agents`. */
  agent: string;
  /** The pinned framework version (`25` §2). */
  frameworkVersion: string;
  /** Text of every file the IR references by path, as for harnesses, and of every file of a local skill directory. */
  texts: Record<string, string>;
  /** Facts about the created project that change the output. */
  project: {
    /** Did the template author a sandbox. */
    hasSandbox: boolean;
    /** Agent-directory paths not in the manifest (template- or user-owned), for collisions. */
    existing: string[];
  };
}

export interface AgentCompileOutput {
  /** Agent-directory-relative; every one is donn-owned. */
  files: Record<string, FileEntry>;
  /** Placeholder env var → secret ref. Files read `process.env.<NAME>`, never values. */
  secretEnv: Record<string, SecretRef>;
  /** Plain values from `agents.define.<name>.env`. */
  env: Record<string, string>;
  report: CompileReport;
  portability: PortabilityEntry[];
}

export type VercelService =
  | "connect"
  | "sandbox"
  | "drive"
  | "daemons"
  | "ai-gateway"
  | "github-checkout";

/** What a portability entry is about: a Vercel service, or the route auth every agent has (`vercelOidc()`). */
export type PortabilityService = VercelService | "route-auth";

export interface TemplateInfo {
  /** The gallery slug: "kody-eve-template". */
  slug: string;
  /** "GitHub Project Maintainer" */
  title: string;
  /** Directory in the framework repository at the version tag; absent for a template kept elsewhere. */
  repoPath?: string;
  /** Vercel-only services the template's code uses. */
  services: VercelService[];
}

export interface PortabilityEntry {
  target: "local" | "self-host" | "vercel";
  service: PortabilityService;
  /** What to do instead at this target, written to be read as an instruction. */
  instead: string;
  /** Env names the replacement needs, if any. */
  env?: string[];
  /** The agent cannot run at this target until the user acts on it. */
  blocking: boolean;
}

/** The prefix of every skill and connection donn writes into an agent's slots. */
export const DONN_SLOT_PREFIX = "donn-";
/** eve's longest slot name, prefix included. */
export const SLOT_NAME_MAX_LENGTH = 64;
/** eve 0.83 connection names: lowercase ASCII letters, digits and dashes, starting with a letter. */
export const CONNECTION_NAME_RULE = /^[a-z][a-z0-9-]*$/;
/** eve 0.83 skill names: ASCII letters, digits, `_` and `-`, starting with a letter or digit. */
export const SKILL_NAME_RULE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NUM = "(?:0|[1-9]\\d*)";
const COMPARATOR = new RegExp(`^(>=|<=|>|<|=|\\^|~)?${NUM}\\.${NUM}\\.${NUM}$`);

/**
 * Whether `range` is a semver range this SDK understands: space-separated comparators, each
 * `>=a.b.c`, `<a.b.c`, `^a.b.c`, `~a.b.c` or an exact `a.b.c` (also `>`, `<=`, `=`), numbers
 * without leading zeros. Intentionally narrow: no `||`, `x`-ranges, hyphen ranges or prerelease tags.
 */
export function isSemverRange(range: string): boolean {
  const parts = range.trim().split(/\s+/);
  return parts.every((part) => COMPARATOR.test(part));
}

/** Problems with a capability matrix: a fixed field left out, or not native without a note. */
export function matrixProblems(
  adapterId: string,
  matrix: CapabilityMatrix,
): string[] {
  return capabilityFields(adapterId).flatMap((field) => {
    const entry = matrix.fields[field];
    if (!entry) return [`missing field ${field}`];
    return entry.support !== "native" && !entry.note
      ? [`${field} is ${entry.support} without a note`]
      : [];
  });
}

/** Stamp the contract version on an agent adapter and check its declaration. */
export function defineAgentAdapter(
  declaration: Omit<AgentAdapter, "apiVersion">,
): AgentAdapter {
  const fail = (problem: string) => {
    throw new AdapterDeclarationError(`adapter ${declaration.id}: ${problem}`);
  };
  if (!KEBAB.test(declaration.id)) fail("id must be lowercase kebab-case");
  if (declaration.irVersions.length === 0)
    fail("must accept at least one IR version");
  if (!isSemverRange(declaration.frameworkRange))
    fail(
      `frameworkRange "${declaration.frameworkRange}" is not a semver range`,
    );
  for (const field of Object.keys(declaration.capabilities().fields)) {
    if (!isCapabilityField(field)) fail(`unknown capability field "${field}"`);
  }
  const problems = matrixProblems(declaration.id, declaration.capabilities());
  if (problems.length > 0) fail(problems.join("; "));
  // Built from named fields, so the methods of a class-based adapter survive.
  return {
    apiVersion: 1,
    id: declaration.id,
    irVersions: declaration.irVersions,
    frameworkRange: declaration.frameworkRange,
    ...(declaration.providerEnv && { providerEnv: declaration.providerEnv }),
    capabilities: declaration.capabilities.bind(declaration),
    templates: declaration.templates.bind(declaration),
    compile: declaration.compile.bind(declaration),
  };
}

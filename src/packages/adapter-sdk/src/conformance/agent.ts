import { isDeepStrictEqual } from "node:util";
import { isContainedPath, secretRefsIn } from "../paths.js";
import {
  CONNECTION_NAME_RULE,
  DONN_SLOT_PREFIX,
  matrixProblems,
  SKILL_NAME_RULE,
  SLOT_NAME_MAX_LENGTH,
  type AgentAdapter,
  type AgentCompileInput,
  type AgentCompileOutput,
} from "../agent.js";

// The agent half of the conformance kit. See docs/planning/24-adapter-eve.md, section 1.
// compile() is pure, so unlike the harness half nothing here needs a working directory.

export const AGENT_CHECK_NAMES = [
  "complete-matrix",
  "unique-templates",
  "deterministic",
  "no-secrets",
  "paths-inside",
  "env-declared",
  "donn-names",
  "connection-description",
] as const;
export type AgentCheckName = (typeof AGENT_CHECK_NAMES)[number];

/** Checks that run once per case; the others run once per adapter. */
export const AGENT_PER_CASE_CHECKS: readonly AgentCheckName[] = [
  "deterministic",
  "no-secrets",
  "paths-inside",
  "env-declared",
  "donn-names",
  "connection-description",
];

export interface AgentConformanceCase {
  name: string;
  input: AgentCompileInput;
}

export interface AgentConformanceResult {
  name: AgentCheckName;
  case?: string;
  passed: boolean;
  reason?: string;
}

/** Problems found, empty when the check passes. */
type Check = () => string[];

function outcome(
  name: AgentCheckName,
  check: Check,
  caseName?: string,
): AgentConformanceResult {
  let problems: string[];
  try {
    problems = check();
  } catch (error) {
    problems = [`threw: ${(error as Error).message}`];
  }
  return {
    name,
    ...(caseName !== undefined && { case: caseName }),
    passed: problems.length === 0,
    ...(problems.length > 0 && { reason: problems.join("; ") }),
  };
}

/**
 * The files whose text donn wrote itself. A `copyFrom` entry is a skill directory copied from
 * the persona, its own files, which the secret and env checks leave alone.
 */
const contentFiles = (output: AgentCompileOutput) =>
  Object.entries(output.files).flatMap(([path, file]) =>
    "content" in file ? [{ path, content: file.content }] : [],
  );

/** A path inside the agent directory; a leading `agent/` is accepted and ignored. */
const slotPath = (path: string) => path.replace(/^agent\//, "");

const structuredCopy = <T>(value: T): T => structuredClone(value);

function pathsInside(output: AgentCompileOutput): string[] {
  const problems: string[] = [];
  for (const [path, file] of Object.entries(output.files)) {
    const normalized = path.split("/").filter((s) => s !== "." && s !== "");
    if (!isContainedPath(path) || normalized.join("/") !== path)
      problems.push(`path is not relative and normalized: ${path}`);
    // Copied directories are checked by where they land, like any other output.
    if ("copyFrom" in file && !isContainedPath(file.copyFrom))
      problems.push(`copyFrom escapes the personas root: ${file.copyFrom}`);
  }
  return problems;
}

function noSecrets(
  input: AgentCompileInput,
  output: AgentCompileOutput,
): string[] {
  const refs = new Set([
    ...secretRefsIn(input.ir, "ir").map((r) => r.ref),
    ...Object.values(output.secretEnv),
  ]);
  const problems: string[] = [];
  for (const { path, content } of contentFiles(output)) {
    if (content.includes("secret://")) problems.push(`secret ref in ${path}`);
    for (const ref of refs) {
      if (content.includes(ref)) problems.push(`secret ref ${ref} in ${path}`);
    }
  }
  return problems;
}

const ENV_READ =
  /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*["'`]([^"'`]+)["'`]\s*\])/g;

function envDeclared(
  adapter: AgentAdapter,
  output: AgentCompileOutput,
): string[] {
  const allowed = new Set([
    ...Object.keys(output.env),
    ...Object.keys(output.secretEnv),
    ...(adapter.providerEnv ?? []),
  ]);
  const problems: string[] = [];
  for (const { path, content } of contentFiles(output)) {
    for (const match of content.matchAll(ENV_READ)) {
      const name = (match[1] ?? match[2])!;
      if (!allowed.has(name))
        problems.push(`${path} reads undeclared process.env.${name}`);
    }
  }
  return problems;
}

function donnNames(output: AgentCompileOutput): string[] {
  const problems: string[] = [];
  const check = (
    path: string,
    kind: string,
    name: string,
    rule: RegExp,
  ): void => {
    if (!name.startsWith(DONN_SLOT_PREFIX))
      problems.push(`${kind} ${path} is not named ${DONN_SLOT_PREFIX}…`);
    else if (!rule.test(name) || name.length > SLOT_NAME_MAX_LENGTH)
      problems.push(`${kind} name "${name}" breaks the framework's name rule`);
  };
  for (const path of Object.keys(output.files)) {
    const rel = slotPath(path);
    const connection = /^connections\/([^/]+)\.ts$/.exec(rel);
    if (connection)
      check(path, "connection", connection[1]!, CONNECTION_NAME_RULE);
    else if (rel.startsWith("connections/"))
      problems.push(`connection ${path} is not connections/<name>.ts`);
    if (rel.startsWith("skills/")) {
      const [, entry = ""] = rel.split("/");
      check(path, "skill", entry.replace(/\.md$/, ""), SKILL_NAME_RULE);
    }
  }
  return problems;
}

function connectionDescription(output: AgentCompileOutput): string[] {
  return contentFiles(output)
    .filter(({ path }) => slotPath(path).startsWith("connections/"))
    .filter(({ content }) => !/\bdescription\s*:\s*\S/.test(content))
    .map(({ path }) => `connection ${path} has no description`);
}

/**
 * Run every agent check against `adapter` for each case. Synchronous: compile does no I/O, so
 * there is nothing to isolate.
 */
export function runAgentConformance(
  adapter: AgentAdapter,
  cases: readonly AgentConformanceCase[],
): AgentConformanceResult[] {
  const results: AgentConformanceResult[] = [];
  results.push(
    outcome("complete-matrix", () =>
      matrixProblems(adapter.id, adapter.capabilities()),
    ),
    outcome("unique-templates", () => {
      const seen = new Set<string>();
      return adapter.templates().flatMap(({ slug }) => {
        const duplicate = seen.has(slug);
        seen.add(slug);
        return duplicate ? [`duplicate template slug ${slug}`] : [];
      });
    }),
  );
  for (const { name, input } of cases) {
    let output: AgentCompileOutput;
    try {
      output = adapter.compile(structuredCopy(input));
    } catch (error) {
      for (const check of AGENT_PER_CASE_CHECKS) {
        results.push(
          outcome(check, () => [`threw: ${(error as Error).message}`], name),
        );
      }
      continue;
    }
    results.push(
      outcome(
        "deterministic",
        () =>
          isDeepStrictEqual(output, adapter.compile(structuredCopy(input)))
            ? []
            : ["compile output differs between runs"],
        name,
      ),
      outcome("no-secrets", () => noSecrets(input, output), name),
      outcome("paths-inside", () => pathsInside(output), name),
      outcome("env-declared", () => envDeclared(adapter, output), name),
      outcome("donn-names", () => donnNames(output), name),
      outcome(
        "connection-description",
        () => connectionDescription(output),
        name,
      ),
    );
  }
  return results;
}

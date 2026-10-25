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

/** Every output path starts with this, below the eve project root. */
const AGENT_DIR = "agent/";

const structuredCopy = <T>(value: T): T => structuredClone(value);

function pathsInside(output: AgentCompileOutput): string[] {
  const problems: string[] = [];
  for (const [path, file] of Object.entries(output.files)) {
    const normalized = path.split("/").filter((s) => s !== "." && s !== "");
    if (!isContainedPath(path) || normalized.join("/") !== path)
      problems.push(`path is not relative and normalized: ${path}`);
    else if (!path.startsWith(AGENT_DIR))
      problems.push(`path is not under ${AGENT_DIR}: ${path}`);
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
  const SCHEME = "secret://";
  const refs = new Set(
    [
      ...secretRefsIn(input.ir, "ir").map((r) => r.ref),
      ...Object.values(output.secretEnv),
    ].flatMap((ref) => {
      // The ref itself contains the scheme, so the target text is what can leak on its own.
      const target = ref.slice(SCHEME.length);
      return target.length >= 4 ? [ref, target] : [ref];
    }),
  );
  const problems: string[] = [];
  for (const { path, content } of contentFiles(output)) {
    if (content.includes("secret://")) problems.push(`secret ref in ${path}`);
    for (const ref of refs) {
      if (content.includes(ref))
        problems.push(`secret ref text ${ref} in ${path}`);
    }
  }
  return problems;
}

const ENV_NAMED =
  /^\.([A-Za-z_][A-Za-z0-9_]*)|^\[\s*(?:"([^"]+)"|'([^']+)')\s*\]/;

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
    for (const match of content.matchAll(/process\.env(?![A-Za-z0-9_$])/g)) {
      const rest = content.slice(match.index + match[0].length);
      const named = ENV_NAMED.exec(rest);
      if (!named) {
        problems.push(`${path} has an unanalysable env read`);
        continue;
      }
      const name = (named[1] ?? named[2] ?? named[3])!;
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
    else if (
      name.length === DONN_SLOT_PREFIX.length ||
      !rule.test(name) ||
      name.length > SLOT_NAME_MAX_LENGTH
    )
      problems.push(`${kind} name "${name}" breaks the framework's name rule`);
  };
  for (const path of Object.keys(output.files)) {
    const connection = /^agent\/connections\/([^/]+)\.ts$/.exec(path);
    if (connection)
      check(path, "connection", connection[1]!, CONNECTION_NAME_RULE);
    else if (path.startsWith("agent/connections/"))
      problems.push(`connection ${path} is not connections/<name>.ts`);
    if (path.startsWith("agent/skills/")) {
      const entry = path.split("/")[2] ?? "";
      check(path, "skill", entry.replace(/\.md$/, ""), SKILL_NAME_RULE);
    }
  }
  return problems;
}

/** A connection needs a description eve can route on: present and not an empty literal. */
const hasDescription = (content: string) => {
  const literal = /\bdescription\s*:\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1/.exec(
    content,
  );
  if (literal) return literal[2]!.trim() !== "";
  return /\bdescription\s*:\s*\S/.test(content);
};

function connectionDescription(output: AgentCompileOutput): string[] {
  return contentFiles(output)
    .filter(({ path }) => path.startsWith("agent/connections/"))
    .filter(({ content }) => !hasDescription(content))
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
    const snapshot = structuredCopy(input);
    try {
      output = adapter.compile(input);
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
        () => {
          const problems: string[] = [];
          if (!isDeepStrictEqual(input, snapshot))
            problems.push("compile mutated its input");
          // Key order counts: the same bytes means the same JSON text.
          if (
            JSON.stringify(output) !==
            JSON.stringify(adapter.compile(structuredCopy(snapshot)))
          )
            problems.push("compile output differs between runs");
          return problems;
        },
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

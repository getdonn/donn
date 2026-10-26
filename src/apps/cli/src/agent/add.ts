import { readFile } from "node:fs/promises";
import type { CliIo } from "../cli.js";
import { CliError } from "../errors.js";
import { withFileLock, writeFileAtomic } from "../fs.js";
import { runEve } from "./eve.js";
import { posixRelative } from "./files.js";
import { loadCreatedAgent, projectContext } from "./load.js";
import {
  askAnswers,
  parseAnswer,
  readQuestion,
  shellWord,
  type AgentQuestion,
} from "./questions.js";
import { agentLockPath, agentStatePath } from "./registry.js";

// `donn agent add <name> <item>`: `eve add <item> --non-interactive` in a created agent, its
// questions passed on (asked on a terminal, returned with the command that continues them
// otherwise), `eve link` run for a vercel agent. eve's events are JSON lines `{"version":1,…}` on
// stdout and stderr, mixed with text. See docs/planning/26-gui.md (the 2026-10-25 amendment),
// docs/planning/25-agent-runner.md §6 and spikes/eve-runner/FINDINGS-runtime.md R5.

export interface AddOptions {
  answer?: string[];
  skipInstall?: boolean;
  json?: boolean;
  project?: string;
}

/** What eve add is run with: whether to skip the install, and the answers so far (`<JSON>`). */
interface AddState {
  skipInstall: boolean;
  answers: Map<string, string>;
}

interface Prerequisite {
  kind: string;
  code: string;
  message: string;
  command?: string;
}

/** The last outcome event of an eve add run. */
type Outcome =
  | { type: "completed"; completedItems?: string[]; deploymentRequired?: true }
  | {
      type: "failed";
      message: string;
      failureCode?: string;
      rolledBack?: boolean;
      changed?: string[];
    }
  | { type: "cancelled" }
  | { type: "question"; question: AgentQuestion; next: string[] }
  | { type: "prerequisite"; prerequisite: Prerequisite; next: string[] };

/** eve keeps the lock refreshed while it runs; another command waits or reports `locked`. */
const LOCK_REFRESH_MS = 2_000;
/** What eve's continuation puts where the asked answer goes. */
const PLACEHOLDER = "<JSON value>";

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : undefined;

/** A `{"version":1,"type":…}` event, or undefined for a line of text. */
function eventOf(line: string): Record<string, unknown> | undefined {
  const text = line.trim();
  if (!text.startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value === "object" &&
      value !== null &&
      (value as { version?: unknown }).version === 1 &&
      typeof (value as { type?: unknown }).type === "string"
    )
      return value as Record<string, unknown>;
  } catch {
    // Text that happens to start with a brace.
  }
  return undefined;
}

/** A secret prerequisite (eve's headless form of a secret question) as that question. */
function secretQuestion(p: Record<string, unknown>): AgentQuestion {
  return {
    key: str(p.code) ?? "",
    message: str(p.message) ?? `Set ${str(p.variable)}.`,
    kind: "environment",
    required: true,
    variable: str(p.variable)!,
  };
}

/** The outcome an event reports; undefined for progress and anything else. */
function outcomeOf(event: Record<string, unknown>): Outcome | undefined {
  const next = strings((event.next as { args?: unknown } | undefined)?.args);
  switch (event.type) {
    case "completed":
      return {
        type: "completed",
        ...(strings(event.completedItems) && {
          completedItems: strings(event.completedItems)!,
        }),
        ...(event.deploymentRequired === true && {
          deploymentRequired: true as const,
        }),
      };
    case "failed":
      return {
        type: "failed",
        message: str(event.message) ?? "eve add failed",
        ...(str(event.failureCode) && { failureCode: str(event.failureCode)! }),
        ...(typeof event.rolledBack === "boolean" && {
          rolledBack: event.rolledBack,
        }),
        ...(strings(event.changed) && { changed: strings(event.changed)! }),
      };
    case "cancelled":
      return { type: "cancelled" };
    case "blocked": {
      if (event.status === "input_required") {
        const question = readQuestion(event.question, event.issue);
        if (question === undefined) return undefined;
        return { type: "question", question, next: next ?? [] };
      }
      const p = event.prerequisite as Record<string, unknown> | undefined;
      if (event.status !== "prerequisite_required" || typeof p !== "object")
        return undefined;
      if (p.kind === "environment" && str(p.variable) && str(p.code))
        return {
          type: "question",
          question: secretQuestion(p),
          next: next ?? [],
        };
      return {
        type: "prerequisite",
        prerequisite: {
          kind: str(p.kind) ?? "command",
          code: str(p.code) ?? "",
          message: str(p.message) ?? "",
          ...(str(p.command) && { command: str(p.command)! }),
        },
        next: next ?? [],
      };
    }
    default:
      return undefined;
  }
}

/** The state eve's `next.args` continues with, leaving out the answer `asked` waits for. */
function fromNext(next: string[], asked?: string): AddState {
  const answers = new Map<string, string>();
  for (let i = 0; i < next.length; i++) {
    if (next[i] !== "--answer") continue;
    const pair = next[++i] ?? "";
    const at = pair.indexOf("=");
    if (at === -1) continue;
    const key = pair.slice(0, at);
    const value = pair.slice(at + 1);
    if (key === asked || value === PLACEHOLDER) continue;
    answers.set(key, value);
  }
  return { skipInstall: next.includes("--skip-install"), answers };
}

/** `eve add`'s arguments for a state: never `--yes` (25 §6: no default accepted unseen). */
const eveArgs = (item: string, state: AddState) => [
  "add",
  item,
  "--non-interactive",
  ...(state.skipInstall ? ["--skip-install"] : []),
  ...[...state.answers].flatMap(([k, v]) => ["--answer", `${k}=${v}`]),
];

/**
 * The questions eve asked, by item: `<home>/agents/<hash>/<name>.add.json`. `environment` maps a
 * secret's key to its variable; `asked` lists every other key. Only those take an answer: donn
 * cannot tell an unasked secret from a plain question, and eve takes either from its argv.
 */
interface Asked {
  environment: Record<string, Record<string, string>>;
  asked: Record<string, string[]>;
}

const askedFile = (home: string, root: string, name: string) =>
  agentStatePath(home, root, `${name}.add.json`);

const record = (value: unknown) =>
  typeof value === "object" && value !== null ? value : {};

async function readAsked(file: string): Promise<Asked> {
  try {
    const raw = record(JSON.parse(await readFile(file, "utf8")));
    return {
      environment: record(
        (raw as { environment?: unknown }).environment,
      ) as Asked["environment"],
      asked: record((raw as { asked?: unknown }).asked) as Asked["asked"],
    };
  } catch {
    return { environment: {}, asked: {} };
  }
}

/** Records the question eve asked for `item`: a secret's variable, else its key(s). */
async function recordAsked(
  file: string,
  item: string,
  question: AgentQuestion,
): Promise<void> {
  const state = await readAsked(file);
  if (question.kind === "environment" && question.variable) {
    state.environment[item] = {
      ...state.environment[item],
      [question.key]: question.variable,
    };
  } else {
    const keys = [
      question.key,
      ...(question.editable ? [question.editable.key] : []),
    ];
    state.asked[item] = [...new Set([...(state.asked[item] ?? []), ...keys])];
  }
  await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** `donn agent add <name> <item>`. */
export async function add(
  io: CliIo,
  name: string,
  item: string,
  options: AddOptions,
): Promise<number> {
  if (item === "" || item.startsWith("-")) {
    throw new CliError("invalid-item", `not an eve registry item: ${item}`, {
      fix: "an item as eve add takes it, such as channel/github",
    });
  }
  const given = new Map((options.answer ?? []).map(parseAnswer));
  const ctx = await projectContext(io, options.project);
  const { root, agent, dir } = await loadCreatedAgent(ctx, io, name);
  const lock = agentLockPath(ctx.home, root, name);
  const file = askedFile(ctx.home, root, name);

  const continuing = (state: AddState) => [
    "agent",
    "add",
    name,
    item,
    ...(state.skipInstall ? ["--skip-install"] : []),
    ...[...state.answers].map(([k, v]) => `--answer=${k}=${v}`),
    ...(options.project !== undefined ? ["--project", options.project] : []),
    ...(options.json ? ["--json"] : []),
  ];
  const command = (state: AddState) =>
    `donn ${continuing(state)
      .map((a) =>
        a.startsWith("--answer=")
          ? `--answer ${shellWord(a.slice(9))}`
          : shellWord(a),
      )
      .join(" ")}`;

  // A secret is never answered on a command line, and neither is a question eve has not asked
  // (it could be a secret): both refused before eve sees them.
  const state0 = await readAsked(file);
  const known = Object.hasOwn(state0.environment, item)
    ? state0.environment[item]!
    : {};
  const keys = new Set(
    Object.hasOwn(state0.asked, item) ? state0.asked[item] : [],
  );
  for (const [key] of given) {
    const variable = Object.hasOwn(known, key) ? known[key] : undefined;
    if (variable !== undefined) {
      throw new CliError(
        "secret-question",
        `${key} is a secret: eve reads it from ${variable}, never from a command line`,
        {
          key,
          variable,
          fix: `set ${variable} in the environment, then run donn agent add ${name} ${item} without --answer ${key}`,
        },
      );
    }
    if (!keys.has(key)) {
      throw new CliError(
        "not-asked",
        `eve has not asked ${key} for ${item} yet; an answer is taken only for a question eve asked`,
        {
          key,
          fix: `run donn agent add ${name} ${item} without --answer ${key}, then answer what eve asks`,
        },
      );
    }
  }

  const progress = (line: string) =>
    (options.json ? io.stderr : io.stdout).write(`${line}\n`);
  const shown = posixRelative(root, dir);
  let state: AddState = {
    skipInstall: options.skipInstall === true,
    answers: given,
  };
  const ran = new Set<string>();

  for (;;) {
    let outcome: Outcome | undefined;
    const result = await withFileLock(
      lock,
      async () => {
        const run = await runEve(io, dir, eveArgs(item, state), {
          env: {},
          onProgress: (line) => {
            const event = eventOf(line);
            if (event === undefined) return progress(line);
            if (event.type === "progress" && str(event.message))
              return progress(str(event.message)!);
            if (event.type === "external_action" && str(event.message))
              return progress(
                `${str(event.message)}: ${str(event.url) ?? ""}${str(event.userCode) ? ` (code ${str(event.userCode)})` : ""}`,
              );
            outcome = outcomeOf(event) ?? outcome;
          },
        });
        if (outcome?.type === "question")
          await recordAsked(file, item, outcome.question);
        return run;
      },
      { refreshMs: LOCK_REFRESH_MS },
    );
    // Narrowed by the callback's assignments, which TypeScript does not follow.
    const done = outcome as Outcome | undefined;

    if (done === undefined) {
      if (result.exitCode === 0) return report({ type: "completed" });
      throw new CliError(
        "eve-failed",
        `eve add exited ${result.exitCode}: ${result.tail.at(-1) ?? "no output"}`,
        { exitCode: result.exitCode, tail: result.tail },
      );
    }
    switch (done.type) {
      case "completed":
        return report(done);
      case "failed":
        throw new CliError("eve-add-failed", done.message, {
          item,
          ...(done.failureCode && { failureCode: done.failureCode }),
          ...(done.rolledBack !== undefined && { rolledBack: done.rolledBack }),
          ...(done.changed && { changed: done.changed }),
        });
      case "cancelled":
        throw new CliError(
          "eve-add-cancelled",
          `eve add ${item} was cancelled`,
          {
            item,
          },
        );
      case "question": {
        const next = fromNext(done.next, done.question.key);
        const answers = options.json
          ? undefined
          : await askAnswers(io, done.question);
        if (answers !== undefined) {
          for (const [k, v] of answers) next.answers.set(k, v);
          state = next;
          continue;
        }
        return needsAnswer(done.question, next);
      }
      case "prerequisite": {
        const next = fromNext(done.next);
        const { prerequisite } = done;
        // 25 §6: donn runs eve link for a vercel agent, once; anything else is the user's.
        if (
          agent.target === "vercel" &&
          prerequisite.command === "eve link" &&
          !ran.has(prerequisite.code)
        ) {
          ran.add(prerequisite.code);
          const linked = await withFileLock(
            lock,
            () =>
              runEve(
                io,
                dir,
                ["link", "--non-interactive", "--project", name],
                {
                  env: {},
                  onProgress: progress,
                },
              ),
            { refreshMs: LOCK_REFRESH_MS },
          );
          if (linked.exitCode !== 0) {
            throw new CliError(
              "eve-failed",
              `eve link exited ${linked.exitCode}: ${linked.tail.at(-1) ?? "no output"}`,
              { exitCode: linked.exitCode, tail: linked.tail },
            );
          }
          state = next;
          continue;
        }
        const fix = `${prerequisite.command ? `run ${prerequisite.command} in ${shown}` : prerequisite.message}, then ${command({ ...next })}`;
        if (options.json) {
          io.stdout.write(
            `${JSON.stringify(
              {
                status: "needs-prerequisite",
                item,
                prerequisite,
                continue: continuing(next),
                fix,
              },
              null,
              2,
            )}\n`,
          );
        } else {
          io.stdout.write(`${prerequisite.message}\n${fix}\n`);
        }
        return 2;
      }
    }
  }

  function report(done: Extract<Outcome, { type: "completed" }>): number {
    if (options.json) {
      io.stdout.write(
        `${JSON.stringify(
          {
            status: "completed",
            item,
            ...(done.completedItems && { completedItems: done.completedItems }),
            ...(done.deploymentRequired && { deploymentRequired: true }),
          },
          null,
          2,
        )}\n`,
      );
    } else {
      io.stdout.write(`added ${item} to ${name}\n`);
      if (done.deploymentRequired)
        io.stdout.write(
          `deploy it to take effect: donn agent deploy ${name}\n`,
        );
    }
    return 0;
  }

  function needsAnswer(question: AgentQuestion, next: AddState): number {
    const secret =
      question.kind === "environment" ? question.variable : undefined;
    const fix =
      secret !== undefined
        ? `set ${secret} in the environment (a secret is never answered on a command line), then run ${command(next)}`
        : `${command(next)} --answer ${shellWord(`${question.key}=<JSON>`)}`;
    if (options.json) {
      io.stdout.write(
        `${JSON.stringify(
          {
            status: "needs-answer",
            item,
            question,
            continue: continuing(next),
            ...(secret !== undefined && { fix }),
          },
          null,
          2,
        )}\n`,
      );
      return 2;
    }
    const lines = [`eve asks: ${question.message}`];
    if (question.issue) lines.push(`  ${question.issue.message}`);
    for (const o of question.options ?? [])
      lines.push(`  ${o.id}: ${o.label}${o.hint ? ` (${o.hint})` : ""}`);
    if (question.recommended !== undefined)
      lines.push(`  recommended: ${JSON.stringify(question.recommended)}`);
    lines.push(secret !== undefined ? fix : `answer with: ${fix}`);
    io.stdout.write(`${lines.join("\n")}\n`);
    return 2;
  }
}

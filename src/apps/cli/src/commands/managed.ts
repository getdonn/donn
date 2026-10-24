import { resolve } from "node:path";
import type { ManagedOs } from "@getdonn/adapter-sdk";
import type { CliIo } from "../cli.js";
import { createContext } from "../context.js";
import { CliError, errorText } from "../errors.js";
import { MANAGED_ROOTS } from "@getdonn/adapter-claude-code";
import {
  MANIFEST_PATH,
  refuseManagedRoot,
  writeBundle,
} from "../managed/bundle-io.js";
import { buildBundle, defaultOs, MANAGED_OSES } from "../managed/build.js";
import {
  checkManaged,
  type CheckResult,
  type CheckState,
} from "../managed/check.js";
import { managedEnv, type ManagedEnv } from "../managed/env.js";
import {
  applyInstall,
  applyUninstall,
  planInstall,
  planIsEmpty,
  planUninstall,
} from "../managed/install.js";

export interface ManagedBuildOptions {
  layer?: string;
  os?: string;
  out?: string;
  fromRegistry?: boolean;
  json?: boolean;
}

export async function managedBuildCommand(
  io: CliIo,
  options: ManagedBuildOptions,
): Promise<number> {
  const os = (options.os ?? defaultOs()) as ManagedOs;
  if (!MANAGED_OSES.includes(os)) {
    throw new CliError(
      "managed-bad-os",
      `--os must be one of ${MANAGED_OSES.join(", ")}`,
      { os: options.os },
    );
  }
  const out = resolve(io.cwd, options.out ?? "donn-managed");
  await refuseManagedRoot(out, [
    managedEnv(io).root,
    ...Object.values(MANAGED_ROOTS),
  ]);
  const ctx = await createContext(io);
  const result = await buildBundle(
    ctx,
    {
      ...(options.layer !== undefined && { layer: options.layer }),
      os,
      fromRegistry: options.fromRegistry === true,
    },
    io,
  );
  const { report, bundle } = result;
  const refused = report.entries.filter((e) => e.outcome === "refused");
  if (bundle === undefined) {
    if (options.json) {
      io.stdout.write(`${JSON.stringify({ report, out: null }, null, 2)}\n`);
    } else {
      for (const e of refused) {
        io.stderr.write(
          `refused: ${e.path} (${e.layer}) ${e.code ?? ""}: ${e.reason}\n`,
        );
      }
      io.stderr.write(`error: ${refused.length} refused; no bundle written\n`);
    }
    return 1;
  }
  const deepest = bundle.manifest.layers.at(-1)?.ref;
  const notice =
    report.entries.some((e) => e.outcome === "enforced") || !deepest
      ? undefined
      : report.entries.length === 0
        ? `nothing in ${deepest} and its ancestors is locked; the bundle enforces nothing`
        : `nothing in ${deepest} and its ancestors is enforced by Claude Code; the bundle enforces nothing`;
  await writeBundle(out, bundle.files);
  if (options.json) {
    io.stdout.write(
      `${JSON.stringify({ out, report, ...(notice && { notice }) }, null, 2)}\n`,
    );
    return 0;
  }
  for (const e of report.entries) {
    io.stdout.write(`${e.outcome}: ${e.path} (${e.layer}) ${e.reason}\n`);
  }
  for (const w of report.warnings) {
    io.stderr.write(`warning: ${w.code}: ${w.message}\n`);
  }
  if (notice) io.stdout.write(`${notice}\n`);
  io.stdout.write(`bundle: ${out}\n`);
  return 0;
}

const quietStderr = (io: CliIo): CliIo => ({
  ...io,
  stderr: { write: () => true },
});

/** A word as the user's shell would need it: plain when safe, otherwise quoted. */
const shellWord = (value: string, os: ManagedOs) =>
  /^[\w./:@%+=-]+$/.test(value)
    ? value
    : os === "windows"
      ? `"${value}"`
      : `'${value.replaceAll("'", "'\\''")}'`;

/** Refuse without administrator rights, naming the exact command to re-run. */
export function needAdmin(env: ManagedEnv, command: string): void {
  if (env.isAdmin()) return;
  const what = command.split(" ").slice(0, 2).join(" ");
  throw new CliError(
    "managed-needs-admin",
    env.os === "windows"
      ? `${what} needs administrator rights; run it in an elevated PowerShell: donn ${command}`
      : `${what} needs administrator rights; run: sudo donn ${command}`,
    { command: `donn ${command}` },
  );
}

/**
 * True to go ahead; false (after saying so) when declined; throws `code` without a terminal.
 * `donn migrate` asks through it too.
 */
export async function confirmed(
  io: CliIo,
  env: Pick<ManagedEnv, "confirm">,
  question: string,
  declined: string,
  code = "managed-confirm",
): Promise<boolean> {
  const answer = await env.confirm(question);
  if (answer === undefined) {
    throw new CliError(code, "no terminal to confirm on; re-run with --yes", {
      hint: "--yes",
    });
  }
  if (!answer) io.stderr.write(`cancelled; ${declined}\n`);
  return answer;
}

const planLines = (rows: [string, string[]][]) =>
  rows.flatMap(([verb, paths]) =>
    paths.map((p) => `  ${verb.padEnd(9)}${p}\n`),
  );

export interface ManagedInstallOptions {
  yes?: boolean;
  json?: boolean;
}

export async function managedInstallCommand(
  io: CliIo,
  dir: string,
  options: ManagedInstallOptions,
): Promise<number> {
  const env = managedEnv(io);
  needAdmin(env, `managed install ${shellWord(dir, env.os)}`);
  const bundleDir = resolve(io.cwd, dir);
  const planned = await planInstall(env, bundleDir);
  const { plan } = planned;
  const result = {
    root: plan.root,
    written: plan.written,
    replaced: plan.replaced,
    removed: plan.removed,
    replaces: plan.replaces,
  };
  if (planIsEmpty(plan)) {
    // Only an interrupted install's pending.json, if any, to tidy away.
    await applyInstall(env, planned);
    const check = await checkHere(io);
    io.stdout.write(
      options.json
        ? `${JSON.stringify({ ...result, check }, null, 2)}\n`
        : `${plan.root} already holds this bundle; nothing to change\n${notCurrent(check)}`,
    );
    return 0;
  }
  const out = options.json ? io.stderr : io.stdout;
  out.write(`install into ${plan.root}:\n`);
  for (const line of [
    ...planLines([
      ["write", plan.written],
      ["replace", plan.replaced],
      ["remove", plan.removed],
    ]),
    // Not a refusal: Claude Code reads ours after these, so ours wins.
    ...plan.replaces.map((r) => `  replaces ${r.key} from ${r.file}\n`),
  ])
    out.write(line);
  let final = planned;
  if (!options.yes) {
    const question = `Install into ${plan.root}?`;
    if (!(await confirmed(io, env, question, "nothing installed"))) return 1;
    // The folder or the bundle may have changed while the question waited: plan again (which
    // refuses anything now in the way) and go ahead only with the plan that was shown.
    final = await planInstall(env, bundleDir);
    const sameBundle =
      Buffer.compare(
        final.files[MANIFEST_PATH]!,
        planned.files[MANIFEST_PATH]!,
      ) === 0;
    if (!sameBundle || JSON.stringify(final.plan) !== JSON.stringify(plan)) {
      throw new CliError(
        "managed-changed",
        `${plan.root} or the bundle changed while waiting for an answer; nothing was written; run the command again`,
      );
    }
  }
  await applyInstall(env, final);
  // Installed is not yet in effect: a higher source or a later drop-in can still win.
  const check = await checkHere(io);
  io.stdout.write(
    options.json
      ? `${JSON.stringify({ ...result, check }, null, 2)}\n`
      : `installed into ${plan.root}: ${plan.written.length} written, ${plan.replaced.length} replaced, ${plan.removed.length} removed\n${notCurrent(check)}`,
  );
  return 0;
}

/** The check's state and findings when it is not `current`; nothing when it is. */
const notCurrent = (check: CheckResult) =>
  check.state === "current"
    ? ""
    : `managed: ${check.state}\n${checkLines(check)}`;

/** One line per finding; findings that leave the state `current` are notes. */
const checkLines = (check: CheckResult) =>
  check.findings
    .map((f) => `${f.state === "current" ? "note" : f.state}: ${f.detail}\n`)
    .join("");

export async function managedUninstallCommand(
  io: CliIo,
  options: ManagedInstallOptions,
): Promise<number> {
  const env = managedEnv(io);
  needAdmin(env, "managed uninstall");
  const removed = await planUninstall(env);
  if (removed === undefined) {
    io.stdout.write(
      options.json
        ? `${JSON.stringify({ root: env.root, removed: [] }, null, 2)}\n`
        : `nothing installed in ${env.root}\n`,
    );
    return 0;
  }
  const out = options.json ? io.stderr : io.stdout;
  out.write(`uninstall from ${env.root}:\n`);
  for (const line of planLines([["remove", removed]])) out.write(line);
  if (
    !options.yes &&
    !(await confirmed(
      io,
      env,
      `Remove these from ${env.root}?`,
      "nothing removed",
    ))
  ) {
    return 1;
  }
  await applyUninstall(env.root, removed);
  io.stdout.write(
    options.json
      ? `${JSON.stringify({ root: env.root, removed }, null, 2)}\n`
      : `removed ${removed.length} file(s) from ${env.root}\n`,
  );
  return 0;
}

/** `check` for this machine; the context (for the fresh compile) is made only when needed. */
export function checkHere(io: CliIo): Promise<CheckResult> {
  return checkManaged(() => createContext(quietStderr(io)), managedEnv(io));
}

export async function managedCheckCommand(
  io: CliIo,
  options: { json?: boolean },
): Promise<number> {
  const env = managedEnv(io);
  const result = await checkHere(io);
  if (options.json) {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    io.stdout.write(
      `managed: ${result.state}${result.state === "current" ? ` (${env.root})` : ""}\n${checkLines(result)}`,
    );
  }
  return result.state === "current" ? 0 : 1;
}

/** One `fix:` line for doctor: what to do about each state the check found. */
export function managedFix(result: CheckResult, os: ManagedOs): string {
  const install =
    os === "windows"
      ? "donn managed install <dir> in an elevated PowerShell"
      : "sudo donn managed install <dir>";
  const fixes: Partial<Record<CheckState, string>> = {
    ignored:
      'set managedSourcesBehavior: "merge" in the higher-ranked source, or deliver the policy through it',
    edited: `reinstall the bundle: ${install}`,
    overridden:
      "remove the value from the later drop-in, or ask its owner to; donn never edits other drop-ins",
    stale: `donn managed build, then ${install}`,
  };
  const all = result.findings.flatMap((f) => f.fix ?? fixes[f.state] ?? []);
  return [...new Set(all)].join("; ");
}

/** The `managed:` line of `donn status`, or undefined when nothing is installed. */
export async function managedStatus(
  io: CliIo,
): Promise<{ line?: string; json: object }> {
  try {
    const result = await checkHere(io);
    const first = result.findings.find((f) => f.state === result.state);
    return {
      ...(result.state !== "missing" && {
        line:
          result.state === "current" || first === undefined
            ? `managed: ${result.state}`
            : `managed: ${result.state} (${first.detail})`,
      }),
      json: result,
    };
  } catch (error) {
    const text = errorText(error);
    return {
      line: `managed: ${text}`,
      json: {
        error: {
          code: error instanceof CliError ? error.code : "managed-check",
          message: text,
        },
      },
    };
  }
}

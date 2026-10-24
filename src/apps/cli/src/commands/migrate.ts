import type { CliIo } from "../cli.js";
import { runChecks, type Check } from "../doctor/checks.js";
import { CliError } from "../errors.js";
import { LEGACY } from "../migrate/legacy.js";
import {
  legacyEnv,
  legacyPolicy,
  MANAGED_NEXT,
  migrateManaged,
  migrateProject,
  migrationWarnings,
  NOTHING,
  oldCli,
  oldHomePaths,
  pendingProjects,
  planMigration,
  runMigration,
  type StepResult,
} from "../migrate/plan.js";
import { checkLines } from "./doctor.js";

// donn migrate [--project [dir] | --managed]: move an install from before the rename to donn,
// then run donn doctor. See docs/planning/22-rename-donn.md §3.

export interface MigrateOptions {
  /** `--project` alone is true; with a folder, the folder. */
  project?: string | boolean;
  managed?: boolean;
  yes?: boolean;
  json?: boolean;
}

const stepsJson = (results: StepResult[]) =>
  results.map(({ id, status, notes }) => ({
    id,
    status,
    ...(notes !== undefined && { notes }),
  }));

/** `donn doctor`'s checks, after a migration that changed something. */
const doctor = (io: CliIo) => runChecks(io, { fix: false });

function printDoctor(io: CliIo, checks: Check[]): void {
  io.stdout.write(`doctor:\n${checkLines(checks)}`);
}

export async function migrateCommand(
  io: CliIo,
  options: MigrateOptions,
): Promise<number> {
  if (options.project !== undefined && options.managed) {
    throw new CliError(
      "usage",
      "--project and --managed are separate migrations; run one at a time",
    );
  }
  if (options.managed) return managedForm(io, options);
  if (options.project !== undefined) {
    return projectForm(
      io,
      typeof options.project === "string" ? options.project : undefined,
      options,
    );
  }
  return userForm(io, options);
}

async function userForm(io: CliIo, options: MigrateOptions): Promise<number> {
  const steps = await planMigration(io);
  const env = legacyEnv(io);
  const managed = await legacyPolicy(io);
  const warnings = await migrationWarnings(io);
  const results = await runMigration(io, steps, { ...options, warnings });
  if (results === undefined) return 1;
  const nothing = results.every((r) => r.status === "done");
  const checks = nothing ? undefined : await doctor(io);
  const cli = oldCli(io);
  const projects = await pendingProjects(io);
  const oldPaths = await oldHomePaths(io);
  if (options.json) {
    io.stdout.write(
      `${JSON.stringify(
        {
          steps: stepsJson(results),
          env,
          ...(warnings.length > 0 && { warnings }),
          ...(projects.length > 0 && { projects }),
          ...(oldPaths.length > 0 && { oldPaths }),
          ...(managed !== undefined && { managed }),
          ...(cli !== undefined && { oldCli: cli }),
          ...(checks === undefined
            ? { message: NOTHING }
            : { doctor: { checks } }),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  if (nothing) io.stdout.write(`${NOTHING}\n`);
  if (env.length > 0) {
    io.stdout.write(
      `set in your environment; rename them in your shell profile:\n${env
        .map((v) => `  ${v.name} -> ${v.rename}\n`)
        .join("")}`,
    );
  }
  if (managed !== undefined) {
    io.stdout.write(
      `an old ${LEGACY.name} managed policy is installed in ${managed.root}; to replace it:\n${managed.next
        .map((command) => `  ${command}\n`)
        .join("")}`,
    );
  }
  if (oldPaths.length > 0) {
    io.stdout.write(
      `these values still name ~/${LEGACY.home}, which is gone once migrated; change them by hand:\n${oldPaths
        .map((p) => `  ${p.file}: ${p.field}: ${p.value}\n`)
        .join("")}`,
    );
  }
  if (projects.length > 0) {
    io.stdout.write(
      `projects whose ${LEGACY.home}/ is still there (their switches carry over once moved):\n${projects
        .map((p) => `  ${p.next}\n`)
        .join("")}`,
    );
  }
  if (cli !== undefined) {
    io.stdout.write(
      `the old CLI is still on PATH (${cli.path}); remove it: ${cli.remove}\n`,
    );
  }
  if (checks !== undefined) printDoctor(io, checks);
  return 0;
}

async function projectForm(
  io: CliIo,
  dir: string | undefined,
  options: MigrateOptions,
): Promise<number> {
  const { start, root, results, gitignore } = await migrateProject(
    io,
    dir,
    options,
  );
  if (root === undefined) {
    const message = `nothing to migrate: no ${LEGACY.home} project found from ${start}`;
    io.stdout.write(
      options.json
        ? `${JSON.stringify({ steps: [], message }, null, 2)}\n`
        : `${message}\n`,
    );
    return 0;
  }
  if (results === undefined) return 1;
  const nothing = results.every((r) => r.status === "done");
  const message = `nothing to migrate in ${root}`;
  const checks = nothing ? undefined : await doctor(io);
  if (options.json) {
    io.stdout.write(
      `${JSON.stringify(
        {
          project: root,
          steps: stepsJson(results),
          ...(gitignore !== undefined && { gitignore }),
          ...(checks === undefined ? { message } : { doctor: { checks } }),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  for (const hit of gitignore ?? []) {
    io.stdout.write(
      `${hit.file}:${hit.line} names ${LEGACY.home} (${hit.text}); change it to .donn if it should still apply\n`,
    );
  }
  if (checks === undefined) io.stdout.write(`${message}\n`);
  else {
    io.stdout.write("nothing was committed; review the changes with git\n");
    printDoctor(io, checks);
  }
  return 0;
}

async function managedForm(
  io: CliIo,
  options: MigrateOptions,
): Promise<number> {
  const { root, removed, kept } = await migrateManaged(io, options);
  if (removed === undefined) return 1;
  const message =
    removed.length === 0
      ? `nothing to migrate: no ${LEGACY.name} managed policy in ${root}`
      : `removed ${removed.length} file(s) from ${root}`;
  if (options.json) {
    io.stdout.write(
      `${JSON.stringify({ root, removed, ...(kept && { kept }), message, next: MANAGED_NEXT }, null, 2)}\n`,
    );
    return 0;
  }
  io.stdout.write(
    `${message}\nthen, for the policy under its new name:\n${MANAGED_NEXT.map((c) => `  ${c}\n`).join("")}`,
  );
  return 0;
}

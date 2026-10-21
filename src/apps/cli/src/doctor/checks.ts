import { existsSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findBuildLeftovers, removeBuildLeftovers } from "@zzpersona/executor";
import { resolveSecrets, SecretResolutionError } from "@zzpersona/secrets";
import { createLocalStore } from "@zzpersona/store-local";
import { prepareBuild, type PreparedBuild } from "../build.js";
import type { CliIo } from "../cli.js";
import { secretContext } from "../secret-context.js";
import { loadConfig, type Config } from "../config.js";
import { createContext, homeOf, type Context } from "../context.js";
import { CliError, errorText } from "../errors.js";
import { HARNESSES } from "../harness.js";
import { selectPersona, type Selection } from "../select.js";
import { readState, writeState, type State } from "../state.js";

// zzpersona doctor: one line per check, in a fixed order; a check whose prerequisite failed is
// `skipped`. Never creates anything except under --fix. See docs/planning/07-cli-daily-use.md, §3.

export type Status = "ok" | "warn" | "error" | "skipped";
export interface Check {
  id: string;
  status: Status;
  message: string;
  fix?: string;
}

const VERIFIED_CLAUDE = "2.1.306";

/** Numeric, component by component: "2.1.100" < "2.1.306". */
function olderThan(version: string, reference: string): boolean {
  const a = version.split(".").map(Number);
  const b = reference.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

/** Writable now, or creatable because its nearest existing ancestor is writable. */
async function writable(dir: string): Promise<boolean> {
  let path = dir;
  while (!existsSync(path)) {
    const parent = dirname(path);
    if (parent === path) return false;
    path = parent;
  }
  return access(path, constants.W_OK).then(
    () => true,
    () => false,
  );
}

export async function runChecks(
  io: CliIo,
  options: { persona?: string; fix: boolean },
): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (id: string, status: Status, message: string, fix?: string) =>
    checks.push({ id, status, message, ...(fix !== undefined && { fix }) });
  const skip = (id: string, because: string) => add(id, "skipped", because);
  const home = homeOf(io);

  // home
  if (io.env.ZZPERSONA_HOME === "") {
    add(
      "home",
      "warn",
      `ZZPERSONA_HOME is set but empty; using ${home}`,
      "unset ZZPERSONA_HOME",
    );
  } else if (await writable(home)) {
    add("home", "ok", home);
  } else {
    add(
      "home",
      "error",
      `${home} is not writable`,
      `fix the permissions on ${home}`,
    );
  }

  // config
  let config: Config | undefined;
  try {
    config = await loadConfig(home, io.env);
    if (config.personas === undefined) {
      add(
        "config",
        "warn",
        "no personas folder configured; only project and user personas are available",
        "zzpersona init --personas <dir>",
      );
    } else {
      add("config", "ok", join(home, "config.yaml"));
    }
  } catch (error) {
    add(
      "config",
      "error",
      errorText(error),
      `fix ${join(home, "config.yaml")}`,
    );
  }

  // personas
  if (config === undefined) skip("personas", "config.yaml could not be read");
  else if (config.personas === undefined)
    skip("personas", "no personas folder configured");
  else if (!existsSync(config.personas)) {
    add(
      "personas",
      "error",
      `the configured personas folder ${config.personas} does not exist`,
      `create it, or zzpersona init --personas <dir> --force`,
    );
  } else {
    const problems: string[] = [];
    const fixes: string[] = [];
    if (!existsSync(join(config.personas, ".git"))) {
      problems.push(`${config.personas} is not a git repository`);
      fixes.push(
        `run \`git init\` in ${config.personas} to track your personas`,
      );
    }
    const strays = await createLocalStore({
      personas: config.personas,
      user: home,
    }).strayLayerDirs();
    for (const dir of strays) {
      problems.push(
        `${dir} is ignored (project/ and user/ layers are mounted elsewhere)`,
      );
      fixes.push(`move or remove ${dir}`);
    }
    if (problems.length > 0)
      add("personas", "warn", problems.join("; "), fixes.join("; "));
    else add("personas", "ok", config.personas);
  }

  // state
  let state: State | undefined;
  try {
    state = await readState(home);
    const orphans = Object.keys(state.projects).filter(
      (key) => !existsSync(join(key, "persona.yaml")),
    );
    if (orphans.length === 0) {
      add(
        "state",
        "ok",
        `${Object.keys(state.projects).length} project switch(es)`,
      );
    } else if (options.fix) {
      for (const key of orphans) delete state.projects[key];
      await writeState(home, state);
      add(
        "state",
        "ok",
        `removed ${orphans.length} switch(es) for projects that no longer exist`,
      );
    } else {
      add(
        "state",
        "warn",
        `${orphans.length} switch(es) for projects that no longer exist: ${orphans.join(", ")}`,
        "zzpersona doctor --fix",
      );
    }
  } catch (error) {
    add(
      "state",
      "error",
      errorText(error),
      `fix or delete ${join(home, "state.json")}`,
    );
  }

  // persona
  let ctx: Context | undefined;
  let selection: Selection | undefined;
  if (config === undefined || state === undefined) {
    skip("persona", "config.yaml or state.json could not be read");
  } else {
    try {
      ctx = await createContext({ ...io, stderr: { write: () => true } });
      selection = await selectPersona(options.persona, ctx);
      const where = selection.project
        ? ` for ${dirname(selection.project)}`
        : "";
      add("persona", "ok", `${selection.ref} (${selection.source}${where})`);
    } catch (error) {
      if (error instanceof CliError && error.code === "no-persona") {
        add(
          "persona",
          "warn",
          "no persona would be used here",
          "zzpersona init --extends <persona> in a project, or zzpersona switch <persona>",
        );
      } else {
        add("persona", "error", errorText(error));
      }
    }
  }

  // resolve: resolve and compile without writing anything
  let build: PreparedBuild | undefined;
  if (ctx === undefined || selection === undefined)
    skip("resolve", "no persona to resolve");
  else {
    try {
      build = await prepareBuild(
        ctx,
        { ...io, stderr: { write: () => true } },
        { selection, harness: "claude-code", overlay: true, passthrough: [] },
      );
      add(
        "resolve",
        "ok",
        `${selection.ref} resolves and compiles (${build.result.ir.layers.length} layers, ${build.result.warnings.length} warning(s))`,
      );
    } catch (error) {
      add("resolve", "error", errorText(error));
    }
  }

  // claude
  const detection = await HARNESSES["claude-code"]!.detect(io.probe);
  if (!detection.installed) {
    add(
      "claude",
      "error",
      "claude is not installed (or not on PATH)",
      "install Claude Code",
    );
  } else if (
    detection.version &&
    olderThan(detection.version, VERIFIED_CLAUDE)
  ) {
    add(
      "claude",
      "warn",
      `claude ${detection.version} is older than ${VERIFIED_CLAUDE}, the version zzpersona was verified against`,
      "update Claude Code",
    );
  } else if (detection.facts.sideloadBlocked === true) {
    add(
      "claude",
      "warn",
      "managed settings block --plugin-dir and --mcp-config; launches use partial mode",
    );
  } else if (detection.facts.managedMcp === true) {
    add(
      "claude",
      "warn",
      "a managed-mcp.json is deployed; launches use relaunch-no-mcp mode",
    );
  } else {
    add("claude", "ok", `claude ${detection.version ?? "(unknown version)"}`);
  }

  // secrets
  if (build === undefined || ctx === undefined)
    skip("secrets", "no build to check");
  else if (build.secretRefs.length === 0)
    add("secrets", "ok", "no secrets needed");
  else {
    try {
      await resolveSecrets(
        build.secretRefs,
        build.result.ir.secrets.providers,
        secretContext(io),
      );
      add("secrets", "ok", `${build.secretRefs.length} secret(s) resolve`);
    } catch (error) {
      if (!(error instanceof SecretResolutionError)) throw error;
      add(
        "secrets",
        "error",
        error.failures.map((f) => `${f.ref}: ${f.reason}`).join("; "),
        "set the environment variables, or change the providers (spec 06 §2)",
      );
    }
  }

  // build
  const buildRoot = join(home, "build");
  if (!(await writable(buildRoot))) {
    add(
      "build",
      "error",
      `${buildRoot} is not writable`,
      `fix the permissions on ${buildRoot}`,
    );
  } else {
    const leftovers = await findBuildLeftovers(home);
    const count =
      leftovers.staleLocks.length +
      leftovers.orphanVersions.length +
      leftovers.tempLinks.length;
    if (count === 0) add("build", "ok", buildRoot);
    else if (options.fix) {
      await removeBuildLeftovers(leftovers);
      add("build", "ok", `removed ${count} leftover(s) in ${buildRoot}`);
    } else {
      add(
        "build",
        "warn",
        `${leftovers.staleLocks.length} stale lock(s), ${leftovers.orphanVersions.length} orphaned version(s), ${leftovers.tempLinks.length} temporary link(s)`,
        `zzpersona doctor --fix (deleting ${buildRoot} entirely is also safe; builds are recreated on launch)`,
      );
    }
  }

  return checks;
}

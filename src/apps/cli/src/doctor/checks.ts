import { existsSync } from "node:fs";
import { access, constants, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findBuildLeftovers, removeBuildLeftovers } from "@zzpersona/executor";
import {
  keychainParts,
  parseSecretRef,
  resolveSecrets,
  SecretResolutionError,
} from "@zzpersona/secrets";
import { createLocalStore } from "@zzpersona/store-local";
import { prepareBuild, type PreparedBuild } from "../build.js";
import type { CliIo } from "../cli.js";
import { bundledMod, installedModVersion } from "../commands/mod.js";
import { CLI_ON_PATH_FIX, findOnPath } from "../path.js";
import { findOrphanSessions, removeSession } from "../session.js";
import { secretContext } from "../secret-context.js";
import { loadConfig, type Config } from "../config.js";
import { createContext, homeOf, type Context } from "../context.js";
import { CliError, errorText } from "../errors.js";
import { HARNESSES } from "../harness.js";
import {
  backendLoader,
  loadAdapters,
  loadSecretProviders,
} from "../plugins.js";
import { selectPersona, type Selection } from "../select.js";
import { readState, updateState, type State } from "../state.js";

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

/** A POSIX-shell word: as is when plainly safe, otherwise single-quoted. */
const shellQuote = (value: string) =>
  /^[\w./:@%+=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

/** For keychain items that are missing, the command that stores each one; otherwise general advice. */
function secretsFix(
  failures: { ref: string; reason: string }[],
  providers: Record<string, { type: string }>,
  platform: string,
): string {
  const store = failures.flatMap(({ ref, reason }) => {
    const parsed = parseSecretRef(ref);
    const type =
      parsed && (providers[parsed.provider]?.type ?? parsed.provider);
    const parts = parsed && keychainParts(parsed.path);
    if (type !== "keychain" || !parts || reason !== "not found in the keychain")
      return [];
    // Names come from persona files, possibly shared: quote them for the user's shell.
    const service = shellQuote(parts.service);
    const account = shellQuote(parts.account);
    return platform === "darwin"
      ? [`security add-generic-password -s ${service} -a ${account} -w`]
      : [
          `secret-tool store --label=${service} service ${service} account ${account}`,
        ];
  });
  if (store.length === 0) {
    return "set the environment variables, or change the providers (spec 06 §2)";
  }
  const note =
    platform === "darwin"
      ? " (each prompts for the value; if macOS asks to allow access for security, choose Always Allow)"
      : " (each prompts for the value)";
  return `${store.join("; ")}${note}`;
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
  if (!(await writable(home))) {
    add(
      "home",
      "error",
      `${home} is not writable`,
      `fix the permissions on ${home}`,
    );
  } else if (io.env.ZZPERSONA_HOME === "") {
    add(
      "home",
      "warn",
      `ZZPERSONA_HOME is set but empty; using ${home}`,
      "unset ZZPERSONA_HOME",
    );
  } else {
    add("home", "ok", home);
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
    // Missing persona.yaml is a warning. Forget an entry only when its repo folder is gone but
    // the folder that held it is still there: another branch or an unmounted volume (whose
    // whole path disappears) may bring the project back.
    const orphans = Object.keys(state.projects).filter(
      (key) => !existsSync(join(key, "persona.yaml")),
    );
    const removable = orphans.filter(
      (key) => !existsSync(dirname(key)) && existsSync(dirname(dirname(key))),
    );
    if (orphans.length === 0) {
      add(
        "state",
        "ok",
        `${Object.keys(state.projects).length} project switch(es)`,
      );
    } else {
      let kept = orphans;
      if (options.fix && removable.length > 0) {
        await updateState(home, (fresh) => {
          for (const key of removable) delete fresh.projects[key];
        });
        kept = orphans.filter((key) => !removable.includes(key));
      }
      const removed = orphans.length - kept.length;
      const note =
        removed > 0
          ? `removed ${removed} switch(es) for repos that no longer exist`
          : undefined;
      if (kept.length === 0) {
        add("state", "ok", note!);
      } else {
        const gone = kept.filter((key) => removable.includes(key));
        add(
          "state",
          "warn",
          [
            ...(note ? [note] : []),
            `${kept.length} switch(es) for projects without a persona.yaml: ${kept.join(", ")}`,
          ].join("; "),
          gone.length > 0
            ? "zzpersona doctor --fix"
            : `kept because the project may come back (its repo exists on another branch, or its volume is not mounted); delete the entry from ${join(home, "state.json")} if it is no longer needed`,
        );
      }
    }
  } catch (error) {
    add(
      "state",
      "error",
      errorText(error),
      `fix or delete ${join(home, "state.json")}`,
    );
  }

  // plugins: load every listed entry, so a broken one shows here and not mid-launch
  if (config === undefined) skip("plugins", "config.yaml could not be read");
  else if (!config.adapters?.length && !config.secretProviders?.length) {
    add("plugins", "ok", "no plugins configured");
  } else {
    try {
      const where = { home, config };
      const lines = [
        ...(await loadAdapters(where, io.env)).map(
          (p) =>
            `${p.entry} → ${p.resolved}${p.version ? ` (${p.version})` : ""} adapter ${p.plugin.id}`,
        ),
        ...(await loadSecretProviders(where, io.env)).map(
          (p) =>
            `${p.entry} → ${p.resolved}${p.version ? ` (${p.version})` : ""} secret provider ${p.plugin.type}`,
        ),
      ];
      add("plugins", "ok", `${lines.length} plugin(s): ${lines.join("; ")}`);
    } catch (error) {
      if (!(error instanceof CliError && error.code === "plugin-load"))
        throw error;
      const entry = String(error.details.entry);
      add(
        "plugins",
        "error",
        error.message,
        error.details.reason === "not-installed"
          ? `npm install --prefix ${join(home, "adapters")} ${entry}`
          : `fix or remove ${entry} in ${join(home, "config.yaml")}`,
      );
    }
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
      // Claude Code reads AGENTS.md when the repo has no CLAUDE.md, so the persona's
      // instructions would reach a zzpersona claude session twice (docs/planning/11-agents-md.md).
      let twice = "";
      if (ctx.projectDir !== undefined) {
        const repo = dirname(ctx.projectDir);
        const agents = await readFile(join(repo, "AGENTS.md"), "utf8").catch(
          () => "",
        );
        if (
          agents.includes("<!-- zzpersona:begin") &&
          !existsSync(join(repo, "CLAUDE.md"))
        )
          twice = "; AGENTS.md also carries it for Claude Code";
      }
      add(
        "persona",
        "ok",
        `${selection.ref} (${selection.source}${where})${twice}`,
      );
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
  } else {
    // Version and mode are independent findings: an old claude must not hide a degraded mode.
    // `zzpersona claude` runs the claude PATH finds; a shell alias does not count.
    const claudePath = findOnPath("claude", io.env);
    const where = claudePath ? ` (${claudePath})` : "";
    const findings: string[] = [];
    const fixes: string[] = [];
    if (detection.version && olderThan(detection.version, VERIFIED_CLAUDE)) {
      findings.push(
        `claude ${detection.version}${where} is older than ${VERIFIED_CLAUDE}, the version zzpersona was verified against`,
      );
      fixes.push(
        "update the Claude Code that PATH finds (zzpersona claude ignores shell aliases)",
      );
    }
    if (detection.facts.sideloadBlocked === true) {
      findings.push(
        "managed settings block --plugin-dir and --mcp-config; launches use partial mode",
      );
    } else if (detection.facts.managedMcp === true) {
      findings.push(
        "a managed-mcp.json is deployed; launches use relaunch-no-mcp mode",
      );
    }
    if (findings.length === 0) {
      add(
        "claude",
        "ok",
        `claude ${detection.version ?? "(unknown version)"}${where}`,
      );
    } else {
      add(
        "claude",
        "warn",
        findings.join("; "),
        ...(fixes.length > 0 ? [fixes.join("; ")] : []),
      );
    }
  }

  // cli: the mod runs `zzpersona` from PATH without a shell
  const cli = findOnPath("zzpersona", io.env);
  if (cli) add("cli", "ok", `zzpersona on PATH: ${cli}`);
  else
    add(
      "cli",
      "warn",
      "zzpersona is not on PATH, so the Claude Code mod cannot run it",
      CLI_ON_PATH_FIX,
    );

  // mod: the Claude Code mod this zzpersona ships, installed and current
  const installed = await installedModVersion(home);
  const shipped = bundledMod().version;
  if (installed === undefined) {
    add("mod", "warn", "the mod is not installed", "zzpersona mod install");
  } else if (installed !== shipped) {
    add(
      "mod",
      "warn",
      `mod ${installed} does not match the mod this zzpersona ships (${shipped})`,
      "zzpersona mod install",
    );
  } else {
    add("mod", "ok", `zzpersona mod ${installed}`);
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
        { loadBackend: backendLoader(ctx, io.env) },
      );
      add("secrets", "ok", `${build.secretRefs.length} secret(s) resolve`);
    } catch (error) {
      if (error instanceof CliError && error.code === "plugin-load") {
        add("secrets", "error", error.message, "see the plugins check");
      } else {
        if (!(error instanceof SecretResolutionError)) throw error;
        add(
          "secrets",
          "error",
          error.failures.map((f) => `${f.ref}: ${f.reason}`).join("; "),
          secretsFix(
            error.failures,
            build.result.ir.secrets.providers,
            io.probe.platform,
          ),
        );
      }
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
    const sessions = await findOrphanSessions(home, Date.now());
    const summary = `${leftovers.staleLocks.length} stale lock(s), ${leftovers.orphanVersions.length} orphaned version(s), ${leftovers.tempLinks.length} temporary link(s), ${sessions.length} orphaned session folder(s)`;
    const count =
      leftovers.staleLocks.length +
      leftovers.orphanVersions.length +
      leftovers.tempLinks.length +
      sessions.length;
    if (count === 0) add("build", "ok", buildRoot);
    else if (options.fix) {
      await removeBuildLeftovers(leftovers);
      for (const dir of sessions) await removeSession(dir);
      add("build", "ok", `removed ${summary}`);
    } else {
      add(
        "build",
        "warn",
        summary,
        `zzpersona doctor --fix (it removes only what no running session uses; deleting ${buildRoot} entirely is also safe, builds are recreated on launch, but leave session folders of running sessions alone)`,
      );
    }
  }

  return checks;
}

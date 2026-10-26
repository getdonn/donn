import { existsSync } from "node:fs";
import { access, constants, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { findBuildLeftovers, removeBuildLeftovers } from "@getdonn/executor";
import {
  keychainParts,
  parseSecretRef,
  resolveSecrets,
  SecretResolutionError,
} from "@getdonn/secrets";
import {
  createClient,
  normaliseUrl,
  readIndex,
  RegistryError,
} from "@getdonn/store-remote";
import { createLocalStore } from "@getdonn/store-local";
import { prepareBuild, type PreparedBuild } from "../build.js";
import type { CliIo } from "../cli.js";
import { cliVersion } from "../commands/daemon.js";
import { agentChecks } from "./agents.js";
import { checkHere, managedFix } from "../commands/managed.js";
import { bundledMod, installedModVersion } from "../commands/mod.js";
import { managedEnv } from "../managed/env.js";
import { clean } from "../commands/registry.js";
import {
  connectDaemon,
  daemonSocket,
  versionMismatch,
} from "../daemon/client.js";
import { daemonPaths } from "../daemon/paths.js";
import { isDaemonProcess } from "../daemon/process.js";
import { serviceFor } from "../daemon/service.js";
import { CLI_ON_PATH_FIX, findOnPath } from "../path.js";
import { findOrphanSessions, removeSession } from "../session.js";
import { missingHint, shellHint, shellLookup } from "../shell.js";
import { secretContext } from "../secret-context.js";
import { loadConfig, type Config } from "../config.js";
import { createContext, homeOf, type Context } from "../context.js";
import { CliError, errorText } from "../errors.js";
import { userHomeDir } from "../userhome.js";
import { absoluteHome } from "../daemon/service.js";
import { HARNESSES } from "../harness.js";
import {
  initOrLoginAdvice,
  initOrLoginWhat,
  legacyHome,
  madeByDonn,
  madeByDonnAdvice,
  madeByInitOrLogin,
  occupied,
  shellWord,
  unmigratedRepo,
} from "../migrate/steps.js";
import {
  backendLoader,
  loadAdapters,
  loadSecretProviders,
} from "../plugins.js";
import { ageText, readToken } from "../registry.js";
import { selectPersona, type Selection } from "../select.js";
import { readState, updateState, type State } from "../state.js";

// donn doctor: one line per check, in a fixed order; a check whose prerequisite failed is
// `skipped`. Never creates anything except under --fix. See docs/planning/07-cli-daily-use.md, §3.

export type Status = "ok" | "warn" | "error" | "skipped";
export interface Check {
  id: string;
  status: Status;
  message: string;
  fix?: string;
}

const VERIFIED_CLAUDE = "2.1.306";
const VERIFIED_CODEX = "0.163.0";

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

/** The three registry checks; offline is a warning, because the cache keeps working. */
async function registryChecks(
  io: CliIo,
  home: string,
  configured: string,
  add: (id: string, status: Status, message: string, fix?: string) => void,
): Promise<void> {
  let url: string;
  try {
    url = normaliseUrl(configured);
  } catch (error) {
    const message = errorText(
      error instanceof RegistryError
        ? new CliError(error.code, error.message)
        : error,
    );
    add("registry", "error", message, `donn login <https url>`);
    add("registry-token", "skipped", "the registry URL is not valid");
    add("registry-cache", "skipped", "the registry URL is not valid");
    return;
  }
  const token = await readToken(io, home, url);
  if (token === undefined) {
    add("registry", "skipped", `${url}: not logged in`);
    add(
      "registry-token",
      "warn",
      `not logged in to ${url}`,
      `donn login ${shellWord(url)} --token-stdin`,
    );
  } else {
    try {
      const who = await createClient({
        url,
        token,
        timeoutMs: 3000,
      }).whoami();
      add("registry", "ok", `${url} is reachable`);
      const subject = clean(who.subject);
      const until =
        who.kind === "session" && who.expiresAt !== undefined
          ? `, session until ${who.expiresAt.slice(0, 10)}`
          : "";
      const inFile =
        io.env.DONN_REGISTRY_TOKEN === undefined &&
        existsSync(join(home, "registry-token"));
      if (
        who.kind === "session" &&
        who.expiresAt !== undefined &&
        Date.parse(who.expiresAt) - (io.now ?? Date.now)() < 2 * 86_400_000
      ) {
        add(
          "registry-token",
          "warn",
          `session ends ${who.expiresAt.slice(0, 10)}`,
          `donn login ${shellWord(url)}`,
        );
      } else if (inFile) {
        add(
          "registry-token",
          "warn",
          `accepted as ${subject}${until}, but stored in ${join(home, "registry-token")}, not a keychain`,
          "install a keychain tool (secret-tool on Linux) and log in again",
        );
      } else {
        add("registry-token", "ok", `accepted as ${subject}${until}`);
      }
    } catch (error) {
      if (error instanceof RegistryError && error.code === "unauthorized") {
        add("registry", "ok", `${url} is reachable`);
        add(
          "registry-token",
          "error",
          "the registry refused the token",
          `donn login ${shellWord(url)} --token-stdin`,
        );
      } else {
        add(
          "registry",
          "warn",
          `${url} did not answer; cached layers stay in use`,
          "check your network, then run donn pull",
        );
        add("registry-token", "skipped", "the registry did not answer");
      }
    }
  }
  const index = await readIndex(home);
  if (index === undefined || index.url !== url) {
    add(
      "registry-cache",
      "warn",
      "nothing pulled from this registry yet",
      "donn pull",
    );
  } else {
    const pulled = Date.parse(index.pulledAt);
    const when =
      pulled === 0
        ? "never pulled"
        : `pulled ${ageText((io.now ?? Date.now)() - pulled)} ago`;
    add(
      "registry-cache",
      "ok",
      `${Object.keys(index.layers).length} layers, ${when}`,
    );
  }
}

/** Whether `dir` is in a git work tree: a `.git` (folder, or a worktree's file) here or above. */
function insideGit(dir: string): boolean {
  for (let at = resolve(dir); ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return true;
    if (dirname(at) === at) return false;
  }
}

export async function runChecks(
  io: CliIo,
  options: { persona?: string; fix: boolean },
): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (id: string, status: Status, message: string, fix?: string) =>
    checks.push({ id, status, message, ...(fix !== undefined && { fix }) });
  const skip = (id: string, because: string) => add(id, "skipped", because);
  // As donn uses it: a relative DONN_HOME is relative to the working folder.
  const home = absoluteHome(io, homeOf(io));

  // migrate: a home from before the rename, not migrated yet (spec 22 §3). First, because running
  // other fixes (init, mod install) first would make the new home and stand in migrate's way.
  // Under the user's home as migrate finds it.
  const oldHome = legacyHome(io);
  if (existsSync(oldHome)) {
    if (!existsSync(home)) {
      add(
        "migrate",
        "error",
        `${oldHome} is from before the rename, and ${home} does not exist yet`,
        "donn migrate",
      );
    } else if (!(await occupied(home))) {
      add(
        "migrate",
        "error",
        `${oldHome} is from before the rename, and ${home} is empty`,
        "donn migrate",
      );
    } else if (await madeByDonn(home)) {
      add(
        "migrate",
        "error",
        `${oldHome} is from before the rename, and ${home} was made by running donn before migrating`,
        await madeByDonnAdvice(home),
      );
    } else {
      const files = await madeByInitOrLogin(home);
      if (files !== undefined) {
        add(
          "migrate",
          "error",
          `${oldHome} is from before the rename, and ${initOrLoginWhat(home, files)}`,
          await initOrLoginAdvice(home, files),
        );
      }
    }
  }

  // home
  if (!(await writable(home))) {
    add(
      "home",
      "error",
      `${home} is not writable`,
      `fix the permissions on ${home}`,
    );
  } else if (io.env.DONN_HOME === "") {
    add(
      "home",
      "warn",
      `DONN_HOME is set but empty; using ${home}`,
      "unset DONN_HOME",
    );
  } else {
    add("home", "ok", home);
  }

  // config
  let config: Config | undefined;
  try {
    config = await loadConfig(home, io.env, io.passwdHome);
    if (config.personas === undefined) {
      add(
        "config",
        "warn",
        "no personas folder configured; only project and user personas are available",
        "donn init --personas <dir>",
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
      `create it, or donn init --personas <dir> --force`,
    );
  } else {
    const problems: string[] = [];
    const fixes: string[] = [];
    if (!insideGit(config.personas)) {
      problems.push(`${config.personas} is not a git repository`);
      fixes.push(
        `run \`git init\` in ${shellWord(config.personas)} to track your personas`,
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
      fixes.push(`move or remove ${shellWord(dir)}`);
    }
    if (problems.length > 0)
      add("personas", "warn", problems.join("; "), fixes.join("; "));
    else add("personas", "ok", config.personas);
  }

  // state
  let state: State | undefined;
  let waiting: string[] = [];
  try {
    state = await readState(home);
    // Missing persona.yaml is a warning. Forget an entry only when its repo folder is gone but
    // the folder that held it is still there: another branch or an unmounted volume (whose
    // whole path disappears) may bring the project back.
    // A project whose repo still has the old folder is not migrated yet: its own warning below,
    // and its switch is never forgotten.
    const missing = Object.keys(state.projects).filter(
      (key) => !existsSync(join(key, "persona.yaml")),
    );
    const repos = await Promise.all(missing.map((key) => unmigratedRepo(key)));
    waiting = [...new Set(repos.flatMap((repo) => repo ?? []))].sort();
    const orphans = missing.filter((_, i) => repos[i] === undefined);
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
            ? "donn doctor --fix"
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

  if (waiting.length > 0) {
    add(
      "projects",
      "warn",
      `${waiting.length} project(s) not migrated yet: ${waiting.join(", ")}`,
      waiting
        .map((repo) => `donn migrate --project ${shellWord(repo)}`)
        .join("; "),
    );
  }

  // plugins: load every listed entry, so a broken one shows here and not mid-launch
  if (config === undefined) skip("plugins", "config.yaml could not be read");
  else if (!config.adapters?.length && !config.secretProviders?.length) {
    add("plugins", "ok", "no plugins configured");
  } else {
    try {
      const where = {
        home,
        config,
        ...(io.passwdHome && { passwdHome: io.passwdHome }),
      };
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
      // instructions would reach a donn claude session twice (docs/planning/11-agents-md.md).
      let twice = "";
      if (ctx.projectDir !== undefined) {
        const repo = dirname(ctx.projectDir);
        const agents = await readFile(join(repo, "AGENTS.md"), "utf8").catch(
          () => "",
        );
        if (
          agents.includes("<!-- donn:begin") &&
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
          "donn init --extends <persona> in a project, or donn switch <persona>",
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
  const claudePath = findOnPath("claude", io.env);
  if (!detection.installed) {
    const hint = await missingHint("claude", claudePath, io);
    add(
      "claude",
      "error",
      "claude is not installed (or not on PATH)",
      hint ?? "install Claude Code",
    );
  } else {
    // Version and mode are independent findings: an old claude must not hide a degraded mode.
    // `donn claude` runs the claude PATH finds; a shell alias does not count.
    const where = claudePath ? ` (${claudePath})` : "";
    const findings: string[] = [];
    const fixes: string[] = [];
    // Only an alias can differ from PATH here; with nothing on PATH to compare, say nothing.
    const differs =
      claudePath === undefined
        ? undefined
        : shellHint(
            "claude",
            await shellLookup("claude", io),
            claudePath,
            "",
            userHomeDir(io.env, io.passwdHome),
          );
    if (differs) {
      findings.push(differs);
      fixes.push(
        `point the alias at ${shellWord(claudePath!)}, or remove it so the shell and donn run the same claude`,
      );
    }
    if (detection.version && olderThan(detection.version, VERIFIED_CLAUDE)) {
      findings.push(
        `claude ${detection.version}${where} is older than ${VERIFIED_CLAUDE}, the version donn was verified against`,
      );
      fixes.push(
        "update the Claude Code that PATH finds (donn claude ignores shell aliases)",
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

  // codex: optional; `donn codex` runs the codex PATH finds
  const codex = await HARNESSES.codex!.detect(io.probe);
  if (!codex.installed) {
    add("codex", "ok", "codex not installed (optional)");
  } else {
    const codexPath = findOnPath("codex", io.env);
    const where = codexPath ? ` (${codexPath})` : "";
    if (codex.version && olderThan(codex.version, VERIFIED_CODEX)) {
      add(
        "codex",
        "warn",
        `codex ${codex.version}${where} is older than ${VERIFIED_CODEX}, the version donn was verified against`,
        "update the Codex CLI that PATH finds",
      );
    } else {
      add(
        "codex",
        "ok",
        `codex ${codex.version ?? "(unknown version)"}${where}`,
      );
    }
  }

  // cli: the mod runs `donn` from PATH without a shell
  const cli = findOnPath("donn", io.env);
  if (cli) add("cli", "ok", `donn on PATH: ${cli}`);
  else
    add(
      "cli",
      "warn",
      "donn is not on PATH, so the Claude Code mod cannot run it",
      CLI_ON_PATH_FIX,
    );

  // daemon: optional; running at the version of this CLI, or not at all. An installed service
  // must name a donn that exists and be loaded. A service for another home is not this
  // home's concern: `daemon install` here would take it over.
  const service = await serviceFor(io, home);
  const serviceCommand = service?.installed.command;
  const reinstall = "donn daemon install";
  let serviceProblem: string | undefined;
  if (service && serviceCommand !== undefined) {
    if (!existsSync(serviceCommand)) {
      serviceProblem = `the daemon service runs ${serviceCommand}, which no longer exists`;
    } else if (!(await service.manager.loaded())) {
      serviceProblem = `the daemon service is installed but not loaded (${service.manager.path})`;
    }
  }
  let refused: string | undefined;
  const daemon = await connectDaemon(home).catch((error: unknown) => {
    if (error instanceof CliError && error.code === "daemon-unauthorized") {
      refused = error.message;
      return undefined;
    }
    throw error;
  });
  if (refused !== undefined) {
    add(
      "daemon",
      "warn",
      refused.replace(/^daemon: /, "the daemon ").replace(/;.*$/, ""),
      "donn daemon stop && donn daemon start",
    );
  } else if (daemon) {
    const status = daemon.probed;
    if (status.version !== cliVersion()) {
      const mismatch = versionMismatch(status.version, cliVersion());
      if (serviceCommand !== undefined) {
        add("daemon", "warn", mismatch.replace(/;.*$/, ""), reinstall);
      } else {
        add(
          "daemon",
          "warn",
          mismatch,
          "donn daemon stop && donn daemon start",
        );
      }
    } else if (serviceProblem !== undefined) {
      add("daemon", "warn", serviceProblem, reinstall);
    } else {
      add(
        "daemon",
        "ok",
        `daemon ${status.version} running (pid ${status.pid})`,
      );
    }
  } else {
    // Nothing answers: a socket or pid file left behind is a daemon that died, as is a pid the OS
    // has given to another process (which `daemon stop` leaves alone).
    const paths = daemonPaths(home);
    const pid = Number.parseInt(
      await readFile(paths.pid, "utf8").catch(() => ""),
      10,
    );
    if (pid > 0 && isDaemonProcess(pid)) {
      add(
        "daemon",
        "warn",
        `the daemon (pid ${pid}) is unresponsive`,
        "donn daemon stop",
      );
    } else if (existsSync(await daemonSocket(home)) || pid > 0) {
      add(
        "daemon",
        "warn",
        `the daemon's socket or pid file is stale in ${paths.dir}`,
        "donn daemon start",
      );
    } else if (serviceProblem !== undefined) {
      add("daemon", "warn", serviceProblem, reinstall);
    } else {
      add("daemon", "ok", "daemon not running (optional)");
    }
  }

  // mod: the Claude Code mod this donn ships, installed and current
  const installed = await installedModVersion(home);
  const shipped = bundledMod().version;
  if (installed === undefined) {
    add("mod", "warn", "the mod is not installed", "donn mod install");
  } else if (installed !== shipped) {
    add(
      "mod",
      "warn",
      `mod ${installed} does not match the mod this donn ships (${shipped})`,
      "donn mod install",
    );
  } else {
    add("mod", "ok", `donn mod ${installed}`);
  }

  // registry: configured, token accepted, cache age (only with a registry in config.yaml)
  if (config?.registry !== undefined) {
    await registryChecks(io, home, config.registry.url, add);
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

  // agents: per created agent, the pinned eve, Docker, the gateway, agent.ts and its files
  // (spec 25 §7); nothing without created agents.
  await agentChecks(io, home, add);

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
        `donn doctor --fix (it removes only what no running session uses; deleting ${shellWord(absoluteHome(io, buildRoot))} entirely is also safe, builds are recreated on launch, but leave session folders of running sessions alone)`,
      );
    }
  }

  // managed: the Claude Code policy `donn managed install` put on this machine (spec 21).
  // Most machines have none, which is not a problem to flag.
  try {
    const result = await checkHere(io);
    const { root, os } = managedEnv(io);
    if (result.state === "missing") {
      add("managed", "skipped", `no managed policy installed in ${root}`);
    } else if (result.state === "current") {
      const notes = result.findings.map((f) => f.detail);
      add(
        "managed",
        "ok",
        `${root}: current${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`,
      );
    } else {
      add(
        "managed",
        "warn",
        result.findings.map((f) => `${f.state}: ${f.detail}`).join("; "),
        managedFix(result, os),
      );
    }
  } catch (error) {
    add(
      "managed",
      "warn",
      errorText(error),
      error instanceof CliError && error.code === "managed-newer-format"
        ? "upgrade donn"
        : undefined,
    );
  }

  return checks;
}

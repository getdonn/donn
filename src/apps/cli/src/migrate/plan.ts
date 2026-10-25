import { existsSync } from "node:fs";
import { readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  deleteKeychainItem,
  getKeychainItem,
  hasKeychainItem,
  keychainSupported,
  setKeychainItem,
} from "@getdonn/secrets";
import { API_VERSION } from "@getdonn/spec";
import { normaliseUrl, readIndex } from "@getdonn/store-remote";
import { parse } from "yaml";
import type { CliIo } from "../cli.js";
import { installService } from "../commands/daemon.js";
import { confirmed, needAdmin } from "../commands/managed.js";
import { checkModBuilt, MOD_ID, registerMod } from "../commands/mod.js";
import { expandPath, loadConfig } from "../config.js";
import { homeOf } from "../context.js";
import {
  absoluteHome,
  installedService,
  serviceFor,
  serviceManager,
  type ServiceManager,
} from "../daemon/service.js";
import { CliError } from "../errors.js";
import { managedEnv } from "../managed/env.js";
import {
  applyUninstall,
  planUninstall,
  readInstalled,
  readPending,
  type ManagedLayout,
} from "../managed/install.js";
import { CLI_ON_PATH_FIX, findOnPath } from "../path.js";
import { keychainContext, TOKEN_SERVICE } from "../registry.js";
import { listSessions } from "../session.js";
import { readState, updateState } from "../state.js";
import { missingHint } from "../shell.js";
import { LEGACY } from "./legacy.js";
import {
  clearEmpty,
  dropState,
  findProjectRoot,
  legacyDaemonPid,
  legacyMod,
  madeByDonn,
  madeByInitOrLogin,
  moveHome,
  occupied,
  oldHomeValues,
  onlyProgress,
  present,
  PROGRESS,
  readProgress,
  regenerable,
  rewriteApiVersion,
  rewriteConfigPaths,
  rewriteFile,
  rewriteMarkers,
  rewriteMarkersIn,
  setAsideOf,
  shellWord,
  stagingOf,
  staleFiles,
  stopLegacyDaemon,
  targetExists,
  targetMadeByDonn,
  targetMadeByInitOrLogin,
  unmigratedRepo,
  updateProgress,
  userHome,
  legacyHome,
  writeThrough,
  yamlFiles,
  type MoveOptions,
} from "./steps.js";

// donn migrate: plan the steps from what is on this machine, show them, ask, run them in order.
// Each step knows it is done by its effect and is checked again just before it runs, so the plan
// is an estimate and a re-run, or a run after an interruption, only does what is left.
// See docs/planning/22-rename-donn.md §3.

export type StepStatus = "pending" | "done";

/** Whether a step has work left, and anything the user should know about it. */
export interface StepCheck {
  pending: boolean;
  notes?: string[];
}

/** What a run left: notes, and `pending` when the step could not finish (it is tried again). */
export interface StepOutcome {
  notes?: string[];
  pending?: boolean;
}

export interface MigrationStep {
  id: string;
  title: string;
  /** As planned; `check` decides again when the step's turn comes. */
  status: StepStatus;
  notes?: string[];
  check(): Promise<StepCheck>;
  run(): Promise<StepOutcome | void>;
}

export interface StepResult {
  id: string;
  /** `ran` now, `done` already, or still `pending` (see its notes). */
  status: "ran" | "done" | "pending";
  notes?: string[];
}

export interface RunOptions {
  yes?: boolean;
  json?: boolean;
  /** The plan's first line; the user-level header by default. */
  header?: string;
  /** Shown under the plan, before the question. */
  warnings?: string[];
  /** Test seam: called after each step; a throw stands for an interruption. */
  afterStep?: (id: string) => void | Promise<void>;
}

/** Test seams for planMigration. */
export interface PlanOptions {
  /** The built mod's folder; bundledMod()'s by default. */
  modDir?: string;
  move?: MoveOptions;
}

/** The user's home folder, the old donn home in it, and where the new one goes. */
function where(io: CliIo) {
  const user = userHome(io);
  const src = legacyHome(io);
  const target = absoluteHome(io, homeOf(io));
  /**
   * The home as it is now: the old one until it has moved, then the new one. Between a verified
   * cross-filesystem copy setting the old home aside and the copy going into place, the copy.
   */
  const live = () => {
    if (existsSync(src)) return src;
    const staging = stagingOf(target);
    if (
      !existsSync(target) &&
      existsSync(staging) &&
      existsSync(setAsideOf(src))
    )
      return staging;
    return target;
  };
  return { user, src, target, live };
}

export const userHeader = (io: CliIo) =>
  `migrate ~/${LEGACY.home} to ${where(io).target}:`;

export const NOTHING = `nothing to migrate: no ${LEGACY.name} install found`;

/** The service of the old name, or undefined where there is no service manager. */
function legacyService(io: CliIo): ServiceManager | undefined {
  return serviceManager(io, {
    label:
      io.probe.platform === "darwin"
        ? LEGACY.launchdLabel
        : LEGACY.systemdUnit.replace(/\.service$/, ""),
  });
}

/** config.yaml's text with its old-home paths updated; undefined when nothing changes. */
async function configRewrite(
  w: ReturnType<typeof where>,
): Promise<{ file: string; text: string } | undefined> {
  const file = join(w.live(), "config.yaml");
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  const next = rewriteConfigPaths(text, w);
  return next === text ? undefined : { file, text: next };
}

/** The personas folder config.yaml names, its old-home paths read as the home is now. */
async function personasFolder(
  io: CliIo,
  w: ReturnType<typeof where>,
): Promise<string | undefined> {
  const home = w.live();
  const text = await readFile(join(home, "config.yaml"), "utf8").catch(
    () => undefined,
  );
  let personas: unknown;
  try {
    personas = (
      parse(rewriteConfigPaths(text ?? "", { ...w, target: home })) as {
        personas?: unknown;
      } | null
    )?.personas;
  } catch {
    personas = undefined; // a broken config.yaml: doctor says so afterwards
  }
  return typeof personas === "string" && personas !== ""
    ? expandPath(personas, home, io.env)
    : undefined;
}

/** Persona files with the old apiVersion: under the home and the personas folder config names. */
async function personaFiles(
  io: CliIo,
  w: ReturnType<typeof where>,
): Promise<string[]> {
  const files = new Set(await staleFiles(w.live()));
  const personas = await personasFolder(io, w);
  if (personas !== undefined)
    for (const file of await staleFiles(personas)) files.add(file);
  return [...files].sort();
}

/** What donn makes again in a home, and the mod it installs: never the user's to edit. */
const MADE = ["build", "sessions", "daemon", "mod", "cache"];

/**
 * Values in the home's YAML files (personas, overrides.yaml, config.yaml) and the personas
 * folder that still name the old home, which is gone once moved. Reported, never changed:
 * which new path each should name is the user's call.
 */
export async function oldHomePaths(
  io: CliIo,
): Promise<{ file: string; field: string; value: string }[]> {
  const w = where(io);
  const files = new Set(await yamlFiles(w.live(), MADE));
  const personas = await personasFolder(io, w);
  if (personas !== undefined)
    for (const file of await yamlFiles(personas)) files.add(file);
  const hits: { file: string; field: string; value: string }[] = [];
  for (const file of [...files].sort()) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const hit of oldHomeValues(text, w.src).sort((a, b) =>
      a.field < b.field ? -1 : a.field > b.field ? 1 : 0,
    ))
      hits.push({ file, ...hit });
  }
  return hits;
}

/** The registry accounts (normalised URLs) a token may be stored under. */
async function registryAccounts(io: CliIo, home: string): Promise<string[]> {
  const urls: string[] = [];
  const config = await loadConfig(home, io.env).catch(() => undefined);
  if (config?.registry !== undefined) urls.push(config.registry.url);
  const index = await readIndex(home).catch(() => undefined);
  if (index !== undefined) urls.push(index.url);
  const accounts = new Set<string>();
  for (const url of urls) {
    try {
      accounts.add(normaliseUrl(url));
    } catch {
      // Not a URL a token could have been stored for.
    }
  }
  return [...accounts];
}

/**
 * state.json's switches keyed by a project's old folder: they point at `<project>/.donn` once
 * moved, which is where donn looks, whether or not the project itself is migrated yet. A
 * state.json that cannot be read is left alone (doctor reports it).
 */
async function oldSwitches(
  w: ReturnType<typeof where>,
): Promise<{ keys: string[]; note?: string }> {
  try {
    const state = await readState(w.live());
    return {
      keys: Object.keys(state.projects).filter(
        (key) => basename(key) === LEGACY.home,
      ),
    };
  } catch (error) {
    return {
      keys: [],
      note: `${messageOf(error)}; its project switches are left as they are`,
    };
  }
}

/**
 * Projects with a switch in state.json whose old project folder is still there, each with the
 * command that migrates it. Its switch already names `.donn/`, so it matches once moved.
 */
export async function pendingProjects(
  io: CliIo,
): Promise<{ dir: string; next: string }[]> {
  const w = where(io);
  const state = await readState(w.live()).catch(() => undefined);
  const dirs = new Set<string>();
  for (const key of Object.keys(state?.projects ?? {})) {
    const dir = unmigratedRepo(key);
    if (dir !== undefined) dirs.add(dir);
  }
  return [...dirs]
    .sort()
    .map((dir) => ({ dir, next: `donn migrate --project ${shellWord(dir)}` }));
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
/** No keychain command at all: then nothing can be stored in one. */
const noKeychain = (error: unknown) =>
  /is not installed/.test(messageOf(error));
const keychainNote = (account: string, error: unknown) =>
  `the keychain did not answer for ${account} (${messageOf(error)}); unlock it and run donn migrate again`;

/** Pending while an old item exists; looked up without reading its secret. */
async function checkKeychain(
  io: CliIo,
  w: ReturnType<typeof where>,
): Promise<StepCheck> {
  const context = keychainContext(io);
  if (!keychainSupported(context.platform)) return { pending: false };
  for (const account of await registryAccounts(io, w.live())) {
    try {
      if (await hasKeychainItem(context, LEGACY.keychainService, account))
        return { pending: true };
    } catch (error) {
      if (noKeychain(error)) return { pending: false };
      return { pending: true, notes: [keychainNote(account, error)] };
    }
  }
  return { pending: false };
}

/** Move each old item: copy (unless a newer sign-in is there), read back, delete the old one. */
async function moveTokens(
  io: CliIo,
  w: ReturnType<typeof where>,
): Promise<StepOutcome> {
  const context = keychainContext(io);
  const notes: string[] = [];
  let pending = false;
  for (const account of await registryAccounts(io, w.live())) {
    try {
      if (!(await hasKeychainItem(context, LEGACY.keychainService, account)))
        continue;
      const value = await getKeychainItem(
        context,
        LEGACY.keychainService,
        account,
      );
      if (value === undefined) continue;
      const current = await getKeychainItem(context, TOKEN_SERVICE, account);
      if (current === undefined) {
        await setKeychainItem(context, TOKEN_SERVICE, account, value);
        if (
          (await getKeychainItem(context, TOKEN_SERVICE, account)) !== value
        ) {
          throw new Error(`the token did not read back from ${TOKEN_SERVICE}`);
        }
      } else if (current !== value) {
        notes.push(
          `kept the newer sign-in under ${TOKEN_SERVICE} for ${account}; removed the old ${LEGACY.keychainService} item`,
        );
      }
      await deleteKeychainItem(context, LEGACY.keychainService, account);
    } catch (error) {
      if (noKeychain(error)) continue;
      notes.push(keychainNote(account, error));
      pending = true;
    }
  }
  return { notes, pending };
}

/** What claude has registered, or undefined when claude is not installed. */
async function registrations(
  io: CliIo,
): Promise<{ plugins: string[]; marketplaces: string[] } | undefined> {
  const list = async (args: string[], key: "id" | "name") => {
    const result = await io.probe.run("claude", args);
    if (result.exitCode === 127) return undefined;
    const said = `${["claude", ...args].join(" ")}`;
    if (result.exitCode !== 0) {
      throw new CliError(
        "mod-uninstall",
        `${said} exited ${result.exitCode}: ${firstLine(result)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      parsed = undefined;
    }
    // Only a list of objects, each with a string `key`: anything else could hide the old mod.
    const entries = Array.isArray(parsed) ? (parsed as unknown[]) : undefined;
    if (
      entries === undefined ||
      !entries.every(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          typeof (entry as Record<string, unknown>)[key] === "string",
      )
    ) {
      throw new CliError(
        "mod-uninstall",
        `${said} printed an unexpected shape (not a list of objects with a string "${key}"); claude's plugin list may have changed: update donn, or remove the ${LEGACY.plugin} plugin with claude by hand`,
      );
    }
    return entries.map((entry) => (entry as Record<string, string>)[key]!);
  };
  const plugins = await list(["plugin", "list", "--json"], "id");
  if (plugins === undefined) return undefined;
  const marketplaces =
    (await list(["plugin", "marketplace", "list", "--json"], "name")) ?? [];
  return { plugins, marketplaces };
}

const firstLine = (result: { stdout: string; stderr: string }) =>
  (result.stderr.trim() || result.stdout.trim()).split("\n")[0] ?? "";

/** Whether claude still has the old plugin or its marketplace. */
const oldRegistered = (registered: {
  plugins: string[];
  marketplaces: string[];
}) =>
  registered.plugins.includes(LEGACY.plugin) ||
  registered.marketplaces.includes(LEGACY.marketplace);

/**
 * Unregister the old mod while its folder is still in place. Done is what `claude plugin list`
 * says afterwards, never an exit code or message: a failure leaves it pending, with claude's words.
 */
async function removeOldMod(
  io: CliIo,
  w: ReturnType<typeof where>,
): Promise<void> {
  const before = await registrations(io);
  // The plan saw claude; without it now, nothing can say the old mod is gone.
  if (before === undefined) {
    throw new CliError(
      "mod-uninstall",
      `claude is not on PATH, so the old mod (${LEGACY.plugin}) cannot be unregistered; put claude back on PATH and run donn migrate again`,
    );
  }
  // Step 7 (mod-install) puts the new mod in; remember it is due.
  await updateProgress(w.live(), { mod: true });
  const failures: string[] = [];
  const remove = async (args: string[]) => {
    const result = await io.probe.run("claude", args);
    if (result.exitCode !== 0)
      failures.push(
        `claude ${args.join(" ")} exited ${result.exitCode}: ${firstLine(result)}`,
      );
  };
  if (before.plugins.includes(LEGACY.plugin))
    await remove(["plugin", "uninstall", LEGACY.plugin]);
  if (before.marketplaces.includes(LEGACY.marketplace))
    await remove(["plugin", "marketplace", "remove", LEGACY.marketplace]);
  const after = await registrations(io);
  if (after !== undefined && oldRegistered(after)) {
    throw new CliError(
      "mod-uninstall",
      `the old Claude Code mod is still registered (${LEGACY.plugin}): ${failures.join("; ") || "claude plugin list still shows it"}`,
      { failures },
    );
  }
}

const status = (check: StepCheck): StepStatus =>
  check.pending ? "pending" : "done";

/** A step with its planned status and notes, from its own check. */
async function step(
  id: string,
  title: string,
  check: () => Promise<StepCheck>,
  run: () => Promise<StepOutcome | void>,
): Promise<MigrationStep> {
  const planned = await check();
  return {
    id,
    title,
    status: status(planned),
    ...(planned.notes !== undefined && { notes: planned.notes }),
    check,
    run,
  };
}

const yes = (pending: boolean): StepCheck => ({ pending });

/** The old home variable, set somewhere it would send the old CLI or service elsewhere. */
async function oldHomeElsewhere(
  io: CliIo,
  w: ReturnType<typeof where>,
  old: ServiceManager | undefined,
): Promise<void> {
  const name = `${LEGACY.envPrefixes[0]}HOME`;
  const refuse = (place: string, value: string) =>
    new CliError(
      "migrate-old-home",
      `${name} is set ${place} (${value}); donn migrate moves only ~/${LEGACY.home}: unset it, or move that home by hand`,
      { variable: name, value },
    );
  // A launchd plist or an env file does not expand `~`: it stands for the user's home.
  const expanded = (value: string) =>
    value === "~" || value.startsWith("~/")
      ? join(w.user, value.slice(2))
      : value;
  const elsewhere = (value: string | undefined): value is string =>
    value !== undefined &&
    value !== "" &&
    resolve(io.cwd, expanded(value)) !== resolve(w.src);
  const fromEnv = io.env[name];
  if (elsewhere(fromEnv)) throw refuse("in your environment", fromEnv);
  const file = old && (await installedService(old));
  const fromFile = file?.env[name];
  if (elsewhere(fromFile)) throw refuse(`in ${old!.path}`, fromFile);
}

/** The user-level migration's steps, each `pending` or `done` as planned. Changes nothing. */
export async function planMigration(
  io: CliIo,
  options: PlanOptions = {},
): Promise<MigrationStep[]> {
  const w = where(io);
  if (
    existsSync(w.src) &&
    (w.target === w.src || w.target.startsWith(w.src + sep))
  ) {
    throw new CliError(
      "migrate-target-inside",
      `DONN_HOME (${w.target}) is inside ${w.src}; set it to a folder outside it`,
      { target: w.target },
    );
  }
  const old = legacyService(io);
  await oldHomeElsewhere(io, w, old);
  // A target with only a progress note is a migration under way: it resumes.
  if (
    existsSync(w.src) &&
    (await occupied(w.target)) &&
    !(await onlyProgress(w.target))
  ) {
    const written = await madeByInitOrLogin(w.target);
    if (await madeByDonn(w.target)) throw await targetMadeByDonn(w.target);
    throw written === undefined
      ? targetExists(w.target)
      : await targetMadeByInitOrLogin(w.target, written);
  }
  const oldInstalled = async () =>
    old !== undefined && (existsSync(old.path) || (await old.loaded()));
  const oldDaemon = async () =>
    existsSync(w.src) && (await legacyDaemonPid(w.src)) !== undefined;

  const steps = [
    await step(
      "service-stop",
      `stop and remove the old background service (${old?.label ?? "none"})`,
      async () => yes((await oldInstalled()) || (await oldDaemon())),
      async () => {
        if (await oldInstalled()) {
          // service-start installs the new service only if this one was installed: remember it.
          await updateProgress(w.live(), { service: true });
          await old!.uninstall();
        }
        if (existsSync(w.src)) await stopLegacyDaemon(w.src);
      },
    ),
    await step(
      "mod-remove",
      `unregister the old Claude Code mod (${LEGACY.plugin}) while its folder is in place`,
      // claude is asked only when there is an old mod (or one being replaced); its answer must
      // be readable, or nothing runs.
      async () => {
        if (
          !(await legacyMod(w.live())) &&
          (await readProgress(w.live())).mod !== true
        )
          return yes(false);
        // No claude to ask is not done: the run says so (the plan refuses before that).
        const registered = await registrations(io);
        return yes(registered === undefined || oldRegistered(registered));
      },
      () => removeOldMod(io, w),
    ),
    await step(
      "move-home",
      `move ~/${LEGACY.home} to ${w.target}`,
      async () =>
        yes(
          existsSync(w.src) ||
            (await present(setAsideOf(w.src))) ||
            (await present(stagingOf(w.target))),
        ),
      async () => {
        if (existsSync(w.src)) {
          if (await onlyProgress(w.target)) {
            // An earlier run's note waits in the target: it joins the old home's.
            await updateProgress(w.src, await readProgress(w.target));
            await rm(join(w.target, PROGRESS), { force: true });
            await clearEmpty(w.target);
          }
          // The old home's regenerable state moves with it, marked for drop-state: a donn
          // daemon that runs later makes the same files, and those must stay.
          if ((await regenerable(w.src)).length > 0)
            await updateProgress(w.src, { state: true });
        }
        await moveHome(w.src, w.target, options.move);
      },
    ),
    await step(
      "drop-state",
      "drop build/, sessions/ and the daemon's socket files (made again)",
      async () =>
        yes(
          (existsSync(w.src) && (await regenerable(w.src)).length > 0) ||
            (await readProgress(w.live())).state === true,
        ),
      async () => {
        await dropState(w.live());
        await updateProgress(w.live(), { state: false });
      },
    ),
    await step(
      "api-version",
      `rewrite apiVersion ${LEGACY.apiVersion} to ${API_VERSION}; update config.yaml paths`,
      async () =>
        yes(
          (await configRewrite(w)) !== undefined ||
            (await personaFiles(io, w)).length > 0,
        ),
      async () => {
        const config = await configRewrite(w);
        if (config !== undefined) await writeThrough(config.file, config.text);
        for (const file of await personaFiles(io, w)) await rewriteFile(file);
      },
    ),
    await step(
      "state",
      "point project switches in state.json at .donn/ folders",
      async () => {
        const { keys, note } = await oldSwitches(w);
        return {
          pending: keys.length > 0,
          ...(note !== undefined && { notes: [note] }),
        };
      },
      async () => {
        await updateState(w.live(), (state) => {
          for (const key of Object.keys(state.projects)) {
            if (basename(key) !== LEGACY.home) continue;
            const now = join(dirname(key), ".donn");
            // A switch made since the rename, for the same project, is the newer choice.
            state.projects[now] ??= state.projects[key]!;
            delete state.projects[key];
          }
        });
      },
    ),
    await step(
      "keychain",
      `move the registry token from ${LEGACY.keychainService} to ${TOKEN_SERVICE} in the keychain`,
      () => checkKeychain(io, w),
      () => moveTokens(io, w),
    ),
    await step(
      "mod-install",
      `install the Claude Code mod (${MOD_ID})`,
      async () =>
        yes(
          (await readProgress(w.live())).mod === true ||
            (await legacyMod(w.live())),
        ),
      async () => {
        const home = w.live();
        let notes: string[];
        if ((await registrations(io)) === undefined) {
          await rm(join(home, "mod"), { recursive: true, force: true });
          notes = ["claude is not installed; run donn mod install once it is"];
        } else {
          notes = (await registerMod(io)).warnings;
        }
        await updateProgress(home, { mod: false });
        return { notes };
      },
    ),
    await step(
      "service-start",
      "install and start the new background service",
      // Pending while the old service is installed (service-stop has yet to run) or was.
      async () =>
        yes(
          (await oldInstalled()) ||
            (await readProgress(w.live())).service === true,
        ),
      async () => {
        // Done only once loaded: a service file alone may be from a run that stopped half way.
        const service = await serviceFor(io, w.target);
        if (!service || !(await service.manager.loaded()))
          await installService(io);
        await updateProgress(w.live(), { service: false });
      },
    ),
  ];
  // What later steps need, checked now rather than found missing half way.
  const pending = (id: string) =>
    steps.find((s) => s.id === id)?.status === "pending";
  if (pending("mod-install")) {
    checkModBuilt(options.modDir);
    // No claude to ask: the old mod would be dropped unregistered. claude is often an alias
    // (~/.claude/local/claude) that a spawn without a shell cannot see.
    if ((await registrations(io).catch(() => null)) === undefined) {
      const hint =
        (await missingHint("claude", findOnPath("claude", io.env), io)) ??
        "put claude on PATH";
      // Once the old mod is unregistered, its folder no longer stands in the way.
      const removed = (await readProgress(w.live())).mod === true;
      throw new CliError(
        "claude-not-on-path",
        removed
          ? `claude is not on PATH, so the donn mod cannot be installed (the old one is already unregistered); ${hint}; then run donn migrate again`
          : `claude is not on PATH, so the old mod cannot be unregistered; ${hint}; or, if Claude Code is gone, remove ${join(w.live(), "mod")}; then run donn migrate again`,
        { hint },
      );
    }
  }
  if (pending("service-start") && !findOnPath("donn", io.env)) {
    throw new CliError(
      "cli-not-on-path",
      `donn is not on PATH, so the new background service cannot run it; ${CLI_ON_PATH_FIX}`,
    );
  }
  return steps;
}

/** Warnings for the plan: sessions the old CLI started that are still running. */
export async function migrationWarnings(io: CliIo): Promise<string[]> {
  const { src } = where(io);
  if (!existsSync(src)) return [];
  const running = (await listSessions(src)).filter((s) => s.running);
  const n = running.length;
  if (n === 0) return [];
  const pids = running.map((s) => s.launched.pid).join(", ");
  return [
    n === 1
      ? `1 session started by ${LEGACY.name} is still running (pid ${pids}); it loses its plugin and build folders: restart it after the migration`
      : `${n} sessions started by ${LEGACY.name} are still running (pids ${pids}); they lose their plugin and build folders: restart them after the migration`,
  ];
}

const planLine = (status: string, id: string, title: string) =>
  `  ${status.padEnd(9)}${id.padEnd(15)}${title}\n`;
const noteLine = (note: string) => `${" ".repeat(11)}note: ${note}\n`;

/**
 * Show the plan, ask (unless `yes`), then run the steps in order, each checked again just before
 * its turn. Undefined when the user declined; nothing has changed then. A plan with nothing
 * pending is not shown or asked.
 */
export async function runMigration(
  io: CliIo,
  steps: MigrationStep[],
  options: RunOptions,
): Promise<StepResult[] | undefined> {
  if (steps.every((s) => s.status === "done")) {
    return steps.map(({ id }) => ({ id, status: "done" }));
  }
  const out = options.json ? io.stderr : io.stdout;
  out.write(`${options.header ?? userHeader(io)}\n`);
  for (const s of steps) {
    out.write(planLine(s.status, s.id, s.title));
    for (const note of s.notes ?? []) out.write(noteLine(note));
  }
  for (const warning of options.warnings ?? [])
    out.write(`warning: ${warning}\n`);
  if (
    !options.yes &&
    !(await confirmed(
      io,
      managedEnv(io),
      "Migrate now?",
      "nothing changed",
      "migrate-confirm",
    ))
  ) {
    return undefined;
  }
  const results: StepResult[] = [];
  for (const s of steps) {
    if ((await s.check()).pending) {
      const outcome = (await s.run()) ?? {};
      const notes = outcome.notes ?? [];
      const result = outcome.pending ? "pending" : "ran";
      out.write(`  ${result.padEnd(9)}${s.id}\n`);
      for (const note of notes) out.write(noteLine(note));
      results.push({
        id: s.id,
        status: result,
        ...(notes.length > 0 && { notes }),
      });
    } else {
      results.push({ id: s.id, status: "done" });
    }
    await options.afterStep?.(s.id);
  }
  return results;
}

/** Old environment variables that are set, each with the name it has now. */
export function legacyEnv(io: CliIo): { name: string; rename: string }[] {
  return Object.keys(io.env)
    .filter((name) => io.env[name] !== undefined)
    .flatMap((name) => {
      const prefix = LEGACY.envPrefixes.find((p) => name.startsWith(p));
      return prefix === undefined
        ? []
        : [{ name, rename: `DONN_${name.slice(prefix.length)}` }];
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The old CLI, when it is still on PATH, with the command that removes it. */
export function oldCli(
  io: CliIo,
): { path: string; remove: string } | undefined {
  const path = findOnPath(LEGACY.name, io.env);
  if (path === undefined) return undefined;
  // pnpm's global bin folder (~/Library/pnpm, ~/.local/share/pnpm); npm's otherwise.
  const remove = /[/\\]pnpm[/\\]/.test(path)
    ? `pnpm remove --global ${LEGACY.cliPackage}`
    : `npm uninstall --global ${LEGACY.cliPackage}`;
  return { path, remove };
}

const LEGACY_LAYOUT: ManagedLayout = {
  folder: LEGACY.managedFolder,
  dropIn: LEGACY.managedDropIn,
};

export const MANAGED_NEXT = [
  "donn managed build",
  "sudo donn managed install donn-managed",
];

/** An old managed policy in the system folder, with the commands that replace it. */
export async function legacyPolicy(
  io: CliIo,
): Promise<{ root: string; next: string[] } | undefined> {
  const { root } = managedEnv(io);
  const folder = join(root, LEGACY.managedFolder);
  const installed =
    (await present(join(folder, "manifest.json"))) ||
    (await present(join(folder, "pending.json")));
  return installed
    ? { root, next: ["sudo donn migrate --managed", ...MANAGED_NEXT] }
    : undefined;
}

/** `.gitignore` lines that name the old project folder; reported, never changed. */
async function gitignoreLines(
  root: string,
): Promise<{ file: string; line: number; text: string }[]> {
  const file = join(root, ".gitignore");
  const text = await readFile(file, "utf8").catch(() => "");
  const names = new RegExp(
    `(^|[/!*])${LEGACY.home.replace(/\./g, "\\.")}(/|$)`,
  );
  return text
    .split(/\r?\n/)
    .map((line, i) => ({ file, line: i + 1, text: line }))
    .filter(({ text: line }) => names.test(line.trim()));
}

/** `donn migrate --project`: the project at or above `dir`, its steps planned and run. */
export async function migrateProject(
  io: CliIo,
  dir: string | undefined,
  options: RunOptions,
): Promise<{
  start: string;
  root?: string;
  results?: StepResult[];
  gitignore?: { file: string; line: number; text: string }[];
}> {
  const start = resolve(io.cwd, dir ?? ".");
  const root = await findProjectRoot(start, resolve(userHome(io)));
  if (root === undefined) return { start };
  const legacyDir = join(root, LEGACY.home);
  const newDir = join(root, ".donn");
  const agents = join(root, "AGENTS.md");
  const liveDir = () => (existsSync(legacyDir) ? legacyDir : newDir);
  if (existsSync(legacyDir) && (await occupied(newDir))) {
    throw targetExists(newDir, false);
  }
  const changes = async (path: string, rewrite: (text: string) => string) => {
    const text = await readFile(path, "utf8").catch(() => "");
    return yes(rewrite(text) !== text);
  };
  const steps = [
    await step(
      "project-folder",
      `move ${LEGACY.home}/ to .donn/ (git mv when tracked)`,
      async () => yes(existsSync(legacyDir)),
      async () => {
        await clearEmpty(newDir);
        const tracked = await io.probe.run("git", [
          "-C",
          root,
          "ls-files",
          "--",
          LEGACY.home,
        ]);
        if (tracked.exitCode === 0 && tracked.stdout.trim() !== "") {
          const moved = await io.probe.run("git", [
            "-C",
            root,
            "mv",
            "--",
            LEGACY.home,
            ".donn",
          ]);
          if (moved.exitCode !== 0) {
            throw new CliError(
              "migrate-git-mv",
              `git mv ${LEGACY.home} .donn failed: ${moved.stderr.trim() || `exit code ${moved.exitCode}`}`,
              { root },
            );
          }
          return {
            notes: [`git mv ${LEGACY.home} .donn (staged, not committed)`],
          };
        }
        await rename(legacyDir, newDir);
      },
    ),
    await step(
      "project-api-version",
      `rewrite the project persona's apiVersion to ${API_VERSION}`,
      () => changes(join(liveDir(), "persona.yaml"), rewriteApiVersion),
      () => rewriteFile(join(liveDir(), "persona.yaml")),
    ),
    await step(
      "project-markers",
      "rename the AGENTS.md block markers to donn",
      () => changes(agents, rewriteMarkers),
      () => rewriteMarkersIn(agents, root),
    ),
  ];
  const results = await runMigration(io, steps, {
    ...options,
    header: `migrate ${legacyDir} to ${newDir}:`,
  });
  const gitignore = await gitignoreLines(root);
  return {
    start,
    root,
    ...(results !== undefined && { results }),
    ...(gitignore.length > 0 && { gitignore }),
  };
}

/**
 * `sudo donn migrate --managed`: remove the old policy's files, with managed uninstall's rules.
 * A file the donn install owns now (managed-mcp.json is in both layouts) is kept.
 */
export async function migrateManaged(
  io: CliIo,
  options: RunOptions,
): Promise<{ root: string; removed?: string[]; kept?: string[] }> {
  const env = managedEnv(io);
  needAdmin(env, "migrate --managed");
  const planned = await planUninstall(env, LEGACY_LAYOUT);
  if (planned === undefined) return { root: env.root, removed: [] };
  const owned = new Set([
    ...Object.keys((await readInstalled(env.root))?.files ?? {}),
    ...((await readPending(env.root)) ?? []),
  ]);
  const removed = planned.filter((path) => !owned.has(path));
  const kept = planned.filter((path) => owned.has(path));
  const out = options.json ? io.stderr : io.stdout;
  out.write(`remove the old ${LEGACY.name} policy from ${env.root}:\n`);
  for (const path of removed) out.write(`  remove   ${path}\n`);
  for (const path of kept) out.write(`  keep     ${path} (donn's now)\n`);
  if (
    !options.yes &&
    !(await confirmed(
      io,
      env,
      `Remove these from ${env.root}?`,
      "nothing removed",
    ))
  ) {
    return { root: env.root };
  }
  await applyUninstall(env.root, removed, LEGACY_LAYOUT);
  return { root: env.root, removed, ...(kept.length > 0 && { kept }) };
}

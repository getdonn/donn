import { existsSync } from "node:fs";
import { readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  deleteKeychainItem,
  getKeychainItem,
  keychainSupported,
  setKeychainItem,
} from "@getdonn/secrets";
import { API_VERSION } from "@getdonn/spec";
import { normaliseUrl, readIndex } from "@getdonn/store-remote";
import type { CliIo } from "../cli.js";
import { installService } from "../commands/daemon.js";
import { confirmed, needAdmin } from "../commands/managed.js";
import { MOD_ID, registerMod, unregisterMod } from "../commands/mod.js";
import { parse } from "yaml";
import { expandPath, loadConfig } from "../config.js";
import { homeOf } from "../context.js";
import {
  absoluteHome,
  serviceFor,
  serviceManager,
  type ServiceManager,
} from "../daemon/service.js";
import { CliError } from "../errors.js";
import { CLI_ON_PATH_FIX, findOnPath } from "../path.js";
import { managedEnv } from "../managed/env.js";
import {
  applyUninstall,
  planUninstall,
  type ManagedLayout,
} from "../managed/install.js";
import { keychainContext, TOKEN_SERVICE } from "../registry.js";
import { LEGACY } from "./legacy.js";
import {
  clearEmpty,
  dropState,
  findProjectRoot,
  legacyDaemonPid,
  legacyMod,
  moveHome,
  occupied,
  present,
  readProgress,
  regenerable,
  rewriteApiVersion,
  rewriteConfigPaths,
  rewriteFile,
  rewriteMarkers,
  rewriteMarkersIn,
  setAsideOf,
  stagingOf,
  staleFiles,
  stopLegacyDaemon,
  targetExists,
  updateProgress,
  writeThrough,
} from "./steps.js";

// donn migrate: plan the steps from what is on this machine, show them, ask, run them in order.
// Each step knows it is done by its effect, so a re-run or a run after an interruption only does
// what is left. See docs/planning/22-rename-donn.md §3.

export type StepStatus = "pending" | "done";

export interface MigrationStep {
  id: string;
  title: string;
  status: StepStatus;
  /** Do what is left of the step; returns notes for the user. */
  run(): Promise<string[] | void>;
}

export interface StepResult {
  id: string;
  /** `ran` now, or `done` already. */
  status: "ran" | "done";
  notes?: string[];
}

export interface RunOptions {
  yes?: boolean;
  json?: boolean;
  /** The plan's first line; the user-level header by default. */
  header?: string;
  /** Test seam: called after each step; a throw stands for an interruption. */
  afterStep?: (id: string) => void | Promise<void>;
}

/** The user's home folder, the old donn home in it, and where the new one goes. */
function where(io: CliIo) {
  const user = io.env.HOME ?? homedir();
  const src = join(user, LEGACY.home);
  const target = absoluteHome(io, homeOf(io));
  /** The home as it is now: the old one until it has moved. */
  const live = () => (existsSync(src) ? src : target);
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

/** Persona files with the old apiVersion: under the home and the personas folder config names. */
async function personaFiles(
  io: CliIo,
  w: ReturnType<typeof where>,
): Promise<string[]> {
  const home = w.live();
  const files = new Set(await staleFiles(home));
  const text = await readFile(join(home, "config.yaml"), "utf8").catch(
    () => undefined,
  );
  let personas: unknown;
  try {
    // Read with its old-home paths pointing at the home as it is now.
    personas = (
      parse(rewriteConfigPaths(text ?? "", { ...w, target: home })) as {
        personas?: unknown;
      } | null
    )?.personas;
  } catch {
    personas = undefined; // a broken config.yaml: doctor says so afterwards
  }
  if (typeof personas === "string" && personas !== "") {
    for (const file of await staleFiles(expandPath(personas, home, io.env)))
      files.add(file);
  }
  return [...files].sort();
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

/** Accounts with an item under the old keychain service; none when the keychain cannot say. */
async function oldTokens(
  io: CliIo,
  w: ReturnType<typeof where>,
): Promise<string[]> {
  const context = keychainContext(io);
  if (!keychainSupported(context.platform)) return [];
  const found: string[] = [];
  for (const account of await registryAccounts(io, w.live())) {
    const value = await getKeychainItem(
      context,
      LEGACY.keychainService,
      account,
    ).catch(() => undefined);
    if (value !== undefined) found.push(account);
  }
  return found;
}

const status = (pending: boolean): StepStatus => (pending ? "pending" : "done");

/** The user-level migration's seven steps, each `pending` or `done`. Changes nothing. */
export async function planMigration(io: CliIo): Promise<MigrationStep[]> {
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
  if (existsSync(w.src) && (await occupied(w.target))) {
    throw targetExists(w.target);
  }
  const old = legacyService(io);
  const oldInstalled = async () =>
    old !== undefined && (existsSync(old.path) || (await old.loaded()));
  const oldDaemon = async () =>
    existsSync(w.src) && (await legacyDaemonPid(w.src)) !== undefined;

  const steps: MigrationStep[] = [
    {
      id: "service-stop",
      title: `stop and remove the old background service (${old?.label ?? "none"})`,
      status: status((await oldInstalled()) || (await oldDaemon())),
      run: async () => {
        if (await oldInstalled()) {
          // Step 7 installs the new service only if this one was installed: remember it.
          await updateProgress(w.live(), { service: true });
          await old!.uninstall();
        }
        if (existsSync(w.src)) await stopLegacyDaemon(w.src);
      },
    },
    {
      id: "move-home",
      title: `move ~/${LEGACY.home} to ${w.target}`,
      status: status(
        existsSync(w.src) ||
          (await present(setAsideOf(w.src))) ||
          (await present(stagingOf(w.target))),
      ),
      run: async () => {
        // The old home's regenerable state moves with it, marked for step 3: a donn daemon
        // that runs later makes the same files, and those must stay.
        if (existsSync(w.src) && (await regenerable(w.src)).length > 0)
          await updateProgress(w.src, { state: true });
        await moveHome(w.src, w.target);
      },
    },
    {
      id: "drop-state",
      title:
        "drop build/, sessions/ and the daemon's socket files (made again)",
      status: status(
        (existsSync(w.src) && (await regenerable(w.src)).length > 0) ||
          (await readProgress(w.live())).state === true,
      ),
      run: async () => {
        await dropState(w.live());
        await updateProgress(w.live(), { state: false });
      },
    },
    {
      id: "api-version",
      title: `rewrite apiVersion ${LEGACY.apiVersion} to ${API_VERSION}; update config.yaml paths`,
      status: status(
        (await configRewrite(w)) !== undefined ||
          (await personaFiles(io, w)).length > 0,
      ),
      run: async () => {
        const config = await configRewrite(w);
        if (config !== undefined) await writeThrough(config.file, config.text);
        for (const file of await personaFiles(io, w)) await rewriteFile(file);
      },
    },
    {
      id: "keychain",
      title: `move the registry token from ${LEGACY.keychainService} to ${TOKEN_SERVICE} in the keychain`,
      status: status((await oldTokens(io, w)).length > 0),
      run: async () => {
        const context = keychainContext(io);
        for (const account of await oldTokens(io, w)) {
          const value = await getKeychainItem(
            context,
            LEGACY.keychainService,
            account,
          );
          if (value === undefined) continue;
          // A token stored under the new name already is a newer sign-in: it stays.
          const current = await getKeychainItem(
            context,
            TOKEN_SERVICE,
            account,
          );
          if (current === undefined) {
            await setKeychainItem(context, TOKEN_SERVICE, account, value);
            if (
              (await getKeychainItem(context, TOKEN_SERVICE, account)) !== value
            ) {
              throw new CliError(
                "migrate-keychain",
                `the token for ${account} did not read back from ${TOKEN_SERVICE}; the old item is kept`,
                { account },
              );
            }
          }
          await deleteKeychainItem(context, LEGACY.keychainService, account);
        }
      },
    },
    {
      id: "mod",
      title: `replace the Claude Code mod (${LEGACY.plugin} with ${MOD_ID})`,
      status: status(
        (await readProgress(w.live())).mod === true ||
          (await legacyMod(w.live())),
      ),
      run: async () => {
        const home = w.live();
        await updateProgress(home, { mod: true });
        const { missing } = await unregisterMod(io, {
          plugin: LEGACY.plugin,
          marketplace: LEGACY.marketplace,
        });
        let notes: string[];
        if (missing) {
          await rm(join(home, "mod"), { recursive: true, force: true });
          notes = ["claude is not installed; run donn mod install once it is"];
        } else {
          notes = (await registerMod(io)).warnings;
        }
        await updateProgress(home, { mod: false });
        return notes;
      },
    },
    {
      id: "service-start",
      title: "install and start the new background service",
      // Pending while the old service is installed (step 1 has yet to run) or step 1 removed it.
      status: status(
        (await oldInstalled()) ||
          (await readProgress(w.live())).service === true,
      ),
      run: async () => {
        if (!(await serviceFor(io, w.target))) await installService(io);
        await updateProgress(w.live(), { service: false });
      },
    },
  ];
  // Step 7 runs donn from PATH; refuse now rather than stop half way.
  const start = steps.find((step) => step.id === "service-start")!;
  if (start.status === "pending" && !findOnPath("donn", io.env)) {
    throw new CliError(
      "cli-not-on-path",
      `donn is not on PATH, so the new background service cannot run it; ${CLI_ON_PATH_FIX}`,
    );
  }
  return steps;
}

const planLine = (status: string, id: string, title: string) =>
  `  ${status.padEnd(9)}${id.padEnd(15)}${title}\n`;

/**
 * Show the plan, ask (unless `yes`), then run the pending steps in order. Undefined when the
 * user declined; nothing has changed then. A plan with nothing pending is not shown or asked.
 */
export async function runMigration(
  io: CliIo,
  steps: MigrationStep[],
  options: RunOptions,
): Promise<StepResult[] | undefined> {
  if (steps.every((step) => step.status === "done")) {
    return steps.map(({ id }) => ({ id, status: "done" }));
  }
  const out = options.json ? io.stderr : io.stdout;
  out.write(`${options.header ?? userHeader(io)}\n`);
  for (const step of steps)
    out.write(planLine(step.status, step.id, step.title));
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
  for (const step of steps) {
    if (step.status === "pending") {
      const notes = (await step.run()) ?? [];
      out.write(`  ${"ran".padEnd(9)}${step.id}\n`);
      for (const note of notes) out.write(`${" ".repeat(11)}note: ${note}\n`);
      results.push({
        id: step.id,
        status: "ran",
        ...(notes.length > 0 && { notes }),
      });
    } else {
      results.push({ id: step.id, status: "done" });
    }
    await options.afterStep?.(step.id);
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

/** `donn migrate --project`: the project at or above `dir`, its steps planned and run. */
export async function migrateProject(
  io: CliIo,
  dir: string | undefined,
  options: RunOptions,
): Promise<{ start: string; root?: string; results?: StepResult[] }> {
  const start = resolve(io.cwd, dir ?? ".");
  const root = await findProjectRoot(start, resolve(io.env.HOME ?? homedir()));
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
    return rewrite(text) !== text;
  };
  const steps: MigrationStep[] = [
    {
      id: "project-folder",
      title: `move ${LEGACY.home}/ to .donn/ (git mv when tracked)`,
      status: status(existsSync(legacyDir)),
      run: async () => {
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
          return [`git mv ${LEGACY.home} .donn (staged, not committed)`];
        }
        await rename(legacyDir, newDir);
      },
    },
    {
      id: "project-api-version",
      title: `rewrite the project persona's apiVersion to ${API_VERSION}`,
      status: status(
        await changes(join(liveDir(), "persona.yaml"), rewriteApiVersion),
      ),
      run: () => rewriteFile(join(liveDir(), "persona.yaml")),
    },
    {
      id: "project-markers",
      title: `rename the AGENTS.md block markers to donn`,
      status: status(await changes(agents, rewriteMarkers)),
      run: () => rewriteMarkersIn(agents, root),
    },
  ];
  const results = await runMigration(io, steps, {
    ...options,
    header: `migrate ${legacyDir} to ${newDir}:`,
  });
  return { start, root, ...(results !== undefined && { results }) };
}

/** `sudo donn migrate --managed`: remove the old policy's files, with managed uninstall's rules. */
export async function migrateManaged(
  io: CliIo,
  options: RunOptions,
): Promise<{ root: string; removed?: string[] }> {
  const env = managedEnv(io);
  needAdmin(env, "migrate --managed");
  const removed = await planUninstall(env, LEGACY_LAYOUT);
  if (removed === undefined) return { root: env.root, removed: [] };
  const out = options.json ? io.stderr : io.stdout;
  out.write(`remove the old ${LEGACY.name} policy from ${env.root}:\n`);
  for (const path of removed) out.write(`  remove   ${path}\n`);
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
  return { root: env.root, removed };
}

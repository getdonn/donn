import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolve, ResolveError } from "@zzpersona/resolver";
import type { ResolveResult } from "@zzpersona/spec";
import {
  createLocalStore,
  findProject,
  type LocalStore,
} from "@zzpersona/store-local";
import { normaliseUrl, readIndex, withRegistry } from "@zzpersona/store-remote";
import type { CliIo } from "./cli.js";
import { loadConfig, type Config } from "./config.js";
import { CliError } from "./errors.js";
import type { Selection } from "./select.js";
import { readState, type State } from "./state.js";

export interface Context {
  home: string;
  /** The project's .zzpersona directory, when inside a project. */
  projectDir?: string;
  /** Local layers, with the registry cache in front when one is configured and pulled. */
  store: LocalStore;
  /** The local folders alone. */
  local: LocalStore;
  state: State;
  config: Config;
}

/** ZZPERSONA_HOME, or ~/.zzpersona. An empty ZZPERSONA_HOME counts as unset. */
export function homeOf(io: CliIo): string {
  return io.env.ZZPERSONA_HOME || join(io.env.HOME ?? homedir(), ".zzpersona");
}

export async function createContext(
  io: CliIo,
  options: { local?: boolean } = {},
): Promise<Context> {
  const home = homeOf(io);
  const config = await loadConfig(home, io.env);
  const projectDir = findProject(io.cwd);
  const local = createLocalStore({
    user: home,
    ...(config.personas !== undefined && { personas: config.personas }),
    ...(projectDir !== undefined && { project: projectDir }),
  });
  let store: LocalStore = local;
  if (config.registry !== undefined && !options.local) {
    const index = await readIndex(home);
    let url: string | undefined;
    try {
      url = normaliseUrl(config.registry.url);
    } catch {
      // A bad URL in config.yaml shows up in doctor; layers just stay local.
    }
    if (index !== undefined && index.url === url) {
      store = withRegistry(local, home, index, (ref, version) =>
        io.stderr.write(
          `${ref}: using published @${version}; local copy differs\n`,
        ),
      );
    }
  }
  for (const dir of await local.strayLayerDirs()) {
    io.stderr.write(
      `warning: ${dir} is ignored: project/ and user/ layers are mounted elsewhere\n`,
    );
  }
  const state = await readState(home);
  return {
    home,
    store,
    local,
    state,
    config,
    ...(projectDir !== undefined && { projectDir }),
  };
}

/**
 * Resolve with the user overlay when it exists and `overlay` is on. A persona that came from
 * state.json and no longer exists gets a hint to clear the stale switch.
 */
export async function resolvePersona(
  ctx: Context,
  selection: Selection,
  overlay: boolean,
): Promise<ResolveResult> {
  const overlayFile = ctx.store.locate("user/overrides.yaml")!.path;
  const useOverlay = overlay && existsSync(overlayFile);
  try {
    return await resolve(selection.ref, {
      source: ctx.store,
      ...(useOverlay && { overlay: "user/overrides" }),
    });
  } catch (error) {
    const fromState =
      selection.source === "switch" || selection.source === "default";
    if (
      fromState &&
      error instanceof ResolveError &&
      error.code === "missing-ref" &&
      error.details.ref === selection.ref
    ) {
      throw new CliError(
        "stale-switch",
        `${selection.ref} (set by zzpersona switch) no longer exists; run \`zzpersona switch --clear${selection.source === "default" ? " --default" : ""}\` to remove it`,
        { ref: selection.ref, source: selection.source },
      );
    }
    throw error;
  }
}

export function printWarnings(io: CliIo, result: ResolveResult): void {
  for (const w of result.warnings) {
    io.stderr.write(`warning: ${w.code} ${w.path} (from ${w.layer})\n`);
  }
}

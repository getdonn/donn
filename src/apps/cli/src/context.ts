import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolve } from "@zzpersona/resolver";
import type { Ref, ResolveResult } from "@zzpersona/spec";
import {
  createLocalStore,
  findProject,
  type LocalStore,
} from "@zzpersona/store-local";
import type { CliIo } from "./cli.js";
import { loadConfig } from "./config.js";

export interface Context {
  home: string;
  /** The project's .zzpersona directory, when inside a project. */
  projectDir?: string;
  store: LocalStore;
}

export async function createContext(io: CliIo): Promise<Context> {
  const home =
    io.env.ZZPERSONA_HOME || join(io.env.HOME ?? homedir(), ".zzpersona");
  const config = await loadConfig(home, io.env);
  const projectDir = findProject(io.cwd);
  const store = createLocalStore({
    user: home,
    ...(config.personas !== undefined && { personas: config.personas }),
    ...(projectDir !== undefined && { project: projectDir }),
  });
  for (const dir of await store.strayLayerDirs()) {
    io.stderr.write(
      `warning: ${dir} is ignored: project/ and user/ layers are mounted elsewhere\n`,
    );
  }
  return { home, store, ...(projectDir !== undefined && { projectDir }) };
}

/** Resolve with the user overlay when it exists and `overlay` is on. */
export function resolvePersona(
  ctx: Context,
  ref: Ref,
  overlay: boolean,
): Promise<ResolveResult> {
  const overlayFile = ctx.store.locate("user/overrides.yaml")!.path;
  const useOverlay = overlay && existsSync(overlayFile);
  return resolve(ref, {
    source: ctx.store,
    ...(useOverlay && { overlay: "user/overrides" }),
  });
}

export function printWarnings(io: CliIo, result: ResolveResult): void {
  for (const w of result.warnings) {
    io.stderr.write(`warning: ${w.code} ${w.path} (from ${w.layer})\n`);
  }
}

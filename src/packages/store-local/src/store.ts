import { existsSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { PersonaSource } from "@zzpersona/resolver";
import type { Ref } from "@zzpersona/spec";
import { parse, YAMLParseError } from "yaml";

// Three locations mounted onto the resolver's one virtual root, by layer (the first path
// segment). See docs/planning/06-cli-core-loop.md, section 1.

export interface Mounts {
  /** The personas folder: org/, area/, team/ live here. */
  personas?: string;
  /** The project's .zzpersona directory, when inside a project. */
  project?: string;
  /** ~/.zzpersona: user personas under personas/, the overlay at overrides.yaml. */
  user: string;
}

export interface LocalStore extends PersonaSource {
  /** The physical path of a virtual path, and the mount root containment is checked against. */
  locate(virtualPath: string): { path: string; root: string } | undefined;
  readText(virtualPath: string): Promise<string>;
  list(): Promise<Ref[]>;
  /** project/ or user/ folders inside the personas folder, which are ignored. */
  strayLayerDirs(): Promise<string[]>;
}

export class StoreError extends Error {
  override name = "StoreError";
  file?: string;
  line?: number;
  configKey?: string;
}

const SHARED_LAYERS = ["org", "area", "team"];
const MOUNTED_ELSEWHERE = ["project", "user"];

const storeError = (message: string, fields: Partial<StoreError> = {}) =>
  Object.assign(new StoreError(message), fields);

const isMissing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

/** .yaml files under `dir`, following file symlinks (as load() does). */
async function yamlFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const files: string[] = [];
  for (const e of entries) {
    if (!e.name.endsWith(".yaml")) continue;
    const path = join(e.parentPath, e.name);
    if (
      e.isFile() ||
      (e.isSymbolicLink() &&
        (await stat(path).catch(() => undefined))?.isFile())
    ) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Only persona files count: data files inside skills and overlays are not personas. A file
 * that does not parse is kept, so selecting it reaches load() and reports the parse error.
 */
async function isPersonaFile(path: string): Promise<boolean> {
  try {
    const doc = parse(await readFile(path, "utf8")) as {
      kind?: unknown;
    } | null;
    return doc?.kind === "Persona";
  } catch {
    return true;
  }
}

const toRef = (base: string, file: string, prefix = "") =>
  `${prefix}${relative(base, file).split(sep).join("/")}`.replace(
    /\.yaml$/,
    "",
  );

export function createLocalStore(mounts: Mounts): LocalStore {
  const locate = (virtualPath: string) => {
    const [layer = "", ...rest] = virtualPath.split("/");
    const tail = rest.join("/");
    if (SHARED_LAYERS.includes(layer)) {
      return mounts.personas === undefined
        ? undefined
        : { path: join(mounts.personas, virtualPath), root: mounts.personas };
    }
    if (layer === "project") {
      return mounts.project === undefined
        ? undefined
        : { path: join(mounts.project, tail), root: mounts.project };
    }
    if (layer === "user") {
      if (tail === "overrides.yaml") {
        return { path: join(mounts.user, tail), root: mounts.user };
      }
      const root = join(mounts.user, "personas");
      return { path: join(root, tail), root };
    }
    return undefined;
  };

  /** A configured personas folder must exist; a typo'd path must not look like "no personas". */
  const assertPersonasFolder = () => {
    if (mounts.personas !== undefined && !existsSync(mounts.personas)) {
      throw storeError(
        `the configured personas folder ${mounts.personas} does not exist`,
        { configKey: "personas", file: mounts.personas },
      );
    }
  };

  /** org/area/team need a configured personas folder that exists. */
  const requirePersonas = (ref: string) => {
    if (!SHARED_LAYERS.includes(ref.split("/")[0] ?? "")) return;
    if (mounts.personas === undefined) {
      throw storeError(
        `${ref} needs a personas folder: set "personas" in config.yaml`,
        { configKey: "personas" },
      );
    }
    assertPersonasFolder();
  };

  return {
    locate,

    async load(ref) {
      requirePersonas(ref);
      const location = locate(`${ref}.yaml`);
      if (location === undefined) return undefined;
      let text: string;
      try {
        text = await readFile(location.path, "utf8");
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
      try {
        return parse(text) as unknown;
      } catch (error) {
        if (!(error instanceof YAMLParseError)) throw error;
        const line = error.linePos?.[0].line;
        throw storeError(
          `invalid YAML in ${location.path}${line ? ` at line ${line}` : ""}: ${error.message}`,
          { file: location.path, ...(line !== undefined && { line }) },
        );
      }
    },

    async readText(virtualPath) {
      const location = locate(virtualPath);
      if (location === undefined) {
        throw storeError(
          `${virtualPath} is not inside any configured location`,
        );
      }
      try {
        const [real, realRoot] = await Promise.all([
          realpath(location.path),
          realpath(location.root),
        ]);
        if (real !== realRoot && !real.startsWith(realRoot + sep)) {
          throw storeError(
            `${virtualPath} resolves outside its location (${real} is outside ${realRoot})`,
            { file: location.path },
          );
        }
        return await readFile(location.path, "utf8");
      } catch (error) {
        if (error instanceof StoreError || !isMissing(error)) throw error;
        throw storeError(`${virtualPath} not found at ${location.path}`, {
          file: location.path,
        });
      }
    },

    async list() {
      assertPersonasFolder();
      const refs: string[] = [];
      if (mounts.personas !== undefined) {
        for (const layer of SHARED_LAYERS) {
          for (const file of await yamlFiles(join(mounts.personas, layer))) {
            if (await isPersonaFile(file))
              refs.push(toRef(mounts.personas, file));
          }
        }
      }
      const userRoot = join(mounts.user, "personas");
      for (const file of await yamlFiles(userRoot)) {
        if (await isPersonaFile(file))
          refs.push(toRef(userRoot, file, "user/"));
      }
      if (mounts.project && existsSync(join(mounts.project, "persona.yaml"))) {
        refs.push("project/persona");
      }
      return refs.sort();
    },

    async strayLayerDirs() {
      const personas = mounts.personas;
      if (personas === undefined) return [];
      return MOUNTED_ELSEWHERE.map((layer) => join(personas, layer)).filter(
        (dir) => existsSync(dir),
      );
    },
  };
}

/** The nearest project's .zzpersona directory, walking up from `cwd`. */
export function findProject(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, ".zzpersona");
    if (existsSync(join(candidate, "persona.yaml"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

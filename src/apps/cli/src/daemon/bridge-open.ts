import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
  sep,
} from "node:path";
import { z } from "zod";
import { listCreated } from "../agent/registry.js";
import { loadConfig } from "../config.js";
import { writeFileAtomic } from "../fs.js";
import { listSessions } from "../session.js";
import { passwdHome, userHomeDir } from "../userhome.js";
import { failure } from "./http.js";
import type { runInProcess } from "./run.js";

// The bridge's paths: the projects it knows (`cwd` and `GET|POST /v1/projects`) and the files
// `POST /v1/open` opens. A path is judged by where its symlinks lead. Opening never runs what it
// opens: `$VISUAL` gets the path as the user chose; without it the OS opener is told to treat a
// file as text (macOS `open -t`) or reveal a folder (`open -R`), and on Linux `xdg-open` is
// refused executables and `.desktop` files. See docs/planning/26-gui.md §2.

/** A status and JSON body for the bridge to answer with. */
export interface Answer {
  status: number;
  body: unknown;
}

/**
 * Starts `command` with `args` detached, never through a shell; settles once it has started,
 * or rejects when it cannot start.
 */
export type Opener = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<void>;

/** The default Opener: node:child_process, stdio ignored, not waited for. */
export const nodeOpener: Opener = (command, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      env,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

/** `~/.donn/ui.json`: the projects the user picked in the app. */
const UiFile = z.object({ projects: z.array(z.string()) });

/** A path with symlinks resolved, through its nearest existing ancestor when it does not exist. */
export async function real(path: string): Promise<string> {
  const absolute = resolve(path);
  const rest: string[] = [];
  for (let dir = absolute; ; dir = dirname(dir)) {
    const found = await realpath(dir).catch(() => undefined);
    if (found !== undefined) return join(found, ...rest.reverse());
    if (dirname(dir) === dir) return absolute;
    rest.push(basename(dir));
  }
}

export const under = (path: string, dir: string) =>
  path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);

/** Projects the daemon knows (running sessions', created agents') and the UI picked. */
export async function knownProjects(home: string): Promise<Set<string>> {
  const sessions = (await listSessions(home))
    .filter((s) => s.running)
    .flatMap((s) =>
      s.launched.project === undefined ? [] : [s.launched.project],
    );
  const created = (await listCreated(home).catch(() => [])).map(
    (c) => c.project,
  );
  const picked = await readFile(join(home, "ui.json"), "utf8")
    .then((text) => UiFile.parse(JSON.parse(text)).projects)
    .catch(() => [] as string[]);
  const all = [...sessions, ...created, ...picked].filter((p) => isAbsolute(p));
  return new Set(await Promise.all(all.map(real)));
}

/** `{ path }` (`/v1/open`, `/v1/projects`): an absolute path and nothing else, or why not. */
function pathRequest(text: string): string | { path: string } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return "the body is not JSON";
  }
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return "the body must be { path }";
  const { path, ...rest } = body as { path?: unknown };
  if (Object.keys(rest).length > 0) return "the body must be only { path }";
  // Absolute, so it can never read as an option to the editor.
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))
    return "path must be an absolute path";
  return { path };
}

type Io = Parameters<typeof runInProcess>[0];

/** The folders `/v1/open` opens inside (and the overlay file): personas roots, known projects, created agents'. */
async function openRoots(home: string, io: Io): Promise<string[]> {
  // A config that cannot be read names no personas root: fewer roots, never more.
  const config = await loadConfig(home, io.env, io.passwdHome).catch(
    () => ({}) as { personas?: string },
  );
  const agents = (await listCreated(home).catch(() => [])).flatMap((c) =>
    c.path === undefined ? [] : [resolve(c.project, c.path)],
  );
  const roots = [
    ...(config.personas === undefined ? [] : [config.personas]),
    join(home, "personas"),
    // The user overlay layer: one file, not the home around it.
    join(home, "overrides.yaml"),
    ...agents,
  ];
  return [
    ...(await Promise.all(roots.map(real))),
    ...(await knownProjects(home)),
  ];
}

/** `ui.json` as written, for an update that keeps what it does not know. */
async function readUiFile(home: string): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(
      await readFile(join(home, "ui.json"), "utf8"),
    ) as unknown;
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw))
      return raw as Record<string, unknown>;
  } catch {
    // Missing or not JSON: started afresh, as knownProjects reads it.
  }
  return {};
}

const notOpenable = (path: string, why: string): Answer => ({
  status: 403,
  body: failure("not-openable", `${why}: ${path}`, {
    path,
    fix: "set $VISUAL to your editor",
  }),
});

/**
 * The command that opens `target`: `$VISUAL` (split on whitespace) with the path last; else the
 * OS opener in a form that shows rather than runs: on macOS `open -t` (a file, in the default
 * text editor; never an app, a `.command` or a `.webloc`) or `open -R` (a folder, an `.app`
 * bundle included, revealed in Finder); elsewhere `xdg-open`, refused an executable file or a
 * `.desktop` entry. `$EDITOR` is not used: the daemon has no terminal to give a terminal editor.
 */
function openCommand(
  path: string,
  target: string,
  info: Stats,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): { command: string; args: string[] } | Answer {
  if (!info.isFile() && !info.isDirectory())
    return notOpenable(path, "not a file or a folder");
  const [visual, ...flags] = (env.VISUAL ?? "").split(/\s+/).filter(Boolean);
  if (visual !== undefined)
    return { command: visual, args: [...flags, target] };
  if (platform === "darwin") {
    return {
      command: "open",
      args: [info.isDirectory() ? "-R" : "-t", target],
    };
  }
  if (info.isFile() && (info.mode & 0o111) !== 0)
    return notOpenable(path, "an executable file the OS opener could run");
  if (info.isFile() && extname(target).toLowerCase() === ".desktop")
    return notOpenable(path, "a .desktop entry the OS opener would launch");
  return { command: "xdg-open", args: [target] };
}

export interface OpenRoutesOptions {
  home: string;
  io: Io;
  opener?: Opener;
  /** The OS whose opener is used without `$VISUAL`; this one's. */
  platform?: NodeJS.Platform;
  log?: (line: string) => unknown;
}

/** `POST /v1/open` and `GET|POST /v1/projects`, given each request's body text. */
export function openRoutes(options: OpenRoutesOptions) {
  const { home, io } = options;

  const listProjects = async () => [...(await knownProjects(home))].sort();

  /** One `ui.json` update at a time: concurrent picks must not lose one. */
  let picking: Promise<unknown> = Promise.resolve();

  return {
    listProjects,

    async open(text: string): Promise<Answer> {
      const body = pathRequest(text);
      if (typeof body === "string")
        return { status: 400, body: failure("bad-request", body) };
      // Contained first, by where its symlinks lead: whether a path outside exists stays unsaid.
      const target = await real(body.path);
      const roots = await openRoots(home, io);
      if (!roots.some((root) => under(target, root))) {
        return {
          status: 403,
          body: failure(
            "outside-roots",
            `not inside a personas root or a project: ${body.path}`,
            {
              path: body.path,
              fix: "open a file of a persona, a project or an agent",
            },
          ),
        };
      }
      const info = await stat(target).catch(() => undefined);
      if (info === undefined) {
        return {
          status: 404,
          body: failure("not-found", `no such file: ${body.path}`, {
            path: body.path,
          }),
        };
      }
      const how = openCommand(
        body.path,
        target,
        info,
        io.env,
        options.platform ?? process.platform,
      );
      if ("status" in how) return how;
      try {
        await (options.opener ?? nodeOpener)(how.command, how.args, io.env);
      } catch (error) {
        return {
          status: 500,
          body: failure(
            "open-failed",
            `could not start ${how.command}: ${String(error)}`,
            {
              command: how.command,
              fix: "set $VISUAL to an editor on PATH",
            },
          ),
        };
      }
      void options.log?.(`ui opened ${target} with ${how.command}`);
      return { status: 200, body: { opened: target } };
    },

    async addProject(text: string): Promise<Answer> {
      const body = pathRequest(text);
      if (typeof body === "string")
        return { status: 400, body: failure("bad-request", body) };
      const dir = await realpath(body.path).catch(() => undefined);
      // A project is a repository, not a folder holding everything: every path would be known.
      const broad = await Promise.all(
        [
          "/",
          userHomeDir(io.env, io.passwdHome),
          (io.passwdHome ?? passwdHome)(),
          home,
        ]
          .flatMap((p) => (p ? [resolve(p)] : []))
          .flatMap((p) => [p, real(p)]),
      );
      if (broad.includes(resolve(body.path)) || (dir && broad.includes(dir))) {
        return {
          status: 400,
          body: failure(
            "too-broad",
            `not a project folder: ${body.path} holds too much`,
            { path: body.path, fix: "pick the repository folder" },
          ),
        };
      }
      const persona =
        dir === undefined
          ? undefined
          : await stat(join(dir, ".donn", "persona.yaml")).catch(
              () => undefined,
            );
      if (dir === undefined || !persona?.isFile()) {
        return {
          status: 400,
          body: failure(
            "not-a-project",
            `not a donn project (no .donn/persona.yaml): ${body.path}`,
            { path: body.path, fix: "donn init --extends <persona>" },
          ),
        };
      }
      const update = picking.then(async () => {
        const file = await readUiFile(home);
        const projects = Array.isArray(file.projects)
          ? file.projects.filter((p): p is string => typeof p === "string")
          : [];
        if (projects.includes(dir)) return;
        await writeFileAtomic(
          join(home, "ui.json"),
          `${JSON.stringify({ ...file, projects: [...projects, dir] }, null, 2)}\n`,
        );
      });
      picking = update.catch(() => undefined);
      await update;
      return {
        status: 200,
        body: { path: dir, projects: await listProjects() },
      };
    },
  };
}

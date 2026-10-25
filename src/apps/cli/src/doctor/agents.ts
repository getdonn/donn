import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { setTimeout as sleepFor } from "node:timers/promises";
import adapter, { patchAgentTs } from "@getdonn/adapter-eve";
import { satisfiesRange } from "@getdonn/adapter-sdk";
import type { ResolveResult } from "@getdonn/spec";
import type { CliIo } from "../cli.js";
import { CliError, errorText } from "../errors.js";
import { packageManager } from "../agent/eve.js";
import { nodeSpawn } from "../agent/spawn.js";
import { posixRelative, type Manifest } from "../agent/files.js";
import { locateAgent, projectContext, resolveProject } from "../agent/load.js";
import { listCreated, type CreatedAgent } from "../agent/registry.js";
import { shellWord } from "../migrate/steps.js";

// `donn doctor`'s lines per created agent (`~/.donn/agents/index.json`), after `secrets`. The
// agent's own files being wrong is an error (eve pin, agent.ts, the manifest's files, the vercel
// dev dependency); a tool or service it needs only to run or deploy being unavailable is a
// warning (Docker, the gateway, the Vercel CLI), as is an agent its persona no longer declares.
// See docs/planning/25-agent-runner.md, section 7.

type Status = "ok" | "warn" | "error" | "skipped";
type Add = (id: string, status: Status, message: string, fix?: string) => void;

const GATEWAY_TIMEOUT_MS = 3000;
const TOOL_TIMEOUT_MS = 10_000;
const SPREAD_FIX =
  'add `import { donn } from "./lib/donn/config";` to agent/agent.ts and put `...donn` as the last property of its defineAgent({...}) call, removing any `model` property';

const lastLine = (text: string) => text.trim().split("\n").at(-1)?.trim();

export async function agentChecks(
  io: CliIo,
  home: string,
  add: Add,
): Promise<void> {
  let created: CreatedAgent[];
  try {
    created = await listCreated(home);
  } catch (error) {
    const index = join(home, "agents", "index.json");
    const fix =
      error instanceof CliError && error.details.fix !== undefined
        ? String(error.details.fix)
        : `fix the permissions on ${index}, or remove it; donn agent create records each agent again`;
    add(
      "agents",
      "error",
      error instanceof CliError
        ? error.message
        : `${index}: ${errorText(error)}`,
      fix,
    );
    return;
  }
  if (created.length === 0) return;

  const quiet: CliIo = { ...io, stderr: { write: () => true } };
  const projects = new Map<string, Promise<Project>>();
  const project = (root: string) => {
    let found = projects.get(root);
    if (found === undefined) {
      found = loadProject(quiet, root);
      projects.set(root, found);
    }
    return found;
  };
  let docker: Promise<{ ok: boolean; text: string }> | undefined;
  const gateways = new Map<string, Promise<string | undefined>>();

  for (const entry of created) {
    const { name } = entry;
    const id = (check: string) => `agent:${name}:${check}`;
    const where = ` --project ${shellWord(entry.project)}`;
    const shownPath = entry.path ?? `agents/${name}`;
    const found = await project(entry.project);
    if (found.kind === "failed") {
      for (const check of ["eve", "gateway", "agent-ts", "files"])
        add(
          id(check),
          "skipped",
          `the project persona in ${entry.project} does not resolve: ${found.reason}`,
        );
      continue;
    }
    const agent =
      found.kind === "ok" ? found.result.ir.agents[name] : undefined;
    if (found.kind === "gone" || agent === undefined) {
      const dir = resolvePath(entry.project, shownPath);
      add(
        id("orphan"),
        "warn",
        found.kind === "gone"
          ? `${name} was created in ${entry.project}, which no longer has a project persona`
          : `${name} in ${entry.project} is no longer declared by its project persona`,
        `remove ${shellWord(dir)} and ${name}'s entry in ${join(home, "agents", "index.json")}, or declare agents.define.${name} again`,
      );
      continue;
    }
    // A manifest that does not parse, or a folder that cannot be read, is this agent's files
    // line; the other agents and checks go on.
    let located: Awaited<ReturnType<typeof locateAgent>>;
    try {
      located = await locateAgent(found.ctx, entry.project, name, agent);
    } catch (error) {
      const at = shellWord(resolvePath(entry.project, agent.path));
      add(
        id("files"),
        "error",
        errorText(error),
        `repair ${at}/.donn/agent.json (donn agent create ${name} --force replaces only an incomplete create), or move ${at} aside and run donn agent create ${name}${where}`,
      );
      continue;
    }
    const { dir, manifest } = located;
    const shown = posixRelative(entry.project, dir);
    const complete = manifest?.state === "complete" ? manifest : undefined;
    const notCreated = manifest
      ? `${shown} holds an incomplete create`
      : `nothing at ${shown}`;
    const pkg = complete
      ? await readPackage(dir).catch(() => undefined)
      : undefined;
    const pm = complete ? await packageManager(dir) : "pnpm";

    // eve: the version package.json pins, inside the range this donn compiles for.
    if (!complete) add(id("eve"), "skipped", notCreated);
    else {
      const pinned = pkg?.dependencies?.eve ?? pkg?.devDependencies?.eve;
      const range = adapter.frameworkRange;
      if (pinned === undefined) {
        add(
          id("eve"),
          "error",
          `${shown}/package.json pins no eve`,
          `set eve to a version in ${range} in ${shown}/package.json, then ${pm} install in ${shown}`,
        );
      } else if (!satisfiesRange(pinned, range)) {
        add(
          id("eve"),
          "error",
          `eve ${pinned} is outside the range this donn compiles for (${range})`,
          `set eve to a version in ${range} in ${shown}/package.json, then ${pm} install in ${shown}`,
        );
      } else add(id("eve"), "ok", `eve ${pinned} (in ${range})`);
    }

    // docker: the local run's sandbox, and self-host's build, use the Docker daemon.
    if (agent.target === "local" || agent.target === "self-host") {
      docker ??= io.probe
        .run("docker", ["info", "--format", "{{.ServerVersion}}"])
        .then((r) => ({
          ok: r.exitCode === 0,
          text:
            r.exitCode === 0
              ? (lastLine(r.stdout) ?? "")
              : (lastLine(r.stderr) ?? `docker exited ${r.exitCode}`),
        }));
      const reached = await docker;
      if (reached.ok)
        add(id("docker"), "ok", `Docker ${reached.text} reachable`.trim());
      else
        add(
          id("docker"),
          "warn",
          `Docker is not reachable (${reached.text}); ${agent.target === "local" ? "donn agent run opens its sandbox there" : "donn agent build prepares its sandbox image there"}`,
          "start Docker (Docker Desktop, colima or dockerd), or point DOCKER_HOST at a daemon",
        );
    }

    // gateway: its baseURL answers an HTTP request; any status is an answer.
    const gateway = found.result.ir.models.gateway;
    if (gateway === undefined)
      add(id("gateway"), "skipped", "the persona has no models.gateway");
    else if (gateway.baseURL === undefined)
      add(
        id("gateway"),
        "skipped",
        `${gateway.type} is addressed by name; nothing to reach`,
      );
    else {
      const url = gateway.baseURL;
      let asked = gateways.get(url);
      if (asked === undefined) {
        asked = reach(io, url);
        gateways.set(url, asked);
      }
      const answer = await asked;
      if (answer === undefined) add(id("gateway"), "ok", `${url} answers`);
      else
        add(
          id("gateway"),
          "warn",
          `${url} did not answer (${answer}); the agent's model calls go there`,
          "check the network, or models.gateway.baseURL in the persona",
        );
    }

    // agent-ts: patchAgentTs leaves a file that imports and spreads donn (and sets no literal
    // model) unchanged, so a change means the persona no longer reaches the agent.
    if (!complete) add(id("agent-ts"), "skipped", notCreated);
    else {
      const text = await readFile(join(dir, "agent/agent.ts"), "utf8").catch(
        () => undefined,
      );
      const patched = text === undefined ? undefined : patchAgentTs(text);
      if (patched === undefined)
        add(
          id("agent-ts"),
          "error",
          `${shown}/agent/agent.ts is missing`,
          SPREAD_FIX,
        );
      else if (!patched.ok)
        add(
          id("agent-ts"),
          "error",
          `${shown}/agent/agent.ts is not one donn recognises`,
          patched.hint,
        );
      else if (patched.text !== text)
        add(
          id("agent-ts"),
          "error",
          `${shown}/agent/agent.ts no longer spreads donn (or sets a literal model), so the persona does not reach the agent`,
          SPREAD_FIX,
        );
      else add(id("agent-ts"), "ok", `${shown}/agent/agent.ts spreads donn`);
    }

    // files: the manifest's files, and build's, are on disk.
    if (!manifest)
      add(
        id("files"),
        "error",
        notCreated,
        `donn agent create ${name}${where}`,
      );
    else if (!complete)
      add(
        id("files"),
        "error",
        notCreated,
        `donn agent create ${name} --force${where}`,
      );
    else {
      const owned = await missing(dir, complete.files);
      const built = await missing(dir, complete.deploy ?? {});
      const total =
        Object.keys(complete.files).length +
        Object.keys(complete.deploy ?? {}).length;
      if (owned.length + built.length === 0)
        add(id("files"), "ok", `${total} donn file(s) present in ${shown}`);
      else
        add(
          id("files"),
          "error",
          `missing in ${shown}: ${[...owned, ...built].join(", ")}`,
          [
            ...(owned.length > 0 ? [`donn agent sync ${name}${where}`] : []),
            ...(built.length > 0 ? [`donn agent build ${name}${where}`] : []),
          ].join("; "),
        );
    }

    // vercel: the Vercel CLI `eve link` and `eve deploy` need, as the agent's dev dependency.
    if (agent.target === "vercel") {
      if (!complete) add(id("vercel"), "skipped", notCreated);
      else if (pkg?.devDependencies?.vercel === undefined)
        add(
          id("vercel"),
          "error",
          `${shown}/package.json has no vercel dev dependency (eve link and eve deploy need the Vercel CLI)`,
          `${pm} add -D vercel@<version> in ${shown}`,
        );
      else {
        const result = await bounded(io, dir, pm, [
          "exec",
          "vercel",
          "--version",
        ]);
        const last = result.tail.at(-1)?.trim();
        if (result.exitCode === "timeout")
          add(
            id("vercel"),
            "warn",
            `${pm} exec vercel --version did not finish in ${TOOL_TIMEOUT_MS / 1000}s in ${shown}`,
            `${pm} install in ${shown}, then run ${pm} exec vercel --version there`,
          );
        else if (result.exitCode === 0)
          add(id("vercel"), "ok", `vercel ${last ?? ""}`.trim());
        else
          add(
            id("vercel"),
            "warn",
            `${pm} exec vercel --version exited ${result.exitCode} in ${shown}${last ? `: ${last}` : ""}`,
            `${pm} install in ${shown}`,
          );
      }
    }
  }
}

type Project =
  | {
      kind: "ok";
      ctx: Awaited<ReturnType<typeof projectContext>>;
      result: ResolveResult;
    }
  | { kind: "gone" }
  | { kind: "failed"; reason: string };

async function loadProject(io: CliIo, root: string): Promise<Project> {
  try {
    const ctx = await projectContext(io, root);
    // A folder that lost its `.donn/` would find a project further up: not this one.
    if (ctx.projectDir === undefined || dirname(ctx.projectDir) !== root)
      return { kind: "gone" };
    const found = await resolveProject(ctx);
    if (found === undefined) return { kind: "gone" };
    return { kind: "ok", ctx, result: found.result };
  } catch (error) {
    return { kind: "failed", reason: errorText(error) };
  }
}

interface Package {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function readPackage(dir: string): Promise<Package> {
  return JSON.parse(
    await readFile(join(dir, "package.json"), "utf8"),
  ) as Package;
}

async function missing(
  dir: string,
  files: Manifest["files"],
): Promise<string[]> {
  const gone: string[] = [];
  for (const path of Object.keys(files).sort())
    if ((await lstat(join(dir, path)).catch(() => undefined)) === undefined)
      gone.push(path);
  return gone;
}

/** `command args` in `dir`, killed after TOOL_TIMEOUT_MS; its exit code, or `timeout`. */
async function bounded(
  io: CliIo,
  dir: string,
  command: string,
  args: string[],
): Promise<{ exitCode: number | "timeout"; tail: string[] }> {
  const tail: string[] = [];
  const child = (io.spawn ?? nodeSpawn)(command, args, {
    cwd: dir,
    env: io.env,
    onLine: (line) => {
      tail.push(line);
      if (tail.length > 20) tail.shift();
    },
  });
  // The timer is cancelled once the child exits, so it never holds the process open.
  const cancel = new AbortController();
  const timer = io.sleep
    ? io.sleep(TOOL_TIMEOUT_MS)
    : sleepFor(TOOL_TIMEOUT_MS, undefined, { signal: cancel.signal });
  try {
    const exitCode = await Promise.race([
      child.exited,
      timer.then(() => "timeout" as const),
    ]);
    if (exitCode === "timeout") child.kill("SIGKILL");
    return { exitCode, tail };
  } finally {
    cancel.abort();
    timer.catch(() => undefined);
  }
}

/** Undefined when `url` answered an HTTP request; otherwise why not. */
async function reach(io: CliIo, url: string): Promise<string | undefined> {
  try {
    const response = await (io.fetch ?? fetch)(url, {
      method: "GET",
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return undefined;
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    if ((error as Error).name === "TimeoutError")
      return `no answer in ${GATEWAY_TIMEOUT_MS / 1000}s`;
    return cause ?? (error as Error).message;
  }
}

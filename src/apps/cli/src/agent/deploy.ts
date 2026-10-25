import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CliIo } from "../cli.js";
import { CliError } from "../errors.js";
import { withFileLock } from "../fs.js";
import { managedEnv } from "../managed/env.js";
import { spawnWithInput } from "../registry.js";
import { agentEnvironment } from "./env.js";
import { packageManager, runEve, runTool, eveEnv } from "./eve.js";
import { readManifest, writeManifest } from "./files.js";
import { projectContext } from "./load.js";
import { agentLockPath } from "./registry.js";

// `donn agent deploy` for `vercel`: link the directory, set the env names Vercel does not have
// yet (after confirmation: this is outward-facing), then `eve deploy`. Values go to
// `vercel env add` on stdin and nowhere else. See docs/planning/25-agent-runner.md, section 4
// `vercel`, and spikes/eve-runner/FINDINGS-runtime.md R5.

export interface DeployOptions {
  yes?: boolean;
  json?: boolean;
  project?: string;
}

const ROUTE_TOKEN = "DONN_ROUTE_TOKEN";
const ALREADY_EXISTS = /already exists/i;
const TAIL_LINES = 10;
const DEPLOYMENT_URL = /https:\/\/[A-Za-z0-9.-]+\.vercel\.app\b[^\s]*/;

/** Only a vercel agent deploys; the others are told what to run instead. */
export function assertDeployable(name: string, target: string): void {
  if (target === "vercel") return;
  throw new CliError(
    "target-not-deployable",
    `${name} targets ${target}: donn agent deploy is for vercel agents`,
    {
      target,
      fix:
        target === "self-host"
          ? `donn agent build ${name}`
          : `donn agent run ${name}`,
    },
  );
}

/** `text` with every occurrence of `value` replaced by `***`. */
const mask = (text: string, value: string) =>
  value === "" ? text : text.split(value).join("***");

/** Adds `names` to the manifest's `pushedEnv` under the agent's lock. */
async function recordPushed(
  lock: string,
  dir: string,
  names: string[],
): Promise<void> {
  if (names.length === 0) return;
  await withFileLock(lock, async () => {
    const manifest = await readManifest(dir);
    if (manifest === undefined) return;
    await writeManifest(dir, {
      ...manifest,
      pushedEnv: [...new Set([...(manifest.pushedEnv ?? []), ...names])].sort(),
    });
  });
}

/** `donn agent deploy <name>`. */
export async function deploy(
  io: CliIo,
  name: string,
  options: DeployOptions,
): Promise<number> {
  const ctx = await projectContext(io, options.project);
  const { root, dir, entries } = await agentEnvironment(ctx, io, name, {
    resolve: false,
    check: (target) => assertDeployable(name, target),
  });
  const pm = await packageManager(dir);
  const lock = agentLockPath(ctx.home, root, name);

  const vercel = await runTool(io, dir, pm, ["exec", "vercel", "--version"], {
    env: eveEnv(io.env, {}),
  }).catch(() => ({ exitCode: 127, tail: [] as string[] }));
  if (vercel.exitCode !== 0) {
    throw new CliError(
      "vercel-cli-missing",
      "the Vercel CLI is not installed in the agent; eve link and eve deploy need it",
      {
        fix: `${pm} add -D vercel (in the agent), or donn agent create --force`,
      },
    );
  }

  const pushed = new Set((await readManifest(dir))?.pushedEnv ?? []);
  const names = entries
    .filter(
      (e) =>
        e.source !== "runtime" && e.name !== ROUTE_TOKEN && !pushed.has(e.name),
    )
    .map((e) => e.name);

  const unlinked = !existsSync(join(dir, ".vercel/project.json"));

  // Before any secret is resolved or anything leaves this machine. A first deploy always asks
  // (it creates a Vercel project), even with no variable to set.
  if (names.length > 0 || unlinked) {
    const what =
      names.length > 0
        ? `set ${names.join(", ")} in Vercel production`
        : `link ${name} to a Vercel project and deploy it`;
    if (options.json && options.yes !== true) {
      throw new CliError(
        "confirmation-required",
        `deploy would ${what}; re-run with --yes to confirm`,
        { names, fix: "--yes" },
      );
    }
    if (options.yes !== true) {
      if (names.length > 0)
        (options.json ? io.stderr : io.stdout).write(
          `will set in Vercel production:\n${names.map((n) => `  ${n}\n`).join("")}`,
        );
      const answer = await managedEnv(io).confirm(
        names.length > 0
          ? `Set these ${names.length} variables in Vercel production?`
          : `Link ${name} to a Vercel project and deploy it?`,
      );
      if (answer === undefined) {
        throw new CliError(
          "confirmation-required",
          "no terminal to confirm on; re-run with --yes",
          { names, fix: "--yes" },
        );
      }
      if (!answer) {
        io.stderr.write("cancelled; nothing deployed\n");
        return 1;
      }
    }
  }

  const progress = (line: string) =>
    (options.json ? io.stderr : io.stdout).write(`${line}\n`);
  const failed = (what: string, result: { exitCode: number; tail: string[] }) =>
    new CliError(
      "eve-failed",
      `${what} exited ${result.exitCode}: ${result.tail.at(-1) ?? "no output"}`,
      { exitCode: result.exitCode, tail: result.tail },
    );

  // The values exist only from here, and only as stdin to vercel. An unresolvable ref stops
  // the deploy before a Vercel project is created or linked.
  const values = new Map<string, string | undefined>();
  if (names.length > 0) {
    const resolved = await agentEnvironment(ctx, io, name, {
      resolve: true,
      check: (target) => assertDeployable(name, target),
    });
    for (const e of resolved.entries) values.set(e.name, e.value);
  }

  if (unlinked) {
    const linked = await runEve(
      io,
      dir,
      ["link", "--non-interactive", "--project", name],
      { env: {}, onProgress: progress },
    );
    if (linked.exitCode !== 0) throw failed("eve link", linked);
  }

  const done: string[] = [];
  const existing: string[] = [];
  const run = io.runInput ?? spawnWithInput;
  for (const envName of names) {
    const value = values.get(envName) ?? "";
    const result = await run(
      pm,
      ["exec", "vercel", "env", "add", envName, "production"],
      value,
      { cwd: dir },
    );
    if (result.exitCode !== 0) {
      const output = `${result.stderr}\n${result.stdout}`;
      if (ALREADY_EXISTS.test(output)) {
        // Set before (a dashboard edit, a recreate): kept, never overwritten.
        existing.push(envName);
        continue;
      }
      const tail = mask(output, value)
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "")
        .slice(-TAIL_LINES);
      // A failure to record must not hide the refusal.
      await recordPushed(lock, dir, [...done, ...existing]).catch(() => {});
      throw new CliError(
        "vercel-env-failed",
        `vercel env add ${envName} production exited ${result.exitCode}: ${tail.at(-1) ?? "no output"}`,
        {
          name: envName,
          exitCode: result.exitCode,
          tail,
          pushed: done,
          fix: `check the Vercel project's environment variables, then run donn agent deploy ${name} again`,
        },
      );
    }
    done.push(envName);
  }
  await recordPushed(lock, dir, [...done, ...existing]);

  const lines: string[] = [];
  const deployed = await runEve(
    io,
    dir,
    ["deploy", "--non-interactive", "--yes"],
    {
      env: {},
      onProgress: (line) => {
        lines.push(line);
        progress(line);
      },
    },
  );
  if (deployed.exitCode !== 0) throw failed("eve deploy", deployed);
  const url = lines.map((l) => DEPLOYMENT_URL.exec(l)?.[0]).find(Boolean);

  if (options.json) {
    io.stdout.write(
      `${JSON.stringify({ agent: name, dir, pushed: done, ...(existing.length > 0 && { existing }), ...(url && { url }) }, null, 2)}\n`,
    );
  } else {
    if (done.length > 0)
      io.stdout.write(`set in Vercel production: ${done.join(", ")}\n`);
    for (const n of existing)
      io.stdout.write(`${n} already set in Vercel; not overwritten\n`);
    io.stdout.write(url ? `deployed ${name}: ${url}\n` : `deployed ${name}\n`);
  }
  return 0;
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { printReport } from "../build.js";
import type { CliIo } from "../cli.js";
import { CliError } from "../errors.js";
import { fsStep, withFileLock, writeFileAtomic } from "../fs.js";
import { agentEnvironment, plainEnv, type EnvEntry } from "./env.js";
import { runEve } from "./eve.js";
import {
  checkDeploy,
  posixRelative,
  readManifest,
  sha256,
  writeManifest,
} from "./files.js";
import { compile, compileInputs } from "./inputs.js";
import { loadCreatedAgent, projectContext } from "./load.js";
import { agentLockPath } from "./registry.js";
import { assertSynced } from "./sync.js";

// `donn agent build` for `self-host`: `eve build` on the host (it prepares the Docker sandbox's
// template image on the daemon the agent will run on), then donn's deploy files: a Dockerfile
// that copies the built `.output/`, and `env.json`, the env manifest. See
// docs/planning/25-agent-runner.md, section 4 `self-host`, and spikes/eve-runner/FINDINGS-runtime.md R3.

export interface BuildOptions {
  force?: boolean;
  json?: boolean;
  project?: string;
}

export const DOCKERFILE = "deploy/donn/Dockerfile";
export const ENV_FILE = "deploy/donn/env.json";
const ARTIFACTS = ".output/.eve/compile/sandbox-prepared-artifacts.json";
const WORLD_PACKAGE = "@workflow/world-postgres";
const SOCKET_MOUNT = "/var/run/docker.sock:/var/run/docker.sock";

const Artifacts = z.object({
  entries: z.array(
    z.object({ artifact: z.object({ imageReference: z.string() }) }),
  ),
});

/** Only a self-host agent builds an image: the others are told what to run instead. */
export function assertBuildable(name: string, target: string): void {
  if (target === "self-host") return;
  throw new CliError(
    "target-not-buildable",
    `${name} targets ${target}: donn agent build makes the self-host image`,
    {
      target,
      fix:
        target === "vercel"
          ? `donn agent deploy ${name}`
          : `donn agent run ${name}`,
    },
  );
}

async function assertDocker(io: CliIo): Promise<void> {
  const result = await io.probe.run("docker", ["info"]).catch(() => undefined);
  if (result?.exitCode === 0) return;
  throw new CliError(
    "docker-unreachable",
    "Docker does not answer; eve build prepares the sandbox image on the daemon the agent will run on",
    {
      fix: "start Docker; eve build prepares the sandbox image on the daemon the agent will run on",
    },
  );
}

/** The sandbox template images `eve build` prepared; none when it wrote no such file. */
async function sandboxImages(dir: string): Promise<string[]> {
  const file = join(dir, ARTIFACTS);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  const parsed = Artifacts.safeParse(raw);
  if (!parsed.success) {
    throw new CliError(
      "invalid-sandbox-artifacts",
      `${file} is not eve's list of prepared sandbox images`,
      { file },
    );
  }
  return [
    ...new Set(parsed.data.entries.map((e) => e.artifact.imageReference)),
  ];
}

/** The installed `@workflow/world-postgres` version, which the image installs for `bootstrap`. */
async function worldVersion(dir: string): Promise<string> {
  const file = join(dir, "node_modules", WORLD_PACKAGE, "package.json");
  try {
    const version: unknown = JSON.parse(await readFile(file, "utf8")).version;
    if (typeof version === "string") return version;
  } catch {
    // Not installed, or unreadable: the refusal below.
  }
  throw new CliError(
    "world-package-missing",
    `${WORLD_PACKAGE} is not installed in the agent, so the image cannot create the Workflow schema`,
    { fix: `install ${WORLD_PACKAGE} in the agent, then donn agent build` },
  );
}

/**
 * The Dockerfile: the host-built `.output/` and the docker CLI (eve's Docker sandbox shells out
 * to it). With `world: postgres` the image installs the world package's `bootstrap` bin apart
 * from `.output/` (which bundles the world but not the bin) at image build, so the container
 * needs no network at start; the entrypoint creates the schema before the server starts.
 */
export function dockerfile(world: { version: string } | undefined): string {
  return [
    "# Written by donn agent build; donn owns this file.",
    "FROM node:26-slim",
    "COPY --from=docker:28.3-cli /usr/local/bin/docker /usr/local/bin/docker",
    ...(world === undefined
      ? []
      : [
          `RUN npm install --prefix /bootstrap --no-save --ignore-scripts ${WORLD_PACKAGE}@${world.version}`,
        ]),
    "COPY .output /agent/.output",
    "WORKDIR /agent",
    "ENV HOST=0.0.0.0 PORT=3000 NODE_ENV=production",
    "VOLUME /agent/.eve",
    world === undefined
      ? 'CMD ["node", ".output/server/index.mjs"]'
      : 'CMD ["sh", "-c", "/bootstrap/node_modules/.bin/bootstrap && exec node .output/server/index.mjs"]',
    "",
  ].join("\n");
}

/** The env manifest: no secret value (a ref only), a plain persona value as it is. */
export function envFile(entries: EnvEntry[], sandboxImage: string | null) {
  return {
    env: entries.map((e) => ({
      name: e.name,
      source: e.source,
      ...(e.ref !== undefined && { ref: e.ref }),
      ...(e.source === "plain" && e.value !== undefined && { value: e.value }),
      why: e.why,
    })),
    sandboxImage,
    mounts: [SOCKET_MOUNT],
    volumes: ["/agent/.eve"],
    proxy: ["/eve/", "/.well-known/workflow/"],
  };
}

/** `donn agent build <name>`. */
export async function build(
  io: CliIo,
  name: string,
  options: BuildOptions,
): Promise<number> {
  const ctx = await projectContext(io, options.project);
  const env = await agentEnvironment(ctx, io, name, {
    resolve: false,
    check: (target) => assertBuildable(name, target),
  });
  const { root, dir, entries } = env;
  // Stale donn files would be built into the image as they are.
  await assertSynced(ctx, env, name);
  await assertDocker(io);

  // The build evaluates the agent without its run-time env: its plain values, never a secret.
  const built = await runEve(io, dir, ["build"], {
    env: plainEnv(entries),
    onProgress: (line) =>
      (options.json ? io.stderr : io.stdout).write(`${line}\n`),
  });
  if (built.exitCode !== 0) {
    throw new CliError(
      "eve-failed",
      `eve build exited ${built.exitCode}: ${built.tail.at(-1) ?? "no output"}`,
      { exitCode: built.exitCode, tail: built.tail },
    );
  }
  const images = await sandboxImages(dir);

  // The lock covers the check and the writes only: a sync cannot see these files half-written.
  const { report, dockerfilePath, envPath, texts } = await withFileLock(
    agentLockPath(ctx.home, root, name),
    async () => {
      const { result, agent, manifest } = await loadCreatedAgent(ctx, io, name);
      const output = compile(
        await compileInputs(
          ctx,
          result.ir,
          name,
          dir,
          manifest.frameworkVersion,
        ),
      );
      await checkDeploy(dir, manifest, options.force === true);
      const world =
        agent.world === "postgres"
          ? { version: await worldVersion(dir) }
          : undefined;
      const texts: Record<string, string> = {
        [DOCKERFILE]: dockerfile(world),
        [ENV_FILE]: `${JSON.stringify(envFile(entries, images[0] ?? null), null, 2)}\n`,
      };
      for (const [path, text] of Object.entries(texts)) {
        const target = join(dir, path);
        await fsStep(target, () => writeFileAtomic(target, text));
      }
      await writeManifest(dir, {
        ...((await readManifest(dir)) ?? manifest),
        deploy: Object.fromEntries(
          Object.entries(texts).map(([path, text]) => [
            path,
            `sha256:${sha256(text)}`,
          ]),
        ),
      });
      return {
        report: output,
        dockerfilePath: join(dir, DOCKERFILE),
        envPath: join(dir, ENV_FILE),
        texts,
      };
    },
  );

  if (options.json) {
    io.stdout.write(
      `${JSON.stringify(
        {
          agent: name,
          dir,
          dockerfile: dockerfilePath,
          envFile: envPath,
          sandboxImages: images,
          report: report.report,
          // What was written, for donn ui: env.json holds refs, never a secret's value.
          contents: { dockerfile: texts[DOCKERFILE], envFile: texts[ENV_FILE] },
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  printReport(io, report);
  const shown = posixRelative(root, dir);
  io.stdout.write(
    `wrote ${shown}/${DOCKERFILE}\nwrote ${shown}/${ENV_FILE}\n` +
      `two images to ship:\n` +
      `  agent image: docker build -f ${DOCKERFILE} -t ${name} .   (run in ${shown})\n` +
      (images.length === 0
        ? "  sandbox image: none (eve prepared no sandbox image; this agent opens no sandbox)\n"
        : images
            .map(
              (image) =>
                `  sandbox image: ${image}   (docker save ${image} | docker load on the run host, or push and pull it under the same tag)\n`,
            )
            .join("")) +
      `the container needs a Docker daemon: mount /var/run/docker.sock, and proxy /eve/ and /.well-known/workflow/\n`,
  );
  return 0;
}

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentCompileOutput } from "@getdonn/adapter-sdk";
import type { ResolvedAgent } from "@getdonn/spec";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { CliIo } from "../cli.js";
import { CliError } from "../errors.js";
import { fsStep, writeFileAtomic } from "../fs.js";
import { packageManager, runTool } from "./eve.js";

// Steps 5 and 7 of `donn agent create`: pin eve and add what donn's files import, set up the
// agent's own pnpm workspace file, install in place, and keep build output out of Git.
// See docs/planning/25-agent-runner.md, section 2, and spikes/eve-runner/FINDINGS-templates.md
// (T4): installing with --ignore-workspace drops the template's pnpm settings.

/** eve 0.83.2 peers `ai@^7.0.137`; the generated config needs `wrapLanguageModel`'s fixes. */
const AI = "^7.0.152";
/** Packages donn's generated files may import, with the range each is pinned to. */
const PROVIDERS: Record<string, string> = {
  "@ai-sdk/openai-compatible": "^3",
  "@ai-sdk/anthropic": "^4",
};
const WORLD_POSTGRES = "^5.0.5";

export interface Dependencies {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

/** What the agent's package.json gains besides eve: by what the compile's files import. */
export function dependenciesFor(
  files: AgentCompileOutput["files"],
  agent: Pick<ResolvedAgent, "target" | "world">,
  vercelVersion?: string,
): Dependencies {
  const text = Object.values(files)
    .map((file) => ("content" in file ? file.content : ""))
    .join("\n");
  const dependencies: Record<string, string> = { ai: AI };
  for (const [name, range] of Object.entries(PROVIDERS))
    if (text.includes(`from "${name}"`)) dependencies[name] = range;
  if (agent.world === "postgres")
    dependencies["@workflow/world-postgres"] = WORLD_POSTGRES;
  const devDependencies: Record<string, string> = {};
  if (agent.target === "vercel" && vercelVersion !== undefined)
    devDependencies["vercel"] = vercelVersion;
  return { dependencies, devDependencies };
}

/** The Vercel CLI's current version, pinned exactly (`eve link` and `deploy` need it). */
export async function vercelVersion(io: CliIo): Promise<string> {
  const result = await io.probe.run("npm", ["view", "vercel", "version"]);
  const version = result.stdout.trim();
  if (result.exitCode !== 0 || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new CliError(
      "install-failed",
      `could not read the Vercel CLI's version: ${result.stderr.trim().split("\n").at(-1) || `npm exited ${result.exitCode}`}`,
      { command: "npm view vercel version", exitCode: result.exitCode },
    );
  }
  return version;
}

/**
 * Pins eve exactly, adds `deps` to package.json, and gives the agent its own pnpm workspace
 * settings: `packages: ["."]` when it has no file, `allowBuilds: { cbor-extract: false }` and
 * the pinned eve in `minimumReleaseAgeExclude`. Returns the files it changed.
 */
export async function prepareInstall(
  dir: string,
  version: string,
  deps: Dependencies,
): Promise<string[]> {
  const pkgFile = join(dir, "package.json");
  const pkg = JSON.parse(await readFile(pkgFile, "utf8")) as Record<
    string,
    unknown
  >;
  const section = (key: string) =>
    ((pkg[key] as Record<string, string> | undefined) ??= {});
  const devHasEve = (pkg["devDependencies"] as Record<string, string>)?.["eve"];
  section(devHasEve !== undefined ? "devDependencies" : "dependencies")["eve"] =
    version;
  Object.assign(section("dependencies"), deps.dependencies);
  if (Object.keys(deps.devDependencies).length > 0)
    Object.assign(section("devDependencies"), deps.devDependencies);
  await fsStep(pkgFile, () =>
    writeFileAtomic(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`),
  );

  const wsFile = join(dir, "pnpm-workspace.yaml");
  const text = await readFile(wsFile, "utf8").catch(() => undefined);
  const doc = parseDocument(text ?? "");
  if (
    doc.errors.length > 0 ||
    !(doc.contents === null || isMap(doc.contents))
  ) {
    throw new CliError(
      "invalid-workspace-file",
      `${wsFile} does not parse; fix it first`,
      { file: wsFile },
    );
  }
  if (text === undefined) doc.set("packages", doc.createNode(["."]));
  if (!doc.hasIn(["allowBuilds", "cbor-extract"]))
    doc.setIn(["allowBuilds", "cbor-extract"], false);
  const pin = `eve@${version}`;
  const exclude = doc.get("minimumReleaseAgeExclude");
  const listed = isSeq(exclude)
    ? exclude.items.map((item) => (isScalar(item) ? String(item.value) : ""))
    : [];
  if (!listed.includes("eve") && !listed.includes(pin)) {
    if (isSeq(exclude)) exclude.add(doc.createNode(pin));
    else doc.set("minimumReleaseAgeExclude", doc.createNode([pin]));
  }
  const next = doc.toString();
  if (next !== text) await fsStep(wsFile, () => writeFileAtomic(wsFile, next));
  return next !== text
    ? ["package.json", "pnpm-workspace.yaml"]
    : ["package.json"];
}

/**
 * `<pm> install` in `dir`, found by the agent's own workspace file: never `--ignore-workspace`,
 * never frozen (the re-pin makes the template's lockfile stale).
 */
export async function install(
  io: CliIo,
  dir: string,
  onProgress?: (line: string) => void,
): Promise<void> {
  const pm = await packageManager(dir);
  const result = await runTool(io, dir, pm, ["install"], {
    env: io.env,
    ...(onProgress && { onProgress }),
  });
  if (result.exitCode === 0) return;
  // pnpm exits non-zero for an ignored build script after installing everything.
  if (
    result.tail.some((line) => line.includes("ERR_PNPM_IGNORED_BUILDS")) &&
    existsSync(join(dir, "node_modules"))
  )
    return;
  throw new CliError(
    "install-failed",
    `${pm} install exited ${result.exitCode} in ${dir}: ${result.tail.at(-1) ?? "no output"}`,
    { command: `${pm} install`, exitCode: result.exitCode, tail: result.tail },
  );
}

/** What must never be committed from an agent directory. */
const IGNORED = [".env*", ".output/", ".vercel/", "node_modules/", ".eve/"];
const bare = (line: string) =>
  line.trim().replace(/^\//, "").replace(/\/$/, "");

/** Appends the missing entries to the agent's `.gitignore`; true when it changed. */
export async function ignoreGenerated(dir: string): Promise<boolean> {
  const file = join(dir, ".gitignore");
  const text = await readFile(file, "utf8").catch(() => "");
  const present = new Set(text.split(/\r?\n/).map(bare));
  const missing = IGNORED.filter((entry) => !present.has(bare(entry)));
  if (missing.length === 0) return false;
  const head = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  await fsStep(file, () =>
    writeFileAtomic(file, `${head}${missing.join("\n")}\n`),
  );
  return true;
}

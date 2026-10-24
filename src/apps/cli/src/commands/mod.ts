import { existsSync } from "node:fs";
import { cp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { CliIo } from "../cli.js";
import { homeOf } from "../context.js";
import { CliError } from "../errors.js";
import { fsStep, writeFileAtomic } from "../fs.js";
import { CLI_ON_PATH_FIX, findOnPath } from "../path.js";

// donn mod install|uninstall: the Claude Code mod, registered through a local folder
// marketplace that Claude Code reads in place. See docs/planning/09-mod-claude-code.md §1.

export const MOD_ID = "donn@donn";
/** The local marketplace the mod is registered through. */
export const MARKETPLACE = "donn";

/** The built mod this CLI ships. */
export function bundledMod(): { dir: string; version: string } {
  const pkg = createRequire(import.meta.url).resolve(
    "@getdonn/mod-claude-code/package.json",
  );
  const { version } = createRequire(import.meta.url)(pkg) as {
    version: string;
  };
  return { dir: join(dirname(pkg), "dist/mod"), version };
}

/** Refuse a mod folder that has not been built. */
export function checkModBuilt(dir: string = bundledMod().dir): void {
  if (!existsSync(join(dir, "hooks/register.js"))) {
    throw new CliError(
      "mod-install",
      `the mod is not built (${dir} is missing); build @getdonn/mod-claude-code first`,
    );
  }
}

/** The installed mod's version, or undefined when it is not installed. */
export async function installedModVersion(
  home: string,
): Promise<string | undefined> {
  const manifest = join(home, "mod/plugin/.claude-plugin/plugin.json");
  const text = await readFile(manifest, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    return String((JSON.parse(text) as { version?: unknown }).version);
  } catch {
    return "unknown";
  }
}

/**
 * Run `claude plugin …`. Output matching `tolerate` counts as done: "already" on install, and
 * Claude's own "not installed"/"not found" on uninstall. Exit 127 (no claude) is returned as
 * `missing` when `allowMissing`; anything else is a `code` error.
 */
async function claude(
  io: CliIo,
  args: string[],
  tolerate: RegExp,
  code: "mod-install" | "mod-uninstall",
  allowMissing = false,
): Promise<{ argv: string[]; missing: boolean }> {
  const argv = ["claude", ...args];
  const result = await io.probe.run("claude", args);
  if (result.exitCode === 127 && allowMissing) return { argv, missing: true };
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode !== 0 && !tolerate.test(output)) {
    const reason =
      result.exitCode === 127
        ? "claude is not installed (or not on PATH)"
        : `exited ${result.exitCode}: ${(result.stderr.trim() || result.stdout.trim()).split("\n")[0]}`;
    throw new CliError(code, `${argv.join(" ")} ${reason}`, {
      command: argv,
    });
  }
  return { argv, missing: false };
}

export interface RegisteredMod {
  installed: string;
  version: string;
  ran: string[][];
  warnings: string[];
}

/** Copy the mod into `<home>/mod`, write its marketplace and register both with claude. */
export async function registerMod(io: CliIo): Promise<RegisteredMod> {
  const home = homeOf(io);
  const modDir = join(home, "mod");
  const plugin = join(modDir, "plugin");
  const source = bundledMod();
  checkModBuilt(source.dir);
  await fsStep(plugin, async () => {
    await rm(plugin, { recursive: true, force: true });
    await cp(source.dir, plugin, { recursive: true });
  });
  const marketplace = join(modDir, ".claude-plugin/marketplace.json");
  await fsStep(marketplace, () =>
    writeFileAtomic(
      marketplace,
      `${JSON.stringify(
        {
          name: MARKETPLACE,
          owner: { name: "donn" },
          plugins: [{ name: "donn", source: "./plugin" }],
        },
        null,
        2,
      )}\n`,
    ),
  );
  const already = /already/i;
  const ran = [
    (
      await claude(
        io,
        ["plugin", "marketplace", "add", modDir],
        already,
        "mod-install",
      )
    ).argv,
    (
      await claude(
        io,
        ["plugin", "install", MOD_ID, "--scope", "user"],
        already,
        "mod-install",
      )
    ).argv,
  ];
  // The mod runs `donn` from PATH, without a shell: an alias will not do.
  const warnings = findOnPath("donn", io.env)
    ? []
    : [`donn is not on PATH, so the mod cannot run it; ${CLI_ON_PATH_FIX}`];
  return { installed: plugin, version: source.version, ran, warnings };
}

export async function modInstall(
  io: CliIo,
  options: { json?: boolean },
): Promise<number> {
  const { installed, version, ran, warnings } = await registerMod(io);
  io.stdout.write(
    options.json
      ? `${JSON.stringify({ installed, ran, warnings }, null, 2)}\n`
      : [
          `copied the mod (${version}) to ${installed}`,
          ...ran.map((argv) => `ran: ${argv.join(" ")}`),
          ...warnings.map((w) => `warning: ${w}`),
          "start a new claude session to load it",
          "",
        ].join("\n"),
  );
  return 0;
}

/**
 * Unregister the mod from claude; its folder stays. `missing` when claude is not installed (then
 * there was nothing to unregister).
 */
async function unregisterMod(
  io: CliIo,
): Promise<{ ran: string[][]; missing: boolean }> {
  // Claude's own answers for a plugin or marketplace that is already gone.
  const gone = /not (?:be )?(?:found|installed)/i;
  const first = await claude(
    io,
    ["plugin", "uninstall", MOD_ID],
    gone,
    "mod-uninstall",
    true,
  );
  if (first.missing) return { ran: [], missing: true };
  const second = await claude(
    io,
    ["plugin", "marketplace", "remove", MARKETPLACE],
    gone,
    "mod-uninstall",
  );
  return { ran: [first.argv, second.argv], missing: false };
}

export async function modUninstall(
  io: CliIo,
  options: { json?: boolean },
): Promise<number> {
  const home = homeOf(io);
  const modDir = join(home, "mod");
  // Without claude there is nothing to unregister; still remove the folder.
  const { ran, missing } = await unregisterMod(io);
  const notes = missing
    ? ["claude is not installed; skipped unregistering the mod"]
    : [];
  await fsStep(modDir, () => rm(modDir, { recursive: true, force: true }));
  io.stdout.write(
    options.json
      ? `${JSON.stringify({ removed: modDir, ran, notes }, null, 2)}\n`
      : [
          ...notes,
          ...ran.map((argv) => `ran: ${argv.join(" ")}`),
          `removed ${modDir}`,
          "",
        ].join("\n"),
  );
  return 0;
}

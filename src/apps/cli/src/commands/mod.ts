import { existsSync } from "node:fs";
import { cp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { CliIo } from "../cli.js";
import { homeOf } from "../context.js";
import { CliError } from "../errors.js";
import { fsStep, writeFileAtomic } from "../fs.js";

// zzpersona mod install|uninstall: the Claude Code mod, registered through a local folder
// marketplace that Claude Code reads in place. See docs/planning/09-mod-claude-code.md §1.

export const MOD_ID = "zzpersona@zzpersona";

/** The built mod this CLI ships. */
export function bundledMod(): { dir: string; version: string } {
  const pkg = createRequire(import.meta.url).resolve(
    "@zzpersona/mod-claude-code/package.json",
  );
  const { version } = createRequire(import.meta.url)(pkg) as {
    version: string;
  };
  return { dir: join(dirname(pkg), "dist/mod"), version };
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

export async function modInstall(
  io: CliIo,
  options: { json?: boolean },
): Promise<number> {
  const home = homeOf(io);
  const modDir = join(home, "mod");
  const plugin = join(modDir, "plugin");
  const source = bundledMod();
  if (!existsSync(join(source.dir, "hooks/register.js"))) {
    throw new CliError(
      "mod-install",
      `the mod is not built (${source.dir} is missing); build @zzpersona/mod-claude-code first`,
    );
  }
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
          name: "zzpersona",
          owner: { name: "zzpersona" },
          plugins: [{ name: "zzpersona", source: "./plugin" }],
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
  io.stdout.write(
    options.json
      ? `${JSON.stringify({ installed: plugin, ran }, null, 2)}\n`
      : [
          `copied the mod (${source.version}) to ${plugin}`,
          ...ran.map((argv) => `ran: ${argv.join(" ")}`),
          "start a new claude session to load it",
          "",
        ].join("\n"),
  );
  return 0;
}

export async function modUninstall(
  io: CliIo,
  options: { json?: boolean },
): Promise<number> {
  const home = homeOf(io);
  const modDir = join(home, "mod");
  // Claude's own answers for a plugin or marketplace that is already gone.
  const gone = /not (?:be )?(?:found|installed)/i;
  const notes: string[] = [];
  const ran: string[][] = [];
  // Without claude there is nothing to unregister; still remove the folder.
  const first = await claude(
    io,
    ["plugin", "uninstall", MOD_ID],
    gone,
    "mod-uninstall",
    true,
  );
  if (first.missing) {
    notes.push("claude is not installed; skipped unregistering the mod");
  } else {
    ran.push(
      first.argv,
      (
        await claude(
          io,
          ["plugin", "marketplace", "remove", "zzpersona"],
          gone,
          "mod-uninstall",
        )
      ).argv,
    );
  }
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

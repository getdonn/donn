import type { Probe } from "@zzpersona/adapter-sdk";
import type { runPlan } from "@zzpersona/executor";
import { Command, CommanderError, Option } from "commander";
import { capabilitiesCommand } from "./commands/capabilities.js";
import { claudeCommand } from "./commands/claude.js";
import { statusCommand } from "./commands/status.js";
import { codexCommand } from "./commands/codex.js";
import { compileCommand } from "./commands/compile.js";
import {
  daemonRefresh,
  daemonRun,
  daemonStart,
  daemonStatus,
  daemonStop,
} from "./commands/daemon.js";
import { diffCommand } from "./commands/diff.js";
import { doctorCommand } from "./commands/doctor.js";
import { listCommand } from "./commands/list.js";
import { writeCommand } from "./commands/write.js";
import { liveCommand } from "./commands/live.js";
import { modInstall, modUninstall } from "./commands/mod.js";
import { initCommand } from "./commands/init.js";
import { resolveCommand } from "./commands/resolve.js";
import { switchCommand } from "./commands/switch.js";
import { CliError, report } from "./errors.js";

// The zzpersona command line. Everything goes through createCli(io) so tests run commands
// in-process. See docs/planning/06-cli-core-loop.md, section 4.

export interface CliIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  probe: Probe;
  /** Runs secret provider commands, which may wait on a keychain prompt; defaults to probe. */
  secretProbe?: Probe;
  /** Injected in tests; defaults to the executor's runPlan. */
  runPlan?: typeof runPlan;
  /** Injected in tests; defaults to Date.now. */
  now?: () => number;
  /** Injected in tests; defaults to spawning `zzpersona daemon run` detached. */
  spawnDaemon?: (home: string) => Promise<void>;
}

export function createCli(io: CliIo): { run(argv: string[]): Promise<number> } {
  return {
    async run(argv) {
      let code = 0;
      // Everything after `--` passes through to the harness untouched.
      const split = argv.indexOf("--");
      const ours = split === -1 ? argv : argv.slice(0, split);
      const passthrough = split === -1 ? [] : argv.slice(split + 1);
      const wantsJson = ours.includes("--json");
      /** Run a command; only `claude` and `codex` take passthrough arguments after `--`. */
      const handle = async (
        json: boolean | undefined,
        command: () => Promise<number>,
        options: { passthrough?: boolean } = {},
      ) => {
        try {
          if (passthrough.length > 0 && !options.passthrough) {
            throw new CliError(
              "unexpected-passthrough",
              "arguments after `--` are only passed through by zzpersona claude and zzpersona codex",
              { args: passthrough },
            );
          }
          code = await command();
        } catch (error) {
          code = report(io, json === true, error);
        }
      };

      const program = new Command("zzpersona")
        .description("Compile personas to AI coding harnesses and launch them")
        .exitOverride()
        .configureOutput({
          writeOut: (s) => io.stdout.write(s),
          writeErr: (s) => io.stderr.write(s),
          // Under --json, usage errors become an envelope (below) instead of text.
          outputError: (s, write) => {
            if (!wantsJson) write(s);
          },
        });

      program
        .command("resolve")
        .description("Resolve a persona and its ancestors")
        .argument(
          "[persona]",
          "a ref like team/payments, or a bare name; defaults to the project persona",
        )
        .option("--explain", "print every value with the layer that set it")
        .option("--json", "print the resolve result as JSON")
        .option("--no-overlay", "skip ~/.zzpersona/overrides.yaml")
        .action((persona: string | undefined, options) =>
          handle(options.json, () => resolveCommand(io, persona, options)),
        );

      program
        .command("diff")
        .description(
          "Show what changes from one persona to another, with the layers that set each value",
        )
        .argument(
          "<persona>",
          "the persona to compare to; with two personas, the first is compared to the second",
        )
        .argument("[other]", "the persona to compare to, when two are given")
        .option("--json", "print the changes as JSON")
        .option("--no-overlay", "skip ~/.zzpersona/overrides.yaml")
        .action((persona: string, other: string | undefined, options) =>
          handle(options.json, () => diffCommand(io, persona, other, options)),
        );

      program
        .command("list")
        .description("List every available persona with its layer")
        .option("--json", "print the personas as JSON")
        .action((options) =>
          handle(options.json, () => listCommand(io, options)),
        );

      const mod = program
        .command("mod")
        .description("Install or remove the zzpersona mod for Claude Code");
      mod
        .command("install")
        .description("Register the mod with Claude Code (user scope)")
        .option("--json", "print { installed, ran } as JSON")
        .action((options) =>
          handle(options.json, () => modInstall(io, options)),
        );
      mod
        .command("uninstall")
        .description("Unregister the mod and remove its folder")
        .option("--json", "print { removed, ran } as JSON")
        .action((options) =>
          handle(options.json, () => modUninstall(io, options)),
        );

      program
        .command("live")
        .description(
          "Switch a running zzpersona claude session's persona (skills, hooks, agents, instructions)",
        )
        .argument("[persona]", "the persona to switch to")
        .requiredOption(
          "--session <dir>",
          "the session folder (ZZPERSONA_SESSION)",
        )
        .option("--show", "print the session's live state instead of switching")
        .option("--json", "print the live state as JSON")
        .action((persona: string | undefined, options) =>
          handle(options.json, () => liveCommand(io, persona, options)),
        );

      program
        .command("write")
        .description(
          "Render the project persona into the files a harness reads from the repo (AGENTS.md)",
        )
        .option("--harness <id>", "the file harness", "agents-md")
        .option("--check", "write nothing; exit 1 when the file is out of date")
        .option("--remove", "remove the generated block")
        .option("--json", "print { path, status, report } as JSON")
        .action((options) =>
          handle(options.json, () => writeCommand(io, options)),
        );

      program
        .command("compile")
        .description(
          "Compile a persona into a harness build without launching it",
        )
        .argument(
          "[persona]",
          "a ref like team/payments, or a bare name; defaults to the project persona",
        )
        .option("--harness <id>", "the harness to compile for", "claude-code")
        .option("--dry-run", "print the build and plan; write nothing")
        .option(
          "--json",
          "print { buildDir, report, secretRefs, plan } as JSON",
        )
        .option("--no-overlay", "skip ~/.zzpersona/overrides.yaml")
        .action((persona: string | undefined, options) =>
          handle(options.json, () => compileCommand(io, persona, options)),
        );

      program
        .command("capabilities")
        .description(
          "Show what each harness can carry: native, approximated, advisory or none",
        )
        .option("--harness <id>", "one harness, with every field and its note")
        .option("--detect", "the matrix for this machine's install and mode")
        .option("--markdown", "the published Markdown form")
        .option("--json", "every field per harness as JSON")
        .action((options) =>
          handle(options.json, () => capabilitiesCommand(io, options)),
        );

      program
        .command("claude")
        .description(
          "Build a persona for Claude Code and launch claude with it",
        )
        .argument(
          "[persona]",
          "a ref like team/payments, or a bare name; defaults to the project persona",
        )
        .addOption(
          new Option(
            "--mode <mode>",
            "override managed-settings detection",
          ).choices(["partial", "relaunch-no-mcp"]),
        )
        .option(
          "--dry-run",
          "print the build and plan; write and launch nothing",
        )
        .option("--json", "print the plan as JSON; launches nothing")
        .option("--no-overlay", "skip ~/.zzpersona/overrides.yaml")
        .action((persona: string | undefined, options) =>
          handle(
            options.json,
            () => claudeCommand(io, persona, options, passthrough),
            { passthrough: true },
          ),
        );

      program
        .command("codex")
        .description("Build a persona for Codex and launch codex with it")
        .argument(
          "[persona]",
          "a ref like team/payments, or a bare name; defaults to the project persona",
        )
        .option(
          "--dry-run",
          "print the build and plan; write and launch nothing",
        )
        .option("--json", "print the plan as JSON; launches nothing")
        .option("--no-overlay", "skip ~/.zzpersona/overrides.yaml")
        .action((persona: string | undefined, options) =>
          handle(
            options.json,
            () => codexCommand(io, persona, options, passthrough),
            { passthrough: true },
          ),
        );

      program
        .command("switch")
        .description(
          "Choose the persona for this project, or your default outside projects",
        )
        .argument(
          "[persona]",
          "a ref or bare name; omit to show what is in use",
        )
        .option("--default", "set or clear the default even inside a project")
        .option("--clear", "remove this project's switch (or the default)")
        .option("--json", "print the result as JSON")
        .action((persona: string | undefined, options) =>
          handle(options.json, () => switchCommand(io, persona, options)),
        );

      program
        .command("init")
        .description(
          "Set up this machine (--personas) and/or a project (--extends)",
        )
        .option(
          "--personas <dir>",
          "your personas folder; written to config.yaml",
        )
        .option(
          "--extends <persona>",
          "write .zzpersona/persona.yaml here extending it",
        )
        .option(
          "--force",
          "replace an existing config value or project persona",
        )
        .option("--json", "print { created, updated } as JSON")
        .action((options) =>
          handle(options.json, () => initCommand(io, options)),
        );

      program
        .command("doctor")
        .description(
          "Check this machine and project, and explain what is wrong",
        )
        .argument(
          "[persona]",
          "check this persona instead of the one that would be used here",
        )
        .option(
          "--fix",
          "remove orphaned switches, stale locks and orphaned builds",
        )
        .option("--json", "print { checks } as JSON")
        .action((persona: string | undefined, options) =>
          handle(options.json, () => doctorCommand(io, persona, options)),
        );

      const daemon = program
        .command("daemon")
        .description(
          "Run the local daemon that keeps live sessions current (spec 14)",
        );
      daemon
        .command("run")
        .description("Run the daemon in the foreground")
        .option("--json", "print { running, pid, socket } as JSON")
        .action((options) =>
          handle(options.json, () => daemonRun(io, options)),
        );
      daemon
        .command("start")
        .description("Start the daemon in the background")
        .option("--json", "print { running, already, pid, version } as JSON")
        .action((options) =>
          handle(options.json, () => daemonStart(io, options)),
        );
      daemon
        .command("stop")
        .description("Stop the daemon")
        .option("--json", "print { running, stopped } as JSON")
        .action((options) =>
          handle(options.json, () => daemonStop(io, options)),
        );
      daemon
        .command("status")
        .description(
          "Show whether the daemon runs, its pid, version and uptime",
        )
        .option("--json", "print the daemon's status as JSON")
        .action((options) =>
          handle(options.json, () => daemonStatus(io, options)),
        );

      daemon
        .command("refresh")
        .description("Refresh every live session now")
        .option("--json", "print { running, refreshed } as JSON")
        .action((options) =>
          handle(options.json, () => daemonRefresh(io, options)),
        );

      program
        .command("status")
        .description(
          "Show the live sessions and whether the daemon keeps them current",
        )
        .option("--json", "print { daemon, sessions } as JSON")
        .action((options) =>
          handle(options.json, () => statusCommand(io, options)),
        );

      try {
        await program.parseAsync(ours, { from: "user" });
      } catch (error) {
        if (!(error instanceof CommanderError)) throw error;
        if (wantsJson && error.exitCode !== 0) {
          io.stdout.write(
            `${JSON.stringify({ error: { code: "usage", message: error.message } }, null, 2)}\n`,
          );
          return 1;
        }
        return error.exitCode;
      }
      return code;
    },
  };
}

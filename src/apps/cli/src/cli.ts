import type { Probe } from "@zzpersona/adapter-sdk";
import type { runPlan } from "@zzpersona/executor";
import { Command, CommanderError, Option } from "commander";
import { claudeCommand } from "./commands/claude.js";
import { compileCommand } from "./commands/compile.js";
import { doctorCommand } from "./commands/doctor.js";
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
      /** Run a command; only `claude` takes passthrough arguments after `--`. */
      const handle = async (
        json: boolean | undefined,
        command: () => Promise<number>,
        options: { passthrough?: boolean } = {},
      ) => {
        try {
          if (passthrough.length > 0 && !options.passthrough) {
            throw new CliError(
              "unexpected-passthrough",
              "arguments after `--` are only passed through by zzpersona claude",
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

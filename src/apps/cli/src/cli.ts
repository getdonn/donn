import type { Probe } from "@zzpersona/adapter-sdk";
import type { runPlan } from "@zzpersona/executor";
import { Command, CommanderError } from "commander";
import { compileCommand } from "./commands/compile.js";
import { resolveCommand } from "./commands/resolve.js";
import { report } from "./errors.js";

// The zzpersona command line. Everything goes through createCli(io) so tests run commands
// in-process. See docs/planning/06-cli-core-loop.md, section 4.

export interface CliIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  probe: Probe;
  /** Injected in tests; defaults to the executor's runPlan. */
  runPlan?: typeof runPlan;
  /** Injected in tests; defaults to Date.now. */
  now?: () => number;
}

export function createCli(io: CliIo): { run(argv: string[]): Promise<number> } {
  return {
    async run(argv) {
      let code = 0;
      const handle = async (
        json: boolean | undefined,
        command: () => Promise<number>,
      ) => {
        try {
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

      try {
        await program.parseAsync(argv, { from: "user" });
      } catch (error) {
        if (error instanceof CommanderError) return error.exitCode;
        throw error;
      }
      return code;
    },
  };
}

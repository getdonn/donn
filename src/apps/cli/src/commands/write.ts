import { dirname } from "node:path";
import { applyOverlay, type OverlayMode } from "@getdonn/executor";
import { prepareBuild, printReport } from "../build.js";
import type { CliIo } from "../cli.js";
import { createContext } from "../context.js";
import { CliError } from "../errors.js";

// donn write: render the repo's project persona into the files a harness reads from the
// repo (a committed AGENTS.md block). Always the project persona, without the user's overlay,
// switches or default: the file is the same for every teammate. See
// docs/planning/11-agents-md.md.

export interface WriteOptions {
  harness: string;
  check?: boolean;
  remove?: boolean;
  json?: boolean;
}

const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;

export async function writeCommand(
  io: CliIo,
  options: WriteOptions,
): Promise<number> {
  const ctx = await createContext(io);
  if (ctx.projectDir === undefined) {
    throw new CliError(
      "no-project-persona",
      "no project persona here; write renders the repo's project persona",
      { fix: "donn init --extends <persona>" },
    );
  }
  const build = await prepareBuild(ctx, io, {
    selection: { ref: "project/persona", source: "project" },
    harness: options.harness,
    overlay: false,
    passthrough: [],
  });
  const userLayer = build.result.ir.layers.find((ref) =>
    ref.startsWith("user/"),
  );
  if (userLayer !== undefined) {
    throw new CliError(
      "user-layer-in-shared-file",
      `project/persona extends ${userLayer}, which only you can resolve; a shared file cannot include it`,
      { layer: userLayer },
    );
  }
  const overlays = build.plan.steps.filter((step) => step.kind === "overlay");
  if (overlays.length === 0 || overlays.length !== build.plan.steps.length) {
    throw new CliError(
      "not-a-file-harness",
      `${options.harness} launches a program; write is for harnesses that read files from the repo (agents-md)`,
      { harness: options.harness },
    );
  }
  // A whole-file overlay would replace or delete a file whatever its owner; until overlays carry
  // an ownership marker (spec 05 open question 1), only marked blocks are written.
  const whole = overlays.find((step) => step.block === undefined);
  if (whole) {
    throw new CliError(
      "overlay-needs-block",
      `${options.harness} would own the whole of ${whole.path}; write only merges marked blocks, so it never replaces a file it does not own`,
      { harness: options.harness, path: whole.path },
    );
  }
  const mode: OverlayMode = options.check
    ? "check"
    : options.remove
      ? "remove"
      : "write";
  const root = dirname(ctx.projectDir);
  let stale = false;
  for (const step of overlays) {
    const result = await applyOverlay(step, root, { mode });
    stale ||= result.status === "stale";
    if (options.json) {
      io.stdout.write(
        `${JSON.stringify({ ...result, report: build.output.report }, null, 2)}\n`,
      );
    } else {
      const block = step.block
        ? ` (${step.block} block, ${kib(Buffer.byteLength(step.content))})`
        : "";
      io.stdout.write(`${result.status} ${step.path}${block}\n`);
    }
  }
  if (!options.json) printReport(io, build.output);
  return stale ? 1 : 0;
}

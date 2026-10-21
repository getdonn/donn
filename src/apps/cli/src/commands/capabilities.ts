import type { HarnessAdapter } from "@zzpersona/adapter-sdk";
import type { CliIo } from "../cli.js";
import {
  capabilitiesDoc,
  capabilitiesJson,
  renderGrid,
  renderHarness,
  type Column,
} from "../capabilities/render.js";
import { createContext } from "../context.js";
import { allAdapters, findAdapter } from "../plugins.js";

// `zzpersona capabilities`: what each harness can carry, from the adapters' own matrices.
// See docs/planning/13-capability-matrix.md.

export interface CapabilitiesOptions {
  harness?: string;
  detect?: boolean;
  markdown?: boolean;
  json?: boolean;
}

async function column(
  io: CliIo,
  adapter: HarnessAdapter,
  detect: boolean,
): Promise<Column> {
  if (!detect) return { id: adapter.id, matrix: adapter.capabilities() };
  const detection = await adapter.detect(io.probe);
  return {
    id: adapter.id,
    detected: {
      installed: detection.installed,
      ...(detection.version !== undefined && { version: detection.version }),
    },
    matrix: adapter.capabilities(detection),
  };
}

export async function capabilitiesCommand(
  io: CliIo,
  options: CapabilitiesOptions,
): Promise<number> {
  const ctx = await createContext(io);
  const adapters = options.harness
    ? [await findAdapter(ctx, io.env, options.harness)]
    : await allAdapters(ctx, io.env);
  const columns = await Promise.all(
    adapters.map((adapter) => column(io, adapter, options.detect === true)),
  );
  if (options.json) {
    io.stdout.write(`${JSON.stringify(capabilitiesJson(columns), null, 2)}\n`);
  } else if (options.markdown) {
    io.stdout.write(capabilitiesDoc(columns));
  } else if (options.harness) {
    io.stdout.write(renderHarness(columns[0]!));
  } else {
    io.stdout.write(renderGrid(columns));
  }
  return 0;
}

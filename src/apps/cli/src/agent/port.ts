import { createServer } from "node:net";
import { CliError } from "../errors.js";
import { recordPort, storedPort } from "./registry.js";

// The sticky port of a `local` agent: picked once, stored in the index, checked free before each
// run. See docs/planning/25-agent-runner.md, "Amendment: a sticky port for local agents".

export const PORT_RANGE = { min: 1024, max: 65535 } as const;

/** Whether `value` is an integer within `PORT_RANGE`. */
export const isPort = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= PORT_RANGE.min &&
  value <= PORT_RANGE.max;

/** A `--port` value: digits only, within `PORT_RANGE`. */
export function parsePort(text: string): number {
  const port = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!isPort(port)) {
    throw new CliError(
      "invalid-port",
      `--port must be an integer from ${PORT_RANGE.min} to ${PORT_RANGE.max}`,
      { fix: "donn agent run <name> --port 8787" },
    );
  }
  return port;
}

/** Listen on 127.0.0.1 at `port` (0 = any free one), report the bound port and close. */
function probe(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      const address = server.address();
      const bound =
        typeof address === "object" && address ? address.port : port;
      server.close((error) => (error ? reject(error) : resolve(bound)));
    });
  });
}

/** A port the OS says is free right now. */
export const freePort = (): Promise<number> => probe(0);

/** Throws `port-in-use` when something already listens on `port`. */
export async function assertPortFree(
  port: number,
  name: string,
): Promise<void> {
  try {
    await probe(port);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    throw new CliError(
      "port-in-use",
      `port ${port} is in use by another process`,
      { port, fix: `donn agent run ${name} --port <other>` },
    );
  }
}

/**
 * The port to run on: `requested`, else the stored one, else a fresh free one. It must be free,
 * and is then stored. `picked` is true only when donn chose it.
 */
export async function choosePort(
  home: string,
  project: string,
  name: string,
  requested?: number,
): Promise<{ port: number; picked: boolean }> {
  const stored =
    requested === undefined ? await storedPort(home, project, name) : undefined;
  const picked = requested === undefined && stored === undefined;
  const port = requested ?? stored ?? (await freePort());
  await assertPortFree(port, name);
  await recordPort(home, project, name, port);
  return { port, picked };
}

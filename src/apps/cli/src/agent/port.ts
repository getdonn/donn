import { createServer } from "node:net";
import { CliError } from "../errors.js";
import { listCreated, recordPort, storedPort } from "./registry.js";

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

const PICK_TRIES = 20;

/**
 * A free port no other created agent has stored (it may be stopped, its port not bound). After
 * `PICK_TRIES` tries the last one is refused as `port-in-use`.
 */
async function pickPort(
  home: string,
  project: string,
  name: string,
  pick: () => Promise<number>,
): Promise<number> {
  const others = new Set<number>();
  for (const a of await listCreated(home))
    if (a.port !== undefined && !(a.project === project && a.name === name))
      others.add(a.port);
  let port = await pick();
  for (let i = 1; others.has(port); i += 1) {
    if (i >= PICK_TRIES)
      throw new CliError(
        "port-in-use",
        `port ${port} is in use by another process`,
        { port, fix: `donn agent run ${name} --port <other>` },
      );
    port = await pick();
  }
  return port;
}

/**
 * The port to run on: `requested`, else the stored one, else a fresh free one (not another
 * agent's stored port). It must be free, and is then stored. `picked` is true only when donn
 * chose it. `pick` is the source of fresh ports.
 */
export async function choosePort(
  home: string,
  project: string,
  name: string,
  requested?: number,
  pick: () => Promise<number> = freePort,
): Promise<{ port: number; picked: boolean }> {
  const stored =
    requested === undefined ? await storedPort(home, project, name) : undefined;
  const picked = requested === undefined && stored === undefined;
  const port =
    requested ?? stored ?? (await pickPort(home, project, name, pick));
  await assertPortFree(port, name);
  await recordPort(home, project, name, port);
  return { port, picked };
}

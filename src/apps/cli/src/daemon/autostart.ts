import type { CliIo } from "../cli.js";
import type { Config } from "../config.js";
import { cliVersion, startDaemonProcess } from "../commands/daemon.js";
import { connectDaemon } from "./client.js";

// Spec 16 §2: `claude` and `codex` start the daemon, so live refresh works without a step.

const WAIT_MS = 1000;
const POLL_MS = 50;

/** Whether a daemon of `home` answers; a refused token throws. */
async function answers(io: CliIo, home: string): Promise<boolean> {
  const client = await connectDaemon(home, {
    version: cliVersion(),
    warn: (message) => io.stderr.write(`${message}\n`),
  });
  return client !== undefined;
}

/**
 * Make sure a daemon runs for `home`, waiting at most a second for it. A launch never fails
 * for this: any trouble is one line on stderr.
 */
export async function ensureDaemon(
  io: CliIo,
  home: string,
  config: Config,
): Promise<void> {
  if (config.daemon?.autoStart === false) return;
  if (io.env.ZZPERSONA_NO_DAEMON === "1") return;
  try {
    if (await answers(io, home)) return;
    await startDaemonProcess(io, home);
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
      if (await answers(io, home)) return;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    throw new Error("did not answer within 1 s");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    io.stderr.write(
      `zzpersona: daemon not started (${reason}); live refresh is off for this session\n`,
    );
  }
}

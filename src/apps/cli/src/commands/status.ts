import type { CliIo } from "../cli.js";
import { homeOf } from "../context.js";
import { connectDaemon, type SessionStatus } from "../daemon/client.js";
import { updateFix } from "../daemon/service.js";
import { listSessions } from "../session.js";
import { cliVersion } from "./daemon.js";
import { managedStatus } from "./managed.js";

// donn status: what the daemon knows of live sessions, or what the registry shows without
// it. See docs/planning/14-daemon.md §4.

export interface StatusOptions {
  json?: boolean;
}

export const NOT_RUNNING =
  "daemon not running: sessions are not refreshed on edits; donn daemon start";

/** `<harness>  <launched> → <live>  [<state>  ]<project or ->` */
function line(s: Omit<SessionStatus, "state"> & { state?: string }): string {
  const persona = s.live ? `${s.launched} → ${s.live}` : s.launched;
  return [
    s.harness,
    persona,
    ...(s.state ? [s.state] : []),
    s.project ?? "-",
  ].join("  ");
}

export async function statusCommand(
  io: CliIo,
  options: StatusOptions,
): Promise<number> {
  const home = homeOf(io);
  const client = await connectDaemon(home, {
    version: cliVersion(),
    warn: (message) => io.stderr.write(`${message}\n`),
    fix: () => updateFix(io, home),
  });
  const managed = await managedStatus(io);
  const managedLine = managed.line === undefined ? [] : [managed.line];
  if (client) {
    const status = client.probed;
    io.stdout.write(
      options.json
        ? `${JSON.stringify({ daemon: true, ...status, managed: managed.json }, null, 2)}\n`
        : `${[`daemon ${status.version} (pid ${status.pid})`, ...status.sessions.map(line), ...managedLine].join("\n")}\n`,
    );
    return 0;
  }
  const sessions = (await listSessions(home))
    .filter((s) => s.running)
    .map((s) => ({
      dir: s.dir,
      harness: s.launched.harness,
      ...(s.launched.project !== undefined && { project: s.launched.project }),
      launched: s.launched.persona,
      ...(s.live && { live: s.live.persona }),
      ...(s.launched.startedAt !== undefined && {
        startedAt: s.launched.startedAt,
      }),
      held: s.live?.held ?? [],
    }));
  io.stdout.write(
    options.json
      ? `${JSON.stringify({ daemon: false, sessions, managed: managed.json }, null, 2)}\n`
      : `${[NOT_RUNNING, ...sessions.map(line), ...managedLine].join("\n")}\n`,
  );
  return 0;
}

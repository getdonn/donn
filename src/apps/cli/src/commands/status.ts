import type { StatusOutput } from "@getdonn/cli-schemas";
import { createdAgentRows, createdLine } from "../agent/list.js";
import type { CliIo } from "../cli.js";
import { homeOf } from "../context.js";
import { connectDaemon, type SessionStatus } from "../daemon/client.js";
import { updateFix } from "../daemon/service.js";
import { listSessions } from "../session.js";
import { readState } from "../state.js";
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

/** What `status --json` prints, daemon up or down (the `StatusOutput` schema). */
export type StatusJson = StatusOutput;

interface Gathered {
  json: StatusJson;
  head: string;
  sessionLines: string[];
  managedLine: string[];
}

async function gather(io: CliIo): Promise<Gathered> {
  const home = homeOf(io);
  const client = await connectDaemon(home, {
    version: cliVersion(),
    warn: (message) => io.stderr.write(`${message}\n`),
    fix: () => updateFix(io, home),
  });
  const managed = await managedStatus(io);
  const managedLine = managed.line === undefined ? [] : [managed.line];
  // One line per agent created on this machine; running only when the daemon says so.
  const agents = await createdAgentRows(
    io,
    home,
    client?.probed.agents ?? [],
    client?.probed.syncFailed,
  );
  // The switches in state.json, keys as stored (docs/planning/28-desktop.md section 1).
  const state = await readState(home);
  const switched = {
    ...(state.default !== undefined && { default: state.default }),
    projects: state.projects,
  };
  if (client) {
    const status = client.probed;
    return {
      json: {
        daemon: true,
        ...status,
        agents,
        managed: managed.json,
        switched,
      } as StatusJson,
      head: `daemon ${status.version} (pid ${status.pid})`,
      sessionLines: status.sessions.map(line),
      managedLine,
    };
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
  return {
    json: {
      daemon: false,
      sessions,
      agents,
      managed: managed.json,
      switched,
    } as StatusJson,
    head: NOT_RUNNING,
    sessionLines: sessions.map(line),
    managedLine,
  };
}

/** The object `donn status --json` prints; the desktop shell reuses it. */
export async function statusSnapshot(io: CliIo): Promise<StatusJson> {
  return (await gather(io)).json;
}

export async function statusCommand(
  io: CliIo,
  options: StatusOptions,
): Promise<number> {
  const { json, head, sessionLines, managedLine } = await gather(io);
  io.stdout.write(
    options.json
      ? `${JSON.stringify(json, null, 2)}\n`
      : `${[head, ...sessionLines, ...json.agents.map(createdLine), ...managedLine].join("\n")}\n`,
  );
  return 0;
}

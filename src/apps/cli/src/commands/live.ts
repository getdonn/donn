import type { CliIo } from "../cli.js";
import {
  applyLive,
  launchedOf,
  readJson,
  type LiveState,
} from "../live-apply.js";
import { join } from "node:path";

// donn live: switch a running session's persona plugin and record what it now runs. MCP
// servers and permissions stay as launched; `held` says which differ. No secret is resolved.
// See docs/planning/10-live-switching.md, section 2.

export type { LiveState };

export interface LiveOptions {
  session: string;
  show?: boolean;
  json?: boolean;
}

export async function liveCommand(
  io: CliIo,
  persona: string | undefined,
  options: LiveOptions,
): Promise<number> {
  const dir = options.session;
  const launched = await launchedOf(dir);
  const print = (text: string, json: unknown) =>
    io.stdout.write(
      options.json ? `${JSON.stringify(json, null, 2)}\n` : `${text}\n`,
    );

  if (options.show || persona === undefined) {
    const state = await readJson<LiveState>(join(dir, "live.json"));
    print(
      state
        ? `${state.persona} is live (launched ${launched.persona})`
        : `${launched.persona} (as launched)`,
      state ?? { launched: launched.persona },
    );
    return 0;
  }

  const state = await applyLive(io, dir, persona);
  const { held, stricter } = state;
  print(
    [
      `${state.persona} is now live in ${dir}`,
      ...(held.length > 0
        ? [
            `still from ${launched.persona} until a relaunch: ${held.join(", ")}`,
          ]
        : []),
      ...(stricter
        ? [`${state.persona} denies more than ${launched.persona}`]
        : []),
    ].join("\n"),
    state,
  );
  return 0;
}

import { prepareBuild } from "../build.js";
import type { CliIo } from "../cli.js";
import { createContext, homeOf } from "../context.js";
import { applyLive, LiveSuperseded } from "../live-apply.js";
import { selectPersona } from "../select.js";
import { buildHash, MODE_FACTS, type SessionInfo } from "../session.js";
import type { SessionStatus } from "./client.js";

// One session's refresh: recompile its persona as its files are now and, when the build changed,
// swap it in as `zzpersona live` does. No secret is resolved: prepareBuild only names the refs.
// See docs/planning/14-daemon.md §3.

export interface RefreshOutcome {
  state: SessionStatus["state"];
  held: string[];
  error?: string;
  /** The session switched persona during the refresh: nothing was swapped. */
  superseded?: boolean;
}

export async function refreshSession(
  io: CliIo,
  session: SessionInfo,
): Promise<RefreshOutcome> {
  const { launched } = session;
  // The session's project decides the project layer, as it did at launch.
  const sessionIo = { ...io, cwd: launched.project ?? homeOf(io) };
  const persona = session.live?.persona ?? launched.persona;
  const before = session.live?.held ?? [];
  try {
    const ctx = await createContext(sessionIo);
    const build = await prepareBuild(ctx, sessionIo, {
      selection: await selectPersona(persona, ctx),
      harness: launched.harness,
      overlay: launched.overlay ?? true,
      passthrough: [],
      // As launched: a `--mode` stands for managed policy detection cannot see.
      ...(launched.mode !== undefined && { facts: MODE_FACTS[launched.mode] }),
    });
    const hash = buildHash(build.output);
    // Codex reads its config once, at launch: a changed build needs a relaunch.
    if (launched.harness === "codex") {
      return {
        state: hash === launched.buildHash ? "current" : "stale",
        held: [],
      };
    }
    if (hash === (session.live?.buildHash ?? launched.buildHash)) {
      return { state: "current", held: before };
    }
    const state = await applyLive(sessionIo, session.dir, persona, {
      persona,
      ...(session.live && { appliedAt: session.live.appliedAt }),
    });
    const grew = state.held.some((part) => !before.includes(part));
    return { state: grew ? "stale" : "refreshed", held: state.held };
  } catch (error) {
    if (error instanceof LiveSuperseded) {
      return { state: "current", held: before, superseded: true };
    }
    return {
      state: "refresh-failed",
      held: before,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

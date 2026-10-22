import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeBuild } from "@zzpersona/executor";
import { prepareBuild } from "./build.js";
import type { CliIo } from "./cli.js";
import { createContext, resolvePersona } from "./context.js";
import { CliError } from "./errors.js";
import { withFileLock, writeFileAtomic } from "./fs.js";
import { selectPersona } from "./select.js";
import {
  buildHash,
  MODE_FACTS,
  pluginNameOf,
  sessionPlugins,
  type Launched,
  type LaunchSnapshot,
} from "./session.js";

// The swap behind `zzpersona live`: compile a persona and replace the session's plugin with it,
// recording what it now runs. Shared with the daemon. See docs/planning/10-live-switching.md §2
// and 14-daemon.md §3.

export interface LiveState {
  persona: string;
  previous: string;
  launched: string;
  instructions: string;
  held: ("mcp" | "permissions" | "settings")[];
  stricter: boolean;
  plugin: string;
  appliedAt: string;
  /** Hash of the compiled build now live (see `buildHash`); absent in older live.json files. */
  buildHash?: string;
}

const unavailable = (reason: string) =>
  new CliError("live-unavailable", `live switching is unavailable: ${reason}`, {
    reason,
  });

/** JSON with sorted keys, so structurally equal values compare equal. */
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  );

const denyOf = (permissions: unknown): string[] =>
  ((permissions as { deny?: string[] } | undefined)?.deny ?? []).slice();

export async function readJson<T>(path: string): Promise<T | undefined> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  return text === undefined ? undefined : (JSON.parse(text) as T);
}

/** The session's launch record; refuses a folder live switching cannot use. */
export async function launchedOf(dir: string): Promise<Launched> {
  if (!existsSync(dir))
    throw unavailable("the session folder is gone; relaunch");
  const launched = await readJson<Launched>(join(dir, "launched.json"));
  if (!launched)
    throw unavailable(
      "live switching needs a session started by zzpersona claude",
    );
  if (!existsSync(sessionPlugins(dir)))
    throw unavailable("managed settings block --plugin-dir");
  return launched;
}

/**
 * Thrown by `applyLive` given `expect` when the session switched since: the swap would undo it.
 */
export class LiveSuperseded extends Error {
  constructor(readonly persona: string) {
    super(`the session switched to ${persona}`);
  }
}

/**
 * Swap `persona` into the session at `sessionDir`; nothing is touched if anything fails first.
 * With `expect`, the session must still run what the caller read (its persona and live.json's
 * `appliedAt`) when the swap begins, or `LiveSuperseded` is thrown and nothing is touched.
 */
export async function applyLive(
  io: CliIo,
  sessionDir: string,
  persona: string,
  expect?: { persona: string; appliedAt?: string },
): Promise<LiveState & { buildHash: string }> {
  const dir = sessionDir;
  const launched = await launchedOf(dir);
  const ctx = await createContext(io);
  const selection = await selectPersona(persona, ctx);
  // Everything that can fail runs before the session folder is touched.
  const build = await prepareBuild(ctx, io, {
    selection,
    harness: "claude-code",
    overlay: launched.overlay ?? true,
    passthrough: [],
    // Managed policy the launch was told about: detection cannot see it.
    ...(launched.mode !== undefined && { facts: MODE_FACTS[launched.mode] }),
  });
  // Compare with what was launched, recorded at launch: today's files may differ or be broken.
  let launchedSnapshot: LaunchSnapshot | undefined = launched.snapshot;
  if (!launchedSnapshot) {
    const { ir } = await resolvePersona(
      ctx,
      { ref: launched.persona, source: "argument" },
      launched.overlay ?? true,
    );
    launchedSnapshot = {
      mcp: ir.mcp,
      permissions: ir.permissions,
      settings: ir.targets["claude-code"] ?? {},
    };
  }
  const ir = build.result.ir;
  const now: LaunchSnapshot = {
    mcp: ir.mcp,
    permissions: ir.permissions,
    settings: ir.targets["claude-code"] ?? {},
  };
  const held = (["mcp", "permissions", "settings"] as const).filter(
    (part) => stable(launchedSnapshot[part]) !== stable(now[part]),
  );
  const launchedDeny = new Set(denyOf(launchedSnapshot.permissions));
  const stricter = denyOf(now.permissions).some(
    (rule) => !launchedDeny.has(rule),
  );
  await writeBuild(build.output, {
    buildDir: build.buildDir,
    store: ctx.store,
  });

  // One switch at a time per session: two overlapping swaps could remove each other's plugin.
  return withFileLock(join(dir, "live.lock"), async () => {
    const current = await readJson<LiveState>(join(dir, "live.json"));
    // A switch made while this one compiled wins: the daemon must never undo the user's.
    if (expect) {
      const running = current?.persona ?? launched.persona;
      if (
        running !== expect.persona ||
        current?.appliedAt !== expect.appliedAt
      ) {
        throw new LiveSuperseded(running);
      }
    }
    // Copy the new plugin in before removing the old: the session always has one.
    const plugins = sessionPlugins(dir);
    const source = join(build.buildDir, "plugin");
    const name = await pluginNameOf(source);
    // Staged beside plugins/, not in it: the watcher must never see a half-copied plugin.
    const staging = join(dir, `.staging-${randomBytes(4).toString("hex")}`);
    await cp(source, staging, { recursive: true, dereference: true });
    await rm(join(plugins, name), { recursive: true, force: true });
    await rename(staging, join(plugins, name));
    for (const child of await readdir(plugins)) {
      if (child !== name)
        await rm(join(plugins, child), { recursive: true, force: true });
    }

    const previous = current?.persona ?? launched.persona;
    const prompt = build.output.files["system-prompt.md"];
    const state: LiveState & { buildHash: string } = {
      persona: selection.ref,
      previous,
      launched: launched.persona,
      instructions: prompt && "content" in prompt ? prompt.content : "",
      held: [...held],
      stricter,
      plugin: name,
      appliedAt: new Date((io.now ?? Date.now)()).toISOString(),
      buildHash: buildHash(build.output),
    };
    await writeFileAtomic(
      join(dir, "live.json"),
      `${JSON.stringify(state, null, 2)}\n`,
    );
    return state;
  });
}

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HarnessAdapter, ReportEntry } from "@zzpersona/adapter-sdk";
import { applyOverlay } from "@zzpersona/executor";
import { prepareBuild } from "./build.js";
import type { CliIo } from "./cli.js";
import { homeOf, type Context } from "./context.js";
import { connectDaemon, type SessionStatus } from "./daemon/client.js";
import { errorText } from "./errors.js";
import { allAdapters, findAdapter } from "./plugins.js";
import type { Selection } from "./select.js";

// What a switch means in each harness: what it keeps and drops, which sessions here still run
// another persona, and what the committed AGENTS.md carries. See docs/planning/17-switch-report.md.

export interface HarnessResult {
  id: string;
  status: "ok" | "drops" | "error" | "shared";
  dropped: string[];
  /** Sessions here still on another persona: how many, which (the first, "and others"), the fix. */
  sessions?: { count: number; persona: string; fix: string };
  message?: string;
  fix?: string;
}

const SHARED = "project/persona";

/** Report entries grouped by field, in report order: `hooks (2)`, `knowledge (3 approximated)`. */
function groups(entries: readonly ReportEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const field = /^[^.[]+/.exec(entry.path)![0];
    const key =
      entry.outcome === "dropped" ? field : `${field}\u0000approximated`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, n]) => {
    const [field, approximated] = key.split("\u0000");
    return approximated ? `${field} (${n} approximated)` : `${field} (${n})`;
  });
}

/** The session list of a running daemon, or undefined: never starts one, never fails. */
async function daemonSessions(io: CliIo): Promise<SessionStatus[] | undefined> {
  try {
    const client = await connectDaemon(homeOf(io));
    return client ? (await client.status()).sessions : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the repo's AGENTS.md carries a zzpersona block. */
async function hasBlock(repo: string): Promise<boolean> {
  const text = await readFile(join(repo, "AGENTS.md"), "utf8").catch(() => "");
  return text.includes("<!-- zzpersona:begin");
}

async function agentsMd(
  io: CliIo,
  ctx: Context,
  persona: string,
): Promise<HarnessResult> {
  const build = await prepareBuild(ctx, io, {
    selection: { ref: SHARED, source: "project" },
    harness: "agents-md",
    overlay: false,
    passthrough: [],
    quiet: true,
  });
  let stale = false;
  for (const step of build.plan.steps) {
    if (step.kind !== "overlay") continue;
    const result = await applyOverlay(step, dirname(ctx.projectDir!), {
      mode: "check",
    });
    stale ||= result.status === "stale";
  }
  return {
    id: "agents-md",
    status: persona === SHARED ? "ok" : "shared",
    dropped: [],
    ...(stale && { fix: "zzpersona write" }),
  };
}

export async function harnessReport(
  io: CliIo,
  ctx: Context,
  selection: Selection,
  options: { only?: string; countSessions: boolean },
): Promise<HarnessResult[]> {
  const adapters: HarnessAdapter[] =
    options.only !== undefined
      ? [await findAdapter(ctx, io.env, options.only)]
      : await allAdapters(ctx, io.env);
  const repo =
    ctx.projectDir === undefined ? undefined : dirname(ctx.projectDir);
  const sessions =
    options.countSessions && repo ? await daemonSessions(io) : undefined;
  const results: HarnessResult[] = [];
  for (const adapter of adapters) {
    try {
      if (adapter.id === "agents-md") {
        // A committed file rendered from the shared project persona, not from the choice.
        if (repo !== undefined && (await hasBlock(repo)))
          results.push(await agentsMd(io, ctx, selection.ref));
        continue;
      }
      const detection = await adapter.detect(io.probe);
      if (!detection.installed) continue;
      const build = await prepareBuild(ctx, io, {
        selection,
        harness: adapter.id,
        overlay: true,
        passthrough: [],
        quiet: true,
        detection,
      });
      const dropped = groups(build.output.report.entries);
      const result: HarnessResult = {
        id: adapter.id,
        status: dropped.length > 0 ? "drops" : "ok",
        dropped,
      };
      const behind = (sessions ?? []).filter(
        (session) =>
          session.harness === adapter.id &&
          session.project === repo &&
          (session.live ?? session.launched) !== selection.ref,
      );
      if (behind.length > 0) {
        const personas = [
          ...new Set(behind.map((session) => session.live ?? session.launched)),
        ];
        result.sessions = {
          count: behind.length,
          persona:
            personas.length > 1 ? `${personas[0]} and others` : personas[0]!,
          fix:
            adapter.id === "codex"
              ? "relaunch with zzpersona codex"
              : `/persona use ${selection.ref}`,
        };
      }
      results.push(result);
    } catch (error) {
      results.push({
        id: adapter.id,
        status: "error",
        dropped: [],
        message: errorText(error),
      });
    }
  }
  return results;
}

/** One line per harness, the ids padded to line up. */
export function reportLines(
  results: readonly HarnessResult[],
  persona: string,
): string[] {
  const width = Math.max(0, ...results.map((r) => r.id.length)) + 2;
  return results.map((r) => {
    let text: string;
    if (r.status === "error") text = `error ${r.message ?? ""}`.trimEnd();
    else if (r.status === "shared")
      text = `AGENTS.md carries ${SHARED} (shared); ${persona} applies to zzpersona launches only`;
    else if (r.status === "drops") text = `drops ${r.dropped.join(", ")}`;
    else text = "ok";
    if (r.fix !== undefined) text += ` — ${r.fix}`;
    if (r.sessions !== undefined) {
      const { count, persona: running, fix } = r.sessions;
      const verb =
        count === 1 ? "session here still runs" : "sessions here still run";
      text += ` · ${count} ${verb} ${running}: ${fix}`;
    }
    return `${r.id.padEnd(width)}${text}`;
  });
}

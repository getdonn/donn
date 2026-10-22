import type { H, Hook, Mod$, Next, On, Options } from "./api.js";
import { runCli, type CliResult } from "./cli.js";
import {
  bandText,
  commandText,
  failureText,
  launchedFrom,
  liveSection,
  liveText,
  nudgeText,
  personaCommand,
  USAGE,
  type Here,
  type Launched,
  type LiveState,
} from "./decide.js";

// The zzpersona mod for Claude Code: the active persona in the band above the prompt, a nudge
// when this folder selects a different one, and /persona. It never changes the session's
// persona. See docs/planning/09-mod-claude-code.md.

declare const h: H;

const toHere = (result: CliResult): Here =>
  result.ok
    ? {
        kind: "persona",
        ...(result.json as { persona: string; source: never }),
      }
    : result.code === "no-persona"
      ? { kind: "none" }
      : { kind: "unavailable", reason: result.reason };

// Module state: the engine runs register (and session.start) again on a reload, so register
// resets it. Hooks are top-level functions, as the engine's static checks require.
let showBand = true;
let showNudge = true;
let launched: Launched | undefined;
let here: Here = { kind: "none" };
let nudged = false;
/** The session folder `zzpersona claude` launched with, and the live switch, if any (spec 10). */
let session: string | undefined;
let live: LiveState | undefined;

const NO_SESSION = "live switching needs a session started by zzpersona claude";

const HELD: readonly unknown[] = ["mcp", "permissions", "settings"];

/** A live state with every field the mod uses well formed; anything else counts as none. */
function asLive(json: unknown): LiveState | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const s = json as Partial<Record<keyof LiveState, unknown>>;
  const strings = [s.persona, s.launched, s.instructions, s.appliedAt];
  return strings.every((value) => typeof value === "string") &&
    Array.isArray(s.held) &&
    s.held.every((part) => HELD.includes(part)) &&
    typeof s.stricter === "boolean"
    ? (json as LiveState)
    : undefined;
}

/** What this folder selects, asked once at start and again after a /persona command. */
async function refresh($: Mod$): Promise<void> {
  here = toHere(await runCli($, ["switch"], await $.session.cwd()));
  $.ui.invalidate("ui.render");
}

async function onStart(
  $: Mod$,
  e: { isInteractive?: boolean },
  next: Next,
): Promise<unknown> {
  await $.command.register({
    name: "persona",
    description: "Show, list or switch zzpersona personas",
    argumentHint:
      "[list | switch <persona> [--default] | use <persona> | clear [--default]]",
  });
  // Literal names: the engine lists the variables a mod reads.
  launched = launchedFrom(
    await $.env.get("ZZPERSONA_PERSONA"),
    await $.env.get("ZZPERSONA_SOURCE"),
    await $.env.get("ZZPERSONA_PROJECT"),
  );
  session = (await $.env.get("ZZPERSONA_SESSION")) || undefined;
  // Headless (`claude -p`, the SDK): nothing is drawn, so don't run the CLI.
  if (e.isInteractive === false) return next(e);
  // In the background: the session starts without waiting for the CLI. A failure here (the
  // engine unloading the mod, say) has nowhere to go, and must not escape.
  void refresh($)
    .then(async () => {
      // After a reload, pick up a switch made before it.
      if (session !== undefined) {
        const shown = await runCli(
          $,
          ["live", "--show", "--session", session],
          await $.session.cwd(),
        );
        if (shown.ok) live = asLive(shown.json);
        $.ui.invalidate("ui.render");
        if (live) $.ui.invalidate("prompt.section");
      }
      const text = nudgeText(launched, here, live, session !== undefined);
      if (showNudge && !nudged && text !== undefined) {
        nudged = true;
        $.ui.status(text);
      }
    })
    .catch(() => {});
  return next(e);
}

async function onBand(
  $: Mod$,
  e: { props?: { hasSurvey?: boolean } },
  next: Next,
): Promise<unknown> {
  // A survey holds the band; a hook yields to it.
  if (e.props?.hasSurvey) return next(e);
  const text = showBand ? bandText(launched, here, live) : undefined;
  if (text === undefined) return next(e);
  const { Box, Text } = $.ui.resolve(e);
  // A column, so other mods' band output stacks below this line rather than beside it.
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { dimColor: true }, text),
    await next(e),
  );
}

async function onPersona($: Mod$, e: { args?: string }): Promise<unknown> {
  $.ui.status(undefined);
  const command = personaCommand(e.args ?? "");
  if ("usage" in command) return { text: USAGE };
  const cwd = await $.session.cwd();
  if (command.form === "use") {
    if (session === undefined) return { text: NO_SESSION };
    return { text: await applyLive($, command.argv[1]!, cwd) };
  }
  const result = await runCli($, command.argv, cwd);
  if (command.form === "switch" && result.ok && session !== undefined) {
    const saved = commandText("switch", result.json, launched, here).split(
      "\n",
    )[0];
    const text = await applyLive($, command.argv[1]!, cwd, saved);
    await refresh($);
    return { text };
  }
  if (command.form === "show") here = toHere(result);
  // A folder with no persona is an answer for `/persona`, not an error.
  const isAnswer = command.form === "show" && here.kind === "none";
  if (!result.ok && !isAnswer)
    return { text: failureText(result.reason, result.code) };
  if (command.form !== "show") await refresh($);
  const json = result.ok ? result.json : {};
  return { text: commandText(command.form, json, launched, here) };
}

/** Run `zzpersona live` and adopt its state; the text to print either way. */
async function applyLive(
  $: Mod$,
  persona: string,
  cwd: string,
  saved?: string,
): Promise<string> {
  const result = await runCli($, ["live", persona, "--session", session!], cwd);
  if (!result.ok)
    return [
      ...(saved ? [saved] : []),
      failureText(result.reason, result.code),
    ].join("\n");
  live = asLive(result.json);
  $.ui.invalidate("ui.render");
  $.ui.invalidate("prompt.section");
  return live ? liveText(live, saved) : `unexpected answer from live`;
}

/**
 * Where the superseding instructions go: the last session-scope section of the system prompt,
 * as composed for this session. Claude Code fixes the composed list after the first request, but
 * re-reads a section's text after $.ui.invalidate("prompt.section") (spikes/live-smoke).
 */
let anchor = "env_info_simple";
/** Sections the engine has passed through prompt.section; not every composed one is. */
const seen = new Set<string>();

async function onCompose($: Mod$, e: unknown, next: Next): Promise<unknown> {
  const result = (await next(e)) as {
    sections?: readonly { id: string; scope: string }[];
  };
  const last = [...(result.sections ?? [])]
    .reverse()
    .find((section) => section.scope === "session" && seen.has(section.id));
  if (last) anchor = last.id;
  return result;
}

/**
 * Before each turn, pick up a live.json written since: the daemon refreshes the session when its
 * persona changes (docs/planning/14-daemon.md). A file read, not the CLI: this runs every turn.
 */
async function onSubmit($: Mod$, e: unknown, next: Next): Promise<unknown> {
  if (session !== undefined) {
    // An older Claude Code has no $.fs: the call throws and the session keeps what it has. No
    // typeof guard: the engine's checks want $ spelled $.noun.event(...).
    let read: LiveState | undefined;
    try {
      const text = await $.fs.read(`${session}/live.json`);
      read = asLive(JSON.parse(text));
    } catch {
      read = undefined;
    }
    // Only a newer state: a read racing a /persona use must not roll it back.
    if (read && read.appliedAt > (live?.appliedAt ?? "")) {
      live = read;
      $.ui.invalidate("prompt.section");
      $.ui.invalidate("ui.render");
    }
  }
  return next(e);
}

/** While a live state is in effect, the anchor section carries the superseding text. */
async function onSection(
  $: Mod$,
  e: { name?: string },
  next: Next,
): Promise<unknown> {
  if (e.name !== undefined) seen.add(e.name);
  const result = (await next(e)) as { text?: string | null };
  const section = live ? liveSection(live) : undefined;
  if (!section || e.name !== anchor) return result;
  return { ...result, text: `${result.text ?? ""}\n\n${section.text}` };
}

export function register(on: On, options: Options = {}): void {
  showBand = options.band !== false;
  showNudge = options.nudge !== false;
  launched = undefined;
  here = { kind: "none" };
  nudged = false;
  session = undefined;
  live = undefined;
  anchor = "env_info_simple";
  seen.clear();
  on("session.start", onStart as Hook);
  on("ui.render", { component: "AbovePrompt" }, onBand as Hook);
  on("command.run", { command: "persona" }, onPersona as Hook);
  on("prompt.compose", onCompose as Hook);
  on("prompt.section", onSection as Hook);
  on("prompt.submit", onSubmit as Hook);
}
